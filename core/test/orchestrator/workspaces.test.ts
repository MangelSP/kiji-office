// 0.2c: varios workspaces abiertos a la vez, projectId en peticiones y eventos, cola global, tope diario,
// resumen del Home y reapertura tras reiniciar el core.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../src/adapters/types.js';
import { costToday, requestStart } from '../../src/orchestrator/queue.js';
import { removeRepo } from '../git/helpers.js';
import { makeHarness, makeNodeRepo, type Harness } from './helpers.js';

let repoA: string;
let repoB: string;
let h: Harness;
const harnesses: Harness[] = [];
const tmps: string[] = [];

beforeEach(() => {
  repoA = makeNodeRepo();
  repoB = makeNodeRepo();
});
afterEach(async () => {
  vi.useRealTimers();
  for (const x of harnesses.splice(0)) await x.orch.shutdown();
  removeRepo(repoA);
  removeRepo(repoB);
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function harness(opts: Parameters<typeof makeHarness>[0] = {}): Harness {
  h = makeHarness(opts);
  harnesses.push(h);
  return h;
}

const task = (id: string) => h.orch.ctx.repos.tasks.get(id)!;
const usage = (n: number, over: Partial<Extract<AgentEvent, { type: 'usage' }>> = {}): AgentEvent => ({
  type: 'usage', model: 'claude-sonnet-4-5', input: n, output: n * 2, cacheRead: n * 10, cacheWrite: n, contextTokens: n * 100, contextWindow: 200_000, ...over,
});

/** Abre un repo como workspace; devuelve su proyecto y su trabajador. */
async function openRepo(path: string) {
  const project = await h.call('project.open', { path });
  const worker = (await h.call('agent.list', { projectId: project.id })).find((a: any) => a.is_boss === 0);
  return { project, worker };
}
async function newTask(projectId: string, workerId: string, title = 'x', file = 'src/a.ts') {
  return h.call('task.create', { projectId, title, files: [file], agent_id: workerId });
}
/** Adaptador que corre en la carpeta de un repo (los worktrees viven en `<repo>/.kiji`). */
const adapterIn = (repo: string) => h.adapters.find((a) => a.spec?.cwd.startsWith(repo))!;
const events = (name: string) => h.emitted.filter((e) => e.name === name);

describe('dos workspaces abiertos a la vez', () => {
  it('cada run emite eventos con su projectId, sin mezclar; los listados se filtran por projectId', async () => {
    harness();
    const A = await openRepo(repoA);
    const B = await openRepo(repoB);
    expect(h.orch.ctx.projects.size).toBe(2); // abrir B no cierra A
    expect(h.orch.ctx.lastProjectId).toBe(B.project.id);

    const ta = await newTask(A.project.id, A.worker.id, 'tarea A');
    const tb = await newTask(B.project.id, B.worker.id, 'tarea B', 'src/other.ts');
    expect(ta.projectId).toBe(A.project.id);
    await h.call('task.start', { id: ta.id, projectId: A.project.id });
    await h.call('task.start', { id: tb.id, projectId: B.project.id });
    expect(h.adapters).toHaveLength(2);
    const fa = adapterIn(repoA);
    const fb = adapterIn(repoB);
    expect(fa).not.toBe(fb);

    fa.push({ type: 'tool', name: 'Read', input: { file_path: 'src/a.ts' }, status: 'start' }, usage(1));
    fb.push({ type: 'permission_request', id: 'p1', tool: 'Bash', input: { command: 'ls' }, risk: 'ask' }, usage(2));
    await h.waitFor(() => task(tb.id).status === 'needs_you', 'B pide permiso');

    // approval.requested solo en B; run.metrics y agent.status con el proyecto de su agente
    expect(events('approval.requested').map((e) => e.payload.projectId)).toEqual([B.project.id]);
    for (const e of events('run.metrics')) {
      expect(e.payload.projectId).toBe(e.payload.taskId === ta.id ? A.project.id : B.project.id);
    }
    for (const e of events('agent.status')) {
      const agent = h.orch.ctx.repos.agents.get(e.payload.agent_id)!;
      expect(e.payload.projectId).toBe(agent.project_id);
    }
    // task.changed / event.appended: el projectId siempre es el de la tarea
    for (const e of events('task.changed')) {
      expect(e.payload.projectId).toBe(e.payload.id === ta.id ? A.project.id : B.project.id);
    }
    for (const e of events('event.appended')) {
      if (e.payload.task_id === ta.id) expect(e.payload.projectId).toBe(A.project.id);
      if (e.payload.task_id === tb.id) expect(e.payload.projectId).toBe(B.project.id);
      expect(e.payload.projectId).toBe(e.payload.project_id);
    }

    // peticiones por projectId: cada una ve solo lo suyo
    expect((await h.call('task.list', { projectId: A.project.id })).map((t: any) => t.id)).toEqual([ta.id]);
    expect((await h.call('task.list', { projectId: B.project.id })).map((t: any) => t.id)).toEqual([tb.id]);
    expect((await h.call('agent.list', { projectId: A.project.id })).every((a: any) => a.projectId === A.project.id)).toBe(true);
    const tailA = await h.call('events.tail', { projectId: A.project.id, limit: 500 });
    expect(tailA.length).toBeGreaterThan(0);
    expect(tailA.every((e: any) => e.project_id === A.project.id)).toBe(true);
    expect(await h.call('relays.list', { projectId: A.project.id })).toEqual([]);

    // sin projectId: el último abierto (la UI de 0.2a); un id ajeno o desconocido falla
    expect((await h.call('task.list')).map((t: any) => t.id)).toEqual([tb.id]);
    await expect(h.call('task.list', { projectId: 'no-existe' })).rejects.toThrow(/no está abierto/);
    await expect(h.call('task.start', { id: ta.id, projectId: B.project.id })).rejects.toThrow(/no pertenece/);
    await expect(h.call('agent.metrics', { agentId: A.worker.id, projectId: B.project.id })).rejects.toThrow(/no pertenece/);
    await expect(h.call('agent.update', { agentId: A.worker.id, projectId: B.project.id, name: 'Otro' })).rejects.toThrow(/no pertenece/);
  });

  it('cerrar uno no toca al otro: sin force falla con runs vivos; con force los para limpiamente', async () => {
    harness();
    const A = await openRepo(repoA);
    const B = await openRepo(repoB);
    const ta = await newTask(A.project.id, A.worker.id);
    const tb = await newTask(B.project.id, B.worker.id, 'b', 'src/other.ts');
    await h.call('task.start', { id: ta.id });
    await h.call('task.start', { id: tb.id });
    const fa = adapterIn(repoA);
    const fb = adapterIn(repoB);

    await expect(h.call('project.close', { projectId: A.project.id })).rejects.toThrow(/run\(s\) en marcha/);
    expect(h.orch.ctx.projects.has(A.project.id)).toBe(true);
    expect(fa.stopped).toBe(false);

    const res = await h.call('project.close', { projectId: A.project.id, force: true });
    expect(res).toEqual({ projectId: A.project.id, closed: true, stoppedRuns: 1 });
    expect(fa.stopped).toBe(true);
    expect(task(ta.id).status).toBe('assigned');
    expect(h.orch.ctx.repos.runs.latestByTask(ta.id)!.status).toBe('cancelled');
    expect(h.orch.ctx.repos.projects.get(A.project.id)!.is_open).toBe(0);
    // B sigue intacto
    expect(fb.stopped).toBe(false);
    expect(task(tb.id).status).toBe('running');
    expect(h.orch.ctx.live.has(tb.id)).toBe(true);
    expect(h.orch.ctx.lastProjectId).toBe(B.project.id);
    // el proyecto cerrado no acepta peticiones ni arranques
    await expect(h.call('task.list', { projectId: A.project.id })).rejects.toThrow(/no está abierto/);
    await expect(h.call('task.start', { id: ta.id })).rejects.toThrow(/no está abierto/);
    fb.push({ type: 'done', text: 'fin B' });
    await h.waitFor(() => task(tb.id).status === 'review', 'B termina');
    await expect(h.call('project.close', { projectId: A.project.id })).rejects.toThrow(/no está abierto/);
    await h.call('project.close', { projectId: B.project.id }); // sin runs vivos no hace falta force
    expect(h.orch.ctx.lastProjectId).toBeNull();
  });

  it('project.update admite scene y color; project.list trae contadores y ordena abiertos primero', async () => {
    harness();
    const A = await openRepo(repoA);
    const B = await openRepo(repoB);
    const upd = await h.call('project.update', { projectId: A.project.id, scene: 'casa', color: '#ff8800' });
    expect(upd).toMatchObject({ scene: 'casa', color: '#ff8800' });
    await expect(h.call('project.update', { projectId: A.project.id, scene: 'cueva' })).rejects.toThrow(/scene/);
    await expect(h.call('project.update', { projectId: A.project.id, color: 'rojo' })).rejects.toThrow(/color/);
    await expect(h.call('project.update', { projectId: A.project.id })).rejects.toThrow(/indica/);
    expect((await h.call('project.update', { projectId: A.project.id, color: null })).color).toBeNull();

    const ta = await newTask(A.project.id, A.worker.id);
    await newTask(A.project.id, A.worker.id, 'otra', 'src/other.ts');
    await h.call('task.start', { id: ta.id });
    adapterIn(repoA).push({ type: 'permission_request', id: 'p', tool: 'Bash', input: {}, risk: 'ask' });
    await h.waitFor(() => task(ta.id).status === 'needs_you', 'permiso');

    await h.call('project.close', { projectId: B.project.id });
    const list = await h.call('project.list');
    expect(list.map((p: any) => [p.projectId, p.open])).toEqual([[A.project.id, true], [B.project.id, false]]);
    expect(list[0]).toMatchObject({
      scene: 'casa', liveRuns: 1, needsYou: 1, approvalsPending: 1, queued: 0, tasksByStatus: { needs_you: 1, assigned: 1 },
    });
    expect(list[1]).toMatchObject({ open: false, liveRuns: 0, tasksByStatus: {} });
    expect(typeof list[1].lastOpenedAt).toBe('number');
  });

  it('providers.status agrega los runs y agentes de todos los proyectos abiertos', async () => {
    harness();
    const A = await openRepo(repoA);
    const B = await openRepo(repoB);
    const ta = await newTask(A.project.id, A.worker.id);
    const tb = await newTask(B.project.id, B.worker.id, 'b', 'src/other.ts');
    await h.call('task.start', { id: ta.id });
    await h.call('task.start', { id: tb.id });
    const claude = (await h.call('providers.status')).find((p: any) => p.id === 'claude');
    const sonnet = claude.models.find((m: any) => m.model === 'sonnet');
    expect(sonnet.liveRuns).toBe(2);
    expect(sonnet.agents).toEqual(expect.arrayContaining([A.worker.id, B.worker.id]));
  });
});

describe('cola global (max_concurrent_runs)', () => {
  it('tope 1: la segunda tarea queda en cola (queued/position, queue.changed) y arranca sola al terminar la primera', async () => {
    harness();
    await h.call('settings.set', { key: 'max_concurrent_runs', value: '1' });
    const A = await openRepo(repoA);
    const B = await openRepo(repoB);
    const ta = await newTask(A.project.id, A.worker.id);
    const tb = await newTask(B.project.id, B.worker.id, 'b', 'src/other.ts');
    await h.call('task.start', { id: ta.id });
    const queuedView = await h.call('task.start', { id: tb.id });
    expect(queuedView).toMatchObject({ status: 'assigned', queued: true, queue_position: 1, projectId: B.project.id });
    expect(h.adapters).toHaveLength(1);
    expect(events('queue.changed').at(-1)!.payload).toEqual({
      projectId: B.project.id, taskId: tb.id, queued: true, position: 1, blockedBy: 'slots',
    });
    expect((await h.call('task.list', { projectId: B.project.id }))[0]).toMatchObject({ queued: true, queue_position: 1 });
    expect(await h.call('queue.list')).toMatchObject([{ projectId: B.project.id, taskId: tb.id, position: 1 }]);
    await expect(h.call('task.start', { id: tb.id })).rejects.toThrow(/en la cola/);

    adapterIn(repoA).push({ type: 'done', text: 'fin A' });
    await h.waitFor(() => task(tb.id).status === 'running', 'B arranca sola');
    expect(h.adapters).toHaveLength(2);
    expect(events('queue.changed').at(-1)!.payload).toMatchObject({ taskId: tb.id, queued: false, position: 0, blockedBy: null });
    expect((await h.call('task.list', { projectId: B.project.id }))[0]).toMatchObject({ queued: false, queue_position: null });
    expect(h.orch.ctx.queue).toHaveLength(0);
  });

  it('task.stop saca una tarea de la cola; subir el tope libera las que esperan', async () => {
    harness();
    await h.call('settings.set', { key: 'max_concurrent_runs', value: '1' });
    const A = await openRepo(repoA);
    const t1 = await newTask(A.project.id, A.worker.id, 'uno', 'src/a.ts');
    const second = (await h.call('agent.create', { projectId: A.project.id, name: 'Dos', provider: 'claude' }));
    const third = (await h.call('agent.create', { projectId: A.project.id, name: 'Tres', provider: 'claude' }));
    const t2 = await newTask(A.project.id, second.id, 'dos', 'src/other.ts');
    const t3 = await newTask(A.project.id, third.id, 'tres', 'package.json');
    await h.call('task.start', { id: t1.id });
    await h.call('task.start', { id: t2.id });
    await h.call('task.start', { id: t3.id });
    expect((await h.call('queue.list')).map((q: any) => [q.taskId, q.position])).toEqual([[t2.id, 1], [t3.id, 2]]);

    const stopped = await h.call('task.stop', { id: t2.id });
    expect(stopped).toMatchObject({ queued: false, status: 'assigned' });
    expect(events('queue.changed').filter((e) => e.payload.taskId === t3.id).at(-1)!.payload).toMatchObject({ position: 1, queued: true });

    await h.call('settings.set', { key: 'max_concurrent_runs', value: '2' });
    await h.waitFor(() => task(t3.id).status === 'running', 'el tope más alto libera t3');
    expect(h.orch.ctx.queue).toHaveLength(0);
  });

  it('el relevo de modelo pasa por la cola con prioridad: se relanza antes que lo que ya esperaba', async () => {
    harness();
    await h.call('settings.set', { key: 'max_concurrent_runs', value: '1' });
    const A = await openRepo(repoA);
    const B = await openRepo(repoB);
    const ta = await newTask(A.project.id, A.worker.id);
    const tb = await newTask(B.project.id, B.worker.id, 'b', 'src/other.ts');
    await h.call('task.start', { id: ta.id });
    await h.call('task.start', { id: tb.id });
    expect(task(tb.id).status).toBe('assigned');
    const first = adapterIn(repoA);
    const resetsAt = Date.now() + 3600_000;
    first.push(
      { type: 'rate', status: 'rejected', rateLimitType: 'seven_day_sonnet', resetsAt },
      { type: 'limit', kind: 'rate', rateLimitType: 'seven_day_sonnet', resetsAt, message: 'límite', sessionId: 's1' },
    );
    await h.waitFor(() => h.adapters.length === 2, 'relevo');
    expect(h.adapters[1]!.spec!.cwd.startsWith(repoA)).toBe(true); // el relevo de A, no la tarea de B
    expect(task(ta.id).status).toBe('running');
    expect(task(tb.id).status).toBe('assigned');
    expect(h.orch.ctx.queue.map((e) => e.taskId)).toEqual([tb.id]);
    await h.waitFor(() => h.orch.ctx.repos.relays.list(A.project.id).length === 1, 'relevo registrado');
  });

  it('cerrar un proyecto saca sus tareas de la cola', async () => {
    harness();
    await h.call('settings.set', { key: 'max_concurrent_runs', value: '1' });
    const A = await openRepo(repoA);
    const B = await openRepo(repoB);
    const ta = await newTask(A.project.id, A.worker.id);
    const tb = await newTask(B.project.id, B.worker.id, 'b', 'src/other.ts');
    await h.call('task.start', { id: ta.id });
    await h.call('task.start', { id: tb.id });
    await h.call('project.close', { projectId: B.project.id });
    expect(h.orch.ctx.queue).toHaveLength(0);
    expect(events('queue.changed').at(-1)!.payload).toMatchObject({ taskId: tb.id, queued: false });
  });

  it('settings: valida max_concurrent_runs y daily_budget_usd', async () => {
    harness();
    expect(await h.call('settings.set', { key: 'max_concurrent_runs', value: '4' })).toEqual({ key: 'max_concurrent_runs', value: '4' });
    await expect(h.call('settings.set', { key: 'max_concurrent_runs', value: '0' })).rejects.toThrow(/entero/);
    await expect(h.call('settings.set', { key: 'max_concurrent_runs', value: '1.5' })).rejects.toThrow(/entero/);
    expect(await h.call('settings.set', { key: 'daily_budget_usd', value: '12.5' })).toEqual({ key: 'daily_budget_usd', value: '12.5' });
    await expect(h.call('settings.set', { key: 'daily_budget_usd', value: '-1' })).rejects.toThrow(/mayor que 0/);
    expect((await h.call('workspaces.overview')).totals).toMatchObject({ maxConcurrentRuns: 4, dailyBudgetUsd: 12.5 });
  });
});

/** Inserta un run ya terminado con un coste, empezado en `startedAt`. */
function seedRun(taskId: string, agentId: string, startedAt: number, cost: number, tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }) {
  const run = h.orch.ctx.repos.runs.create({ taskId, agentId, model: 'sonnet' });
  h.orch.ctx.db.prepare('UPDATE runs SET started_at = ?, status = ?, cost_usd = ?, input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cache_write_tokens = ? WHERE id = ?')
    .run(startedAt, 'done', cost, tokens.input, tokens.output, tokens.cacheRead, tokens.cacheWrite, run.id);
  return run;
}
const DAY = 86_400_000;

describe('tope de gasto diario (daily_budget_usd)', () => {
  it('con el gasto de hoy (todos los proyectos) >= tope no arranca nada, avisa; el de ayer no cuenta; subir el tope arranca', async () => {
    harness();
    const A = await openRepo(repoA);
    const B = await openRepo(repoB);
    const ta = await newTask(A.project.id, A.worker.id);
    const tb = await newTask(B.project.id, B.worker.id, 'b', 'src/other.ts');
    await h.call('settings.set', { key: 'daily_budget_usd', value: '10' });
    seedRun(ta.id, A.worker.id, Date.now() - 3 * DAY, 50); // viejo: no cuenta
    seedRun(ta.id, A.worker.id, Date.now(), 6); // hoy, proyecto A
    await h.call('task.start', { id: tb.id }); // 6 < 10: arranca
    expect(h.adapters).toHaveLength(1);
    expect(events('budget.reached')).toHaveLength(0);
    adapterIn(repoB).push({ type: 'done', text: 'ok' });
    await h.waitFor(() => task(tb.id).status === 'review', 'B termina');

    seedRun(tb.id, B.worker.id, Date.now(), 4); // hoy, proyecto B: 6 + 4 = 10 >= 10
    const tc = await newTask(A.project.id, A.worker.id, 'c', 'src/other.ts');
    const view = await h.call('task.start', { id: tc.id });
    expect(view).toMatchObject({ queued: true, status: 'assigned' });
    expect(h.adapters).toHaveLength(1); // no arrancó nada nuevo
    expect(events('queue.changed').at(-1)!.payload).toMatchObject({ taskId: tc.id, queued: true, blockedBy: 'budget' });
    const notice = events('budget.reached').at(-1)!.payload;
    expect(notice).toMatchObject({ costTodayUsd: 10, dailyBudgetUsd: 10, taskId: tc.id, projectId: A.project.id });
    expect(notice.message).toMatch(/Tope de gasto diario alcanzado/);
    expect(h.orch.ctx.budgetTimer).not.toBeNull(); // se reintenta a medianoche

    await h.call('settings.set', { key: 'daily_budget_usd', value: '25' });
    await h.waitFor(() => task(tc.id).status === 'running', 'arranca al subir el tope');
    expect(h.adapters).toHaveLength(2);
  });
});

describe('workspaces.overview', () => {
  it('cifras por proyecto y totales; hoy = día local; incluye consumo vivo aún no escrito, relevo y cerrados', async () => {
    harness();
    const A = await openRepo(repoA);
    const B = await openRepo(repoB);
    const ta = await newTask(A.project.id, A.worker.id);
    const tb = await newTask(B.project.id, B.worker.id, 'b', 'src/other.ts');
    seedRun(ta.id, A.worker.id, Date.now() - 3 * DAY, 4, { input: 100, output: 100, cacheRead: 100, cacheWrite: 100 }); // ayer o antes
    seedRun(ta.id, A.worker.id, Date.now(), 1.5, { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 });
    seedRun(tb.id, B.worker.id, Date.now(), 0.5, { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 });
    h.orch.ctx.repos.relays.create({ projectId: A.project.id, taskId: ta.id, reason: 'manual', detail: 'antes' });
    const lastRelay = h.orch.ctx.repos.relays.create({ projectId: A.project.id, taskId: ta.id, reason: 'limit', detail: 'último', fromModel: 'sonnet', toModel: 'opus' });

    // un run vivo en B con consumo en memoria que aún no llegó a la BD (escritura cada 2 s)
    await h.call('task.start', { id: tb.id });
    const fb = adapterIn(repoB);
    fb.push(usage(1, { costUsd: 0.1 }), usage(5, { input: 50, output: 60, cacheRead: 70, cacheWrite: 80, costUsd: 0.25 }));
    await h.waitFor(() => h.orch.ctx.live.get(tb.id)?.usage.input === 50, 'uso en memoria');
    await h.call('project.close', { projectId: A.project.id });

    const o = await h.call('workspaces.overview');
    expect(o.workspaces.map((w: any) => [w.projectId, w.open])).toEqual([[B.project.id, true], [A.project.id, false]]); // abiertos primero
    const [wb, wa] = o.workspaces;
    expect(wb).toMatchObject({
      name: expect.any(String), path: repoB, color: null, scene: 'oficina', liveRuns: 1, queued: 0, needsYou: 0, approvalsPending: 0,
      tasksByStatus: { running: 1 },
    });
    expect(wb.costTodayUsd).toBeCloseTo(0.75, 6); // 0.5 guardado + 0.25 vivo
    expect(wb.costTotalUsd).toBeCloseTo(0.75, 6);
    expect(wb.tokensToday).toEqual({ input: 51, output: 62, cacheRead: 73, cacheWrite: 84 });
    expect(wb.agents.map((a: any) => a.id)).toContain(B.worker.id);
    expect(wb.agents.find((a: any) => a.id === B.worker.id)).toMatchObject({ name: B.worker.name, model: 'sonnet', color: expect.any(String), isBoss: false });
    expect(wb.agents.find((a: any) => a.isBoss)).toBeTruthy();
    expect(typeof wb.lastActivityAt).toBe('number');
    expect(wb.lastRelay).toBeUndefined();

    expect(wa).toMatchObject({ open: false, liveRuns: 0, tasksByStatus: { assigned: 1 } });
    expect(wa.costTodayUsd).toBeCloseTo(1.5, 6);
    expect(wa.costTotalUsd).toBeCloseTo(5.5, 6);
    expect(wa.tokensToday).toEqual({ input: 10, output: 20, cacheRead: 30, cacheWrite: 40 });
    expect(wa.lastRelay).toMatchObject({ id: lastRelay.id, projectId: A.project.id, reason: 'limit', toModel: 'opus' });

    expect(o.totals.costTodayUsd).toBeCloseTo(2.25, 6);
    expect(o.totals).toMatchObject({ liveRuns: 1, queued: 0, maxConcurrentRuns: 3, dailyBudgetUsd: 10 });
  });

  it('workspaces.changed se limita a ~1 por segundo aunque haya una ráfaga de cambios', async () => {
    harness({ metricsNotifyMs: 1 });
    const A = await openRepo(repoA);
    const ta = await newTask(A.project.id, A.worker.id);
    await h.call('task.start', { id: ta.id });
    await h.waitFor(() => events('workspaces.changed').length >= 1, 'primer aviso');
    const before = events('workspaces.changed').length;
    for (let i = 1; i <= 60; i++) adapterIn(repoA).push(usage(i, { costUsd: i / 100 }), { type: 'text', delta: String(i) });
    await h.waitFor(() => h.orch.ctx.live.get(ta.id)!.usage.input === 60, 'ráfaga procesada');
    expect(events('workspaces.changed').length - before).toBeLessThanOrEqual(2);
    await h.waitFor(() => events('workspaces.changed').length > before, 'aviso diferido', 2500);
    const last = events('workspaces.changed').at(-1)!.payload;
    expect(last.workspaces[0].liveRuns).toBe(1);
    expect(last.totals.maxConcurrentRuns).toBe(3);
  });
});

describe('reinicio del core con dos workspaces abiertos', () => {
  it('project.reopen vuelve a abrir los is_open=1, recupera sus runs colgados y deja fuera los cerrados y los que ya no existen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kiji-reopen-'));
    tmps.push(dir);
    const dbPath = join(dir, 'kiji.db');
    const repoC = makeNodeRepo();
    const repoD = makeNodeRepo();
    try {
      harness({ dbPath });
      const first = h;
      const A = await openRepo(repoA);
      const B = await openRepo(repoB);
      const C = await openRepo(repoC); // se cierra antes del reinicio
      const D = await openRepo(repoD); // desaparecerá
      await h.call('project.update', { projectId: A.project.id, color: '#112233', scene: 'casa' });
      const ta = await newTask(A.project.id, A.worker.id);
      const tb = await newTask(B.project.id, B.worker.id, 'b', 'src/other.ts');
      await h.call('task.start', { id: ta.id });
      await h.call('task.start', { id: tb.id });
      await h.call('project.close', { projectId: C.project.id });
      // "se cae el core": se paran los adaptadores sin cerrar proyectos ni terminar las tareas
      await first.orch.shutdown();
      await first.orch.whenIdle();
      // un corte real no deja tiempo de cerrar nada: la BD queda con las tareas y runs "en marcha"
      first.orch.ctx.db.exec(`UPDATE tasks SET status = 'running'; UPDATE runs SET status = 'running', ended_at = NULL`);
      first.orch.ctx.db.close();
      removeRepo(repoD);

      harness({ dbPath });
      expect(h.orch.ctx.projects.size).toBe(0); // el core nuevo no abre nada solo
      expect(h.orch.ctx.repos.projects.listOpen().map((p) => p.id).sort()).toEqual([A.project.id, B.project.id, D.project.id].sort());

      const res = await h.call('project.reopen');
      expect(res.opened.map((p: any) => p.projectId).sort()).toEqual([A.project.id, B.project.id].sort());
      expect(res.opened.every((p: any) => p.open)).toBe(true);
      expect(res.failed).toEqual([expect.objectContaining({ projectId: D.project.id, path: repoD })]);
      expect([...h.orch.ctx.projects.keys()].sort()).toEqual([A.project.id, B.project.id].sort());
      expect(h.orch.ctx.projects.has(C.project.id)).toBe(false);
      expect(h.orch.ctx.repos.projects.get(D.project.id)!.is_open).toBe(0);
      expect(h.orch.ctx.lastProjectId).toBe(B.project.id); // el abierto más reciente

      // ambos recuperan lo suyo: run huérfano cancelado y tarea bloqueada
      expect(task(ta.id).status).toBe('blocked');
      expect(task(tb.id).status).toBe('blocked');
      expect(h.orch.ctx.repos.runs.latestByTask(ta.id)!.status).toBe('cancelled');
      expect(h.orch.ctx.repos.runs.latestByTask(tb.id)!.status).toBe('cancelled');
      const list = await h.call('project.list');
      expect(list.find((p: any) => p.projectId === A.project.id)).toMatchObject({ open: true, color: '#112233', scene: 'casa', tasksByStatus: { blocked: 1 } });
      expect(list.find((p: any) => p.projectId === C.project.id)).toMatchObject({ open: false });

      // y es idempotente
      expect((await h.call('project.reopen')).opened).toHaveLength(2);
      expect(h.orch.ctx.projects.size).toBe(2);
    } finally {
      removeRepo(repoC);
      removeRepo(repoD);
    }
  });
});

describe('revisión CAMBIOS de 935eec5', () => {
  it('1. un arranque rápido que falla (createWorktree lanza) libera el hueco: la tarea en cola arranca', async () => {
    harness();
    await h.call('settings.set', { key: 'max_concurrent_runs', value: '1' });
    const A = await openRepo(repoA);
    const B = await openRepo(repoB);
    const ta = await newTask(A.project.id, A.worker.id);
    const tb = await newTask(B.project.id, B.worker.id, 'b', 'src/other.ts');
    const broken = h.orch.ctx.repos.projects.update(A.project.id, { baseBranch: 'no-existe' });
    h.orch.ctx.projects.set(broken.id, broken);
    const failing = h.call('task.start', { id: ta.id }).then(() => null, (e) => e);
    const queued = await h.call('task.start', { id: tb.id });
    expect(queued).toMatchObject({ queued: true });
    expect(await failing).toBeInstanceOf(Error);
    await h.waitFor(() => task(tb.id).status === 'running', 'B arranca al fallar A');
    expect(h.orch.ctx.queue).toHaveLength(0);
  });

  it('2. cerrar un proyecto con un run lento de parar no deja arrancar nada de ese proyecto mientras tanto', async () => {
    harness();
    const A = await openRepo(repoA);
    const ta = await newTask(A.project.id, A.worker.id);
    const tb = await newTask(A.project.id, A.worker.id, 'otra', 'src/other.ts');
    await h.call('task.start', { id: ta.id });
    const fa = adapterIn(repoA);
    const realStop = fa.stop.bind(fa);
    fa.stop = async () => {
      await new Promise((r) => setTimeout(r, 150));
      await realStop();
    };
    const closing = h.call('project.close', { projectId: A.project.id, force: true });
    expect(h.orch.ctx.projects.has(A.project.id)).toBe(false); // la puerta se cierra ya
    expect(h.orch.ctx.repos.projects.get(A.project.id)!.is_open).toBe(0);
    await expect(h.call('task.start', { id: tb.id })).rejects.toThrow(/no está abierto/);
    expect(h.adapters).toHaveLength(1);
    const res = await closing;
    expect(res).toMatchObject({ closed: true, stoppedRuns: 1 });
    expect([...h.orch.ctx.live.values()].filter((l) => l.projectId === A.project.id)).toHaveLength(0);
    expect(h.adapters).toHaveLength(1);
  });

  it('3. el gasto vivo aún no escrito cuenta como de hoy aunque el run empezara ayer (cruce de medianoche)', async () => {
    const before = new Date(); before.setHours(23, 59, 0, 0);
    vi.useFakeTimers({ toFake: ['Date'], now: before });
    harness({ metricsWriteMs: 1_000_000 });
    const A = await openRepo(repoA);
    const ta = await newTask(A.project.id, A.worker.id);
    await h.call('task.start', { id: ta.id });
    adapterIn(repoA).push(usage(1, { costUsd: 0.5 }));
    await h.waitFor(() => h.orch.ctx.repos.runs.get(h.orch.ctx.live.get(ta.id)!.runId)!.cost_usd === 0.5, 'primera escritura');
    vi.setSystemTime(new Date(before.getTime() + 2 * 60_000)); // 00:01 del día siguiente
    expect(costToday(h.orch.ctx)).toBe(0); // lo escrito pertenece al run de ayer
    adapterIn(repoA).push(usage(2, { costUsd: 0.8 })); // +0.3 gastado ya hoy, sin escribir aún (escritura limitada)
    await h.waitFor(() => h.orch.ctx.live.get(ta.id)?.usage.costUsd === 0.8, 'uso en memoria');
    expect(h.orch.ctx.repos.runs.get(h.orch.ctx.live.get(ta.id)!.runId)!.cost_usd).toBe(0.5);
    expect(costToday(h.orch.ctx)).toBeCloseTo(0.3, 6);
  });

  it('4. los relevos en cola van delante del resto pero en orden FIFO entre ellos', async () => {
    harness();
    await h.call('settings.set', { key: 'max_concurrent_runs', value: '1' });
    const A = await openRepo(repoA);
    const B = await openRepo(repoB);
    const ta = await newTask(A.project.id, A.worker.id);
    const t1 = await newTask(B.project.id, B.worker.id, 'normal', 'src/n1.ts');
    const r1 = await newTask(B.project.id, B.worker.id, 'relevo 1', 'src/r1.ts');
    const r2 = await newTask(B.project.id, B.worker.id, 'relevo 2', 'src/r2.ts');
    await h.call('task.start', { id: ta.id });
    await h.call('task.start', { id: t1.id });
    await requestStart(h.orch.ctx, r1.id, {}, 'relay');
    await requestStart(h.orch.ctx, r2.id, {}, 'relay');
    expect(h.orch.ctx.queue.map((e) => e.taskId)).toEqual([r1.id, r2.id, t1.id]);
  });

  it('5. tras un corte, los proyectos cerrados no muestran tareas running/needs_you ni aprobaciones pending fantasma', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kiji-stale-'));
    tmps.push(dir);
    const dbPath = join(dir, 'kiji.db');
    harness({ dbPath });
    const first = h;
    const A = await openRepo(repoA);
    const ta = await newTask(A.project.id, A.worker.id);
    await h.call('task.start', { id: ta.id });
    adapterIn(repoA).push({ type: 'permission_request', id: 'p1', tool: 'Bash', input: { command: 'ls' }, risk: 'ask' });
    await h.waitFor(() => task(ta.id).status === 'needs_you', 'pide permiso');
    await first.orch.shutdown();
    await first.orch.whenIdle();
    first.orch.ctx.db.exec(`UPDATE tasks SET status = 'needs_you'; UPDATE runs SET status = 'running', ended_at = NULL; UPDATE approvals SET status = 'pending'`);
    first.orch.ctx.repos.projects.setOpen(A.project.id, false); // el proyecto quedó cerrado
    first.orch.ctx.db.close();

    harness({ dbPath }); // core nuevo: no reabre nada
    const item = (await h.call('project.list')).find((p: any) => p.projectId === A.project.id);
    expect(item).toMatchObject({ open: false, needsYou: 0, approvalsPending: 0, tasksByStatus: { blocked: 1 } });
    expect(h.orch.ctx.repos.runs.latestByTask(ta.id)!.status).toBe('cancelled');
    const w = (await h.call('workspaces.overview')).workspaces.find((x: any) => x.projectId === A.project.id);
    expect(w).toMatchObject({ approvalsPending: 0, needsYou: 0 });
  });
});
