// Revisión 0.2d: integración en segundo plano, parada global (halted) y reloj inyectado del gerente.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { git, removeRepo } from '../git/helpers.js';
import { applyAndWait } from '../orchestrator/helpers.js';
import { makeManagerHarness, type MgrHarness } from './helpers.js';

let m: MgrHarness;
let extra: MgrHarness[] = [];
let tmp: string | null = null;
afterEach(async () => {
  for (const x of [m, ...extra]) await x?.h.orch.shutdown();
  removeRepo(m.repo);
  extra = [];
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

const SLOW_TESTS = `node -e "setTimeout(() => {}, 1500)"`;
const finals = (taskId: string) => m.h.emitted.filter((e) => e.name === 'integration.changed' && e.payload.taskId === taskId && ['done', 'failed'].includes(e.payload.phase));
const approvedTask = async (slow = true) => {
  const id = await m.toReview('Feature', 'src/a.ts', 'export const a = 9;\n');
  await m.h.call('task.review', { id, verdict: 'approve' });
  if (slow) {
    m.repos.projects.update(m.project.id, { testCommand: SLOW_TESTS });
    m.ctx.projects.set(m.project.id, m.repos.projects.get(m.project.id)!);
  }
  return id;
};
const inTests = (id: string) => m.h.waitFor(() => m.h.emitted.some((e) => e.name === 'integration.changed' && e.payload.taskId === id && e.payload.phase === 'tests'), 'fase tests');

describe('integración en segundo plano', () => {
  it('integration.apply responde ya {phase:started}; ping/stopAll responden con los tests en marcha y la parada impide el merge (halted)', async () => {
    m = await makeManagerHarness();
    const id = await approvedTask();
    const head = git(m.repo, 'rev-parse', 'HEAD');
    const t0 = Date.now();
    expect(await m.h.call('integration.apply', { id })).toEqual({ phase: 'started', taskId: id });
    expect(Date.now() - t0).toBeLessThan(1000);
    await inTests(id);
    expect(finals(id)).toHaveLength(0); // sigue integrando
    expect(await m.h.call('manager.get', { projectId: m.project.id })).toMatchObject({ halted: false });
    expect(await m.h.call('manager.stopAll')).toEqual({ halted: true });
    expect(finals(id)).toHaveLength(0); // stopAll no esperó a la integración
    await m.h.waitFor(() => finals(id).length === 1, 'integración terminada', 30_000);
    expect(finals(id)[0]!.payload).toMatchObject({ status: 'failed', reason: 'halted' });
    expect(m.repos.tasks.get(id)!.status).toBe('approved'); // la tarea sigue aprobada
    expect(git(m.repo, 'rev-parse', 'HEAD')).toBe(head);
    expect(m.h.emitted.some((e) => e.name === 'notify' && e.payload.level === 'warn' && e.payload.title.includes('No se pudo integrar'))).toBe(true);
    await m.h.call('manager.resume');
    expect((await applyAndWait(m.h, id)).status).toBe('applied');
  }, 40_000); // espera hasta 30 s a git y a unos tests lentos: con 5 s fallaba con la máquina cargada

  it('con la parada ya activa, integrar falla con reason halted sin tocar nada', async () => {
    m = await makeManagerHarness();
    const id = await approvedTask(false);
    await m.h.call('manager.stopAll');
    expect(await applyAndWait(m.h, id)).toMatchObject({ status: 'failed', reason: 'halted' });
    expect(m.repos.tasks.get(id)!.status).toBe('approved');
  });

  it('approval.answer de integrate:ask responde ya (pending) y el router sigue libre mientras corre', async () => {
    m = await makeManagerHarness();
    await m.enable({ levels: { integrate: 'ask' } });
    const id = await approvedTask();
    await m.invoke('request_integration', { taskId: id });
    const ap = m.repos.approvals.listPending()[0]!;
    const t0 = Date.now();
    expect(await m.h.call('approval.answer', { id: ap.id, allow: true })).toMatchObject({ ok: true, status: 'approved', pending: true });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(m.repos.tasks.get(id)!.status).toBe('approved'); // todavía integrando
    expect(await m.h.call('manager.get', { projectId: m.project.id })).toMatchObject({ halted: false });
    await m.h.waitFor(() => m.repos.tasks.get(id)!.status === 'integrated', 'integrada', 30_000);
    await m.h.waitFor(() => m.repos.managerActions.listByProject(m.project.id).some((a) => a.tool === 'request_integration' && a.decided_by === 'user'), 'diario');
  }, 40_000);

  it('si la acción aprobada lanza, queda en el diario y avisa', async () => {
    m = await makeManagerHarness();
    await m.enable({ levels: { start: 'ask' } });
    const t = await m.task('x');
    await m.invoke('start_task', { taskId: t.id });
    const ap = m.repos.approvals.listPending()[0]!;
    m.repos.tasks.setStatus(t.id, 'integrated'); // ya no se puede arrancar: la ejecución falla
    await m.h.call('approval.answer', { id: ap.id, allow: true });
    await m.h.waitFor(() => m.repos.managerActions.listByProject(m.project.id).some((a) => a.tool === 'start_task' && a.decided_by === 'user'), 'resuelta');
    const act = m.repos.managerActions.listByProject(m.project.id).find((a) => a.tool === 'start_task')!;
    expect(JSON.parse(act.result)).toMatchObject({ ok: false });
    expect(m.h.emitted.some((e) => e.name === 'notify' && e.payload.level === 'warn' && e.payload.title === 'No se pudo hacer lo aprobado')).toBe(true);
  });
});

describe('parada global', () => {
  it('con ctx.halted, un SÍ a una pregunta del gerente lanza sin decidir; un NO sí se admite', async () => {
    m = await makeManagerHarness();
    await m.enable({ levels: { start: 'ask' } });
    const t = await m.task('x');
    await m.invoke('start_task', { taskId: t.id });
    const ap = m.repos.approvals.listPending()[0]!;
    m.ctx.halted = true;
    await expect(m.h.call('approval.answer', { id: ap.id, allow: true })).rejects.toThrow(/Parada global activa/);
    expect(m.repos.approvals.get(ap.id)!.status).toBe('pending');
    expect(m.ctx.managerAsks.has(ap.id)).toBe(true);
    m.ctx.halted = false;
    await m.h.call('approval.answer', { id: ap.id, allow: true });
    expect(m.repos.approvals.get(ap.id)!.status).toBe('approved');
  });

  it('manager.halted se emite al arrancar con la parada persistida y en los early-return de stopAll/resume', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'kiji-mgr-'));
    const dbPath = join(tmp, 'k.db');
    m = await makeManagerHarness({ dbPath });
    const halted = (h: MgrHarness) => h.h.emitted.filter((e) => e.name === 'manager.halted').map((e) => e.payload.halted);
    m.h.orch.announceHalted();
    expect(halted(m)).toEqual([]); // sin parada no hay nada que anunciar
    await m.h.call('manager.stopAll');
    await m.h.call('manager.stopAll');
    expect(halted(m)).toEqual([true, true]);
    const again = await makeManagerHarness({ dbPath, repo: m.repo });
    extra.push(again);
    expect(halted(again)).toEqual([]);
    again.h.orch.announceHalted();
    expect(halted(again)).toEqual([true]);
    await again.h.call('manager.resume');
    await again.h.call('manager.resume');
    expect(halted(again)).toEqual([true, false, false]);
  });
});

describe('reloj inyectado', () => {
  const firstTick = async (now: () => number) => {
    m = await makeManagerHarness({ manager: { now } });
    await m.enable({ maxTicksPerHour: 1 });
    m.ctx.manager!.trigger(m.project.id, 'timer');
    await m.h.waitFor(() => m.ticksEnded() >= 1, 'primer tick');
  };

  it('maxTicksPerHour: dentro de la hora del reloj del gerente no hay segundo despertar', async () => {
    await firstTick(() => Date.now());
    m.ctx.manager!.trigger(m.project.id, 'task.changed', 'a');
    await new Promise((r) => setTimeout(r, 150));
    expect(m.ticksEnded()).toBe(1);
  });

  it('maxTicksPerHour: pasada la hora (falsa) vuelve a despertar', async () => {
    let offset = 0;
    await firstTick(() => Date.now() + offset);
    offset = 61 * 60_000;
    m.ctx.manager!.trigger(m.project.id, 'task.changed', 'b');
    await m.h.waitFor(() => m.ticksEnded() >= 2, 'segundo tick tras la hora falsa');
  });
});
