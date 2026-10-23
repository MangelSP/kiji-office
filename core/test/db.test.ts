import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrations, openDb } from '../src/db/db.js';
import { createRepos, FileClaimError, type Repos } from '../src/db/repos.js';

let repos: Repos;
let projectId: string;
let objectiveId: string;
let agentId: string;

beforeEach(() => {
  repos = createRepos(openDb(':memory:'));
  projectId = repos.projects.create({ path: '/tmp/demo', name: 'demo', testCommand: 'npm test' }).id;
  objectiveId = repos.objectives.create({ projectId, text: 'hacer algo' }).id;
  agentId = repos.agents.create({ projectId, name: 'Kiji', provider: 'claude' }).id;
});

describe('tablas básicas', () => {
  it('projects: create / get / getByPath y path único', () => {
    const p = repos.projects.getByPath('/tmp/demo')!;
    expect(p.id).toBe(projectId);
    expect(p.base_branch).toBe('main');
    expect(p.test_command).toBe('npm test');
    expect(repos.projects.get(projectId)!.name).toBe('demo');
    expect(repos.projects.getByPath('/nope')).toBeUndefined();
    expect(() => repos.projects.create({ path: '/tmp/demo', name: 'otro' })).toThrow();
  });

  it('agents: create / list / get / update y CHECK de proveedor', () => {
    const a = repos.agents.get(agentId)!;
    expect(a).toMatchObject({ name: 'Kiji', provider: 'claude', is_boss: 0 });
    repos.agents.create({ projectId, name: 'Local', provider: 'api', apiBase: 'http://localhost:11434/v1', model: 'llama3.2' });
    expect(repos.agents.list(projectId).map((x) => x.name)).toEqual(['Kiji', 'Local']);
    expect(repos.agents.update(agentId, { color: '#f00', model: 'opus' })).toMatchObject({ color: '#f00', model: 'opus' });
    expect(() => repos.agents.create({ projectId, name: 'X', provider: 'gpt' as never })).toThrow();
    expect(() => repos.agents.update(agentId, { id: 'otro' } as never)).toThrow();
  });

  it('objectives: create / get / setStatus y CHECK de estado', () => {
    expect(repos.objectives.get(objectiveId)).toMatchObject({ status: 'planning', text: 'hacer algo' });
    repos.objectives.setStatus(objectiveId, 'active');
    expect(repos.objectives.get(objectiveId)!.status).toBe('active');
    expect(() => repos.objectives.setStatus(objectiveId, 'otro' as never)).toThrow();
  });

  it('tasks: create / list / update y CHECK de estado', () => {
    const t1 = repos.tasks.create({ objectiveId, title: 'uno', sortOrder: 2, acceptance: '["a"]' });
    const t2 = repos.tasks.create({ objectiveId, title: 'dos', sortOrder: 1, agentId });
    expect(t1.status).toBe('todo');
    expect(repos.tasks.listByObjective(objectiveId).map((t) => t.title)).toEqual(['dos', 'uno']);
    expect(repos.tasks.listByProject(projectId)).toHaveLength(2);
    const upd = repos.tasks.update(t1.id, { status: 'running', branch: 'kiji/x', worktree_path: '/w' })!;
    expect(upd).toMatchObject({ status: 'running', branch: 'kiji/x', worktree_path: '/w', acceptance: '["a"]' });
    expect(repos.tasks.get(t2.id)!.agent_id).toBe(agentId);
    expect(() => repos.tasks.setStatus(t1.id, 'raro' as never)).toThrow();
  });

  it('runs: create / update / costByAgent', () => {
    const t = repos.tasks.create({ objectiveId, title: 't' });
    const r = repos.runs.create({ taskId: t.id, agentId });
    expect(r.status).toBe('running');
    repos.runs.update(r.id, { cost_usd: 0.5, input_tokens: 10, output_tokens: 20, status: 'done', ended_at: 1, provider_session_id: 's1' });
    expect(repos.runs.get(r.id)).toMatchObject({ cost_usd: 0.5, status: 'done', provider_session_id: 's1' });
    expect(repos.runs.latestByTask(t.id)!.id).toBe(r.id);
    repos.runs.create({ taskId: t.id, agentId }).id;
    expect(repos.runs.listByTask(t.id)).toHaveLength(2);
    expect(repos.runs.costByAgent(agentId)).toBe(0.5);
  });

  it('messages: create / listByAgent', () => {
    repos.messages.create({ agentId, role: 'user', text: 'hola' });
    repos.messages.create({ agentId, role: 'agent', text: 'qué tal' });
    expect(repos.messages.listByAgent(agentId).map((m) => m.text)).toEqual(['hola', 'qué tal']);
    expect(() => repos.messages.create({ agentId, role: 'robot' as never, text: 'x' })).toThrow();
  });

  it('events: append y tail paginado por id', () => {
    const ids = [1, 2, 3, 4, 5].map((n) => repos.events.append({ projectId, kind: 'text', payload: { n }, agentId }).id);
    repos.events.append({ projectId, kind: 'error', payload: { boom: true } });
    expect(JSON.parse(repos.events.tail(projectId, { limit: 1 })[0].payload)).toEqual({ boom: true });
    // últimos 3, en orden ascendente
    expect(repos.events.tail(projectId, { limit: 3 }).map((e) => e.id)).toEqual([ids[3], ids[4], ids[4] + 1]);
    // hacia delante desde un id
    expect(repos.events.tail(projectId, { afterId: ids[1], limit: 2 }).map((e) => e.id)).toEqual([ids[2], ids[3]]);
    // hacia atrás desde un id
    expect(repos.events.tail(projectId, { beforeId: ids[3], limit: 2 }).map((e) => e.id)).toEqual([ids[1], ids[2]]);
    // filtros
    expect(repos.events.tail(projectId, { kind: 'error' })).toHaveLength(1);
    expect(repos.events.tail(projectId, { agentId })).toHaveLength(5);
    expect(() => repos.events.append({ projectId, kind: 'nope' as never })).toThrow();
  });

  it('approvals: create / get / decide una sola vez', () => {
    const a = repos.approvals.create({ tool: 'Bash', risk: 'ask', input: { cmd: 'git push' } });
    expect(a).toMatchObject({ status: 'pending', decided_at: null });
    expect(repos.approvals.listPending()).toHaveLength(1);
    expect(repos.approvals.decide(a.id, 'approved')).toBe(true);
    expect(repos.approvals.decide(a.id, 'denied')).toBe(false);
    expect(repos.approvals.get(a.id)).toMatchObject({ status: 'approved' });
    expect(repos.approvals.get(a.id)!.decided_at).not.toBeNull();
    expect(repos.approvals.listPending()).toHaveLength(0);
  });

  it('test_runs: create (recorta a 64 KB) / latestByTask', () => {
    const t = repos.tasks.create({ objectiveId, title: 't' });
    repos.testRuns.create({ taskId: t.id, command: 'npm test', exitCode: 1, output: 'x'.repeat(70 * 1024) });
    const last = repos.testRuns.create({ taskId: t.id, command: 'npm test', exitCode: 0, output: 'ok' });
    expect(repos.testRuns.latestByTask(t.id)!.id).toBe(last.id);
    expect(repos.testRuns.latestByTask(t.id)).toMatchObject({ exit_code: 0, output: 'ok' });
    const big = repos.testRuns.create({ taskId: t.id, command: 'c', exitCode: 1, output: 'x'.repeat(70 * 1024) });
    expect(big.output.length).toBe(64 * 1024);
  });

  it('integrations: create / getByTask / markReverted', () => {
    const t = repos.tasks.create({ objectiveId, title: 't' });
    const i = repos.integrations.create({ taskId: t.id, beforeSha: 'aaa', afterSha: 'bbb' });
    expect(i).toMatchObject({ before_sha: 'aaa', after_sha: 'bbb', reverted_at: null });
    repos.integrations.markReverted(i.id);
    expect(repos.integrations.getByTask(t.id)!.reverted_at).not.toBeNull();
  });

  it('settings: get / set (upsert)', () => {
    expect(repos.settings.get('default_budget_usd')).toBeUndefined();
    repos.settings.set('default_budget_usd', '2');
    repos.settings.set('default_budget_usd', '5');
    expect(repos.settings.get('default_budget_usd')).toBe('5');
  });

  it('borrar un proyecto borra en cascada sus datos (foreign_keys activo)', () => {
    const db = openDb(':memory:');
    const r = createRepos(db);
    const p = r.projects.create({ path: '/c', name: 'c' });
    const o = r.objectives.create({ projectId: p.id, text: 'o' });
    const t = r.tasks.create({ objectiveId: o.id, title: 't' });
    r.taskFiles.claim(t.id, ['a.ts']);
    r.events.append({ projectId: p.id, kind: 'text' });
    db.prepare('DELETE FROM projects WHERE id = ?').run(p.id);
    for (const table of ['objectives', 'tasks', 'task_files', 'events']) {
      expect((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n).toBe(0);
    }
  });
});

describe('jefe único por proyecto', () => {
  it('un segundo is_boss=1 en el mismo proyecto falla; en otro proyecto vale', () => {
    const boss = repos.agents.create({ projectId, name: 'Jefe', provider: 'claude', isBoss: true });
    expect(repos.agents.getBoss(projectId)!.id).toBe(boss.id);
    expect(() => repos.agents.create({ projectId, name: 'Jefe2', provider: 'codex', isBoss: true })).toThrow();
    // promover a otro agente existente también falla
    expect(() => repos.agents.update(agentId, { is_boss: 1 })).toThrow();
    // tras degradar al jefe, se puede promover al otro
    repos.agents.update(boss.id, { is_boss: 0 });
    expect(repos.agents.update(agentId, { is_boss: 1 })!.is_boss).toBe(1);
    const p2 = repos.projects.create({ path: '/tmp/otro', name: 'otro' });
    expect(repos.agents.create({ projectId: p2.id, name: 'Jefe', provider: 'claude', isBoss: true }).is_boss).toBe(1);
  });
});

describe('task_files: propiedad de archivos', () => {
  it('rechaza una segunda tarea activa sobre la misma ruta y lo permite tras liberar', () => {
    const t1 = repos.tasks.create({ objectiveId, title: 'uno' });
    const t2 = repos.tasks.create({ objectiveId, title: 'dos' });
    repos.taskFiles.claim(t1.id, ['src/a.ts', 'src/b.ts']);
    expect(() => repos.taskFiles.claim(t2.id, ['src/c.ts', 'src/b.ts'])).toThrow(FileClaimError);
    // todo o nada: src/c.ts no quedó reservada
    expect(repos.taskFiles.list(t2.id)).toHaveLength(0);
    try {
      repos.taskFiles.claim(t2.id, ['src/b.ts']);
    } catch (e) {
      expect((e as FileClaimError).conflicts).toEqual([{ path: 'src/b.ts', taskId: t1.id }]);
    }
    repos.taskFiles.release(t1.id);
    repos.taskFiles.claim(t2.id, ['src/c.ts', 'src/b.ts']);
    expect(repos.taskFiles.list(t2.id, true).map((f) => f.path)).toEqual(['src/b.ts', 'src/c.ts']);
    expect(repos.taskFiles.list(t1.id, true)).toHaveLength(0);
    expect(repos.taskFiles.list(t1.id)).toHaveLength(2); // el historial se conserva
  });

  it('el índice único parcial lo hace cumplir también por SQL directo', () => {
    const db = openDb(':memory:');
    const r = createRepos(db);
    const p = r.projects.create({ path: '/p', name: 'p' });
    const o = r.objectives.create({ projectId: p.id, text: 'o' });
    const a = r.tasks.create({ objectiveId: o.id, title: 'a' });
    const b = r.tasks.create({ objectiveId: o.id, title: 'b' });
    const ins = db.prepare('INSERT INTO task_files (task_id, project_id, path) VALUES (?, ?, ?)');
    ins.run(a.id, p.id, 'x');
    expect(() => ins.run(b.id, p.id, 'x')).toThrow(/UNIQUE/);
  });

  it('la misma ruta en proyectos distintos no choca', () => {
    const p2 = repos.projects.create({ path: '/tmp/otro', name: 'otro' });
    const o2 = repos.objectives.create({ projectId: p2.id, text: 'o' });
    const t1 = repos.tasks.create({ objectiveId, title: 'uno' });
    const t2 = repos.tasks.create({ objectiveId: o2.id, title: 'dos' });
    repos.taskFiles.claim(t1.id, ['a.ts']);
    expect(() => repos.taskFiles.claim(t2.id, ['a.ts'])).not.toThrow();
  });

  it('reclamar otra vez las mismas rutas con la misma tarea es idempotente', () => {
    const t1 = repos.tasks.create({ objectiveId, title: 'uno' });
    repos.taskFiles.claim(t1.id, ['a.ts']);
    repos.taskFiles.claim(t1.id, ['a.ts', 'b.ts']);
    expect(repos.taskFiles.list(t1.id, true)).toHaveLength(2);
  });

  it('una tarea que pasa a integrated o failed libera sus archivos sola', () => {
    const t1 = repos.tasks.create({ objectiveId, title: 'uno' });
    const t2 = repos.tasks.create({ objectiveId, title: 'dos' });
    repos.taskFiles.claim(t1.id, ['a.ts']);
    repos.tasks.setStatus(t1.id, 'review'); // no terminal: sigue reservado
    expect(() => repos.taskFiles.claim(t2.id, ['a.ts'])).toThrow(FileClaimError);
    repos.tasks.setStatus(t1.id, 'integrated');
    expect(() => repos.taskFiles.claim(t2.id, ['a.ts'])).not.toThrow();
  });
});

describe('migraciones', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'kiji-db-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('abrir dos veces la misma BD no re-aplica nada y conserva los datos', () => {
    const file = join(dir, 'kiji.db');
    const db1 = openDb(file);
    expect((db1.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(3);
    expect((db1.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal');
    expect((db1.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys).toBe(1);
    createRepos(db1).projects.create({ path: '/x', name: 'x' });
    db1.close();

    // si re-aplicara schema.sql fallaría con "table projects already exists"
    const db2 = openDb(file);
    expect((db2.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(3);
    expect(createRepos(db2).projects.getByPath('/x')).toBeDefined();
    db2.close();
  });

  it('migración 2: desde una BD v1 añade perfil, métricas y relays sin perder datos', () => {
    const file = join(dir, 'v1.db');
    const old = new DatabaseSync(file);
    old.exec('PRAGMA foreign_keys = ON');
    old.exec(readFileSync(new URL('../src/db/schema.sql', import.meta.url), 'utf8'));
    old.exec('PRAGMA user_version = 1');
    old.exec(`INSERT INTO projects (id, path, name, created_at) VALUES ('p', '/x', 'x', 1)`);
    old.exec(`INSERT INTO agents (id, project_id, name, provider, model, created_at) VALUES ('a', 'p', 'Vieja', 'claude', 'sonnet', 1)`);
    old.exec(`INSERT INTO objectives (id, project_id, text, created_at) VALUES ('o', 'p', 't', 1)`);
    old.exec(`INSERT INTO tasks (id, objective_id, title, updated_at) VALUES ('t', 'o', 't', 1)`);
    old.exec(`INSERT INTO runs (id, task_id, agent_id, started_at, cost_usd) VALUES ('r', 't', 'a', 1, 0.5)`);
    old.close();

    const db = openDb(file);
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(3);
    const repos = createRepos(db);
    expect(repos.agents.get('a')).toMatchObject({ name: 'Vieja', persona: '', skills: '[]', auto_relay: 1, relay_order: null });
    expect(repos.runs.get('r')).toMatchObject({
      cost_usd: 0.5, model: null, cache_read_tokens: 0, cache_write_tokens: 0, context_tokens: 0, context_window: 200000,
    });
    const relay = repos.relays.create({ projectId: 'p', taskId: 't', fromModel: 'opus', toModel: 'sonnet', reason: 'limit', detail: 'x' });
    expect(repos.relays.list('p')).toEqual([relay]);
    expect(() => repos.relays.create({ projectId: 'p', reason: 'limit' })).not.toThrow();
    expect(repos.relays.list('p').map((r) => r.id)).toEqual([2, 1]); // el más nuevo primero
    repos.agents.update('a', { persona: 'Hablo claro.', skills: '["graphify"]', auto_relay: 0 });
    expect(repos.agents.get('a')).toMatchObject({ persona: 'Hablo claro.', skills: '["graphify"]', auto_relay: 0 });
    repos.runs.update('r', { model: 'opus', cache_read_tokens: 7, cache_write_tokens: 3, context_tokens: 100, context_window: 1_000_000 });
    expect(repos.runs.get('r')).toMatchObject({ model: 'opus', cache_read_tokens: 7, cache_write_tokens: 3, context_tokens: 100, context_window: 1_000_000 });
    db.close();
  });

  it('migración 3: sobre una BD real de 0.2a (v2) con datos añade workspaces sin perder nada', () => {
    const file = join(dir, 'v2.db');
    const old = new DatabaseSync(file);
    old.exec('PRAGMA foreign_keys = ON');
    migrations[0]!(old); // esquema 0.1
    migrations[1]!(old); // 0.2a
    old.exec('PRAGMA user_version = 2');
    old.exec(`INSERT INTO projects (id, path, name, base_branch, test_command, created_at) VALUES ('p', '/x', 'x', 'dev', 'npm test', 1)`);
    old.exec(`INSERT INTO agents (id, project_id, name, provider, model, persona, skills, auto_relay, created_at) VALUES ('a', 'p', 'Vieja', 'claude', 'opus', 'calma', '["graphify"]', 0, 1)`);
    old.exec(`INSERT INTO objectives (id, project_id, text, created_at) VALUES ('o', 'p', 't', 1)`);
    old.exec(`INSERT INTO tasks (id, objective_id, title, status, updated_at) VALUES ('t', 'o', 't', 'running', 1)`);
    old.exec(`INSERT INTO runs (id, task_id, agent_id, started_at, cost_usd, model, cache_read_tokens) VALUES ('r', 't', 'a', 1, 0.5, 'opus', 9)`);
    old.exec(`INSERT INTO relays (project_id, task_id, reason, created_at) VALUES ('p', 't', 'limit', 1)`);
    old.close();

    const db = openDb(file);
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(3);
    const repos = createRepos(db);
    expect(repos.projects.get('p')).toMatchObject({
      name: 'x', base_branch: 'dev', test_command: 'npm test', scene: 'oficina', last_opened_at: null, color: null, is_open: 0,
    });
    expect(repos.agents.get('a')).toMatchObject({ persona: 'calma', skills: '["graphify"]', auto_relay: 0 });
    expect(repos.tasks.get('t')!.status).toBe('running');
    expect(repos.runs.get('r')).toMatchObject({ cost_usd: 0.5, model: 'opus', cache_read_tokens: 9 });
    expect(repos.relays.list('p')).toHaveLength(1);

    expect(repos.projects.update('p', { scene: 'casa', color: '#aabbcc' })).toMatchObject({ scene: 'casa', color: '#aabbcc' });
    expect(() => repos.projects.update('p', { scene: 'otra' as never })).toThrow(); // CHECK de la columna
  });
});
