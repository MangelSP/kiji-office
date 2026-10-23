import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorktree } from '../../src/git/worktree.js';
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

/** Abre el proyecto y devuelve proyecto, jefe y trabajador. */
async function open() {
  const project = await h.call('project.open', { path: repo });
  const agents = await h.call('agent.list');
  return { project, boss: agents.find((a: any) => a.is_boss === 1), worker: agents.find((a: any) => a.is_boss === 0) };
}

const task = (id: string) => h.orch.ctx.repos.tasks.get(id)!;

describe('project.open', () => {
  it('crea el proyecto con rama base y comando de tests, el jefe único y a Clau', async () => {
    const { project, boss, worker } = await open();
    expect(project).toMatchObject({ path: repo, base_branch: 'main', test_command: 'npm test' });
    expect(boss).toMatchObject({ name: 'Jefe', role: 'jefe', model: 'opus', provider: 'claude', status: 'idle' });
    expect(worker).toMatchObject({ name: 'Clau', role: 'programador', model: 'sonnet', provider: 'claude' });

    // Reabrir recupera el mismo proyecto y no duplica agentes.
    const again = await h.call('project.open', { path: repo });
    expect(again.id).toBe(project.id);
    expect(await h.call('agent.list')).toHaveLength(2);
    expect(await h.call('project.get')).toMatchObject({ id: project.id });
  });

  it('sin package.json el comando de tests queda vacío; una subcarpeta abre la raíz del repo', async () => {
    git(repo, 'rm', '-q', 'package.json');
    git(repo, 'commit', '-m', 'sin package');
    const project = await h.call('project.open', { path: join(repo, 'src') });
    expect(project.path).toBe(repo);
    expect(project.test_command).toBeNull();
  });

  it('rechaza carpetas que no son repos git o no existen', async () => {
    await expect(h.call('project.open', { path: '/tmp/kiji-no-existe-xyz' })).rejects.toThrow(/no existe/);
    await expect(h.call('project.open', { path: '/' })).rejects.toThrow(/no es un repositorio git/);
    await expect(h.call('project.open', {})).rejects.toThrow(/path/);
  });

  it('un run `running` de una sesión anterior deja la tarea `blocked` y conserva el worktree', async () => {
    // BD en disco para simular el reinicio del core con otro orquestador sobre la misma base.
    const dir = mkdtempSync(join(tmpdir(), 'kiji-db-'));
    const dbPath = join(dir, 'kiji.db');
    try {
      h = makeHarness({ dbPath });
      const { worker } = await open();
      const t = await h.call('task.create', { title: 'x', files: ['src/a.ts'], agent_id: worker.id });
      // Estado que dejaría un core muerto en pleno run: worktree creado, tarea y run en `running`, permiso sin contestar.
      const wt = await createWorktree(repo, t.id, 'main');
      const repos = h.orch.ctx.repos;
      repos.tasks.update(t.id, { status: 'running', branch: `kiji/${t.id}`, worktree_path: wt });
      const run = repos.runs.create({ taskId: t.id, agentId: worker.id });
      const approval = repos.approvals.create({ tool: 'Bash', risk: 'ask', runId: run.id, taskId: t.id });
      h.orch.ctx.db.close();

      const h2 = makeHarness({ dbPath });
      expect(h2.orch.ctx.repos.tasks.get(t.id)!.status).toBe('running'); // aún sin abrir el proyecto
      await h2.call('project.open', { path: repo });

      const r2 = h2.orch.ctx.repos;
      expect(r2.tasks.get(t.id)!.status).toBe('blocked');
      expect(r2.runs.get(run.id)!.status).toBe('cancelled');
      expect(r2.approvals.get(approval.id)!.status).toBe('denied');
      expect(existsSync(wt)).toBe(true);
      expect(h2.emitted.find((e) => e.name === 'task.changed' && e.payload.id === t.id)!.payload.status).toBe('blocked');
      expect(await h2.call('agent.list')).toHaveLength(2); // sin duplicar jefe ni Clau

      // Y se puede relanzar: reutiliza el worktree.
      await h2.call('task.start', { id: t.id });
      expect(h2.adapters[0]!.spec!.cwd).toBe(wt);
      await h2.orch.shutdown();
      h2.orch.ctx.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('agent.create', () => {
  it('crea un trabajador Claude y rechaza otros proveedores y un segundo jefe', async () => {
    await open();
    const a = await h.call('agent.create', { name: 'Pixel', provider: 'claude', model: 'haiku', role: 'tester', color: 'azul' });
    expect(a).toMatchObject({ name: 'Pixel', model: 'haiku', role: 'tester', color: 'azul', is_boss: 0 });
    await expect(h.call('agent.create', { name: 'X', provider: 'codex' })).rejects.toThrow(/paso 15/);
    await expect(h.call('agent.create', { name: 'X', provider: 'api' })).rejects.toThrow(/paso 16/);
    await expect(h.call('agent.create', { name: 'X', provider: 'ollama' })).rejects.toThrow(/paso 16/);
    await expect(h.call('agent.create', { name: 'X', provider: 'claude', role: 'jefe' })).rejects.toThrow(/jefe/);
  });

  it('sin proyecto abierto las listas están vacías y crear falla con un mensaje claro', async () => {
    expect(await h.call('agent.list')).toEqual([]);
    expect(await h.call('task.list')).toEqual([]);
    expect(await h.call('events.tail')).toEqual([]);
    await expect(h.call('task.create', { title: 't', files: ['a'] })).rejects.toThrow(/project\.open/);
  });
});

describe('task.create', () => {
  it('la segunda tarea sobre el mismo archivo falla al crearse y no deja nada', async () => {
    const { worker } = await open();
    await h.call('task.create', { title: 'primera', files: ['src/a.ts'], agent_id: worker.id });
    await expect(h.call('task.create', { title: 'segunda', files: ['src/other.ts', 'src/a.ts'], agent_id: worker.id })).rejects.toThrow(
      /src\/a\.ts \(tarea «primera»\)/,
    );
    const list = await h.call('task.list');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ title: 'primera', status: 'assigned', files: ['src/a.ts'] });
    // other.ts no quedó reservado por la tarea fallida.
    await h.call('task.create', { title: 'tercera', files: ['src/other.ts'], agent_id: null });
  });

  it('valida rutas y agente; sin agente queda en todo y se puede asignar', async () => {
    const { boss, worker } = await open();
    await expect(h.call('task.create', { title: 't', files: ['/etc/passwd'] })).rejects.toThrow(/relativa/);
    await expect(h.call('task.create', { title: 't', files: ['../fuera'] })).rejects.toThrow(/relativa/);
    await expect(h.call('task.create', { title: 't', files: ['.git/config'] })).rejects.toThrow(/\.git/);
    await expect(h.call('task.create', { title: 't', files: ['a'], agent_id: boss.id })).rejects.toThrow(/jefe/);
    await expect(h.call('task.create', { title: '', files: ['a'] })).rejects.toThrow(/title/);

    const t = await h.call('task.create', { title: 'sin agente', files: ['./src//a.ts'], agent_id: null });
    expect(t).toMatchObject({ status: 'todo', agent_id: null, files: ['src/a.ts'] });
    await expect(h.call('task.start', { id: t.id })).rejects.toThrow(/agente/);
    const assigned = await h.call('task.assign', { id: t.id, agent_id: worker.id });
    expect(assigned).toMatchObject({ status: 'assigned', agent_id: worker.id });
    // Las tareas sueltas viven en un único objetivo implícito.
    const objectives = h.orch.ctx.repos.objectives.list(h.orch.ctx.activeProject!.id);
    expect(objectives.map((o) => o.text)).toEqual(['Tareas sueltas']);
  });

  it('emite task.changed con la fila completa y los archivos', async () => {
    const { worker } = await open();
    const t = await h.call('task.create', { title: 'x', files: ['src/a.ts'], agent_id: worker.id });
    const ev = h.emitted.find((e) => e.name === 'task.changed' && e.payload.id === t.id)!;
    expect(ev.payload).toMatchObject({ id: t.id, title: 'x', status: 'assigned', agent_id: worker.id, files: ['src/a.ts'] });
    expect(ev.payload).toHaveProperty('objective_id');
    expect(ev.payload).toHaveProperty('updated_at');
  });
});

describe('flujo completo con adaptador falso', () => {
  it('start -> eventos -> permiso -> approval.answer -> done -> commit + tests -> review', async () => {
    const { worker } = await open();
    const t = await h.call('task.create', { title: 'Añadir sum', files: ['src/a.ts'], agent_id: worker.id });

    const started = await h.call('task.start', { id: t.id });
    expect(started.status).toBe('running');
    const fake = h.adapters[0]!;
    const spec = fake.spec!;
    expect(spec).toMatchObject({ model: 'sonnet', allowedPaths: ['src/a.ts'], budgetUsd: 2 });
    expect(spec.cwd).toBe(join(repo, '.kiji', 'worktrees', t.id));
    expect(spec.systemPrompt).toContain('programador');
    expect(spec.prompt).toContain('Añadir sum');
    expect(spec.prompt).toContain('- src/a.ts');
    expect(h.orch.ctx.repos.tasks.get(t.id)).toMatchObject({ branch: `kiji/${t.id}`, worktree_path: spec.cwd });

    // El agente piensa, escribe y pide permiso para `npm test`.
    fake.push(
      { type: 'thinking' },
      { type: 'text', delta: 'voy a editar' },
      { type: 'tool', name: 'Edit', input: { file_path: join(spec.cwd, 'src/a.ts'), env: { ANTHROPIC_API_KEY: 'sk-ant-api03-secretsecretsecretsecret' } }, status: 'start' },
      { type: 'tool', name: 'Edit', input: undefined, status: 'end', output: 'ok' },
      { type: 'permission_request', id: 'tool-1', tool: 'Bash', input: { command: 'npm test' }, risk: 'ask' },
    );
    await h.waitFor(() => task(t.id).status === 'needs_you', 'needs_you');
    const approvalEv = h.emitted.find((e) => e.name === 'approval.requested')!;
    expect(approvalEv.payload).toMatchObject({ tool: 'Bash', input: { command: 'npm test' }, agent_id: worker.id, task_id: t.id });
    const approvalId = approvalEv.payload.id as string;
    expect(h.orch.ctx.repos.approvals.get(approvalId)).toMatchObject({ status: 'pending', tool: 'Bash', task_id: t.id });
    expect(h.robot(worker.id).at(-1)).toBe('needs_you');

    // La persona aprueba: el adaptador recibe el id propio del adaptador.
    expect(await h.call('approval.answer', { id: approvalId, allow: true })).toMatchObject({ ok: true });
    expect(fake.answers).toEqual([{ id: 'tool-1', allow: true, reason: undefined }]);
    expect(task(t.id).status).toBe('running');
    expect(h.orch.ctx.repos.approvals.get(approvalId)!.status).toBe('approved');
    await expect(h.call('approval.answer', { id: approvalId, allow: true })).rejects.toThrow(/desconocida|resuelta/);

    // El agente edita su archivo y termina.
    writeFileSync(join(spec.cwd, 'src/a.ts'), 'export const a = 1;\nexport const sum = (x: number, y: number) => x + y;\n');
    fake.push({ type: 'done', text: 'listo', sessionId: 'sess-1', costUsd: 0.12, usage: { input: 10, output: 20 } });
    fake.end();
    await h.waitFor(() => task(t.id).status === 'review', 'review');
    await h.orch.whenIdle();

    // Robot: thinking -> writing -> needs_you -> thinking -> done.
    expect(h.robot(worker.id)).toEqual(['thinking', 'writing', 'thinking', 'needs_you', 'thinking', 'done']);

    // Commit en la rama de la tarea y tests guardados.
    expect(git(repo, 'log', '--format=%s', `kiji/${t.id}`).split('\n')[0]).toBe('Añadir sum');
    expect(git(repo, 'show', '--stat', '--format=', `kiji/${t.id}`)).toContain('src/a.ts');
    expect(git(repo, 'rev-parse', 'main')).not.toBe(git(repo, 'rev-parse', `kiji/${t.id}`)); // main intacta
    const testRun = h.orch.ctx.repos.testRuns.latestByTask(t.id)!;
    expect(testRun).toMatchObject({ command: 'npm test', exit_code: 0 });
    const run = h.orch.ctx.repos.runs.latestByTask(t.id)!;
    expect(run).toMatchObject({ status: 'done', cost_usd: 0.12, input_tokens: 10, output_tokens: 20, provider_session_id: 'sess-1' });
    expect(fake.stopped).toBe(true);

    // Eventos persistidos, sin la clave que venía en el `env` ni patrones de claves.
    const events = h.orch.ctx.repos.events.tail(h.orch.ctx.activeProject!.id, { limit: 500 });
    const kinds = new Set(events.map((e) => e.kind));
    for (const k of ['thinking', 'text', 'tool', 'permission', 'status', 'git', 'test']) expect(kinds.has(k as any)).toBe(true);
    const all = events.map((e) => e.payload).join('\n');
    expect(all).not.toMatch(/sk-ant|secretsecret|ANTHROPIC_API_KEY/);
    expect(h.emitted.filter((e) => e.name === 'event.appended').length).toBe(events.length);

    // task.diff muestra el cambio ya confirmado (contra el punto de partida, no contra el tip de main).
    const d = await h.call('task.diff', { id: t.id });
    expect(d.diff).toContain('+export const sum');
    expect(d.files).toEqual(['src/a.ts']);

    // events.tail por la API
    const tail = await h.call('events.tail', { limit: 5 });
    expect(tail).toHaveLength(5);
    expect(typeof tail[0].payload).toBe('object');
    // task.changed pasó por los estados esperados
    const statuses = h.emitted.filter((e) => e.name === 'task.changed' && e.payload.id === t.id).map((e) => e.payload.status);
    expect(statuses).toEqual(['assigned', 'running', 'needs_you', 'running', 'review']);
  });

  it('task.diff incluye los archivos nuevos sin rastrear mientras el run está activo', async () => {
    const { worker } = await open();
    const t = await h.call('task.create', { title: 'nuevo', files: ['src/nuevo.ts'], agent_id: worker.id });
    await expect(h.call('task.diff', { id: t.id })).rejects.toThrow(/worktree/);
    await h.call('task.start', { id: t.id });
    const cwd = h.adapters[0]!.spec!.cwd;
    writeFileSync(join(cwd, 'src/nuevo.ts'), 'export const n = 1;\n');
    const d = await h.call('task.diff', { id: t.id });
    expect(d.diff).toContain('src/nuevo.ts');
    expect(d.diff).toContain('+export const n = 1;');
    expect(d.files).toEqual(['src/nuevo.ts']);
  });

  it('un permiso denegado llega al adaptador con motivo y la tarea sigue', async () => {
    const { worker } = await open();
    const t = await h.call('task.create', { title: 'x', files: ['src/a.ts'], agent_id: worker.id });
    await h.call('task.start', { id: t.id });
    const fake = h.adapters[0]!;
    fake.push({ type: 'permission_request', id: 'p1', tool: 'Bash', input: { command: 'rm -rf dist' }, risk: 'ask' });
    await h.waitFor(() => task(t.id).status === 'needs_you', 'needs_you');
    const id = h.emitted.find((e) => e.name === 'approval.requested')!.payload.id;
    await h.call('approval.answer', { id, allow: false });
    expect(fake.answers[0]).toMatchObject({ id: 'p1', allow: false });
    expect(fake.answers[0]!.reason).toMatch(/denegó/);
    expect(task(t.id).status).toBe('running');
    expect(h.orch.ctx.repos.approvals.get(id)!.status).toBe('denied');
  });

  it('si el run termina con aprobaciones pendientes, quedan `denied`', async () => {
    const { worker } = await open();
    const t = await h.call('task.create', { title: 'x', files: ['src/a.ts'], agent_id: worker.id });
    await h.call('task.start', { id: t.id });
    const fake = h.adapters[0]!;
    fake.push({ type: 'permission_request', id: 'p1', tool: 'Bash', input: {}, risk: 'ask' });
    await h.waitFor(() => task(t.id).status === 'needs_you', 'needs_you');
    const id = h.emitted.find((e) => e.name === 'approval.requested')!.payload.id;
    fake.push({ type: 'done', text: 'fin' });
    await h.waitFor(() => task(t.id).status === 'review', 'review');
    expect(h.orch.ctx.repos.approvals.get(id)!.status).toBe('denied');
    await expect(h.call('approval.answer', { id, allow: true })).rejects.toThrow(/resuelta/);
  });

  it('si fallan los tests la tarea igualmente pasa a review con el test_run guardado', async () => {
    await open();
    h.orch.ctx.db.prepare("UPDATE projects SET test_command = 'node -e \"process.exit(3)\"'").run();
    h.orch.ctx.activeProject = h.orch.ctx.repos.projects.list()[0]!;
    const { worker } = await open();
    const t = await h.call('task.create', { title: 'x', files: ['src/a.ts'], agent_id: worker.id });
    await h.call('task.start', { id: t.id });
    h.adapters[0]!.push({ type: 'done', text: 'fin' });
    await h.waitFor(() => task(t.id).status === 'review', 'review');
    expect(h.orch.ctx.repos.testRuns.latestByTask(t.id)).toMatchObject({ exit_code: 3 });
  });
});

describe('red de seguridad de propiedad', () => {
  it('archivos ajenos -> changes y se revierten; lo permitido no se toca', async () => {
    const { worker } = await open();
    const t = await h.call('task.create', { title: 'solo a', files: ['src/a.ts'], agent_id: worker.id });
    await h.call('task.start', { id: t.id });
    const fake = h.adapters[0]!;
    const cwd = fake.spec!.cwd;

    writeFileSync(join(cwd, 'src/a.ts'), 'export const a = 2;\n'); // permitido
    writeFileSync(join(cwd, 'src/other.ts'), 'export const other = 999;\n'); // ajeno rastreado
    writeFileSync(join(cwd, 'src/intruso.ts'), 'export const x = 1;\n'); // ajeno nuevo
    writeFileSync(join(cwd, 'package.json'), '{"hack":true}\n'); // ajeno rastreado
    git(cwd, 'add', 'src/other.ts'); // además preparado en el índice
    fake.push({ type: 'done', text: 'terminé' });
    await h.waitFor(() => task(t.id).status === 'changes', 'changes');
    await h.orch.whenIdle();

    expect(readFileSync(join(cwd, 'src/other.ts'), 'utf8')).toBe('export const other = 1;\n');
    expect(existsSync(join(cwd, 'src/intruso.ts'))).toBe(false);
    expect(readFileSync(join(cwd, 'package.json'), 'utf8')).toContain('"name": "demo"');
    expect(readFileSync(join(cwd, 'src/a.ts'), 'utf8')).toBe('export const a = 2;\n');
    expect(git(cwd, 'status', '--porcelain')).toBe('M src/a.ts');

    const finding = h.orch.ctx.repos.events.tail(h.orch.ctx.activeProject!.id, { kind: 'git' }).map((e) => JSON.parse(e.payload)).find((p) => p.finding);
    expect(finding.files).toEqual(['package.json', 'src/intruso.ts', 'src/other.ts']);
    expect(finding.message).toMatch(/^tocó archivos ajenos: /);
    expect(h.orch.ctx.repos.testRuns.latestByTask(t.id)).toBeUndefined(); // no se corrieron tests ni hubo commit
    expect(git(repo, 'log', '--format=%s', `kiji/${t.id}`).split('\n')[0]).toBe('node');

    // Reintento: el nuevo prompt incluye el hallazgo y reutiliza el mismo worktree.
    await h.call('task.start', { id: t.id });
    expect(h.adapters[1]!.spec!.cwd).toBe(cwd);
    expect(h.adapters[1]!.spec!.prompt).toContain('tocó archivos ajenos');
  });

  it('un archivo ajeno borrado por el agente se restaura; un archivo permitido borrado no cuenta como ajeno', async () => {
    const { worker } = await open();
    const t = await h.call('task.create', { title: 'a', files: ['src/a.ts'], agent_id: worker.id });
    await h.call('task.start', { id: t.id });
    const cwd = h.adapters[0]!.spec!.cwd;
    const { rmSync } = await import('node:fs');
    rmSync(join(cwd, 'src/other.ts'));
    h.adapters[0]!.push({ type: 'done', text: 'x' });
    await h.waitFor(() => task(t.id).status === 'changes', 'changes');
    expect(existsSync(join(cwd, 'src/other.ts'))).toBe(true);
  });
});

describe('límites, errores y parada', () => {
  it('limit -> paused_limit con resume_hint, y al reanudar se pasa el sessionId', async () => {
    const { worker } = await open();
    const t = await h.call('task.create', { title: 'x', files: ['src/a.ts'], agent_id: worker.id });
    await h.call('task.start', { id: t.id });
    const fake = h.adapters[0]!;
    fake.push({ type: 'limit', kind: 'rate', resetsAt: 1_900_000_000_000, message: 'límite de ritmo', sessionId: 'sess-9' });
    await h.waitFor(() => task(t.id).status === 'paused_limit', 'paused_limit');
    await h.orch.whenIdle();

    const run = h.orch.ctx.repos.runs.latestByTask(t.id)!;
    expect(run.status).toBe('paused_limit');
    expect(JSON.parse(run.resume_hint!)).toEqual({
      worktree: fake.spec!.cwd,
      branch: `kiji/${t.id}`,
      files: ['src/a.ts'],
      sessionId: 'sess-9',
      kind: 'rate',
      resetsAt: 1_900_000_000_000,
    });
    expect(h.robot(worker.id).at(-1)).toBe('idle');
    expect(h.orch.ctx.repos.events.tail(h.orch.ctx.activeProject!.id, { kind: 'limit' })).toHaveLength(1);
    expect(existsSync(fake.spec!.cwd)).toBe(true);

    await h.call('task.start', { id: t.id });
    expect(h.adapters[1]!.spec!.resumeSessionId).toBe('sess-9');
    expect(h.adapters[1]!.spec!.cwd).toBe(fake.spec!.cwd);
    expect(task(t.id).status).toBe('running');
  });

  it('error -> failed (libera los archivos) y robot en error; se puede reintentar', async () => {
    const { worker } = await open();
    const t = await h.call('task.create', { title: 'x', files: ['src/a.ts'], agent_id: worker.id });
    await h.call('task.start', { id: t.id });
    h.adapters[0]!.push({ type: 'error', message: 'se cayó la API', retryable: true });
    await h.waitFor(() => task(t.id).status === 'failed', 'failed');
    await h.orch.whenIdle();
    expect(h.robot(worker.id).at(-1)).toBe('error');
    expect(h.orch.ctx.repos.runs.latestByTask(t.id)!.status).toBe('failed');
    expect(h.orch.ctx.repos.taskFiles.list(t.id, true)).toHaveLength(0);

    // Otra tarea puede tomar el archivo liberado... y entonces la fallida no puede reintentarse.
    const other = await h.call('task.create', { title: 'otra', files: ['src/a.ts'], agent_id: null });
    await expect(h.call('task.start', { id: t.id })).rejects.toThrow(/ya reservados/);
    expect(task(t.id).status).toBe('failed');
    h.orch.ctx.repos.tasks.update(other.id, { status: 'failed' }); // libera de nuevo
    await h.call('task.start', { id: t.id });
    expect(task(t.id).status).toBe('running');
    expect(h.orch.ctx.repos.taskFiles.list(t.id, true)).toHaveLength(1);
  });

  it('un adaptador que termina sin resultado deja la tarea en failed', async () => {
    const { worker } = await open();
    const t = await h.call('task.create', { title: 'x', files: ['src/a.ts'], agent_id: worker.id });
    await h.call('task.start', { id: t.id });
    h.adapters[0]!.end();
    await h.waitFor(() => task(t.id).status === 'failed', 'failed');
  });

  it('task.stop para el adaptador, cancela el run y deja la tarea en assigned', async () => {
    const { worker } = await open();
    const t = await h.call('task.create', { title: 'x', files: ['src/a.ts'], agent_id: worker.id });
    await expect(h.call('task.stop', { id: t.id })).rejects.toThrow(/run en curso/);
    await h.call('task.start', { id: t.id });
    const fake = h.adapters[0]!;
    fake.push({ type: 'permission_request', id: 'p1', tool: 'Bash', input: {}, risk: 'ask' });
    await h.waitFor(() => task(t.id).status === 'needs_you', 'needs_you');
    const approvalId = h.emitted.find((e) => e.name === 'approval.requested')!.payload.id;

    const stopped = await h.call('task.stop', { id: t.id });
    expect(stopped.status).toBe('assigned');
    expect(fake.stopped).toBe(true);
    expect(h.orch.ctx.repos.runs.latestByTask(t.id)!.status).toBe('cancelled');
    expect(h.orch.ctx.repos.approvals.get(approvalId)!.status).toBe('denied');
    expect(h.robot(worker.id).at(-1)).toBe('idle');
    await h.orch.whenIdle();
    expect(h.orch.ctx.live.size).toBe(0);
  });

  it('un agente no puede tener dos runs a la vez ni se puede iniciar dos veces la misma tarea', async () => {
    const { worker } = await open();
    const t1 = await h.call('task.create', { title: 'uno', files: ['src/a.ts'], agent_id: worker.id });
    const t2 = await h.call('task.create', { title: 'dos', files: ['src/other.ts'], agent_id: worker.id });
    await h.call('task.start', { id: t1.id });
    await expect(h.call('task.start', { id: t1.id })).rejects.toThrow(/en curso/);
    await expect(h.call('task.start', { id: t2.id })).rejects.toThrow(/ocupado/);
    expect(task(t2.id).status).toBe('assigned');
  });

  it('las transiciones inválidas se rechazan', async () => {
    const { worker } = await open();
    const t = await h.call('task.create', { title: 'x', files: ['src/a.ts'], agent_id: worker.id });
    const { transition, canTransition } = await import('../../src/orchestrator/tasks.js');
    expect(() => transition(h.orch.ctx, t.id, 'integrated')).toThrow(/no válida: assigned -> integrated/);
    expect(() => transition(h.orch.ctx, t.id, 'review')).toThrow(/no válida/);
    expect(canTransition('integrated', 'running')).toBe(false);
    expect(canTransition('review', 'approved')).toBe(true);
    await expect(h.call('task.assign', { id: t.id, agent_id: 'nope' })).rejects.toThrow(/inexistente/);
  });
});
