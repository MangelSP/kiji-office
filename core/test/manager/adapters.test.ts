// Herramientas propias en los adaptadores: Claude (servidores MCP del RunSpec, nada más) y api-loop (extraTools).
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));

import { query } from '@anthropic-ai/claude-agent-sdk';
import { ApiLoopAdapter } from '../../src/adapters/apiLoop.js';
import { ClaudeAdapter } from '../../src/adapters/claude.js';
import type { AgentEvent, ExtraTool, RunSpec } from '../../src/adapters/types.js';

const spec = (over: Partial<RunSpec> = {}): RunSpec => ({
  runId: 'r', cwd: '/work/repo', model: 'haiku', systemPrompt: 'Eres el gerente.', prompt: 'hola', allowedPaths: [], readOnly: true, budgetUsd: 0.05, ...over,
});
async function collect(it: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe('ClaudeAdapter con mcpServers del RunSpec', () => {
  beforeEach(() => vi.mocked(query).mockReset());

  async function run(over: Partial<RunSpec>, tools: Array<[string, any]>) {
    let options: any;
    const decisions: any[] = [];
    vi.mocked(query).mockImplementation(((params: any) => {
      if (!params) return undefined as never; // vitest llama a la implementación una segunda vez sin argumentos
      options = params.options;
      const gen: any = (async function* () {
        for (const [name, input] of tools) {
          decisions.push(await Promise.race([options.canUseTool(name, input, { signal: new AbortController().signal, toolUseID: name, requestId: 'r' }), new Promise((r) => setTimeout(() => r('pending'), 20))]));
        }
        yield { type: 'result', subtype: 'success', is_error: false, result: 'ok', total_cost_usd: 0, usage: {}, session_id: 's' };
      })();
      gen.close = vi.fn();
      return gen;
    }) as any);
    await collect(new ClaudeAdapter().start(spec(over)));
    return { options, decisions };
  }

  it('sin mcpServers: sigue sin ninguno y strictMcpConfig; las herramientas MCP no se permiten', async () => {
    const { options, decisions } = await run({}, [['mcp__kiji__done', {}]]);
    expect(options.mcpServers).toEqual({});
    expect(options.strictMcpConfig).toBe(true);
    expect(decisions[0].behavior).toBe('deny'); // de solo lectura: ni siquiera pregunta
  });

  it('solo pasa el servidor del core y permite únicamente mcp__kiji__* (más Read/Glob/Grep)', async () => {
    const server = { type: 'sdk', name: 'kiji', instance: {} };
    const { options, decisions } = await run({ mcpServers: { kiji: server } }, [
      ['mcp__kiji__get_state', {}],
      ['mcp__otro__lo_que_sea', {}],
      ['mcp__kijix__get_state', {}],
      ['Bash', { command: 'ls' }],
      ['Write', { file_path: '/work/repo/a.ts' }],
      ['Read', { file_path: '/work/repo/a.ts' }],
    ]);
    expect(options.mcpServers).toEqual({ kiji: server });
    expect(options.strictMcpConfig).toBe(true);
    expect(options.tools).toEqual(['Read', 'Glob', 'Grep']);
    expect(decisions.map((d) => d.behavior)).toEqual(['allow', 'deny', 'deny', 'deny', 'deny', 'allow']);
  });
});

describe('ApiLoopAdapter con extraTools', () => {
  const sse = (...chunks: object[]) => new Response([...chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`), 'data: [DONE]\n\n'].join(''), { headers: { 'content-type': 'text/event-stream' } });

  it('ofrece las tools propias junto a las de lectura, las ejecuta y devuelve su salida al modelo', async () => {
    const calls: unknown[] = [];
    const tool: ExtraTool = {
      name: 'get_state', description: 'estado', parameters: { type: 'object', properties: {} },
      execute: async (args) => { calls.push(args); return { output: '{"ok":true,"tasks":3}', isError: false }; },
    };
    const bodies: any[] = [];
    let n = 0;
    const fetchFn = (async (_url: string, init: any) => {
      bodies.push(JSON.parse(init.body));
      return n++ === 0
        ? sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'get_state', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] })
        : sse({ choices: [{ delta: { content: 'hecho' }, finish_reason: 'stop' }] });
    }) as unknown as typeof fetch;
    const adapter = new ApiLoopAdapter({ baseUrl: 'http://x/v1', auth: 'none', model: 'm', contextWindow: 100_000, toolQuality: 'ok', fetch: fetchFn });
    const events = await collect(adapter.start(spec({ extraTools: [tool, { ...tool, name: 'read_file' }] })));
    const names = bodies[0].tools.map((t: any) => t.function.name);
    expect(names).toEqual(['read_file', 'list_dir', 'grep', 'get_state']); // readOnly: sin escritura; la propia no pisa a read_file
    expect(calls).toEqual([{}]);
    expect(bodies[1].messages.at(-1)).toMatchObject({ role: 'tool', content: '{"ok":true,"tasks":3}' });
    expect(events.find((e) => e.type === 'tool' && e.status === 'end')).toMatchObject({ name: 'get_state', isError: false });
    expect(events.at(-1)).toMatchObject({ type: 'done', text: 'hecho' });
  });
});
