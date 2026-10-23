// stats.overview: cifras del panel del Home (día local, 7 días, tiempo trabajado, gerente).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

const DAY = 86_400_000;
const HOUR = 3_600_000;

describe('stats.overview', () => {
  it('vacío: todo a cero con 7 días', async () => {
    h = makeHarness();
    const o = await h.call('stats.overview');
    expect(o.cost.perDay7).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(o).toMatchObject({
      projects: { open: 0, total: 0, mostActive: null }, agents: { total: 0, working: 0, queued: 0 },
      workTimeMs: { today: 0, last7: 0 }, manager: { ticksToday: 0, costToday: 0 },
    });
  });

  it('suma por día local, tokens, tiempo de runs, gerente y proyectos; lo de hace 10 días solo entra en el total', async () => {
    h = makeHarness();
    const project = await h.call('project.open', { path: repo });
    const worker = (await h.call('agent.list', { projectId: project.id })).find((a: any) => a.is_boss === 0);
    const t = await h.call('task.create', { projectId: project.id, title: 'x', files: ['src/a.ts'], agent_id: worker.id });
    const ctx = h.orch.ctx;
    const seed = (startedAt: number, endedAt: number, cost: number, i: number, o: number, c: number) => {
      const run = ctx.repos.runs.create({ taskId: t.id, agentId: worker.id, model: 'sonnet' });
      ctx.db.prepare('UPDATE runs SET started_at = ?, ended_at = ?, status = ?, cost_usd = ?, input_tokens = ?, output_tokens = ?, cache_read_tokens = ? WHERE id = ?')
        .run(startedAt, endedAt, 'done', cost, i, o, c, run.id);
    };
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    const day0 = d.getTime();
    seed(day0 + 1000, day0 + 1000 + 2 * HOUR, 1.5, 10, 20, 30); // hoy, 2 h
    seed(day0 + 5000, day0 + 5000 + HOUR / 2, 0.5, 1, 2, 3); // hoy, 30 min
    d.setDate(d.getDate() - 2);
    seed(d.getTime() + 1000, d.getTime() + 1000 + HOUR, 2, 100, 200, 300); // hace 2 días, 1 h
    seed(day0 - 10 * DAY, day0 - 10 * DAY + HOUR, 7, 5, 5, 5); // fuera de los 7 días
    ctx.repos.managerTicks.end(ctx.repos.managerTicks.create({ projectId: project.id, trigger: 'x' }).id, { costUsd: 0.25 });

    const o = await h.call('stats.overview');
    expect(o.cost.perDay7[6]).toBeCloseTo(2);
    expect(o.cost.perDay7[4]).toBeCloseTo(2);
    expect(o.cost.last7).toBeCloseTo(4);
    expect(o.cost.total).toBeCloseTo(11);
    expect(o.tokens.today).toEqual({ in: 11, out: 22, cacheRead: 33 });
    expect(o.tokens.last7).toEqual({ in: 111, out: 222, cacheRead: 333 });
    expect(o.workTimeMs).toEqual({ today: 2.5 * HOUR, last7: 3.5 * HOUR });
    expect(o.manager).toEqual({ ticksToday: 1, costToday: 0.25 });
    expect(o.projects).toMatchObject({ open: 1, total: 1 });
    expect(o.agents.total).toBeGreaterThanOrEqual(2);
  });

  it('un run vivo cuenta su tiempo transcurrido y su consumo aún sin escribir', async () => {
    h = makeHarness();
    const project = await h.call('project.open', { path: repo });
    const worker = (await h.call('agent.list', { projectId: project.id })).find((a: any) => a.is_boss === 0);
    const t = await h.call('task.create', { projectId: project.id, title: 'x', files: ['src/a.ts'], agent_id: worker.id });
    await h.call('task.start', { id: t.id });
    h.adapters[0]!.push({ type: 'usage', model: 'claude-sonnet-4-5', input: 5, output: 6, cacheRead: 7, cacheWrite: 1, contextTokens: 1, contextWindow: 200_000, costUsd: 0.3 });
    await h.waitFor(() => h.orch.ctx.live.get(t.id)?.usage.input === 5, 'uso en memoria');
    await new Promise((r) => setTimeout(r, 20));
    const o = await h.call('stats.overview');
    expect(o.workTimeMs.today).toBeGreaterThan(0);
    expect(o.cost.today).toBeCloseTo(0.3);
    expect(o.tokens.today.in).toBe(5);
  });
});
