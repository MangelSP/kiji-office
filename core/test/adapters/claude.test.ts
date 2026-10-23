import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));

import { query } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeAdapter } from '../../src/adapters/claude.js';
import type { AgentEvent, RunSpec } from '../../src/adapters/types.js';

type Ctx = { options: any; messages: AsyncIterator<any> };

/** Un `Query` falso: el guion es un generador que puede llamar a options.canUseTool como lo haría el SDK. */
function mockQuery(script: (ctx: Ctx) => AsyncGenerator<any>) {
  const calls: Array<{ options: any }> = [];
  vi.mocked(query).mockImplementation(((params: any) => {
    calls.push({ options: params.options });
    const gen: any = script({ options: params.options, messages: params.prompt[Symbol.asyncIterator]() });
    gen.close = vi.fn();
    return gen;
  }) as any);
  return calls;
}

const spec = (over: Partial<RunSpec> = {}): RunSpec => ({
  runId: 'r1',
  cwd: '/work/repo',
  model: 'haiku',
  systemPrompt: 'Eres un programador.',
  prompt: 'haz algo',
  allowedPaths: ['hola.txt'],
  budgetUsd: 0.05,
  ...over,
});

async function collect(it: AsyncIterable<AgentEvent>, onEvent?: (e: AgentEvent) => void): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const e of it) {
    events.push(e);
    onEvent?.(e);
  }
  return events;
}

const ask = (opts: Partial<any> = {}) => ({ signal: new AbortController().signal, toolUseID: 'tu_1', requestId: 'r', ...opts });
const resultOk = (extra: object = {}) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'listo',
  total_cost_usd: 0.0123,
  usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 2, cache_read_input_tokens: 3 },
  session_id: 'sess-1',
  ...extra,
});

beforeEach(() => {
  vi.mocked(query).mockReset();
});

describe('ClaudeAdapter — secuencia con permiso', () => {
  it('thinking -> tool -> permission_request -> (deny) -> tool end -> done', async () => {
    mockQuery(async function* ({ options }) {
      yield { type: 'system', subtype: 'init', session_id: 'sess-1' };
      yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'm1' } } };
      yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', content_block: { type: 'thinking' } } };
      yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Voy ' } } };
      yield { type: 'assistant', parent_tool_use_id: null, message: { id: 'm1', content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: 'Voy ' }] } };
      // Write permitido: no genera permission_request
      const w = await options.canUseTool('Write', { file_path: '/work/repo/hola.txt', content: 'hola' }, ask({ toolUseID: 'tu_w' }));
      expect(w.behavior).toBe('allow');
      yield { type: 'assistant', parent_tool_use_id: null, message: { id: 'm2', content: [{ type: 'tool_use', id: 'tu_w', name: 'Write', input: { file_path: '/work/repo/hola.txt' } }] } };
      yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_w', content: 'ok' }] } };
      yield { type: 'assistant', parent_tool_use_id: null, message: { id: 'm3', content: [{ type: 'tool_use', id: 'tu_rm', name: 'Bash', input: { command: 'rm hola.txt' } }] } };
      const r = await options.canUseTool('Bash', { command: 'rm hola.txt' }, ask({ toolUseID: 'tu_rm' }));
      yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_rm', content: [{ type: 'text', text: r.behavior === 'deny' ? r.message : 'borrado' }] }] } };
      yield resultOk();
    });

    const adapter = new ClaudeAdapter();
    const events = await collect(adapter.start(spec()), (e) => {
      if (e.type === 'permission_request') adapter.answerPermission(e.id, false, 'No borres nada');
    });

    expect(events.map((e) => e.type)).toEqual(['thinking', 'text', 'tool', 'tool', 'tool', 'permission_request', 'tool', 'done']);
    // texto en streaming no se duplica con el mensaje completo
    expect(events.filter((e) => e.type === 'text')).toHaveLength(1);
    const perm = events.find((e) => e.type === 'permission_request');
    expect(perm).toMatchObject({ id: 'tu_rm', tool: 'Bash', input: { command: 'rm hola.txt' }, risk: 'ask' });
    const toolEnd = events.filter((e) => e.type === 'tool' && e.status === 'end');
    expect(toolEnd[1]).toMatchObject({ name: 'Bash', output: 'No borres nada' });
    expect(events.at(-1)).toEqual({
      type: 'done',
      text: 'listo',
      sessionId: 'sess-1',
      costUsd: 0.0123,
      usage: { input: 15, output: 5 },
    });
  });

  it('allow: devuelve el input y la herramienta sigue', async () => {
    let decision: any;
    mockQuery(async function* ({ options }) {
      const p = options.canUseTool('Bash', { command: 'rm hola.txt' }, ask());
      await new Promise((r) => setTimeout(r, 0));
      decision = await p;
      yield resultOk();
    });
    const adapter = new ClaudeAdapter();
    await collect(adapter.start(spec()), (e) => e.type === 'permission_request' && adapter.answerPermission(e.id, true));
    expect(decision).toMatchObject({ behavior: 'allow', updatedInput: { command: 'rm hola.txt' } });
  });
});

describe('ClaudeAdapter — canUseTool', () => {
  async function decide(tool: string, input: any, over: Partial<RunSpec> = {}) {
    let result: any;
    mockQuery(async function* ({ options }) {
      const p = options.canUseTool(tool, input, ask());
      result = await Promise.race([p, new Promise((r) => setTimeout(() => r('pending'), 20))]);
      yield resultOk();
    });
    const adapter = new ClaudeAdapter();
    let requested = false;
    await collect(adapter.start(spec(over)), (e) => {
      if (e.type === 'permission_request') {
        requested = true;
        // no se responde: queda pendiente hasta que el guion se rinda (result = 'pending')
      }
    });
    return { result, requested };
  }

  it('Write/Edit fuera de allowedPaths -> deny con mensaje, sin permission_request', async () => {
    const { result, requested } = await decide('Edit', { file_path: '/work/repo/src/otro.ts' });
    expect(requested).toBe(false);
    expect(result.behavior).toBe('deny');
    expect(result.message).toContain('hola.txt');
    expect((await decide('Write', { file_path: '/etc/passwd' })).result.behavior).toBe('deny');
    expect((await decide('NotebookEdit', { notebook_path: '/work/repo/x.ipynb' })).result.behavior).toBe('deny');
    expect((await decide('Write', { file_path: '/work/repo/../hola.txt' })).result.behavior).toBe('deny');
  });

  it('Write dentro de allowedPaths -> allow', async () => {
    expect((await decide('Write', { file_path: '/work/repo/hola.txt' })).result.behavior).toBe('allow');
  });

  it('Bash: ok -> allow, never -> deny, ask -> permission_request', async () => {
    expect((await decide('Bash', { command: 'ls -la' })).result.behavior).toBe('allow');
    const never = await decide('Bash', { command: 'git push --force origin main' });
    expect(never.requested).toBe(false);
    expect(never.result.behavior).toBe('deny');
    const askCase = await decide('Bash', { command: 'npm install lodash' });
    expect(askCase.requested).toBe(true);
  });

  it('AskUserQuestion se muestra como permission_request y acepta updatedInput con las respuestas', async () => {
    const questions = [{ question: '¿Cuál?', header: 'Elige', options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }] }];
    let decision: any;
    mockQuery(async function* ({ options }) {
      decision = await options.canUseTool('AskUserQuestion', { questions }, ask({ toolUseID: 'tu_q' }));
      yield resultOk();
    });
    const adapter = new ClaudeAdapter();
    const events = await collect(adapter.start(spec()), (e) => {
      if (e.type === 'permission_request') adapter.answerPermission(e.id, true, undefined, { questions, answers: { '¿Cuál?': 'B' } });
    });
    expect(events.find((e) => e.type === 'permission_request')).toMatchObject({ tool: 'AskUserQuestion', input: { questions } });
    expect(decision).toMatchObject({ behavior: 'allow', updatedInput: { answers: { '¿Cuál?': 'B' } } });
  });

  it('Read dentro del cwd -> allow; fuera del cwd -> pregunta; .env -> pregunta', async () => {
    expect((await decide('Read', { file_path: '/work/repo/src/a.ts' })).result.behavior).toBe('allow');
    expect((await decide('Grep', { pattern: 'x' })).result.behavior).toBe('allow');
    expect((await decide('Read', { file_path: '/Users/otro/notas.txt' })).requested).toBe(true);
    expect((await decide('Read', { file_path: '/work/repo/.env' })).requested).toBe(true);
    expect((await decide('Read', { file_path: '/home/u/.ssh/id_rsa' })).result.behavior).toBe('deny');
  });

  it('subagentes: las llamadas con agentID pasan por las mismas reglas', async () => {
    async function decideSub(tool: string, input: any) {
      let result: any;
      let requested = false;
      mockQuery(async function* ({ options }) {
        const p = options.canUseTool(tool, input, ask({ toolUseID: 'tu_sub', agentID: 'sub-1' }));
        result = await Promise.race([p, new Promise((r) => setTimeout(() => r('pending'), 20))]);
        yield resultOk();
      });
      await collect(new ClaudeAdapter().start(spec()), (e) => {
        if (e.type === 'permission_request') requested = true;
      });
      return { result, requested };
    }
    expect((await decideSub('Bash', { command: 'rm -rf ~/..' })).result.behavior).toBe('deny');
    expect((await decideSub('Bash', { command: 'npm install x' })).requested).toBe(true);
    expect((await decideSub('Write', { file_path: '/work/repo/otro.ts' })).result.behavior).toBe('deny');
    expect((await decideSub('Bash', { command: 'ls' })).result.behavior).toBe('allow');
  });

  it('herramientas desconocidas se preguntan; en modo readOnly solo Read/Glob/Grep', async () => {
    expect((await decide('WebFetch', { url: 'https://x' })).requested).toBe(true);
    expect((await decide('Bash', { command: 'ls' }, { readOnly: true })).result.behavior).toBe('deny');
    expect((await decide('Read', { file_path: '/work/repo/a' }, { readOnly: true })).result.behavior).toBe('allow');
  });
});

describe('ClaudeAdapter — límites y errores', () => {
  it('rate_limit_event rejected + result de error -> limit rate con resetsAt y sessionId', async () => {
    mockQuery(async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'sess-9' };
      yield { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1_800_000_000, rateLimitType: 'five_hour' }, session_id: 'sess-9' };
      yield { type: 'result', subtype: 'success', is_error: true, result: 'Credit balance too low', errors: [], session_id: 'sess-9' };
    });
    const events = await collect(new ClaudeAdapter().start(spec()));
    // 0.2a: el rechazo produce además un evento `rate` (cupo) antes del `limit` terminal
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: 'rate', rateLimitType: 'five_hour', status: 'rejected', resetsAt: 1_800_000_000_000 });
    expect(events[1]).toMatchObject({ type: 'limit', kind: 'rate', resetsAt: 1_800_000_000_000, sessionId: 'sess-9', rateLimitType: 'five_hour' });
  });

  it('error_max_budget_usd -> limit budget', async () => {
    mockQuery(async function* () {
      yield { type: 'result', subtype: 'error_max_budget_usd', is_error: false, errors: [], total_cost_usd: 0.05, session_id: 'sess-2' };
    });
    const events = await collect(new ClaudeAdapter().start(spec()));
    expect(events).toEqual([expect.objectContaining({ type: 'limit', kind: 'budget', sessionId: 'sess-2' })]);
  });

  it('api_retry agotado + result de error sin errors[] -> limit rate', async () => {
    mockQuery(async function* () {
      yield { type: 'system', subtype: 'api_retry', error: 'rate_limit', attempt: 10, max_retries: 10, session_id: 's' };
      yield { type: 'result', subtype: 'error_during_execution', is_error: true, errors: [], session_id: 's' };
    });
    const events = await collect(new ClaudeAdapter().start(spec()));
    expect(events).toEqual([expect.objectContaining({ type: 'limit', kind: 'rate' })]);
  });

  it('límite previo + result con otro error -> error (el límite no tapa la causa real)', async () => {
    mockQuery(async function* () {
      yield { type: 'system', subtype: 'api_retry', error: 'rate_limit', attempt: 10, max_retries: 10, session_id: 's' };
      yield { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['boom'], session_id: 's' };
    });
    expect(await collect(new ClaudeAdapter().start(spec()))).toEqual([expect.objectContaining({ type: 'error', message: 'boom' })]);
  });

  it('límite previo + error_max_turns -> error, no limit', async () => {
    mockQuery(async function* () {
      yield { type: 'rate_limit_event', rate_limit_info: { status: 'rejected' }, session_id: 's' };
      yield { type: 'result', subtype: 'error_max_turns', is_error: true, errors: [], session_id: 's' };
    });
    expect(await collect(new ClaudeAdapter().start(spec()))).toEqual([
      { type: 'rate', status: 'rejected' },
      expect.objectContaining({ type: 'error' }),
    ]);
  });

  it('result is_error con "overloaded" -> limit rate', async () => {
    mockQuery(async function* () {
      yield { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['API Error: Overloaded'], session_id: 's' };
    });
    expect((await collect(new ClaudeAdapter().start(spec())))[0]).toMatchObject({ type: 'limit', kind: 'rate' });
  });

  it('error normal -> error (no limit)', async () => {
    mockQuery(async function* () {
      yield { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['algo se rompió'], session_id: 's' };
    });
    expect(await collect(new ClaudeAdapter().start(spec()))).toEqual([
      { type: 'error', message: 'algo se rompió', retryable: false, sessionId: 's' },
    ]);
  });

  it('rate_limit_event rejected pero el run termina bien -> done (no limit)', async () => {
    mockQuery(async function* () {
      yield { type: 'rate_limit_event', rate_limit_info: { status: 'rejected' }, session_id: 's' };
      yield resultOk();
    });
    expect((await collect(new ClaudeAdapter().start(spec()))).map((e) => e.type)).toEqual(['rate', 'done']);
  });

  it('el SDK lanza una excepción -> error; con texto de límite -> limit', async () => {
    mockQuery(async function* () {
      throw new Error('Claude Code process exited with code 1');
      yield;
    });
    expect(await collect(new ClaudeAdapter().start(spec()))).toEqual([expect.objectContaining({ type: 'error' })]);

    mockQuery(async function* () {
      throw new Error('Claude AI usage limit reached');
      yield;
    });
    expect(await collect(new ClaudeAdapter().start(spec()))).toEqual([expect.objectContaining({ type: 'limit', kind: 'rate' })]);
  });

  it('el stream termina sin result -> error retryable', async () => {
    mockQuery(async function* () {
      yield { type: 'system', subtype: 'init', session_id: 's' };
    });
    expect(await collect(new ClaudeAdapter().start(spec()))).toEqual([expect.objectContaining({ type: 'error', retryable: true })]);
  });
});

describe('ClaudeAdapter — opciones del SDK', () => {
  it('no carga MCP del usuario ni del proyecto y ToolSearch ya no es segura', async () => {
    let decision: any;
    const calls = mockQuery(async function* ({ options }) {
      decision = await Promise.race([options.canUseTool('ToolSearch', { query: 'x' }, ask()), Promise.resolve('pregunta')]);
      yield resultOk();
    });
    await collect(new ClaudeAdapter().start(spec()));
    expect(calls[0].options.strictMcpConfig).toBe(true);
    expect(calls[0].options.mcpServers).toEqual({});
    expect(decision).toBe('pregunta'); // queda pendiente de respuesta del usuario
  });

  it('pasa cwd, permissionMode, settingSources, disallowedTools, presupuesto y streaming parcial', async () => {
    const calls = mockQuery(async function* () {
      yield resultOk();
    });
    await collect(new ClaudeAdapter({ pathToClaudeCodeExecutable: '/bin/claude' }).start(spec({ resumeSessionId: 'prev' })));
    const o = calls[0].options;
    expect(o).toMatchObject({
      cwd: '/work/repo',
      model: 'haiku',
      permissionMode: 'default',
      settingSources: [],
      maxBudgetUsd: 0.05,
      includePartialMessages: true,
      resume: 'prev',
      pathToClaudeCodeExecutable: '/bin/claude',
    });
    expect(o.disallowedTools).toEqual(
      expect.arrayContaining(['Bash(git push --force*)', 'Edit(//**/.env*)', 'Bash(rm -rf /)', 'Read(./.env)', 'Read(./**/.env.*)', 'Read(~/.ssh/**)']),
    );
    // sin prefijos que denieguen `rm -rf /Users/…/worktree/dist`
    expect(o.disallowedTools).not.toContain('Bash(rm -rf /*)');
    expect(o.disallowedTools).not.toContain('Bash(rm -rf ~*)');
    expect(o.systemPrompt).toMatchObject({ type: 'preset', append: expect.stringContaining('Eres un programador.') });
    expect(o.systemPrompt.append).toContain('no `npx`');
    expect(o.tools).toBeUndefined();
    expect(typeof o.canUseTool).toBe('function');
  });

  it('readOnly restringe a Read/Glob/Grep y outputSchema activa la salida estructurada', async () => {
    const schema = { type: 'object', properties: { summary: { type: 'string' } } };
    const calls = mockQuery(async function* () {
      yield resultOk({ structured_output: { summary: 'plan' } });
    });
    const events = await collect(new ClaudeAdapter().start(spec({ readOnly: true, outputSchema: schema })));
    expect(calls[0].options.tools).toEqual(['Read', 'Glob', 'Grep']);
    expect(calls[0].options.systemPrompt.append).toBe('Eres un programador.'); // el jefe no recibe la línea de npx
    expect(calls[0].options.outputFormat).toEqual({ type: 'json_schema', schema });
    expect(events.at(-1)).toMatchObject({ type: 'done', structured: { summary: 'plan' } });
  });
});

describe('ClaudeAdapter — send y stop', () => {
  it('send() inyecta un mensaje durante el run; después del done lanza', async () => {
    const received: string[] = [];
    mockQuery(async function* ({ messages }) {
      received.push((await messages.next()).value.message.content);
      yield { type: 'assistant', parent_tool_use_id: null, message: { id: 'm', content: [{ type: 'text', text: 'espero…' }] } };
      received.push((await messages.next()).value.message.content);
      yield resultOk();
    });
    const adapter = new ClaudeAdapter();
    const events = await collect(adapter.start(spec({ prompt: 'primero' })), (e) => {
      if (e.type === 'text') void adapter.send('segundo');
    });
    expect(received).toEqual(['primero', 'segundo']);
    expect(events.at(-1)?.type).toBe('done');
    await expect(adapter.send('tarde')).rejects.toThrow(/resumeSessionId/);
  });

  it('stop() aborta, deniega permisos pendientes y cierra el stream sin evento terminal', async () => {
    let decision: any;
    mockQuery(async function* ({ options }) {
      decision = await options.canUseTool('Bash', { command: 'npm install x' }, ask({ signal: options.abortController.signal }));
      yield resultOk(); // no debería importar
    });
    const adapter = new ClaudeAdapter();
    const events: AgentEvent[] = [];
    for await (const e of adapter.start(spec())) {
      events.push(e);
      if (e.type === 'permission_request') await adapter.stop();
    }
    expect(events.map((e) => e.type)).toEqual(['permission_request']);
    expect(decision.behavior).toBe('deny');
  });

  it('un adaptador solo arranca un run', () => {
    mockQuery(async function* () {
      yield resultOk();
    });
    const adapter = new ClaudeAdapter();
    adapter.start(spec());
    expect(() => adapter.start(spec())).toThrow();
  });
});

describe('ClaudeAdapter — usage y rate (0.2a)', () => {
  const assistant = (id: string, usage: object, over: object = {}) => ({
    type: 'assistant',
    parent_tool_use_id: null,
    session_id: 'sess-u',
    message: { id, model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'hola' }], usage, ...over },
  });

  it('cada mensaje assistant con usage emite `usage`: contexto = input + cache_read + cache_creation del turno', async () => {
    mockQuery(async function* () {
      yield assistant('m1', { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50 });
      yield assistant('m2', { input_tokens: 5, output_tokens: 20, cache_read_input_tokens: 1200, cache_creation_input_tokens: 0 });
      yield resultOk();
    });
    const usage = (await collect(new ClaudeAdapter().start(spec({ model: 'sonnet' })))).filter((e) => e.type === 'usage');
    expect(usage).toHaveLength(2);
    expect(usage[0]).toMatchObject({
      model: 'claude-sonnet-4-5', contextTokens: 1150, contextWindow: 200_000, input: 100, output: 10, cacheRead: 1000, cacheWrite: 50, sessionId: 'sess-u',
    });
    // acumulado del run; el contexto es solo el del último turno
    expect(usage[1]).toMatchObject({ contextTokens: 1205, input: 105, output: 30, cacheRead: 2200, cacheWrite: 50 });
    expect(usage[1]).not.toHaveProperty('final');
  });

  it('el mismo mensaje repetido por bloque no se suma dos veces; los subagentes no cuentan para el contexto', async () => {
    mockQuery(async function* () {
      yield assistant('m1', { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
      yield assistant('m1', { input_tokens: 10, output_tokens: 8, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
      yield { ...assistant('s1', { input_tokens: 9999, output_tokens: 9999 }), parent_tool_use_id: 'tu_x' };
      yield resultOk();
    });
    const usage = (await collect(new ClaudeAdapter().start(spec()))).filter((e) => e.type === 'usage');
    expect(usage).toHaveLength(2);
    expect(usage[1]).toMatchObject({ input: 10, output: 8, contextTokens: 10 });
  });

  it('ventana de contexto: 200000 por defecto y 1000000 si el modelo lleva [1m]', async () => {
    mockQuery(async function* () {
      yield assistant('m1', { input_tokens: 1, output_tokens: 1 });
      yield resultOk();
    });
    const a = (await collect(new ClaudeAdapter().start(spec({ model: 'sonnet' })))).find((e) => e.type === 'usage');
    expect(a).toMatchObject({ contextWindow: 200_000 });
    mockQuery(async function* () {
      yield assistant('m1', { input_tokens: 1, output_tokens: 1 });
      yield resultOk();
    });
    const b = (await collect(new ClaudeAdapter().start(spec({ model: 'opus[1m]' })))).find((e) => e.type === 'usage');
    expect(b).toMatchObject({ contextWindow: 1_000_000 });
  });

  it('al result, modelUsage da el `usage` final: tokens por categoría, coste y ventana real, antes del `done`', async () => {
    mockQuery(async function* () {
      yield assistant('m1', { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 90, cache_creation_input_tokens: 0 });
      yield resultOk({
        total_cost_usd: 0.42,
        modelUsage: {
          'claude-sonnet-4-5': { inputTokens: 300, outputTokens: 40, cacheReadInputTokens: 900, cacheCreationInputTokens: 60, costUSD: 0.4, contextWindow: 1_000_000, maxOutputTokens: 64000 },
          'claude-haiku-4-5': { inputTokens: 20, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.02, contextWindow: 200_000, maxOutputTokens: 64000 },
        },
      });
    });
    const events = await collect(new ClaudeAdapter().start(spec({ model: 'sonnet' })));
    expect(events.map((e) => e.type)).toEqual(['usage', 'text', 'usage', 'done']);
    expect(events[2]).toMatchObject({
      type: 'usage', final: true, model: 'claude-sonnet-4-5', input: 320, output: 45, cacheRead: 900, cacheWrite: 60,
      contextTokens: 100, contextWindow: 1_000_000, costUsd: 0.42,
    });
  });

  it('un result de error (p. ej. presupuesto) también deja el `usage` final antes del evento terminal', async () => {
    mockQuery(async function* () {
      yield { type: 'result', subtype: 'error_max_budget_usd', is_error: false, errors: [], total_cost_usd: 0.05, session_id: 's', modelUsage: { sonnet: { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4, costUSD: 0.05, contextWindow: 200000 } } };
    });
    const events = await collect(new ClaudeAdapter().start(spec()));
    expect(events.map((e) => e.type)).toEqual(['usage', 'limit']);
    expect(events[0]).toMatchObject({ final: true, costUsd: 0.05, input: 1, output: 2, cacheRead: 3, cacheWrite: 4 });
  });

  it('rate_limit_event emite `rate` aunque sea allowed o allowed_warning (resetsAt en ms)', async () => {
    mockQuery(async function* () {
      yield { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.31, resetsAt: 1_800_000_000 }, session_id: 's' };
      yield { type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', rateLimitType: 'seven_day_opus', utilization: 0.85 }, session_id: 's' };
      yield resultOk();
    });
    expect(await collect(new ClaudeAdapter().start(spec()))).toEqual([
      { type: 'rate', status: 'allowed', rateLimitType: 'five_hour', utilization: 0.31, resetsAt: 1_800_000_000_000 },
      { type: 'rate', status: 'allowed_warning', rateLimitType: 'seven_day_opus', utilization: 0.85 },
      expect.objectContaining({ type: 'done' }),
    ]);
  });

  it('rejected: además del `rate` produce el `limit` de siempre, ahora con rateLimitType', async () => {
    mockQuery(async function* () {
      yield { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'seven_day_opus', resetsAt: 1_800_000_000 }, session_id: 's' };
      yield { type: 'result', subtype: 'success', is_error: true, result: 'Usage limit reached', errors: ['Usage limit reached'], session_id: 's' };
    });
    const events = await collect(new ClaudeAdapter().start(spec()));
    expect(events.map((e) => e.type)).toEqual(['rate', 'limit']);
    // el límite que sale del texto del `result` hereda tipo y hora de reset del aviso previo
    expect(events[1]).toMatchObject({ kind: 'rate', rateLimitType: 'seven_day_opus', resetsAt: 1_800_000_000_000, sessionId: 's' });
  });

  it('tool end lleva isError cuando el tool_result es un error', async () => {
    mockQuery(async function* () {
      yield { type: 'assistant', parent_tool_use_id: null, message: { id: 'a', content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'x' } }] } };
      yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', is_error: true, content: 'falló' }] } };
      yield resultOk();
    });
    const ends = (await collect(new ClaudeAdapter().start(spec()))).filter((e) => e.type === 'tool' && e.status === 'end');
    expect(ends).toEqual([expect.objectContaining({ name: 'Bash', output: 'falló', isError: true })]);
  });
});

describe('ClaudeAdapter — skills del agente (D12)', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kiji-skillsrc-'));
    mkdirSync(join(tmp, 'marcador'));
    writeFileSync(join(tmp, 'marcador', 'SKILL.md'), '---\nname: marcador\ndescription: prueba\nallowed-tools: Bash(*)\nallowed_tools:\n  - Write\n---\nhola');
    writeFileSync(join(tmp, 'marcador', 'extra.md'), 'x');
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('monta un plugin local temporal con un enlace por skill, filtra con `skills` y lo borra al terminar', async () => {
    let seen: any;
    let pluginDir = '';
    const calls = mockQuery(async function* ({ options }) {
      pluginDir = options.plugins[0].path;
      seen = {
        manifest: JSON.parse(readFileSync(join(pluginDir, '.claude-plugin', 'plugin.json'), 'utf8')),
        skill: readFileSync(join(pluginDir, 'skills', 'marcador', 'SKILL.md'), 'utf8'),
        link: lstatSync(join(pluginDir, 'skills', 'marcador')).isSymbolicLink(),
        extra: lstatSync(join(pluginDir, 'skills', 'marcador', 'extra.md')).isSymbolicLink(),
      };
      yield resultOk();
    });
    await collect(new ClaudeAdapter().start(spec({ skills: [{ name: 'marcador', dir: join(tmp, 'marcador') }] })));
    expect(calls[0]!.options.plugins).toEqual([{ type: 'local', path: pluginDir }]);
    expect(calls[0]!.options.skills).toEqual(['kiji-skills:marcador']);
    expect(seen.manifest.name).toBe('kiji-skills');
    expect(seen.skill).toContain('name: marcador');
    expect(seen.skill).not.toMatch(/allowed/);
    expect(seen.skill).toContain('hola');
    expect(seen.link).toBe(false); // carpeta real con SKILL.md saneado
    expect(seen.extra).toBe(true); // el resto, enlazado
    expect(existsSync(pluginDir)).toBe(false); // limpiado
    expect(existsSync(join(tmp, 'marcador', 'SKILL.md'))).toBe(true); // lo original intacto
  });

  it('Skill se permite sin preguntar, también en solo lectura (que además la recibe en `tools`)', async () => {
    let decision: any;
    const calls = mockQuery(async function* ({ options }) {
      decision = await options.canUseTool('Skill', { skill: 'kiji-skills:marcador' }, ask());
      yield resultOk();
    });
    await collect(new ClaudeAdapter().start(spec({ readOnly: true, skills: [{ name: 'marcador', dir: join(tmp, 'marcador') }] })));
    expect(decision.behavior).toBe('allow');
    expect(calls[0]!.options.tools).toEqual(['Read', 'Glob', 'Grep', 'Skill']);
  });

  it('sin skills no se añade ni plugin ni filtro, y en solo lectura Skill sigue denegada', async () => {
    let decision: any;
    const calls = mockQuery(async function* ({ options }) {
      decision = await options.canUseTool('Skill', {}, ask());
      yield resultOk();
    });
    await collect(new ClaudeAdapter().start(spec({ readOnly: true })));
    expect(calls[0]!.options.plugins).toBeUndefined();
    expect(calls[0]!.options.skills).toBeUndefined();
    expect(calls[0]!.options.tools).toEqual(['Read', 'Glob', 'Grep']);
    expect(decision.behavior).toBe('deny');
  });

  it('plan B: si no se puede montar el plugin, nombre, descripción y ruta van al system prompt', async () => {
    const calls = mockQuery(async function* () {
      yield resultOk();
    });
    await collect(new ClaudeAdapter().start(spec({ skills: [{ name: 'mala/ruta', dir: tmp, description: 'una descripción' }] })));
    const opts = calls[0]!.options;
    expect(opts.plugins).toBeUndefined();
    expect(opts.skills).toBeUndefined();
    expect(opts.systemPrompt.append).toContain('mala/ruta: una descripción');
    expect(opts.systemPrompt.append).toContain(join(tmp, 'SKILL.md'));
    expect(opts.systemPrompt.append).toContain('lee su SKILL.md con Read');
  });
});
