// Métricas (D8): run.metrics con límite de frecuencia, escritura limitada a la BD, agent.metrics, task.list y task.steps.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../src/adapters/types.js';
import { removeRepo } from '../git/helpers.js';
import { makeHarness, makeNodeRepo, type Harness } from './helpers.js';

let repo: string;
let h: Harness;
beforeEach(() => {
  repo = makeNodeRepo();
});
afterEach(async () => {
  await h.orch.shutdown();
  removeRepo(repo);
});

type Usage = Extract<AgentEvent, { type: 'usage' }>;
const usage = (n: number, over: Partial<Usage> = {}): Usage => ({
  type: 'usage', model: 'claude-sonnet-4-5', input: n, output: n * 2, cacheRead: n * 10, cacheWrite: n, contextTokens: n * 100, contextWindow: 200_000, ...over,
});

async function start(harness: Harness, files: string[] = ['src/a.ts']) {
  await harness.call('project.open', { path: repo });
  const worker = (await harness.call('agent.list')).find((a: any) => a.is_boss === 0);
  const t = await harness.call('task.create', { title: 'x', files, agent_id: worker.id });
  await harness.call('task.start', { id: t.id });
  return { worker, t, fake: harness.adapters[0]! };
}
const metricsEvents = (harness: Harness) => harness.emitted.filter((e) => e.name === 'run.metrics');
const task = (id: string) => h.orch.ctx.repos.tasks.get(id)!;

describe('run.metrics y escritura limitada', () => {
  it('una ráfaga de usage notifica como mucho cada 500 ms y escribe la BD como mucho cada 2 s; la última cifra no se pierde', async () => {
    h = makeHarness(); // frecuencias por defecto: 500 ms / 2000 ms
    const { fake } = await start(h);
    for (let i = 1; i <= 40; i++) fake.push(usage(i));
    await h.waitFor(() => metricsEvents(h).length >= 1, 'primera notificación');
    await new Promise((r) => setTimeout(r, 30));
    expect(metricsEvents(h).length).toBeLessThanOrEqual(2); // el primero sale al instante; el resto, agrupado
    expect(metricsEvents(h)[0]!.payload).toMatchObject({ model: 'sonnet', live: true, contextWindow: 200_000 });

    // El envío diferido lleva la última cifra a los ~500 ms.
    await h.waitFor(() => metricsEvents(h).at(-1)!.payload.input === 40, 'cifra final diferida', 1500);
    expect(metricsEvents(h).length).toBeLessThanOrEqual(2);
    expect(metricsEvents(h).at(-1)!.payload).toMatchObject({ input: 40, output: 80, cacheRead: 400, cacheWrite: 40, contextTokens: 4000, live: true });

    // La BD solo recibió la primera escritura (las demás caían dentro de los 2 s).
    const run = h.orch.ctx.repos.runs.latestByTask(task(metricsEvents(h)[0]!.payload.taskId).id)!;
    expect(run.input_tokens).toBe(1);
    expect(run.model).toBe('sonnet');
  });

  it('con frecuencias cortas cada intervalo notifica; al terminar escribe la cifra exacta y notifica live:false', async () => {
    h = makeHarness({ metricsNotifyMs: 20, metricsWriteMs: 20 });
    const { t, fake } = await start(h);
    fake.push(usage(1));
    await h.waitFor(() => metricsEvents(h).length >= 1, 'notificación');
    await new Promise((r) => setTimeout(r, 40));
    fake.push(usage(2));
    await h.waitFor(() => metricsEvents(h).some((e) => e.payload.input === 2), 'segunda notificación');

    fake.push(
      usage(3, { final: true, costUsd: 0.31, contextWindow: 1_000_000, input: 300, output: 40, cacheRead: 900, cacheWrite: 60, contextTokens: 5000 }),
      { type: 'done', text: 'listo', sessionId: 'sess-1', costUsd: 0.31, usage: { input: 1260, output: 40 } },
    );
    await h.waitFor(() => task(t.id).status === 'review', 'review');
    await h.orch.whenIdle();

    const run = h.orch.ctx.repos.runs.latestByTask(t.id)!;
    expect(run).toMatchObject({
      status: 'done', model: 'sonnet', cost_usd: 0.31, input_tokens: 300, output_tokens: 40, // entrada pura, no la del done (que suma la caché)
      cache_read_tokens: 900, cache_write_tokens: 60, context_tokens: 5000, context_window: 1_000_000, provider_session_id: 'sess-1',
    });
    expect(metricsEvents(h).at(-1)!.payload).toMatchObject({
      runId: run.id, taskId: t.id, model: 'sonnet', input: 300, output: 40, cacheRead: 900, cacheWrite: 60,
      contextTokens: 5000, contextWindow: 1_000_000, costUsd: 0.31, live: false,
    });
  });

  it('sin eventos usage (adaptador sin métricas) se conserva el comportamiento de 0.1: coste y tokens del done', async () => {
    h = makeHarness();
    const { t, fake } = await start(h);
    fake.push({ type: 'done', text: 'listo', costUsd: 0.05, usage: { input: 15, output: 5 } });
    await h.waitFor(() => task(t.id).status === 'review', 'review');
    await h.orch.whenIdle();
    expect(h.orch.ctx.repos.runs.latestByTask(t.id)).toMatchObject({ cost_usd: 0.05, input_tokens: 15, output_tokens: 5, model: 'sonnet' });
  });

  it('un run que falla o se para también guarda lo consumido hasta ese momento', async () => {
    h = makeHarness({ metricsWriteMs: 0 });
    const { t, fake } = await start(h);
    fake.push(usage(7));
    await h.waitFor(() => metricsEvents(h).length >= 1, 'notificación');
    await h.call('task.stop', { id: t.id });
    expect(h.orch.ctx.repos.runs.latestByTask(t.id)).toMatchObject({ status: 'cancelled', input_tokens: 7, output_tokens: 14, context_tokens: 700 });
    expect(metricsEvents(h).at(-1)!.payload.live).toBe(false);
  });
});

describe('resume: el result del SDK acumula la sesión', () => {
  it('guarda en el run solo la diferencia respecto a los runs anteriores de la misma sesión', async () => {
    h = makeHarness({ metricsNotifyMs: 0, metricsWriteMs: 0 });
    const { t, fake } = await start(h);
    fake.push(
      usage(1, { final: true, costUsd: 0.1, input: 10, output: 20, cacheRead: 30, cacheWrite: 40 }),
      { type: 'limit', kind: 'rate', rateLimitType: 'five_hour', message: 'x', sessionId: 'S' },
    );
    await h.waitFor(() => task(t.id).status === 'paused_limit' && h.orch.ctx.live.size === 0, 'paused_limit');
    expect(h.orch.ctx.repos.runs.latestByTask(t.id)).toMatchObject({ cost_usd: 0.1, input_tokens: 10, provider_session_id: 'S' });

    await h.call('task.start', { id: t.id });
    // el segundo result trae los totales de TODA la sesión (10 + 5 entrada, 0.1 + 0.05 coste...)
    h.adapters[1]!.push(
      usage(2, { final: true, costUsd: 0.15, input: 15, output: 26, cacheRead: 37, cacheWrite: 48, sessionId: 'S' }),
      { type: 'done', text: 'ok', costUsd: 0.15, sessionId: 'S' },
    );
    await h.waitFor(() => task(t.id).status === 'review', 'review');
    const [r1, r2] = h.orch.ctx.repos.runs.listByTask(t.id);
    expect(r1).toMatchObject({ cost_usd: 0.1, input_tokens: 10 });
    expect(r2!.cost_usd).toBeCloseTo(0.05, 10);
    expect(r2).toMatchObject({ input_tokens: 5, output_tokens: 6, cache_read_tokens: 7, cache_write_tokens: 8 });
  });
});

describe('agent.metrics, task.list y agent.list', () => {
  it('agent.metrics suma los runs del agente, da el modelo en uso y los últimos 20 runs (el más nuevo primero)', async () => {
    h = makeHarness({ metricsNotifyMs: 0, metricsWriteMs: 0 });
    const { worker, t, fake } = await start(h);
    fake.push(usage(1, { final: true, costUsd: 0.1, input: 10, output: 20, cacheRead: 30, cacheWrite: 40, contextTokens: 500 }), { type: 'done', text: 'ok', costUsd: 0.1 });
    await h.waitFor(() => task(t.id).status === 'review', 'review');
    await h.orch.whenIdle();

    // segundo run, vivo
    const t2 = await h.call('task.create', { title: 'y', files: ['src/other.ts'], agent_id: worker.id });
    await h.call('task.start', { id: t2.id });
    h.adapters[1]!.push(usage(2, { input: 5, output: 6, cacheRead: 7, cacheWrite: 8, contextTokens: 900, contextWindow: 1_000_000 }));
    await h.waitFor(() => metricsEvents(h).some((e) => e.payload.taskId === t2.id), 'métricas del segundo run');

    const m = await h.call('agent.metrics', { agentId: worker.id });
    expect(m).toMatchObject({
      agentId: worker.id, model: 'sonnet', runs: 2, costUsd: 0.1, input: 15, output: 26, cacheRead: 37, cacheWrite: 48,
      lastContextTokens: 900, lastContextWindow: 1_000_000,
    });
    expect(m.recent).toHaveLength(2);
    expect(m.recent[0]).toMatchObject({ taskId: t2.id, live: true, contextTokens: 900 });
    expect(m.recent[1]).toMatchObject({ taskId: t.id, live: false, costUsd: 0.1, contextTokens: 500 });
    await expect(h.call('agent.metrics', { agentId: 'nope' })).rejects.toThrow(/inexistente/);
    await expect(h.call('agent.metrics', {})).rejects.toThrow(/agentId/);
  });

  it('agent.metrics sin runs devuelve ceros y el modelo preferido', async () => {
    h = makeHarness();
    await h.call('project.open', { path: repo });
    const worker = (await h.call('agent.list')).find((a: any) => a.is_boss === 0);
    expect(await h.call('agent.metrics', { agentId: worker.id })).toEqual({
      agentId: worker.id, model: 'sonnet', runs: 0, costUsd: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
      lastContextTokens: 0, lastContextWindow: 200_000, recent: [],
    });
  });

  it('task.list añade model, cost_usd, context_pct y steps_count; agent.list, current_model', async () => {
    h = makeHarness({ metricsNotifyMs: 0, metricsWriteMs: 0 });
    const { worker, t, fake } = await start(h);
    const before = (await h.call('task.list')).find((x: any) => x.id === t.id);
    expect(before).toMatchObject({ model: 'sonnet', context_pct: 0 });
    fake.push(
      usage(1, { contextTokens: 50_000 }),
      { type: 'tool', name: 'Read', input: { file_path: 'src/a.ts' }, status: 'start' },
      { type: 'tool', name: 'Read', input: undefined, status: 'end', output: 'x' },
      { type: 'tool', name: 'Bash', input: { command: 'ls' }, status: 'start' },
    );
    await h.waitFor(() => h.orch.ctx.repos.events.listByRun(h.orch.ctx.repos.runs.latestByTask(t.id)!.id, 'tool').length === 3, 'eventos tool');
    const live = (await h.call('task.list')).find((x: any) => x.id === t.id);
    expect(live).toMatchObject({ model: 'sonnet', context_pct: 25, steps_count: 2, cost_usd: 0 });
    expect((await h.call('agent.list')).find((a: any) => a.id === worker.id)).toMatchObject({ current_model: 'sonnet' });

    fake.push({ type: 'done', text: 'ok', costUsd: 0.2 });
    await h.waitFor(() => task(t.id).status === 'review', 'review');
    await h.orch.whenIdle();
    expect((await h.call('task.list')).find((x: any) => x.id === t.id)).toMatchObject({ cost_usd: 0.2, context_pct: 25, steps_count: 2 });
    // task.changed también lleva los campos nuevos (la UI sustituye la fila entera)
    expect(h.emitted.filter((e) => e.name === 'task.changed').at(-1)!.payload).toMatchObject({ model: 'sonnet', cost_usd: 0.2, steps_count: 2 });
  });
});

describe('task.steps', () => {
  it('cronología del último run: target recortado a 80, ok por is_error o salida de denegación, abiertas con ok null', async () => {
    h = makeHarness();
    const { t, fake } = await start(h);
    const long = 'x'.repeat(200);
    fake.push(
      { type: 'tool', name: 'Read', input: { file_path: 'src/a.ts' }, status: 'start' },
      { type: 'tool', name: 'Read', input: undefined, status: 'end', output: 'contenido' },
      { type: 'tool', name: 'Bash', input: { command: `echo ${long}\nsegunda línea` }, status: 'start' },
      { type: 'tool', name: 'Bash', input: undefined, status: 'end', output: 'boom', isError: true },
      { type: 'tool', name: 'Write', input: { file_path: 'otro.ts' }, status: 'start' },
      { type: 'tool', name: 'Write', input: undefined, status: 'end', output: 'No puedes modificar otro.ts: no está entre tus archivos asignados.' },
      { type: 'tool', name: 'Grep', input: { pattern: 'foo.*bar' }, status: 'start' },
      { type: 'tool', name: 'Glob', input: { path: 'src' }, status: 'start' },
      { type: 'tool', name: 'TodoWrite', input: { todos: [] }, status: 'start' },
    );
    await h.waitFor(() => h.orch.ctx.repos.events.listByRun(h.orch.ctx.repos.runs.latestByTask(t.id)!.id, 'tool').length === 9, 'eventos tool');
    const steps = await h.call('task.steps', { taskId: t.id });
    expect(steps.map((s: any) => [s.name, s.ok])).toEqual([['Read', true], ['Bash', false], ['Write', false], ['Grep', null], ['Glob', null], ['TodoWrite', null]]);
    expect(steps.map((s: any) => s.target)).toEqual(['src/a.ts', expect.any(String), 'otro.ts', 'foo.*bar', 'src', '']);
    expect(steps[1].target).toHaveLength(80);
    expect(steps[1].target.endsWith('…')).toBe(true);
    expect(steps[1].target).not.toContain('\n');
    expect(steps[0].endedAt).toBeGreaterThanOrEqual(steps[0].startedAt);
    expect(steps[3].endedAt).toBeNull();
  });

  it('solo cuenta el último run y sin runs devuelve []', async () => {
    h = makeHarness();
    const { worker, t, fake } = await start(h);
    expect(await h.call('task.steps', { taskId: t.id })).toHaveLength(0);
    fake.push({ type: 'tool', name: 'Read', input: { file_path: 'a' }, status: 'start' }, { type: 'error', message: 'cayó', retryable: false });
    await h.waitFor(() => task(t.id).status === 'failed', 'failed');
    await h.orch.whenIdle();
    expect(await h.call('task.steps', { taskId: t.id })).toHaveLength(1);
    await h.call('task.start', { id: t.id });
    h.adapters[1]!.push({ type: 'tool', name: 'Glob', input: { pattern: '*.ts' }, status: 'start' });
    await h.waitFor(() => h.orch.ctx.repos.events.countToolStarts(h.orch.ctx.repos.runs.latestByTask(t.id)!.id) === 1, 'tool del segundo run');
    expect((await h.call('task.steps', { taskId: t.id })).map((s: any) => s.name)).toEqual(['Glob']);
    expect(worker.id).toBeTruthy();
    await expect(h.call('task.steps', { taskId: 'nope' })).rejects.toThrow(/inexistente/);
  });
});
