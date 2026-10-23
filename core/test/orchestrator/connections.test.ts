// Conexiones (0.2b): repos, secretos, presets, URL, prueba en tres pasos, descubrimiento y agentes con conexión.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiLoopAdapter } from '../../src/adapters/apiLoop.js';
import { ClaudeAdapter } from '../../src/adapters/claude.js';
import { missingAccounts } from '../../src/orchestrator/secrets.js';
import { validateBaseUrl, makeAdapterFactory, classifyPing } from '../../src/orchestrator/connections.js';
import { makeHarness, makeNodeRepo, type Harness } from './helpers.js';
import { removeRepo } from '../git/helpers.js';

const KEY = 'sk-SECRETVALUE1234567890abcdef';
let h: Harness;
const servers: Server[] = [];
afterEach(async () => {
  await h?.orch.shutdown();
  for (const s of servers.splice(0)) s.close();
});

type Mode = 'ok' | 'weak' | 'none' | '401' | 'echo-key';
/** Servidor falso OpenAI-compatible en un puerto efímero. */
async function fake(mode: Mode = 'ok', models = ['m1', 'm2']): Promise<{ url: string; auths: string[] }> {
  const auths: string[] = [];
  const srv = createServer((req, res) => {
    auths.push(String(req.headers.authorization ?? req.headers['x-api-key'] ?? ''));
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const send = (code: number, j: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
      if (mode === '401') return send(401, { error: { message: 'bad key' } });
      if (mode === 'echo-key') return send(401, { error: { message: `invalid ${req.headers.authorization}` } });
      if (req.url!.endsWith('/models')) return send(200, { data: models.map((id) => ({ id, context_length: 8192 })) });
      const j = JSON.parse(body);
      if (j.tools) {
        if (mode === 'ok') return send(200, { choices: [{ message: { content: null, tool_calls: [{ function: { name: 'kiji_ping', arguments: '{"n":7}' } }] } }] });
        if (mode === 'weak') return send(200, { choices: [{ message: { content: '{"name":"kiji_ping","arguments":{"n":7}}' } }] });
        return send(200, { choices: [{ message: { content: 'no sé' } }] });
      }
      send(200, { choices: [{ message: { content: 'ok' } }] });
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  servers.push(srv);
  return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1`, auths };
}

describe('validateBaseUrl', () => {
  it('http solo en localhost / loopback / LAN; https para el resto', () => {
    for (const u of ['http://localhost:1234/v1', 'http://127.0.0.1:8080/v1/', 'http://[::1]:11434/v1', 'http://192.168.1.5/v1', 'http://10.0.0.2/v1', 'http://172.20.0.1/v1', 'https://api.groq.com/openai/v1']) {
      expect(() => validateBaseUrl(u)).not.toThrow();
    }
    expect(validateBaseUrl('http://localhost:1234/v1/')).toBe('http://localhost:1234/v1');
    for (const u of ['http://api.example.com/v1', 'http://172.32.0.1/v1', 'http://8.8.8.8/v1', 'ftp://x/v1', 'https://u:p@x.com/v1', 'nada', 'https://x.com/v1?k=1']) {
      expect(() => validateBaseUrl(u), u).toThrow();
    }
  });
});

describe('classifyPing', () => {
  it('ok / weak / none', () => {
    expect(classifyPing({ choices: [{ message: { tool_calls: [{ function: { name: 'kiji_ping', arguments: '{"n":7}' } }] } }] })).toBe('ok');
    expect(classifyPing({ choices: [{ message: { content: 'kiji_ping {"n":7}' } }] })).toBe('weak');
    expect(classifyPing({ choices: [{ message: { content: 'hola' } }] })).toBe('none');
  });
});

describe('connection.* y secretos', () => {
  it('crea con preset, lista sin clave, actualiza y borra (bloqueado si la usa un agente)', async () => {
    h = makeHarness();
    const c = await h.call('connection.create', { name: 'Mi LM Studio', preset: 'lmstudio' });
    expect(c).toMatchObject({ baseUrl: 'http://localhost:1234/v1', auth: 'none', hasSecret: false, contextWindow: 32768, toolQuality: 'unknown', agents: [], prices: {} });
    expect(h.emitted.some((e) => e.name === 'connections.changed')).toBe(true);
    expect(h.emitted.some((e) => e.name === 'secrets.request')).toBe(false); // auth none
    await expect(h.call('connection.create', { name: 'x', preset: 'custom' })).rejects.toThrow(/baseUrl/);
    await expect(h.call('connection.create', { name: 'x', preset: 'custom', baseUrl: 'http://evil.com/v1' })).rejects.toThrow(/https/);
    const u = await h.call('connection.update', { id: c.id, name: 'Otro', prices: { m: { in: 1, out: 2 } }, contextWindow: 65536 });
    expect(u).toMatchObject({ name: 'Otro', contextWindow: 65536, prices: { m: { in: 1, out: 2 } } });
    await expect(h.call('connection.update', { id: c.id, prices: { m: { in: -1, out: 2 } } })).rejects.toThrow();

    const repo = makeNodeRepo();
    try {
      await h.call('project.open', { path: repo });
      const a = await h.call('agent.create', { name: 'Loco', provider: 'api', connectionId: c.id, model: 'qwen' });
      expect((await h.call('connection.list'))[0].agents).toEqual(['Loco']);
      await expect(h.call('connection.delete', { id: c.id })).rejects.toThrow(/Loco/);
      await h.call('agent.update', { agentId: a.id, connectionId: null });
      await expect(h.call('connection.delete', { id: c.id })).resolves.toBe(true);
      expect(await h.call('connection.list')).toEqual([]);
    } finally {
      removeRepo(repo);
    }
  });

  it('secrets.put solo con id rust:*; nunca devuelve ni emite el valor', async () => {
    h = makeHarness();
    const c = await h.call('connection.create', { name: 'Groq', preset: 'groq' });
    expect(h.emitted.find((e) => e.name === 'secrets.request')!.payload).toEqual({ accounts: [`conn:${c.id}`] });
    const params = { account: `conn:${c.id}`, value: KEY };
    await expect(h.call('secrets.put', params)).rejects.toThrow(/nativo/);
    await expect(h.call('secrets.put', params, 'ui:rust:1')).rejects.toThrow();
    expect(h.orch.ctx.secrets.size).toBe(0);
    const res = await h.call('secrets.put', params, 'rust:1');
    expect(res).toBe(true);
    expect(h.orch.ctx.secrets.get(`conn:${c.id}`)).toBe(KEY);
    await expect(h.call('secrets.put', { account: 'conn:no', value: KEY }, 'rust:2')).rejects.toThrow();
    await expect(h.call('secrets.put', { account: `conn:${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}`, value: KEY }, 'rust:3')).rejects.toThrow(/no existe/);

    const view = await h.call('connection.list');
    expect(view[0].hasSecret).toBe(true);
    const everything = JSON.stringify([view, h.emitted, await h.call('providers.status'), await h.call('providers.test', { provider: 'ollama' })]);
    expect(everything).not.toContain(KEY);
    expect(everything).not.toContain('SECRETVALUE');
  });

  it('secrets.put con value null o "" borra la clave, has_secret=0 y emite connections.changed', async () => {
    h = makeHarness();
    const c = await h.call('connection.create', { name: 'Groq', preset: 'groq' });
    const account = `conn:${c.id}`;
    for (const empty of [null, '']) {
      await h.call('secrets.put', { account, value: KEY }, 'rust:1');
      expect(h.orch.ctx.secrets.get(account)).toBe(KEY);
      expect((await h.call('connection.list'))[0].hasSecret).toBe(true);
      const before = h.emitted.filter((e) => e.name === 'connections.changed').length;
      await h.call('secrets.put', { account, value: empty }, 'rust:2');
      expect(h.orch.ctx.secrets.has(account)).toBe(false);
      expect((await h.call('connection.list'))[0].hasSecret).toBe(false);
      expect(h.emitted.filter((e) => e.name === 'connections.changed').length).toBeGreaterThan(before);
    }
    await expect(h.call('secrets.put', { account, value: 5 }, 'rust:3')).rejects.toThrow(/texto/);
  });

  it('missingAccounts pide toda conexión con auth != none sin valor en memoria, aunque has_secret sea 0', async () => {
    h = makeHarness();
    const a = await h.call('connection.create', { name: 'Groq', preset: 'groq' });
    const n = await h.call('connection.create', { name: 'Local', preset: 'ollama' });
    expect(a.hasSecret).toBe(false);
    expect(missingAccounts(h.orch.ctx)).toEqual([`conn:${a.id}`]);
    expect(missingAccounts(h.orch.ctx)).not.toContain(`conn:${n.id}`);
    await h.call('secrets.put', { account: `conn:${a.id}`, value: KEY }, 'rust:1');
    expect(missingAccounts(h.orch.ctx)).toEqual([]);
    expect((await h.call('connection.list')).find((x: any) => x.id === a.id).hasSecret).toBe(true);
  });

  it('crea openai/gemini automáticamente si existe la variable de entorno (una sola vez) y resuelve el alias', async () => {
    const f = await fake();
    const env = { OPENAI_API_KEY: KEY } as NodeJS.ProcessEnv;
    const dbPath = ':memory:';
    h = makeHarness({ dbPath, providerDeps: { env, fetch: (async () => { throw new Error('x'); }) as never, homeDir: '/nonexistent' } });
    const list = await h.call('connection.list');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ preset: 'openai', hasSecret: true, auth: 'bearer', baseUrl: 'https://api.openai.com/v1' });
    expect(JSON.stringify(list)).not.toContain(KEY);
    // el secreto se resuelve por el alias `openai`, sin copiarlo a conn:<id>
    expect(h.orch.ctx.secrets.has(`conn:${list[0].id}`)).toBe(false);
    expect(h.orch.ctx.secrets.get('openai')).toBe(KEY);
    // un servidor propio con preset openai y otra URL NO recibe la clave del alias
    const other = await h.call('connection.create', { name: 'Falsa', preset: 'openai', baseUrl: f.url });
    const t = await h.call('connection.test', { id: other.id });
    expect(t.ok).toBe(false);
    expect(f.auths).toEqual([]);
    // no se pide al llavero la cuenta de un alias
    h.orch.requestSecrets();
    expect(h.emitted.filter((e) => e.name === 'secrets.request').flatMap((e) => e.payload.accounts)).not.toContain(`conn:${list[0].id}`);
  });

  it('no recrea la conexión automática tras borrarla', async () => {
    const env = { GEMINI_API_KEY: KEY } as NodeJS.ProcessEnv;
    const os = await import('node:os');
    const path = await import('node:path');
    const fs = await import('node:fs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiji-conn-'));
    try {
      const deps = { env, fetch: (async () => { throw new Error('x'); }) as never, homeDir: '/nonexistent' };
      h = makeHarness({ dbPath: path.join(dir, 'a.db'), providerDeps: deps });
      const [c] = await h.call('connection.list');
      expect(c.preset).toBe('gemini');
      await h.call('connection.delete', { id: c.id });
      await h.orch.shutdown();
      h.orch.ctx.db.close();
      h = makeHarness({ dbPath: path.join(dir, 'a.db'), providerDeps: deps });
      expect(await h.call('connection.list')).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('requestSecrets pide las cuentas conn:* con clave que faltan en memoria', async () => {
    h = makeHarness();
    const c = h.orch.ctx.repos.connections.create({ name: 'N', preset: 'groq', baseUrl: 'https://api.groq.com/openai/v1', auth: 'bearer', hasSecret: true });
    h.orch.requestSecrets();
    expect(h.emitted.filter((e) => e.name === 'secrets.request').pop()!.payload).toEqual({ accounts: [`conn:${c.id}`] });
  });
});

describe('connection.test / models', () => {
  const mk = async (url: string, auth: 'none' | 'bearer' = 'none') => {
    h = makeHarness();
    return h.call('connection.create', { name: 'F', preset: 'custom', baseUrl: url, auth, defaultModel: 'm1' });
  };

  it('ok: tres pasos, tool_quality ok, guarda el resultado y ajusta el contexto', async () => {
    const f = await fake('ok');
    const c = await mk(f.url);
    const t = await h.call('connection.test', { id: c.id });
    expect(t).toMatchObject({ ok: true, toolQuality: 'ok', models: ['m1', 'm2'] });
    expect(t.steps.map((s: any) => [s.name, s.ok])).toEqual([['models', true], ['chat', true], ['tools', true]]);
    expect(typeof t.latencyMs).toBe('number');
    expect(await h.call('connection.list')).toEqual([expect.objectContaining({ toolQuality: 'ok', lastTestOk: true, contextWindow: 8192 })]);
    expect(await h.call('connection.models', { id: c.id })).toEqual(['m1', 'm2']);
  });

  it('weak y none', async () => {
    for (const mode of ['weak', 'none'] as const) {
      const c = await mk((await fake(mode)).url);
      const t = await h.call('connection.test', { id: c.id });
      expect(t.toolQuality).toBe(mode);
      expect(t.ok).toBe(true);
    }
  });

  it('401: falla en models, sin chat, y no filtra la clave aunque el servidor la repita', async () => {
    const f = await fake('echo-key');
    const c = await mk(f.url, 'bearer');
    await h.call('secrets.put', { account: `conn:${c.id}`, value: KEY }, 'rust:1');
    const t = await h.call('connection.test', { id: c.id });
    expect(t.ok).toBe(false);
    expect(t.steps).toHaveLength(1);
    expect(t.detail).toMatch(/rechaz/);
    expect(JSON.stringify([t, h.emitted])).not.toContain(KEY);
    expect(f.auths[0]).toBe(`Bearer ${KEY}`);
    expect(await h.call('connection.list')).toEqual([expect.objectContaining({ lastTestOk: false })]);
  });

  it('sin clave guardada: mensaje claro y sin red', async () => {
    const f = await fake();
    const c = await mk(f.url, 'bearer');
    const t = await h.call('connection.test', { id: c.id });
    expect(t).toMatchObject({ ok: false });
    expect(f.auths).toEqual([]);
  });

  it('servidor caído: mensaje legible', async () => {
    const f = await fake();
    servers.pop()!.close();
    const c = await mk(f.url);
    const t = await h.call('connection.test', { id: c.id });
    expect(t.ok).toBe(false);
    expect(t.detail).toMatch(/no se pudo conectar|no está en marcha/);
  });

  it('redirect se rechaza', async () => {
    const srv = createServer((_q, res) => { res.writeHead(302, { location: 'http://127.0.0.1:1/' }); res.end(); });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    servers.push(srv);
    const c = await mk(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1`);
    const t = await h.call('connection.test', { id: c.id });
    expect(t.ok).toBe(false);
  });
});

describe('connections.discover', () => {
  it('encuentra el servidor, marca alreadyConnected e installedNotRunning', async () => {
    const f = await fake('ok', ['a', 'b', 'c']);
    h = makeHarness({
      connectionDeps: {
        discoverTargets: [{ preset: 'lmstudio', baseUrl: f.url }, { preset: 'ollama', baseUrl: 'http://127.0.0.1:1/v1' }, { preset: 'vllm', baseUrl: 'http://127.0.0.1:2/v1' }],
        detectInstalled: (p) => p === 'ollama',
      },
    });
    const t0 = Date.now();
    let found = await h.call('connections.discover');
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(found).toEqual([
      { preset: 'lmstudio', baseUrl: f.url, models: ['a', 'b', 'c'], alreadyConnected: false },
      { preset: 'ollama', baseUrl: 'http://127.0.0.1:1/v1', models: [], alreadyConnected: false, installedNotRunning: true },
    ]);
    await h.call('connection.create', { name: 'L', preset: 'lmstudio', baseUrl: f.url });
    found = await h.call('connections.discover');
    expect(found[0].alreadyConnected).toBe(true);
  });
});

describe('agentes con conexión', () => {
  it('create/update con modelo libre validado contra la lista, aviso si no responde, adapterFactory', async () => {
    const f = await fake('ok', ['qwen', 'llama']);
    const repo = makeNodeRepo();
    h = makeHarness();
    try {
      await h.call('project.open', { path: repo });
      const c = await h.call('connection.create', { name: 'F', preset: 'custom', baseUrl: f.url, auth: 'none', defaultModel: 'llama' });
      const a = await h.call('agent.create', { name: 'Local', provider: 'api', connectionId: c.id, model: 'qwen' });
      expect(a).toMatchObject({ provider: 'api', connection_id: c.id, model: 'qwen', relay_order: [] });
      expect(a.warning).toBeUndefined();
      expect((await h.call('agent.create', { name: 'L2', provider: 'claude', connectionId: c.id })).model).toBe('llama'); // el de la conexión
      await expect(h.call('agent.create', { name: 'L3', provider: 'api', connectionId: c.id, model: 'nope' })).rejects.toThrow(/no está/);
      await expect(h.call('agent.create', { name: 'L4', provider: 'api' })).rejects.toThrow(/connectionId/);
      await expect(h.call('agent.create', { name: 'L5', provider: 'api', connectionId: 'zz', model: 'x' })).rejects.toThrow(/no existe/);

      const dead = await h.call('connection.create', { name: 'Muerta', preset: 'custom', baseUrl: 'http://127.0.0.1:1/v1', auth: 'none' });
      const w = await h.call('agent.update', { agentId: a.id, connectionId: dead.id, model: 'lo-que-sea' });
      expect(w).toMatchObject({ connection_id: dead.id, model: 'lo-que-sea' });
      expect(w.warning).toMatch(/No se pudo comprobar/);

      // vuelta a Claude: alias obligatorio
      await expect(h.call('agent.update', { agentId: a.id, connectionId: null, model: 'qwen' })).rejects.toThrow(/no válido/);
      expect(await h.call('agent.update', { agentId: a.id, connectionId: null })).toMatchObject({ provider: 'claude', connection_id: null, model: 'sonnet' });
      // un agente de Claude no admite un modelo libre
      await expect(h.call('agent.update', { agentId: a.id, model: 'qwen' })).rejects.toThrow(/no válido/);

      // relay_order: alias o conn:<id>/<modelo> existente
      await expect(h.call('agent.update', { agentId: a.id, relayOrder: ['conn:nada/x'] })).rejects.toThrow();
      await expect(h.call('agent.update', { agentId: a.id, relayOrder: [`conn:${'1'.repeat(8)}-1111-1111-1111-${'1'.repeat(12)}/x`] })).rejects.toThrow(/no existe/);
      const ok = await h.call('agent.update', { agentId: a.id, relayOrder: ['haiku', `conn:${c.id}/qwen`] });
      expect(ok.relay_order).toEqual(['haiku', `conn:${c.id}/qwen`]);
    } finally {
      removeRepo(repo);
    }
  });

  it('un agente con conexión arranca con modelo libre; run.model = conn:<id>/<modelo>; tool_quality none solo consultas', async () => {
    const repo = makeNodeRepo();
    h = makeHarness();
    try {
      await h.call('project.open', { path: repo });
      const c = h.orch.ctx.repos.connections.create({ name: 'F', preset: 'custom', baseUrl: 'http://127.0.0.1:1/v1', auth: 'none', defaultModel: 'qwen' });
      const a = await h.call('agent.create', { name: 'Local', provider: 'api', connectionId: c.id, model: 'qwen' });
      const t = await h.call('task.create', { title: 'Haz algo', description: 'Haz algo con a.ts', files: ['src/a.ts'], agent_id: a.id });
      h.orch.ctx.repos.connections.update(c.id, { tool_quality: 'none' });
      await expect(h.call('task.start', { id: t.id })).rejects.toThrow(/solo sirve para consultas/);
      h.orch.ctx.repos.connections.update(c.id, { tool_quality: 'ok', context_window: 12345 });
      await h.call('task.start', { id: t.id });
      expect(h.factoryAgents.at(-1)).toMatchObject({ connection_id: c.id, model: 'qwen', provider: 'api' });
      await h.waitFor(() => h.adapters[0]!.spec !== null, 'spec');
      expect(h.adapters[0]!.spec!.model).toBe('qwen');
      const run = h.orch.ctx.repos.runs.listByTask(t.id)[0]!;
      expect(run).toMatchObject({ model: `conn:${c.id}/qwen`, context_window: 12345 });
    } finally {
      removeRepo(repo);
    }
  });

  it('makeAdapterFactory: Claude sin conexión; ApiLoopAdapter con ella (y exige clave)', async () => {
    h = makeHarness();
    const ctx = h.orch.ctx;
    const f = makeAdapterFactory(ctx);
    const none = ctx.repos.connections.create({ name: 'L', preset: 'ollama', baseUrl: 'http://localhost:11434/v1', auth: 'none' });
    const key = ctx.repos.connections.create({ name: 'G', preset: 'groq', baseUrl: 'https://api.groq.com/openai/v1', auth: 'bearer', hasSecret: true });
    const base = { id: 'a', project_id: 'p', name: 'x', provider: 'api', model: 'm', connection_id: none.id } as never;
    expect(f({ ...(base as object), provider: 'claude', connection_id: null } as never)).toBeInstanceOf(ClaudeAdapter);
    expect(f(base)).toBeInstanceOf(ApiLoopAdapter);
    expect(() => f({ ...(base as object), connection_id: key.id } as never)).toThrow(/falta la clave/);
    ctx.secrets.set(`conn:${key.id}`, KEY);
    expect(f({ ...(base as object), connection_id: key.id } as never)).toBeInstanceOf(ApiLoopAdapter);
  });

  it('providers.status trae una tarjeta conn:<id> por conexión', async () => {
    h = makeHarness();
    const ctx = h.orch.ctx;
    const c = ctx.repos.connections.create({ name: 'L', preset: 'ollama', baseUrl: 'http://localhost:11434/v1', auth: 'none' });
    const card = () => h.call('providers.status').then((l: any[]) => l.find((x) => x.id === `conn:${c.id}`));
    expect(await card()).toMatchObject({ label: 'L', configured: true, state: 'unknown' });
    ctx.repos.connections.update(c.id, { last_test_ok: 1, last_test_at: 1 });
    expect((await card()).state).toBe('ok');
    ctx.repos.connections.update(c.id, { last_test_ok: 0 });
    expect((await card()).state).toBe('off');
  });
});
