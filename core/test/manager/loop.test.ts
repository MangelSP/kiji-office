// D3/D4: bucle por eventos, política, parada global, presupuesto, reinicio.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { removeRepo } from '../git/helpers.js';
import { makeManagerHarness, type MgrHarness } from './helpers.js';

let m: MgrHarness;
let extra: MgrHarness[] = [];
let tmp: string | null = null;
afterEach(async () => {
  for (const x of [m, ...extra]) {
    await x?.h.orch.shutdown();
  }
  removeRepo(m.repo);
  extra = [];
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

const ticks = () => m.repos.managerTicks.list(m.project.id, 100).reverse();
const events = (name: string) => m.h.emitted.filter((e) => e.name === name);
const waitTicks = (n: number) => m.h.waitFor(() => m.ticksEnded() >= n, `${n} tick(s) terminados`);
const hhmm = (ms: number): string => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

describe('bucle', () => {
  it('objective.create → tick → create_tasks + assign + start_task; done guarda la decisión', async () => {
    m = await makeManagerHarness();
    await m.enable();
    m.scripts.push(async (api) => {
      const state = await api.call('get_state');
      expect(state.objectives).toHaveLength(1);
      const created = await api.call('create_tasks', { tasks: [{ title: 'Login', files: ['src/a.ts'], role: 'programador' }, { title: 'Docs', files: ['src/other.ts'] }] });
      for (const t of created.created) await api.call('assign_task', { taskId: t.id });
      await api.call('start_task', { taskId: created.created[0].id });
      await api.call('done', { summary: 'Plan de 2 tareas; arranqué Login.' });
    });
    const objective = await m.h.call('objective.create', { projectId: m.project.id, text: 'Hacer el login' });
    await waitTicks(1);

    // el tick es un run de solo lectura con las herramientas Kiji y el prompt completo
    const spec = m.specs[0]!;
    expect(spec).toMatchObject({ readOnly: true, cwd: m.repo });
    expect(Object.keys(spec.mcpServers!)).toEqual(['kiji']);
    expect(spec.extraTools!.map((t) => t.name)).toContain('request_integration');
    expect(spec.systemPrompt).toContain('gerente');
    expect(spec.prompt).toContain('objective.create');
    expect(spec.prompt).toContain('Hacer el login');
    expect(spec.prompt).toContain('Política de autonomía');
    expect(spec.prompt).toContain('"pendingQuestions"'); // get_state preinyectado

    const tasks = m.repos.tasks.listByProject(m.project.id);
    expect(tasks.map((t) => t.title).sort()).toEqual(['Docs', 'Login']);
    expect(tasks.every((t) => t.objective_id === objective.id && t.agent_id === m.worker.id)).toBe(true);
    const login = tasks.find((t) => t.title === 'Login')!;
    expect(login.status).toBe('running');
    expect(m.repos.runs.latestByTask(login.id)!.started_by).toBe('manager');

    const tick = ticks()[0]!;
    expect(tick).toMatchObject({ trigger: 'objective.create', summary: 'Plan de 2 tareas; arranqué Login.', cost_usd: 0.01 });
    expect(tick.ended_at).not.toBeNull();
    expect(m.repos.managerActions.listByTick(tick.id).map((a) => a.tool)).toEqual(['get_state', 'create_tasks', 'assign_task', 'assign_task', 'start_task', 'done']);
    expect(m.repos.memory.recent(m.project.id)[0]).toMatchObject({ kind: 'decision', source: 'manager', text: 'Plan de 2 tareas; arranqué Login.' });
    expect(events('manager.tick').map((e) => e.payload.phase)).toEqual(['started', 'ended']);
    expect(events('manager.action').length).toBeGreaterThanOrEqual(6);
    const diary = await m.h.call('manager.diary', { projectId: m.project.id });
    expect(diary[0]).toMatchObject({ id: tick.id, summary: tick.summary });
    expect(diary[0].actions).toHaveLength(6);
    expect((await m.h.call('manager.get', { projectId: m.project.id })).todayCostUsd).toBeGreaterThanOrEqual(0.01);
  });

  it('review → request_integration con integrate:ask → aprobación al usuario → sin respuesta: denegado y diario', async () => {
    m = await makeManagerHarness({ manager: { askTimeoutMs: 150 } });
    await m.enable({ levels: { integrate: 'ask' } });
    m.scripts.push(async (api) => {
      const st = await api.call('get_state');
      const t = st.tasks.find((x: any) => x.status === 'review');
      expect((await api.call('review_task', { taskId: t.id, verdict: 'approve' })).status).toBe('approved');
      expect((await api.call('request_integration', { taskId: t.id })).pending).toBe(true);
      await api.call('done', { summary: 'Aprobé; pregunté si integrar.' });
    });
    const id = await m.toReview('Feature', 'src/a.ts', 'export const a = 9;\n');
    await waitTicks(1);

    const req = events('approval.requested').find((e) => e.payload.tool === 'manager:request_integration')!;
    expect(req.payload).toMatchObject({ kind: 'integrate', risk: 'ask', projectId: m.project.id, task_id: id });
    expect(req.payload.input).toMatchObject({ taskId: id });
    expect(events('notify').some((e) => e.payload.level === 'ask' && e.payload.approvalId === req.payload.id)).toBe(true);
    expect(m.repos.tasks.get(id)!.status).toBe('approved'); // NO integró

    // sin respuesta en askTimeoutMs → NO, fail-closed
    await m.h.waitFor(() => m.repos.approvals.get(req.payload.id)!.status === 'denied', 'caducidad');
    expect(m.repos.tasks.get(id)!.status).toBe('approved');
    const act = m.repos.managerActions.listByProject(m.project.id).find((a) => a.tool === 'request_integration')!;
    expect(act).toMatchObject({ level: 'ask', decided_by: 'timeout' });
    expect(JSON.parse(act.result)).toMatchObject({ ok: false, denied: true });
    await expect(m.h.call('approval.answer', { id: req.payload.id, allow: true })).rejects.toThrow(/resuelta/);
    expect(m.repos.integrations.getByTask(id)).toBeUndefined();
    const diary = await m.h.call('manager.diary', { projectId: m.project.id });
    expect(diary.flatMap((d: any) => d.actions).some((a: any) => a.tool === 'request_integration' && a.decidedBy === 'timeout')).toBe(true);
    // la caducidad despierta al gerente: otro tick con el motivo
    await waitTicks(2);
    expect(m.specs[1]!.prompt).toContain('caducó sin respuesta');
  });

  it('integrate:ask → la persona aprueba → se integra (decided_by user) y despierta al gerente', async () => {
    m = await makeManagerHarness();
    await m.enable({ levels: { integrate: 'ask' } });
    const id = await m.toReview('Feature', 'src/a.ts', 'export const a = 9;\n');
    await m.h.call('task.review', { id, verdict: 'approve' });
    await m.invoke('request_integration', { taskId: id });
    const ap = m.repos.approvals.listPending()[0]!;
    await m.h.call('approval.answer', { id: ap.id, allow: true });
    expect(m.repos.tasks.get(id)!.status).toBe('integrated');
    expect(m.repos.integrations.getByTask(id)!.status).toBe('applied');
    await m.h.waitFor(() => m.specs.some((x) => x.prompt.includes('La persona respondió SÍ')), 'tick tras la respuesta');
  });

  it('un permiso que pide el cerebro del tick se deniega siempre (candado)', async () => {
    m = await makeManagerHarness();
    await m.enable();
    m.scripts.push(async (api) => {
      void api;
    });
    // el cerebro emite un permission_request antes del guion: la fábrica de pruebas usa ScriptedBrain con extraEvents
    const m2 = m;
    m2.scripts.length = 0;
    const origin = m2.h.orch.ctx.adapterFactory;
    m2.h.orch.ctx.adapterFactory = (agent) => {
      const b = origin(agent) as any;
      if (agent.is_boss === 1) {
        const start = b.start.bind(b);
        b.start = (spec: any) => (async function* () {
          yield { type: 'permission_request', id: 'p1', tool: 'Bash', input: { command: 'git push' }, risk: 'ask' };
          yield* start(spec);
        })();
      }
      return b;
    };
    m.ctx.manager!.trigger(m.project.id, 'timer');
    await waitTicks(1);
    expect(m.brains[0]!.answers).toEqual([{ id: 'p1', allow: false }]);
    expect(m.repos.approvals.listPending()).toHaveLength(0); // no llegó a ser una aprobación: el gerente no pregunta por los robots
  });

  it('bucle limitado: tick → fallo → retry (máx 2) → tick…; maxTicksPerHour frena los despertares', async () => {
    m = await makeManagerHarness();
    await m.enable({ maxTicksPerHour: 2 });
    const t = await m.task('terca', 'src/a.ts', true);
    let retried = 0;
    const script = async (api: any) => {
      const r = await api.call('retry_task', { taskId: t.id, findings: ['inténtalo distinto'] });
      if (r.ok) retried++;
    };
    for (let i = 0; i < 6; i++) m.scripts.push(script);
    for (let round = 1; round <= 3; round++) {
      const before = m.ticksEnded();
      m.h.adapters.at(-1)!.push({ type: 'error', message: `fallo ${round}`, retryable: false });
      if (round <= 2) {
        await m.h.waitFor(() => m.ticksEnded() > before, `tick ${round}`);
        await m.h.waitFor(() => m.repos.tasks.get(t.id)!.status === 'running', 'reintento en marcha');
      }
    }
    // tercera caída: dos ticks por hora ya gastados → no hay tercer tick
    await new Promise((r) => setTimeout(r, 200));
    expect(retried).toBe(2);
    expect(ticks().filter((x) => !x.trigger.startsWith('skipped'))).toHaveLength(2);
    expect(m.repos.tasks.get(t.id)!.status).toBe('failed');
  });

  it('un tick a la vez y pausa mínima entre ticks: los disparadores se agrupan', async () => {
    m = await makeManagerHarness({ manager: { minTickGapMs: 250 } });
    await m.enable();
    m.scripts.push(async (api) => { await new Promise((r) => setTimeout(r, 60)); void api; });
    m.ctx.manager!.trigger(m.project.id, 'timer');
    await m.h.waitFor(() => ticks().length === 1, 'primer tick');
    m.ctx.manager!.trigger(m.project.id, 'run.ended', 'a');
    m.ctx.manager!.trigger(m.project.id, 'run.ended', 'b');
    m.ctx.manager!.trigger(m.project.id, 'task.changed', 'c');
    await waitTicks(2);
    await new Promise((r) => setTimeout(r, 400));
    expect(ticks()).toHaveLength(2); // los tres disparadores, un solo tick
    expect(ticks()[1]!.trigger).toBe('run.ended+task.changed');
    expect(ticks()[1]!.started_at - ticks()[0]!.started_at).toBeGreaterThanOrEqual(240);
    expect(m.specs[1]!.prompt).toContain('c');
  });

  it('task.changed a review despierta; manager.tick manual con mensaje salta la pausa; apagado = nada', async () => {
    m = await makeManagerHarness({ manager: { minTickGapMs: 60_000 } });
    await expect(m.h.call('manager.tick', { projectId: m.project.id })).rejects.toThrow(/apagado/);
    await m.toReview('sin gerente', 'src/a.ts', 'x\n');
    await new Promise((r) => setTimeout(r, 60));
    expect(ticks()).toHaveLength(0);
    await m.enable();
    await m.toReview('con gerente', 'src/other.ts', 'y\n');
    await waitTicks(1);
    expect(ticks()[0]!.trigger).toContain('task.changed');
    const res = await m.h.call('manager.tick', { projectId: m.project.id, message: 'Prioriza los tests' });
    expect(res.tickId).toBe(ticks().at(-1)!.id);
    await waitTicks(2);
    expect(m.specs[1]!.prompt).toContain('Prioriza los tests');
  });

  it('maxTickMinutes aborta el tick', async () => {
    m = await makeManagerHarness({ manager: { maxTickMs: 120 } });
    await m.enable();
    m.scripts.push(async (api) => { await api.untilStopped(); });
    m.ctx.manager!.trigger(m.project.id, 'timer');
    await waitTicks(1);
    expect(ticks()[0]!.summary).toMatch(/Abortado.*tiempo máximo/);
    expect(m.brains[0]!.stopped).toBe(true);
  });

  it('quietHours: solo avisa, no arranca nada ni despierta al cerebro', async () => {
    m = await makeManagerHarness();
    const now = Date.now();
    await m.enable({ quietHours: { from: hhmm(now - 3_600_000), to: hhmm(now + 3_600_000) } });
    await m.task('x');
    m.ctx.manager!.trigger(m.project.id, 'timer');
    await waitTicks(1);
    expect(m.specs).toHaveLength(0);
    expect(ticks()[0]).toMatchObject({ trigger: 'skipped:quiet-hours' });
    expect(ticks()[0]!.summary).toMatch(/Horas de silencio/);
    expect(events('notify').some((e) => e.payload.title.includes('silencio'))).toBe(true);
    // otro disparador dentro del silencio no repite el aviso
    m.ctx.manager!.trigger(m.project.id, 'timer');
    await new Promise((r) => setTimeout(r, 80));
    expect(ticks()).toHaveLength(1);
    // fuera del silencio sí corre
    await m.enable({ quietHours: { from: hhmm(now + 3_600_000), to: hhmm(now + 7_200_000) } });
    m.ctx.manager!.trigger(m.project.id, 'timer');
    await waitTicks(2);
    expect(m.specs).toHaveLength(1);
  });

  it('tope del día: gerente + sus runs; superado, el tick solo avisa y las herramientas de gasto se niegan', async () => {
    m = await makeManagerHarness();
    await m.enable({ dayBudgetUsd: 1, spendAskUsd: 100 });
    const t = await m.task('x');
    // un run del gerente (started_by manager) gastó 0,8 y un tick 0,3
    const run = m.repos.runs.create({ taskId: t.id, agentId: m.worker.id, model: 'sonnet', startedBy: 'manager' });
    m.repos.runs.update(run.id, { cost_usd: 0.8, status: 'done', ended_at: Date.now() });
    expect((await m.invoke('start_task', { taskId: t.id })).ok).toBe(true); // 0,8 < 1: aún se puede
    m.ctx.manager!.acting(m.project.id, 1);
    m.ctx.manager!.acting(m.project.id, -1);
    await m.h.call('task.stop', { id: t.id });
    const tk = m.repos.managerTicks.create({ projectId: m.project.id, trigger: 'prev' });
    m.repos.managerTicks.end(tk.id, { costUsd: 0.3 });
    expect((await m.h.call('manager.get', { projectId: m.project.id })).todayCostUsd).toBeCloseTo(1.1, 2);
    expect((await m.invoke('start_task', { taskId: t.id })).error).toMatch(/tope del día/);
    m.ctx.manager!.trigger(m.project.id, 'timer');
    await m.h.waitFor(() => ticks().some((x) => x.trigger === 'skipped:day-budget'), 'tick de aviso');
    expect(m.specs).toHaveLength(0);
    expect(events('notify').some((e) => e.payload.level === 'warn' && e.payload.title.includes('tope'))).toBe(true);
    await expect(m.h.call('manager.tick', { projectId: m.project.id })).rejects.toThrow(/Tope del día/);
  });
});

describe('manager.set', () => {
  it('valida claves exactas, rangos y el cerebro del proyecto', async () => {
    m = await makeManagerHarness();
    const good = await m.enable();
    const set = (policy: unknown) => m.h.call('manager.set', { projectId: m.project.id, policy });
    const bad = async (patch: (p: any) => void, re: RegExp) => {
      const p = JSON.parse(JSON.stringify(good));
      patch(p);
      await expect(set(p)).rejects.toThrow(re);
    };
    await bad((p) => { p.levels.revert = 'auto'; }, /"revert" no se admite/);
    await bad((p) => { p.secrets = true; }, /"secrets" no se admite/);
    await bad((p) => { p.brain.apiKey = 'x'; }, /"apiKey" no se admite/);
    await bad((p) => { delete p.levels.spend; }, /levels\.spend/);
    await bad((p) => { p.levels.start = 'yolo'; }, /levels\.start/);
    await bad((p) => { p.dayBudgetUsd = -1; }, /dayBudgetUsd/);
    await bad((p) => { p.maxTicksPerHour = 0; }, /maxTicksPerHour/);
    await bad((p) => { p.maxTickMinutes = 1000; }, /maxTickMinutes/);
    await bad((p) => { p.quietHours = { from: '25:00', to: '08:00' }; }, /HH:MM/);
    await bad((p) => { p.brain.agentId = 'inexistente'; }, /no existe en este proyecto/);
    const other = m.repos.projects.create({ path: '/o', name: 'o' });
    const foreign = m.repos.agents.create({ projectId: other.id, name: 'Z', provider: 'claude', model: 'opus', role: 'jefe', isBoss: true });
    await bad((p) => { p.brain.agentId = foreign.id; }, /no existe en este proyecto/);
    const state = await set({ ...good, quietHours: { from: '23:00', to: '08:00' } });
    expect(state.policy.quietHours).toEqual({ from: '23:00', to: '08:00' });
    expect((await set({ ...good, enabled: false })).policy.enabled).toBe(false);
  });
});

describe('parada global', () => {
  it('stopAll en mitad de 2 runs: ambos assigned, nada arranca, preguntas denegadas, diario y evento; resume lo deja todo', async () => {
    m = await makeManagerHarness();
    await m.enable({ levels: { start: 'ask' } });
    const a = await m.task('uno', 'src/a.ts', true);
    const worker2 = (await m.h.call('agent.create', { projectId: m.project.id, name: 'Dos', provider: 'claude', model: 'sonnet', role: 'programador' }));
    const b = await m.h.call('task.create', { projectId: m.project.id, title: 'dos', files: ['src/other.ts'], agent_id: worker2.id });
    await m.h.call('task.start', { id: b.id });
    expect(m.ctx.live.size).toBe(2);
    const worker3 = await m.h.call('agent.create', { projectId: m.project.id, name: 'Tres', provider: 'claude', model: 'sonnet', role: 'programador' });
    const c = await m.h.call('task.create', { projectId: m.project.id, title: 'tres', files: ['src/n.ts'], agent_id: worker3.id });
    await m.invoke('start_task', { taskId: c.id }); // queda como pregunta pendiente
    expect(m.repos.approvals.listPending()).toHaveLength(1);

    expect(await m.h.call('manager.stopAll')).toEqual({ halted: true });
    expect(m.ctx.live.size).toBe(0);
    expect([a.id, b.id].map((id) => m.repos.tasks.get(id)!.status)).toEqual(['assigned', 'assigned']);
    expect(m.h.adapters.filter((x) => x.stopped)).toHaveLength(2);
    expect(m.repos.approvals.listPending()).toHaveLength(0);
    expect(m.ctx.managerAsks.size).toBe(0);
    expect(events('manager.halted').at(-1)!.payload).toEqual({ halted: true });
    expect(m.repos.projects.get(m.project.id)).toBeTruthy(); // proyecto sigue abierto
    expect(m.ctx.projects.has(m.project.id)).toBe(true);
    await expect(m.h.call('task.start', { id: a.id })).rejects.toThrow(/Parada global/);
    expect((await m.invoke('stop_task', { taskId: a.id })).error).toMatch(/Parada global/);
    await expect(m.h.call('manager.tick', { projectId: m.project.id })).rejects.toThrow(/Parada global/);
    m.ctx.manager!.trigger(m.project.id, 'timer');
    await new Promise((r) => setTimeout(r, 60));
    expect(m.specs).toHaveLength(0);
    const diary = await m.h.call('manager.diary', { projectId: m.project.id });
    expect(diary.flatMap((d: any) => d.actions).map((x: any) => x.tool)).toContain('stopAll');
    expect((await m.h.call('manager.get', { projectId: m.project.id })).halted).toBe(true);
    expect(m.repos.settings.get('manager_halted')).toBe('1');

    expect(await m.h.call('manager.resume')).toEqual({ halted: false });
    expect(events('manager.halted').at(-1)!.payload).toEqual({ halted: false });
    await m.h.call('task.start', { id: a.id });
    expect(m.repos.tasks.get(a.id)!.status).toBe('running');
  });

  it('la parada sobrevive al reinicio del core', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'kiji-mgr-'));
    const dbPath = join(tmp, 'k.db');
    m = await makeManagerHarness({ dbPath });
    await m.h.call('manager.stopAll');
    const again = await makeManagerHarness({ dbPath, repo: m.repo });
    extra.push(again);
    expect(again.ctx.halted).toBe(true);
    const t = again.repos.tasks.listByProject(again.project.id)[0] ?? (await again.h.call('task.create', { projectId: again.project.id, title: 'x', files: ['src/a.ts'], agent_id: again.worker.id }));
    await expect(again.h.call('task.start', { id: t.id })).rejects.toThrow(/Parada global/);
  });
});

describe('reinicio', () => {
  it('no se duplican ticks pendientes: lo abierto se cierra y no se relanza nada', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'kiji-mgr-'));
    const dbPath = join(tmp, 'k.db');
    m = await makeManagerHarness({ dbPath });
    await m.enable({ levels: { start: 'ask' } });
    const t = await m.task('x');
    await m.invoke('start_task', { taskId: t.id }); // pregunta pendiente
    m.scripts.push(async (api) => { await api.untilStopped(); }); // tick colgado
    m.ctx.manager!.trigger(m.project.id, 'timer');
    await m.h.waitFor(() => ticks().some((x) => x.trigger !== 'test' && x.ended_at === null), 'tick en curso');
    m.ctx.manager!.trigger(m.project.id, 'task.changed', 'pendiente en memoria');
    const real = (rows: Array<{ trigger: string }>) => rows.filter((x) => x.trigger !== 'test');
    const countBefore = real(ticks()).length;

    // "reinicio": un core nuevo sobre la misma BD mientras el anterior seguía a medias
    const again = await makeManagerHarness({ dbPath, repo: m.repo });
    extra.push(again);
    await new Promise((r) => setTimeout(r, 150));
    const rows = real(again.repos.managerTicks.list(again.project.id, 100));
    expect(rows).toHaveLength(countBefore);
    expect(rows.every((x) => x.ended_at !== null)).toBe(true);
    expect(rows[0]!.summary).toMatch(/reinicio/);
    expect(again.specs).toHaveLength(0); // ningún tick nuevo
    expect(again.repos.approvals.listPending()).toHaveLength(0); // la pregunta huérfana se da por NO
    expect(again.repos.managerActions.listByProject(again.project.id).find((a) => a.tool === 'start_task')).toMatchObject({ decided_by: 'timeout' });
  });
});
