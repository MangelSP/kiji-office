// 0.2d base: objetivos, revisión, integración (apply / revert / list), memoria, avisos y runs.started_by.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { git, removeRepo } from '../git/helpers.js';
import { notify, stripAbsolutePaths } from '../../src/orchestrator/notifications.js';
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

const repos = () => h.orch.ctx.repos;
const task = (id: string) => repos().tasks.get(id)!;
const events = (name: string) => h.emitted.filter((e) => e.name === name);

async function open() {
  const project = await h.call('project.open', { path: repo });
  const worker = (await h.call('agent.list', { projectId: project.id })).find((a: any) => a.is_boss === 0);
  return { project, worker };
}

/** Crea una tarea sobre `file`, la arranca, el "agente" escribe `content` y termina: la deja en `review`. */
async function toReview(projectId: string, workerId: string, title: string, file: string, content: string, extra: Record<string, unknown> = {}) {
  const t = await h.call('task.create', { projectId, title, files: [file], agent_id: workerId, ...extra });
  await h.call('task.start', { id: t.id, projectId });
  const adapter = h.adapters.at(-1)!;
  writeFileSync(join(adapter.spec!.cwd, file), content);
  adapter.push({ type: 'done', text: 'listo' });
  await h.waitFor(() => task(t.id).status === 'review', `${title} en review`);
  return t.id as string;
}
const approved = async (projectId: string, workerId: string, title: string, file: string, content: string) => {
  const id = await toReview(projectId, workerId, title, file, content);
  await h.call('task.review', { id, verdict: 'approve' });
  return id;
};

describe('objetivos', () => {
  it('objective.create devuelve planning y emite objective.changed; objective.list cuenta tareas por estado', async () => {
    const { project, worker } = await open();
    const o = await h.call('objective.create', { projectId: project.id, text: '  Hacer login  ' });
    expect(o).toMatchObject({ projectId: project.id, text: 'Hacer login', status: 'planning', tasksByStatus: {} });
    expect(events('objective.changed').at(-1)!.payload).toMatchObject({ id: o.id, status: 'planning' });
    await expect(h.call('objective.create', { projectId: project.id, text: ' ' })).rejects.toThrow(/text/);

    const t = await h.call('task.create', { projectId: project.id, title: 'a', files: ['src/a.ts'], agent_id: worker.id, objectiveId: o.id });
    expect(repos().tasks.get(t.id)!.objective_id).toBe(o.id);
    const listed = await h.call('objective.list', { projectId: project.id });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: o.id, status: 'active', tasksByStatus: { assigned: 1 } });
    expect(events('objective.changed').at(-1)!.payload).toMatchObject({ id: o.id, status: 'active', tasksByStatus: { assigned: 1 } });
  });

  it('sin objectiveId sigue usando "Tareas sueltas"; un objetivo de otro proyecto se rechaza', async () => {
    const { project, worker } = await open();
    const t = await h.call('task.create', { projectId: project.id, title: 'suelta', files: ['src/a.ts'], agent_id: worker.id });
    expect(repos().objectives.get(task(t.id).objective_id)!.text).toBe('Tareas sueltas');
    const other = repos().projects.create({ path: '/otro', name: 'otro' });
    const foreign = repos().objectives.create({ projectId: other.id, text: 'ajeno' });
    await expect(h.call('task.create', { projectId: project.id, title: 'x', objectiveId: foreign.id })).rejects.toThrow(/no existe en este proyecto/);
    await expect(h.call('task.create', { projectId: project.id, title: 'x', objectiveId: 'nope' })).rejects.toThrow(/no existe/);
  });
});

describe('task.review', () => {
  it('approve -> approved; changes -> changes con hallazgos que viajan en el prompt del siguiente run', async () => {
    const { project, worker } = await open();
    const id = await toReview(project.id, worker.id, 'uno', 'src/a.ts', 'export const a = 2;\n');
    await expect(h.call('task.review', { id, verdict: 'quizas' })).rejects.toThrow(/verdict/);
    await expect(h.call('task.review', { id, verdict: 'changes', findings: [1] })).rejects.toThrow(/findings/);
    const v = await h.call('task.review', { id, projectId: project.id, verdict: 'changes', findings: ['falta un test', ' ', 'renombra a2'] });
    expect(v.status).toBe('changes');
    await expect(h.call('task.review', { id, verdict: 'approve' })).rejects.toThrow(/solo se revisan/);

    await h.call('task.start', { id });
    const prompt = h.adapters.at(-1)!.spec!.prompt;
    expect(prompt).toContain('Hallazgo de la revisión anterior');
    expect(prompt).toContain('- falta un test');
    expect(prompt).toContain('- renombra a2');
    h.adapters.at(-1)!.push({ type: 'done', text: 'otra vez' });
    await h.waitFor(() => task(id).status === 'review', 'de nuevo en review');
    expect((await h.call('task.review', { id, verdict: 'approve' })).status).toBe('approved');
  });

  it('rechaza un projectId que no es el de la tarea', async () => {
    const { project, worker } = await open();
    const id = await toReview(project.id, worker.id, 'uno', 'src/a.ts', 'export const a = 3;\n');
    await expect(h.call('task.review', { id, projectId: 'otro', verdict: 'approve' })).rejects.toThrow(/no pertenece/);
  });
});

describe('integración', () => {
  it('apply: rebase, tests, merge ff-only, fila applied, tarea integrated, archivos liberados y worktree fuera', async () => {
    const { project, worker } = await open();
    const id = await approved(project.id, worker.id, 'cambia a', 'src/a.ts', 'export const a = 42;\n');
    const wt = task(id).worktree_path!;
    expect(existsSync(wt)).toBe(true);
    // la rama base avanza por otro lado: hace falta rebase
    writeFileSync(join(repo, 'src', 'other.ts'), 'export const other = 2;\n');
    git(repo, 'commit', '-am', 'main avanza');

    const view = await h.call('integration.apply', { id, projectId: project.id });
    expect(view).toMatchObject({ projectId: project.id, taskId: id, status: 'applied' });
    expect(view.beforeSha).toMatch(/^[0-9a-f]{40}$/);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(view.afterSha);
    expect(readFileSync(join(repo, 'src', 'a.ts'), 'utf8')).toBe('export const a = 42;\n');
    expect(readFileSync(join(repo, 'src', 'other.ts'), 'utf8')).toContain('= 2'); // lo de main se conserva
    expect(task(id)).toMatchObject({ status: 'integrated', worktree_path: null });
    expect(existsSync(wt)).toBe(false);
    expect(git(repo, 'branch', '--list', `kiji/${id}`)).toBe('');
    expect(repos().taskFiles.list(id, true)).toHaveLength(0);
    expect(events('integration.changed').at(-1)!.payload).toMatchObject({ id: view.id, status: 'applied' });
    expect(events('task.changed').at(-1)!.payload).toMatchObject({ id, status: 'integrated' });
    expect(events('notify').map((e) => e.payload.title)).toContain('Integrado: «cambia a»');
    // la tarea era la única de "Tareas sueltas": el objetivo queda done
    expect(repos().objectives.get(task(id).objective_id)!.status).toBe('done');
    expect(await h.call('integration.list', { projectId: project.id })).toMatchObject([{ id: view.id, status: 'applied' }]);
    await expect(h.call('integration.apply', { id })).rejects.toThrow(/solo se integran las aprobadas/);
  });

  it('revert: deja el repo como antes, la fila reverted y la tarea integrated; no se revierte dos veces', async () => {
    const { project, worker } = await open();
    const id = await approved(project.id, worker.id, 'cambia a', 'src/a.ts', 'export const a = 42;\n');
    const before = git(repo, 'rev-parse', 'HEAD');
    const view = await h.call('integration.apply', { id });
    const rev = await h.call('integration.revert', { integrationId: view.id, projectId: project.id });
    expect(rev).toMatchObject({ id: view.id, status: 'reverted' });
    expect(readFileSync(join(repo, 'src', 'a.ts'), 'utf8')).toBe('export const a = 1;\n');
    expect(git(repo, 'rev-parse', 'HEAD')).not.toBe(before); // el revert es un commit nuevo
    expect(task(id).status).toBe('integrated');
    expect(events('integration.changed').at(-1)!.payload.status).toBe('reverted');
    await expect(h.call('integration.revert', { integrationId: view.id })).rejects.toThrow(/solo se revierten las aplicadas/);
    await expect(h.call('integration.revert', { integrationId: '999' })).rejects.toThrow(/inexistente/);
  });

  it('conflicto de rebase: tarea blocked con los archivos, fila failed, main intacto', async () => {
    const { project, worker } = await open();
    const id = await approved(project.id, worker.id, 'choca', 'src/a.ts', 'export const a = 100;\n');
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 7;\n');
    git(repo, 'commit', '-am', 'main toca a.ts');
    const head = git(repo, 'rev-parse', 'HEAD');

    const view = await h.call('integration.apply', { id });
    expect(view.status).toBe('failed');
    expect(view.detail).toContain('src/a.ts');
    expect(task(id).status).toBe('blocked');
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(repo, 'status', '--porcelain', '--untracked-files=no')).toBe('');
    expect(existsSync(task(id).worktree_path!)).toBe(true);
    expect(events('notify').some((e) => e.payload.level === 'warn' && e.payload.title.includes('No se pudo integrar'))).toBe(true);
  });

  it('tests fallidos: tarea changes con la salida recortada en el hallazgo, nada se integra', async () => {
    const { project, worker } = await open();
    const id = await approved(project.id, worker.id, 'rompe', 'src/a.ts', 'export const a = 5;\n');
    repos().projects.update(project.id, { testCommand: `node -e "console.log('x'.repeat(5000)); console.log('BOOM'); process.exit(3)"` });
    h.orch.ctx.projects.set(project.id, repos().projects.get(project.id)!);
    const head = git(repo, 'rev-parse', 'HEAD');

    const view = await h.call('integration.apply', { id });
    expect(view.status).toBe('failed');
    expect(view.detail.length).toBeLessThanOrEqual(2000);
    expect(task(id).status).toBe('changes');
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
    await h.call('task.start', { id });
    const prompt = h.adapters.at(-1)!.spec!.prompt;
    expect(prompt).toContain('fallaron los tests al integrar');
    expect(prompt).toContain('BOOM');
    expect(prompt.length).toBeLessThan(3000);
  });

  it('repo principal sucio o en otra rama: falla con mensaje claro y no toca nada', async () => {
    const { project, worker } = await open();
    const id = await approved(project.id, worker.id, 'cambia a', 'src/a.ts', 'export const a = 42;\n');
    writeFileSync(join(repo, 'src', 'other.ts'), 'trabajo de la persona sin guardar\n');
    await expect(h.call('integration.apply', { id })).rejects.toThrow(/cambios sin guardar \(src\/other\.ts\)/);
    expect(readFileSync(join(repo, 'src', 'other.ts'), 'utf8')).toBe('trabajo de la persona sin guardar\n');
    git(repo, 'checkout', '--', 'src/other.ts');
    git(repo, 'checkout', '-b', 'otra');
    await expect(h.call('integration.apply', { id })).rejects.toThrow(/rama «otra» y debería estar en «main»/);
    expect(task(id).status).toBe('approved');
    expect(repos().integrations.list(project.id)).toHaveLength(0);
    git(repo, 'checkout', 'main');
    expect((await h.call('integration.apply', { id })).status).toBe('applied'); // y luego sí
  });

  it('una integración a la vez por proyecto: dos apply seguidos se encadenan', async () => {
    const { project, worker } = await open();
    const a = await approved(project.id, worker.id, 'uno', 'src/a.ts', 'export const a = 10;\n');
    const b = await approved(project.id, worker.id, 'dos', 'src/other.ts', 'export const other = 20;\n');
    const [va, vb] = await Promise.all([h.call('integration.apply', { id: a }), h.call('integration.apply', { id: b })]);
    expect([va.status, vb.status]).toEqual(['applied', 'applied']);
    expect(vb.beforeSha).toBe(va.afterSha); // el segundo partió del resultado del primero
    expect(h.orch.ctx.integrationLocks.size).toBe(0);
    expect((await h.call('integration.list', { projectId: project.id })).map((i: any) => i.taskId)).toEqual([b, a]);
  });

  it('una consulta de solo lectura no se integra', async () => {
    const { project, worker } = await open();
    const t = await h.call('task.create', { projectId: project.id, title: 'pregunta', agent_id: worker.id });
    await h.call('task.start', { id: t.id });
    h.adapters.at(-1)!.push({ type: 'done', text: 'respuesta' });
    await h.waitFor(() => task(t.id).status === 'review', 'review');
    await h.call('task.review', { id: t.id, verdict: 'approve' });
    // una consulta aprobada queda integrada directamente: no hay nada que integrar ni fila de integrations
    expect(task(t.id).status).toBe('integrated');
    expect(repos().integrations.getByTask(t.id)).toBeUndefined();
    await expect(h.call('integration.apply', { id: t.id })).rejects.toThrow(/solo se integran las aprobadas/);
  });
});

describe('memoria', () => {
  it('add / list / búsqueda FTS5 con consulta hostil / archive', async () => {
    const { project } = await open();
    const m1 = await h.call('memory.add', { projectId: project.id, kind: 'fact', text: 'Cada tarea usa su worktree' });
    const m2 = await h.call('memory.add', { kind: 'preference', text: 'Responder en español' });
    expect(m1).toMatchObject({ source: 'user', archived: false, kind: 'fact', projectId: project.id });
    await expect(h.call('memory.add', { kind: 'fact', text: 'x'.repeat(2001) })).rejects.toThrow(/2000/);
    await expect(h.call('memory.add', { kind: 'raro', text: 'x' })).rejects.toThrow(/kind/);
    expect((await h.call('memory.list', {})).map((m: any) => m.id)).toEqual([m2.id, m1.id]);
    expect((await h.call('memory.list', { query: 'worktree' })).map((m: any) => m.id)).toEqual([m1.id]);
    for (const q of ['"', 'worktree OR', 'NEAR(', '*', 'a:b', '-x']) await expect(h.call('memory.list', { query: q })).resolves.toBeDefined();
    expect((await h.call('memory.archive', { id: m1.id })).archived).toBe(true);
    expect(await h.call('memory.list', { query: 'worktree' })).toEqual([]);
    expect(await h.call('memory.list', { query: 'worktree', includeArchived: true })).toHaveLength(1);
    await expect(h.call('memory.archive', { id: 9999 })).rejects.toThrow(/inexistente/);
    await expect(h.call('memory.archive', { id: m2.id, projectId: 'otro' })).rejects.toThrow(/no pertenece/);
  });
});

describe('avisos', () => {
  it('notify recorta a 120, quita rutas absolutas y emite el evento; list / markRead', async () => {
    const { project } = await open();
    const row = notify(h.orch.ctx, {
      projectId: project.id, level: 'warn', title: 'Falló /Users/ana/repo/src/app.ts',
      body: `Error en /Users/ana/repo/src/app.ts:12 y C:\\Users\\ana\\x\\y.rs ${'z'.repeat(200)}`,
    });
    expect(row.title).toBe('Falló app.ts');
    expect(row.body.length).toBe(120);
    expect(row.body.startsWith('Error en app.ts:12 y y.rs zzz')).toBe(true);
    expect(row.body).not.toMatch(/Users|\/repo/);
    expect(events('notify').at(-1)!.payload).toEqual({ projectId: project.id, id: row.id, level: 'warn', title: row.title, body: row.body });
    notify(h.orch.ctx, { projectId: project.id, level: 'ask', title: 't', body: 'b', approvalId: 'ap1' });
    expect(events('notify').at(-1)!.payload.approvalId).toBe('ap1');

    expect(stripAbsolutePaths('usa a/b y y/o; ver (/etc/hosts), ok')).toBe('usa a/b y y/o; ver (hosts), ok');
    const all = await h.call('notifications.list', { projectId: project.id });
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({ approvalId: 'ap1', readAt: null });
    expect(await h.call('notifications.markRead', { ids: [row.id] })).toEqual({ marked: 1 });
    expect(await h.call('notifications.list', { unreadOnly: true })).toHaveLength(1);
    expect(await h.call('notifications.markRead', { ids: 'all' })).toEqual({ marked: 1 });
    expect(await h.call('notifications.list', { unreadOnly: true })).toEqual([]);
    await expect(h.call('notifications.markRead', { ids: 'x' })).rejects.toThrow(/ids/);
  });

  it('se avisa cuando una tarea necesita permiso y cuando termina', async () => {
    const { project, worker } = await open();
    const t = await h.call('task.create', { projectId: project.id, title: 'pide', files: ['src/a.ts'], agent_id: worker.id });
    await h.call('task.start', { id: t.id });
    h.adapters.at(-1)!.push({ type: 'permission_request', id: 'p1', tool: 'Bash', input: { command: 'ls /Users/x/secreto' }, risk: 'ask' });
    await h.waitFor(() => task(t.id).status === 'needs_you', 'needs_you');
    const ask = events('notify').find((e) => e.payload.title === 'Clau te necesita')!.payload;
    expect(ask).toMatchObject({ level: 'ask', projectId: project.id });
    expect(ask.approvalId).toBeTruthy();
    expect(ask.body).not.toContain('secreto');
    const approval = repos().approvals.listPending()[0]!;
    await h.call('approval.answer', { id: approval.id, allow: true });
    h.adapters.at(-1)!.push({ type: 'done', text: 'fin' });
    await h.waitFor(() => task(t.id).status === 'review', 'review');
    expect(events('notify').some((e) => e.payload.title === 'Clau terminó: «pide»' && e.payload.level === 'info')).toBe(true);
  });

  it('el tope de gasto diario avisa', async () => {
    const { project, worker } = await open();
    repos().settings.set('daily_budget_usd', '1');
    const t1 = await h.call('task.create', { projectId: project.id, title: 'gasta', files: ['src/a.ts'], agent_id: worker.id });
    await h.call('task.start', { id: t1.id });
    h.adapters.at(-1)!.push({ type: 'done', text: 'fin', costUsd: 5 });
    await h.waitFor(() => task(t1.id).status === 'review', 'review');
    const t2 = await h.call('task.create', { projectId: project.id, title: 'no cabe', files: ['src/other.ts'], agent_id: worker.id });
    const v = await h.call('task.start', { id: t2.id });
    expect(v.queued).toBe(true);
    const n = events('notify').find((e) => e.payload.title === 'Tope de gasto alcanzado')!;
    expect(n.payload).toMatchObject({ level: 'warn', projectId: project.id });
  });
});

describe('runs.started_by', () => {
  it('task.start deja user; startedBy: manager se guarda y un relanzamiento sin indicar lo hereda', async () => {
    const { project, worker } = await open();
    const t = await h.call('task.create', { projectId: project.id, title: 'x', files: ['src/a.ts'], agent_id: worker.id });
    await h.call('task.start', { id: t.id });
    expect(repos().runs.latestByTask(t.id)!.started_by).toBe('user');
    await h.call('task.stop', { id: t.id });

    const { requestStart } = await import('../../src/orchestrator/queue.js');
    await requestStart(h.orch.ctx, t.id, { startedBy: 'manager' });
    expect(repos().runs.latestByTask(t.id)!.started_by).toBe('manager');
    expect(repos().runs.listByTask(t.id).map((r) => r.started_by)).toEqual(['user', 'manager']);
    await h.call('task.stop', { id: t.id });
    await h.call('task.start', { id: t.id }); // la persona vuelve a arrancarla
    expect(repos().runs.latestByTask(t.id)!.started_by).toBe('user');
  });
});
