// providers.test (con fetch y SDK simulados), settings (lista blanca) y project.update (rama inexistente).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../../src/db/db.js';
import { createOrchestrator, type Orchestrator } from '../../src/orchestrator/index.js';
import type { ProviderDeps } from '../../src/orchestrator/providers.js';
import { git, removeRepo } from '../git/helpers.js';
import { makeNodeRepo } from './helpers.js';

const OPENAI_KEY = 'sk-test-OPENAI-1234567890abcdefXYZ';
const GEMINI_KEY = 'AIzaSyGEMINI-1234567890abcdefXYZ';
const ANTHROPIC_KEY = 'sk-ant-test-ANTHROPIC-1234567890abcdef';
const ENV = { OPENAI_API_KEY: OPENAI_KEY, GEMINI_API_KEY: GEMINI_KEY, ANTHROPIC_API_KEY: ANTHROPIC_KEY };

function makeOrch(deps: ProviderDeps = {}): Orchestrator {
  return createOrchestrator({ db: openDb(':memory:'), emit: () => {}, providerDeps: { env: ENV, ...deps } });
}
const call = (o: Orchestrator, method: string, params?: unknown) => o.handlers[method]!(params) as Promise<any>;
const jsonRes = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const noKeyIn = (detail: string) => {
  for (const k of Object.values(ENV)) expect(detail).not.toContain(k);
  expect(detail).not.toMatch(/Bearer\s+\S{6,}/);
};

/** fetch que no contesta nunca: solo termina cuando salta la señal de tiempo máximo. */
const hangingFetch = vi.fn((_url: unknown, init?: RequestInit) =>
  new Promise<Response>((_res, rej) => init?.signal?.addEventListener('abort', () => rej(init.signal!.reason))),
);

/** Un `query` falso del SDK: el guion devuelve los mensajes que emitiría. */
function fakeQuery(messages: unknown[] | (() => never)) {
  const calls: any[] = [];
  const fn = vi.fn((params: any) => {
    calls.push(params);
    if (typeof messages === 'function') messages();
    const gen: any = (async function* () {
      for (const m of messages as unknown[]) yield m;
    })();
    gen.close = vi.fn();
    return gen;
  });
  return { fn: fn as any, calls };
}

describe('providers.test — claude (SDK simulado)', () => {
  it('KIJI_CLAUDE_PATH va a pathToClaudeCodeExecutable; versión antigua da aviso', async () => {
    const q = fakeQuery([{ type: 'result', subtype: 'success', is_error: false, result: 'ok' }]);
    const exec: any = (_f: string, _a: string[], _o: unknown, cb: any) => cb(null, '2.0.1 (Claude Code)\n', '');
    const r = await call(makeOrch({ query: q.fn, env: { ...ENV, KIJI_CLAUDE_PATH: '/x/claude' }, execFile: exec }), 'providers.test', { provider: 'claude' });
    expect(q.calls[0].options.pathToClaudeCodeExecutable).toBe('/x/claude');
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('claude update');
  });

  it('sin KIJI_CLAUDE_PATH no se fija la ruta', async () => {
    const q = fakeQuery([{ type: 'result', subtype: 'success', is_error: false, result: 'ok' }]);
    await call(makeOrch({ query: q.fn }), 'providers.test', { provider: 'claude' });
    expect(q.calls[0].options.pathToClaudeCodeExecutable).toBeUndefined();
  });

  it('SDK sin binario nativo: mensaje claro de instalación', async () => {
    const q = fakeQuery(() => {
      throw new Error('Native CLI binary for darwin-arm64 not found. Reinstall or set options.pathToClaudeCodeExecutable');
    });
    const r = await call(makeOrch({ query: q.fn }), 'providers.test', { provider: 'claude' });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('Claude Code no está instalado');
    expect(r.detail).toContain('install.ps1');
  });

  it('ok: una llamada mínima, haiku, 0.02 USD, sin herramientas', async () => {
    const q = fakeQuery([{ type: 'assistant' }, { type: 'result', subtype: 'success', is_error: false, result: 'ok', total_cost_usd: 0.0003 }]);
    const o = makeOrch({ query: q.fn });
    const r = await call(o, 'providers.test', { provider: 'claude' });
    expect(r).toMatchObject({ ok: true });
    expect(r.detail).toContain('"ok"');
    expect(q.calls).toHaveLength(1);
    const { prompt, options } = q.calls[0];
    expect(prompt).toBe('responde solo: ok');
    expect(options).toMatchObject({ model: 'haiku', maxBudgetUsd: 0.02, tools: [], maxTurns: 1, settingSources: [], persistSession: false });
    await expect(options.canUseTool('Bash', {}, {})).resolves.toMatchObject({ behavior: 'deny' });
  });

  it('error del SDK (401): ok=false y el detalle no contiene la clave aunque el SDK la repita', async () => {
    const q = fakeQuery([{ type: 'result', subtype: 'success', is_error: true, result: `Invalid API key ${ANTHROPIC_KEY} (401)`, errors: [`401 x-api-key: ${ANTHROPIC_KEY}`] }]);
    const r = await call(makeOrch({ query: q.fn }), 'providers.test', { provider: 'claude' });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('401');
    noKeyIn(r.detail);
  });

  it('el SDK lanza una excepción con la clave dentro: se oculta', async () => {
    const q = fakeQuery(() => {
      throw new Error(`spawn falló con ANTHROPIC_API_KEY=${ANTHROPIC_KEY}`);
    });
    const r = await call(makeOrch({ query: q.fn }), 'providers.test', { provider: 'claude' });
    expect(r.ok).toBe(false);
    noKeyIn(r.detail);
  });

  it('timeout: aborta y lo dice', async () => {
    const fn = vi.fn((params: any) => {
      const gen: any = (async function* () {
        await new Promise((_r, rej) => params.options.abortController.signal.addEventListener('abort', () => rej(new Error('aborted'))));
        yield undefined;
      })();
      gen.close = vi.fn();
      return gen;
    });
    const r = await call(makeOrch({ query: fn as any, claudeTimeoutMs: 20 }), 'providers.test', { provider: 'claude' });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/no respondió/);
  });
});

describe('providers.test — ollama', () => {
  it('ok: GET {ollama_url}/models y cuenta modelos', async () => {
    const f = vi.fn(async () => jsonRes(200, { data: [{ id: 'a' }, { id: 'b' }] }));
    const o = makeOrch({ fetch: f as any });
    const r = await call(o, 'providers.test', { provider: 'ollama' });
    expect(r).toEqual({ ok: true, detail: expect.stringContaining('2 modelos') });
    expect(f.mock.calls[0]![0]).toBe('http://localhost:11434/v1/models');
    // Ollama nunca recibe claves.
    expect(JSON.stringify(f.mock.calls[0]![1])).not.toMatch(/authorization/i);
  });

  it('usa la URL de los ajustes', async () => {
    const f = vi.fn(async () => jsonRes(200, { data: [] }));
    const o = makeOrch({ fetch: f as any });
    await call(o, 'settings.set', { key: 'ollama_url', value: 'http://192.168.1.5:11434/v1/' });
    await call(o, 'providers.test', { provider: 'ollama' });
    expect(f.mock.calls[0]![0]).toBe('http://192.168.1.5:11434/v1/models');
  });

  it('no instalado: error claro', async () => {
    const f = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const r = await call(makeOrch({ fetch: f as any }), 'providers.test', { provider: 'ollama' });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/Ollama no responde en http:\/\/localhost:11434\/v1.*instalado/);
  });

  it('timeout', async () => {
    const r = await call(makeOrch({ fetch: hangingFetch as any, ollamaTimeoutMs: 20 }), 'providers.test', { provider: 'ollama' });
    expect(r).toMatchObject({ ok: false });
    expect(r.detail).toMatch(/no respondió/);
  });

  it('HTTP 500', async () => {
    const r = await call(makeOrch({ fetch: (async () => jsonRes(500)) as any }), 'providers.test', { provider: 'ollama' });
    expect(r).toMatchObject({ ok: false, detail: expect.stringContaining('500') });
  });
});

describe.each([
  ['openai', 'https://api.openai.com/v1/models', OPENAI_KEY],
  ['gemini', 'https://generativelanguage.googleapis.com/v1beta/openai/models', GEMINI_KEY],
] as const)('providers.test — %s', (provider, url, key) => {
  it('ok: GET al endpoint fijo con la clave del entorno solo en la cabecera', async () => {
    const f = vi.fn(async () => jsonRes(200, { data: [{ id: 'm1' }] }));
    const r = await call(makeOrch({ fetch: f as any }), 'providers.test', { provider });
    expect(r.ok).toBe(true);
    expect(f.mock.calls[0]![0]).toBe(url);
    expect((f.mock.calls[0]![1] as any).headers.Authorization).toBe(`Bearer ${key}`);
    expect(String(f.mock.calls[0]![0])).not.toContain(key); // nunca en la URL
    noKeyIn(r.detail);
  });

  it('401: clave rechazada, sin la clave en el detalle', async () => {
    const f = vi.fn(async () => jsonRes(401, { error: { message: `Incorrect API key provided: ${key}` } }));
    const r = await call(makeOrch({ fetch: f as any }), 'providers.test', { provider });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('401');
    noKeyIn(r.detail);
  });

  it('timeout', async () => {
    const r = await call(makeOrch({ fetch: hangingFetch as any, apiTimeoutMs: 20 }), 'providers.test', { provider });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/no respondió/);
    noKeyIn(r.detail);
  });

  it('error de red cuyo mensaje contiene la clave: se oculta', async () => {
    const f = vi.fn(async () => {
      throw new Error(`connect ECONNREFUSED; headers: Authorization: Bearer ${key}`);
    });
    const r = await call(makeOrch({ fetch: f as any }), 'providers.test', { provider });
    expect(r.ok).toBe(false);
    noKeyIn(r.detail);
  });

  it('sin clave en el entorno: no llama a la red', async () => {
    const f = vi.fn();
    const r = await call(makeOrch({ fetch: f as any, env: {} }), 'providers.test', { provider });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/no hay clave/);
    expect(f).not.toHaveBeenCalled();
  });
});

describe('providers.test — validación', () => {
  it('proveedor desconocido o ausente', async () => {
    const o = makeOrch();
    await expect(call(o, 'providers.test', { provider: 'otro' })).rejects.toThrow(/desconocido/);
    await expect(call(o, 'providers.test', {})).rejects.toThrow(/provider/);
  });
});

describe('settings.get / settings.set', () => {
  it('solo acepta las claves de la lista blanca (nunca claves de API)', async () => {
    const o = makeOrch();
    for (const key of ['anthropic_api_key', 'ANTHROPIC_API_KEY', 'openai', '__proto__', 'constructor', '']) {
      await expect(call(o, 'settings.set', { key, value: 'x' })).rejects.toThrow();
      await expect(call(o, 'settings.get', { key })).rejects.toThrow();
    }
    expect(o.ctx.repos.settings.get('anthropic_api_key')).toBeUndefined();
  });

  it('guarda y lee ollama_url y default_budget_usd con validación', async () => {
    const o = makeOrch();
    expect(await call(o, 'settings.get', { key: 'ollama_url' })).toBeNull();
    expect(await call(o, 'settings.set', { key: 'ollama_url', value: ' http://localhost:11434/v1/ ' })).toEqual({ key: 'ollama_url', value: 'http://localhost:11434/v1' });
    expect(await call(o, 'settings.get', { key: 'ollama_url' })).toBe('http://localhost:11434/v1');
    await expect(call(o, 'settings.set', { key: 'ollama_url', value: 'file:///etc/passwd' })).rejects.toThrow(/http/);
    await expect(call(o, 'settings.set', { key: 'ollama_url', value: 'no es url' })).rejects.toThrow(/URL/);
    await expect(call(o, 'settings.set', { key: 'ollama_url', value: 'http://user:pass@host/v1' })).rejects.toThrow(/usuario/);
    await call(o, 'settings.set', { key: 'default_budget_usd', value: '1.5' });
    expect(await call(o, 'settings.get', { key: 'default_budget_usd' })).toBe('1.5');
    await expect(call(o, 'settings.set', { key: 'default_budget_usd', value: '-3' })).rejects.toThrow(/número/);
    await expect(call(o, 'settings.set', { key: 'default_budget_usd', value: 'abc' })).rejects.toThrow(/número/);
  });
});

describe('project.update', () => {
  let repo: string;
  let o: Orchestrator;
  beforeEach(async () => {
    repo = makeNodeRepo();
    o = makeOrch();
  });
  afterEach(async () => {
    await o.shutdown();
    removeRepo(repo);
  });

  it('sin proyecto abierto: error claro', async () => {
    await expect(call(o, 'project.update', { test_command: 'npm test' })).rejects.toThrow(/project\.open/);
  });

  it('rama base inexistente -> error y no cambia nada', async () => {
    const p = await call(o, 'project.open', { path: repo });
    await expect(call(o, 'project.update', { base_branch: 'no-existe' })).rejects.toThrow(/no existe/);
    expect(o.ctx.repos.projects.get(p.id)!.base_branch).toBe('main');
  });

  it('rechaza refs que git leería como opción, y etiquetas (solo ramas locales)', async () => {
    await call(o, 'project.open', { path: repo });
    git(repo, 'tag', 'v1');
    await expect(call(o, 'project.update', { base_branch: '--upload-pack=x' })).rejects.toThrow(/no válido/);
    await expect(call(o, 'project.update', { base_branch: 'v1' })).rejects.toThrow(/no existe/);
  });

  it('rama existente y comando de tests: se guardan (vacío = sin comando)', async () => {
    const p = await call(o, 'project.open', { path: repo });
    git(repo, 'branch', 'develop');
    const u = await call(o, 'project.update', { base_branch: 'develop', test_command: ' npm run check ' });
    expect(u).toMatchObject({ id: p.id, base_branch: 'develop', test_command: 'npm run check' });
    expect(o.ctx.repos.projects.get(p.id)).toMatchObject({ base_branch: 'develop', test_command: 'npm run check' });
    expect(await call(o, 'project.get')).toMatchObject({ base_branch: 'develop' });
    expect(await call(o, 'project.update', { test_command: '' })).toMatchObject({ test_command: null, base_branch: 'develop' });
  });

  it('exige algún campo y un comando de una sola línea', async () => {
    await call(o, 'project.open', { path: repo });
    await expect(call(o, 'project.update', {})).rejects.toThrow(/indica/);
    await expect(call(o, 'project.update', { test_command: 'a\nb' })).rejects.toThrow(/una sola línea/);
    await expect(call(o, 'project.update', { test_command: 5 })).rejects.toThrow(/texto/);
  });
});
