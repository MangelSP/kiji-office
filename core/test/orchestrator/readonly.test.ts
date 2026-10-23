// Tareas de solo lectura ("consultas"): sin archivos, sin worktree, sin commit, terminan en `review` con `result`.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { git, removeRepo } from '../git/helpers.js';
import { makeHarness, makeNodeRepo, type Harness } from './helpers.js';

let repo: string;
let h: Harness;
beforeEach(() => {
  repo = makeNodeRepo();
  h = makeHarness();
});
afterEach(async () => {
  await h.orch.shutdown();
  removeRepo(repo);
});

async function open() {
  const project = await h.call('project.open', { path: repo });
  const agents = await h.call('agent.list');
  return { project, worker: agents.find((a: any) => a.is_boss === 0) };
}
const task = (id: string) => h.orch.ctx.repos.tasks.get(id)!;

describe('tareas de solo lectura', () => {
  it('task.create sin files (ausente o vacío) crea una consulta que no reserva archivos', async () => {
    const { worker } = await open();
    const a = await h.call('task.create', { title: 'a', agent_id: worker.id });
    const b = await h.call('task.create', { title: 'b', files: [], agent_id: null });
    expect(a).toMatchObject({ status: 'assigned', files: [], read_only: true, result: null });
    expect(b).toMatchObject({ files: [], read_only: true });
    expect(h.orch.ctx.repos.taskFiles.list(a.id)).toEqual([]);
    const c = await h.call('task.create', { title: 'c', files: ['src/a.ts'], agent_id: null });
    expect(c.read_only).toBe(false);
    await expect(h.call('task.create', { title: 'd', files: 'src/a.ts' })).rejects.toThrow(/files/);
  });

  it('start: readOnly, cwd = repo, sin worktree; done -> review con result, sin commit ni tests', async () => {
    const { worker } = await open();
    const t = await h.call('task.create', {
      title: 'Revisar el proyecto',
      description: 'Revisar el proyecto\nExplícame qué hace.',
      agent_id: worker.id,
    });
    const mainBefore = git(repo, 'rev-parse', 'main');

    const started = await h.call('task.start', { id: t.id });
    expect(started).toMatchObject({ status: 'running', read_only: true, branch: null, worktree_path: null });
    const fake = h.adapters[0]!;
    expect(fake.spec).toMatchObject({ readOnly: true, allowedPaths: [], cwd: repo });
    expect(fake.spec!.prompt).toContain('solo lectura');
    expect(fake.spec!.prompt).toContain('Explícame qué hace.');
    expect(fake.spec!.prompt.match(/Revisar el proyecto/g)).toHaveLength(1); // título no repetido
    expect(existsSync(join(repo, '.kiji', 'worktrees', t.id))).toBe(false);

    fake.push({ type: 'text', delta: 'leyendo' }, { type: 'done', text: 'Es una app de oficina.\nTiene 3 módulos.', costUsd: 0.01 });
    fake.end();
    await h.waitFor(() => task(t.id).status === 'review', 'review');
    await h.orch.whenIdle();

    const view = (await h.call('task.list')).find((x: any) => x.id === t.id);
    expect(view).toMatchObject({ status: 'review', read_only: true, result: 'Es una app de oficina.\nTiene 3 módulos.' });
    const changed = h.emitted.filter((e) => e.name === 'task.changed' && e.payload.id === t.id).at(-1)!;
    expect(changed.payload).toMatchObject({ status: 'review', result: 'Es una app de oficina.\nTiene 3 módulos.' });

    // Ni worktree, ni rama, ni commit, ni tests; main intacta.
    expect(task(t.id)).toMatchObject({ branch: null, worktree_path: null });
    expect(existsSync(join(repo, '.kiji', 'worktrees', t.id))).toBe(false);
    expect(git(repo, 'rev-parse', 'main')).toBe(mainBefore);
    expect(h.orch.ctx.repos.testRuns.latestByTask(t.id)).toBeUndefined();
    const events = h.orch.ctx.repos.events.tail(h.orch.ctx.activeProject!.id, { limit: 500 });
    expect(events.filter((e) => e.kind === 'git' || e.kind === 'test')).toEqual([]);
    expect(h.orch.ctx.repos.runs.latestByTask(t.id)).toMatchObject({ status: 'done' });
  });

  it('result se recorta a 20 000 caracteres y las tareas con archivos también lo llevan', async () => {
    const { worker } = await open();
    const ro = await h.call('task.create', { title: 'larga', agent_id: worker.id });
    await h.call('task.start', { id: ro.id });
    h.adapters[0]!.push({ type: 'done', text: 'x'.repeat(30_000) });
    h.adapters[0]!.end();
    await h.waitFor(() => task(ro.id).status === 'review', 'review');
    await h.orch.whenIdle();
    const long = (await h.call('task.list')).find((x: any) => x.id === ro.id);
    expect(long.result.length).toBe(20_000);

    const rw = await h.call('task.create', { title: 'normal', files: ['src/a.ts'], agent_id: worker.id });
    await h.call('task.start', { id: rw.id });
    h.adapters[1]!.push({ type: 'done', text: 'hecho' });
    h.adapters[1]!.end();
    await h.waitFor(() => task(rw.id).status === 'review', 'review normal');
    await h.orch.whenIdle();
    expect((await h.call('task.list')).find((x: any) => x.id === rw.id)).toMatchObject({ read_only: false, result: 'hecho' });
    expect(h.adapters[1]!.spec).not.toHaveProperty('readOnly');
  });
});
