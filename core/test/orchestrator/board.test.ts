// Pizarra 0.4a: columna automática en cada transición, board.moved y board.move.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeRepo } from '../git/helpers.js';
import { buildState } from '../../src/manager/tools.js';
import { applyAndWait, makeHarness, makeNodeRepo, type Harness } from './helpers.js';

let repo: string;
let h: Harness;
beforeEach(() => { repo = makeNodeRepo(); h = makeHarness(); });
afterEach(async () => { await h.orch.shutdown(); removeRepo(repo); });

const repos = () => h.orch.ctx.repos;
const task = (id: string) => repos().tasks.get(id)!;
const moved = () => h.emitted.filter((e) => e.name === 'board.moved').map((e) => e.payload);

async function open() {
  const project = await h.call('project.open', { path: repo });
  const worker = (await h.call('agent.list', { projectId: project.id })).find((a: any) => a.is_boss === 0);
  return { project, worker };
}
async function toReview(projectId: string, workerId: string) {
  const t = await h.call('task.create', { projectId, title: 'Login', files: ['src/a.ts'], agent_id: workerId });
  await h.call('task.start', { id: t.id, projectId });
  const adapter = h.adapters.at(-1)!;
  writeFileSync(join(adapter.spec!.cwd, 'src/a.ts'), 'export const a = 2;\n');
  adapter.push({ type: 'done', text: 'listo' });
  await h.waitFor(() => task(t.id).status === 'review', 'review');
  return t.id as string;
}

describe('pizarra', () => {
  it('sigue el ciclo de vida, emite board.moved y las vistas llevan board_*', async () => {
    const { project, worker } = await open();
    const boss = repos().agents.list(project.id).find((a) => a.is_boss === 1)!;
    const unassigned = await h.call('task.create', { projectId: project.id, title: 'idea' });
    expect(unassigned).toMatchObject({ board_column: 'refinement', board_manual: 0, board_flag: null });
    expect(moved().at(-1)).toMatchObject({ taskId: unassigned.id, agentId: boss.id, from: null, to: 'refinement', auto: true });

    const id = await toReview(project.id, worker.id);
    expect(moved().filter((m) => m.taskId === id).map((m) => m.to)).toEqual(['refined', 'doing_dev', 'committed']);
    expect(moved().at(-1)).toMatchObject({ agentId: worker.id, from: 'doing_dev', to: 'committed', projectId: project.id, auto: true });
    const changed = h.emitted.filter((e) => e.name === 'task.changed' && e.payload.id === id).at(-1)!;
    expect(changed.payload).toMatchObject({ board_column: 'committed', board_manual: 0, board_flag: null });

    await h.call('task.review', { id, verdict: 'changes', findings: ['el login falla con clave vacía'] });
    expect(task(id).board_column).toBe('bug');
    await h.call('task.start', { id, projectId: project.id });
    expect(task(id).board_column).toBe('fix');
    expect((await h.call('task.list', { projectId: project.id })).find((t: any) => t.id === id)).toMatchObject({ board_column: 'fix' });
    h.adapters.at(-1)!.push({ type: 'done', text: 'arreglado' });
    await h.waitFor(() => task(id).status === 'review', 'review 2');
    await h.call('task.review', { id, verdict: 'approve' });
    expect(task(id).board_column).toBe('functional');
    await applyAndWait(h, id);
    expect(task(id)).toMatchObject({ status: 'integrated', board_column: 'done' });
  });

  it('board.move: manual hasta la siguiente transición, done_prod solo desde done, registro legible', async () => {
    const { project, worker } = await open();
    const id = await toReview(project.id, worker.id);
    await expect(h.call('board.move', { taskId: id, column: 'nada' })).rejects.toThrow(/columna/);
    await expect(h.call('board.move', { taskId: id, column: 'done_prod' })).rejects.toThrow(/Done producción/);
    await expect(h.call('board.move', { taskId: id, projectId: 'otro', column: 'functional' })).rejects.toThrow(/proyecto/);

    const view = await h.call('board.move', { taskId: id, projectId: project.id, column: 'functional' });
    expect(view).toMatchObject({ board_column: 'functional', board_manual: 1 });
    expect(moved().at(-1)).toMatchObject({ taskId: id, from: 'committed', to: 'functional', auto: false });
    expect(h.emitted.filter((e) => e.name === 'task.changed').at(-1)!.payload).toMatchObject({ board_manual: 1 });
    const msgs = repos().events.tail(project.id, { kind: 'status' }).map((e) => JSON.parse(e.payload).message);
    expect(msgs).toContain('Alexis movió «Login» a Prueba funcional');

    await h.call('task.review', { id, verdict: 'approve' }); // transición: vuelve a lo automático
    expect(task(id)).toMatchObject({ board_manual: 0, board_column: 'functional' });
    await applyAndWait(h, id);
    await h.call('board.move', { taskId: id, column: 'done_prod' });
    expect(task(id)).toMatchObject({ board_column: 'done_prod', board_manual: 1 });
  });

  it('get_state del gerente lleva la columna de cada tarea', async () => {
    const { project, worker } = await open();
    const t = await h.call('task.create', { projectId: project.id, title: 'x', files: ['src/a.ts'], agent_id: worker.id });
    const state = buildState(h.orch.ctx, project.id) as { tasks: Array<{ id: string; column: string }> };
    expect(state.tasks.find((x) => x.id === t.id)!.column).toBe('refined');
  });
});
