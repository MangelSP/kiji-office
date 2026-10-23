// Cupo (D9): ctx.limits por rateLimitType, copia en settings, limits.changed y providers.status.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProviderStatus } from '../../../shared/protocol.js';
import { removeRepo } from '../git/helpers.js';
import { limitedUntilOf, modelLimitedUntil, recordRate, windowTypeOf } from '../../src/orchestrator/quota.js';
import { makeHarness, makeNodeRepo, type Harness } from './helpers.js';

let repo: string;
let h: Harness;
const tmps: string[] = [];
beforeEach(() => {
  repo = makeNodeRepo();
  h = undefined as unknown as Harness; // cada test crea el suyo (los puros no necesitan ninguno)
});
afterEach(async () => {
  await h?.orch.shutdown();
  removeRepo(repo);
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

const SECRET = 'sk-test-SUPERSECRETVALUE1234567890';
const mkFetch = (ok: boolean, calls: string[] = []) =>
  (async (url: string) => {
    calls.push(String(url));
    if (!ok) throw new Error('ECONNREFUSED');
    return { ok: true, status: 200, json: async () => ({ data: [] }) };
  }) as unknown as typeof fetch;
const status = async (): Promise<ProviderStatus[]> => h.call('providers.status');
const claude = async () => (await status()).find((p) => p.id === 'claude')!;
const limitsEvents = () => h.emitted.filter((e) => e.name === 'limits.changed');
const inFuture = (ms: number) => Date.now() + ms;

describe('windowTypeOf / limitedUntilOf', () => {
  it('normaliza el tipo del SDK; overage no es una ventana', () => {
    expect(windowTypeOf('five_hour')).toBe('five_hour');
    expect(windowTypeOf('seven_day_sonnet')).toBe('seven_day_sonnet');
    expect(windowTypeOf('seven_day_overage_included')).toBe('other');
    expect(windowTypeOf(undefined)).toBe('other');
    expect(windowTypeOf('overage')).toBeNull();
  });
  it('una ventana rejected sin hora de reset dura 5 min desde que se vio', () => {
    const w = { type: 'other', status: 'rejected', utilization: null, resetsAt: null, seenAt: 1000 } as const;
    expect(limitedUntilOf(w, 1000 + 60_000)).toBe(1000 + 5 * 60_000);
    expect(limitedUntilOf(w, 1000 + 6 * 60_000)).toBeNull();
    expect(limitedUntilOf({ ...w, status: 'allowed' }, 2000)).toBeNull();
  });
});

describe('providers.status', () => {
  it('claude sin datos de cupo: unknown, sin ventanas, con sus tres modelos', async () => {
    const home = mkdtempSync(join(tmpdir(), 'kiji-home-'));
    tmps.push(home);
    h = makeHarness({ providerDeps: { fetch: mkFetch(false), env: {}, homeDir: home } });
    await h.call('project.open', { path: repo });
    const c = await claude();
    expect(c).toMatchObject({ id: 'claude', label: 'Claude', configured: false, state: 'off', windows: [] }); // ni clave ni ~/.claude
    expect(c.models.map((m) => m.model)).toEqual(['opus', 'sonnet', 'haiku']);
    const agents = await h.call('agent.list');
    const idOf = (name: string) => agents.find((a: any) => a.name === name).id;
    // `agents` lleva ids de agente (la UI los traduce a nombres)
    expect(c.models.find((m) => m.model === 'opus')!.agents).toEqual([idOf('Jefe')]);
    expect(c.models.find((m) => m.model === 'sonnet')!.agents).toEqual([idOf('Clau')]);
    expect(c.models.every((m) => m.liveRuns === 0 && m.costTodayUsd === 0 && m.limitedUntil === null)).toBe(true);
  });

  it('claude configurado por clave o por ~/.claude; estados unknown / ok / warning / limited', async () => {
    h = makeHarness({ providerDeps: { fetch: mkFetch(false), env: { ANTHROPIC_API_KEY: SECRET }, homeDir: '/nonexistent' } });
    await h.call('project.open', { path: repo });
    const ctx = h.orch.ctx;
    expect(await claude()).toMatchObject({ configured: true, state: 'unknown', windows: [] });

    recordRate(ctx, { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.3, resetsAt: inFuture(3600_000) });
    expect(await claude()).toMatchObject({ state: 'ok' });
    recordRate(ctx, { status: 'allowed', rateLimitType: 'seven_day', utilization: 0.8, resetsAt: inFuture(3600_000) });
    expect(await claude()).toMatchObject({ state: 'warning' }); // utilization >= 0.8
    recordRate(ctx, { status: 'allowed', rateLimitType: 'seven_day', utilization: 0.1, resetsAt: inFuture(3600_000) });
    recordRate(ctx, { status: 'allowed_warning', rateLimitType: 'seven_day_sonnet', resetsAt: inFuture(3600_000) });
    expect(await claude()).toMatchObject({ state: 'warning' });
    const reset = inFuture(7200_000);
    recordRate(ctx, { status: 'rejected', rateLimitType: 'seven_day_opus', resetsAt: reset });
    const c = await claude();
    expect(c.state).toBe('limited');
    expect(c.windows.map((w) => w.type)).toEqual(['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet']);
    expect(c.windows.find((w) => w.type === 'seven_day_opus')).toMatchObject({ status: 'rejected', utilization: null, resetsAt: reset });
    // limitedUntil: solo el modelo afectado
    expect(c.models.find((m) => m.model === 'opus')!.limitedUntil).toBe(reset);
    expect(c.models.find((m) => m.model === 'sonnet')!.limitedUntil).toBeNull();
    // un límite de toda la cuenta afecta a todos
    recordRate(ctx, { status: 'rejected', rateLimitType: 'five_hour', resetsAt: inFuture(1800_000) });
    expect(modelLimitedUntil(ctx, 'haiku')).not.toBeNull();
    expect((await claude()).models.every((m) => m.limitedUntil !== null)).toBe(true);
  });

  it('una ventana cuyo reset ya pasó desaparece y deja de limitar', async () => {
    h = makeHarness();
    await h.call('project.open', { path: repo });
    recordRate(h.orch.ctx, { status: 'rejected', rateLimitType: 'five_hour', resetsAt: Date.now() - 1000 });
    const c = await claude();
    expect(c.windows).toEqual([]);
    expect(c.models.every((m) => m.limitedUntil === null)).toBe(true);
  });

  it('ollama: configured si responde; el sondeo se cachea 30 s', async () => {
    const calls: string[] = [];
    h = makeHarness({ providerDeps: { fetch: mkFetch(true, calls), env: {}, homeDir: '/nonexistent' } });
    expect((await status()).find((p) => p.id === 'ollama')).toMatchObject({ configured: true, state: 'ok', windows: [], models: [] });
    await status();
    await status();
    expect(calls).toEqual(['http://localhost:11434/v1/models']);

    // caído: configured false, y también cacheado
    const down: string[] = [];
    await h.orch.shutdown();
    h = makeHarness({ providerDeps: { fetch: mkFetch(false, down), env: {}, homeDir: '/nonexistent' } });
    expect((await status()).find((p) => p.id === 'ollama')).toMatchObject({ configured: false, state: 'off' });
    await status();
    expect(down).toHaveLength(1);
  });

  it('ollama: respeta ollama_url y un servidor lento cuenta como no disponible (timeout ≤ 1,5 s)', async () => {
    const urls: string[] = [];
    const slowFetch = ((url: string, init: { signal: AbortSignal }) => {
      urls.push(url);
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('timeout'))));
    }) as unknown as typeof fetch;
    h = makeHarness({ providerDeps: { fetch: slowFetch, env: {}, homeDir: '/nonexistent', ollamaStatusTimeoutMs: 60_000 } });
    await h.call('settings.set', { key: 'ollama_url', value: 'http://127.0.0.1:9999/v1' });
    const t0 = Date.now();
    const o = (await status()).find((p) => p.id === 'ollama')!;
    expect(Date.now() - t0).toBeLessThan(2500);
    expect(o.configured).toBe(false);
    expect(urls).toEqual(['http://127.0.0.1:9999/v1/models']);
  });

  it('openai/gemini: configured si existe la variable; nunca se devuelve ni se pide con la clave', async () => {
    const calls: string[] = [];
    h = makeHarness({ providerDeps: { fetch: mkFetch(false, calls), env: { OPENAI_API_KEY: SECRET }, homeDir: '/nonexistent' } });
    const all = await status();
    expect(all.map((p) => p.id).filter((id) => !id.startsWith('conn:'))).toEqual(['claude', 'ollama', 'openai', 'gemini']);
    expect(all.filter((p) => p.id.startsWith('conn:'))).toHaveLength(1); // 0.2b: la conexión openai automática
    expect(all.find((p) => p.id === 'openai')).toMatchObject({ configured: true, state: 'unknown', windows: [] });
    expect(all.find((p) => p.id === 'gemini')).toMatchObject({ configured: false, state: 'off' });
    expect(JSON.stringify(all)).not.toContain(SECRET);
    expect(calls.every((u) => u.includes('localhost'))).toBe(true); // solo se sondea Ollama
  });

  it('gasto de hoy, agentes y runs vivos por modelo', async () => {
    h = makeHarness();
    await h.call('project.open', { path: repo });
    const worker = (await h.call('agent.list')).find((a: any) => a.is_boss === 0);
    const t = await h.call('task.create', { title: 'x', files: ['src/a.ts'], agent_id: worker.id });
    await h.call('task.start', { id: t.id });
    let sonnet = (await claude()).models.find((m) => m.model === 'sonnet')!;
    expect(sonnet).toMatchObject({ liveRuns: 1, agents: [worker.id] });
    h.adapters[0]!.push({ type: 'done', text: 'ok', costUsd: 0.25 });
    await h.waitFor(() => h.orch.ctx.repos.tasks.get(t.id)!.status === 'review', 'review');
    await h.orch.whenIdle();
    sonnet = (await claude()).models.find((m) => m.model === 'sonnet')!;
    expect(sonnet).toMatchObject({ liveRuns: 0, costTodayUsd: 0.25 });
    expect((await claude()).models.find((m) => m.model === 'opus')!.costTodayUsd).toBe(0);
  });
});

describe('rate -> ctx.limits, snapshot y limits.changed', () => {
  async function runWithEvents(...events: any[]) {
    await h.call('project.open', { path: repo });
    const worker = (await h.call('agent.list')).find((a: any) => a.is_boss === 0);
    const t = await h.call('task.create', { title: 'x', files: ['src/a.ts'], agent_id: worker.id });
    await h.call('task.start', { id: t.id });
    h.adapters[0]!.push(...events);
    return t;
  }

  it('cada evento rate guarda la ventana (también allowed), la copia en settings y avisa con limits.changed', async () => {
    h = makeHarness();
    const reset = inFuture(3600_000);
    await runWithEvents({ type: 'rate', status: 'allowed', rateLimitType: 'five_hour', utilization: 0.42, resetsAt: reset });
    await h.waitFor(() => limitsEvents().length >= 1, 'limits.changed');
    expect(h.orch.ctx.limits.get('five_hour')).toMatchObject({ type: 'five_hour', status: 'allowed', utilization: 0.42, resetsAt: reset });
    const snap = JSON.parse(h.orch.ctx.repos.settings.get('limits_snapshot')!);
    expect(snap).toEqual([expect.objectContaining({ type: 'five_hour', status: 'allowed', utilization: 0.42, resetsAt: reset })]);
    const last = limitsEvents().at(-1)!.payload as ProviderStatus[];
    expect(last.map((p) => p.id)).toEqual(['claude', 'ollama', 'openai', 'gemini']);
    expect(last[0]!.windows[0]).toMatchObject({ type: 'five_hour', utilization: 0.42 });
  });

  it('una ráfaga de eventos iguales o seguidos no inunda: sin cambios no hay aviso y los cambios se agrupan', async () => {
    h = makeHarness();
    await runWithEvents(...Array.from({ length: 30 }, () => ({ type: 'rate', status: 'allowed', rateLimitType: 'seven_day', utilization: 0.5, resetsAt: inFuture(9e6) })));
    await h.waitFor(() => limitsEvents().length >= 1, 'primer aviso');
    const n = limitsEvents().length;
    h.adapters[0]!.push(...Array.from({ length: 20 }, (_, i) => ({ type: 'rate', status: 'allowed', rateLimitType: 'seven_day', utilization: 0.5 + i / 100, resetsAt: inFuture(9e6) })));
    await new Promise((r) => setTimeout(r, 1300));
    expect(limitsEvents().length - n).toBeLessThanOrEqual(2);
    expect((limitsEvents().at(-1)!.payload as ProviderStatus[])[0]!.windows[0]!.utilization).toBeCloseTo(0.69);
  });

  it('el snapshot sobrevive a un reinicio y descarta lo que ya se reinició; overage no se guarda', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kiji-db-'));
    tmps.push(dir);
    const dbPath = join(dir, 'kiji.db');
    h = makeHarness({ dbPath });
    recordRate(h.orch.ctx, { status: 'rejected', rateLimitType: 'seven_day_opus', resetsAt: inFuture(3600_000) });
    recordRate(h.orch.ctx, { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.2, resetsAt: inFuture(3600_000) });
    recordRate(h.orch.ctx, { status: 'rejected', rateLimitType: 'overage', resetsAt: inFuture(3600_000) });
    const caducada = { type: 'seven_day_sonnet', status: 'rejected', utilization: null, resetsAt: Date.now() - 1000, seenAt: Date.now() - 5000 };
    const snap = JSON.parse(h.orch.ctx.repos.settings.get('limits_snapshot')!);
    expect(snap.map((w: any) => w.type)).toEqual(['seven_day_opus', 'five_hour']);
    h.orch.ctx.repos.settings.set('limits_snapshot', JSON.stringify([...snap, caducada, { type: 'raro' }, 'basura']));
    await h.orch.shutdown();
    h.orch.ctx.db.close();

    h = makeHarness({ dbPath });
    expect([...h.orch.ctx.limits.keys()].sort()).toEqual(['five_hour', 'seven_day_opus']);
    expect(modelLimitedUntil(h.orch.ctx, 'opus')).not.toBeNull();
    expect(modelLimitedUntil(h.orch.ctx, 'sonnet')).toBeNull();
  });

  it('snapshot corrupto: se ignora sin romper el arranque', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kiji-db-'));
    tmps.push(dir);
    const dbPath = join(dir, 'kiji.db');
    h = makeHarness({ dbPath });
    h.orch.ctx.repos.settings.set('limits_snapshot', '{no es json');
    await h.orch.shutdown();
    h.orch.ctx.db.close();
    h = makeHarness({ dbPath });
    expect(h.orch.ctx.limits.size).toBe(0);
  });
});
