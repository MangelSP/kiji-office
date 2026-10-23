// CRUD mínimo sobre SQLite: SQL directo con statements preparados, sin ORM.
// Uso: const repos = createRepos(openDb(path)); repos.tasks.create({...}).
// Los campos JSON (acceptance, depends_on, resume_hint, input) se tratan como string:
// quien llama hace JSON.stringify/parse. Solo events.payload se serializa aquí.
import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

// ---------- Tipos de fila ----------

export type Provider = 'claude' | 'codex' | 'api';
export type ObjectiveStatus = 'planning' | 'active' | 'done';
export type TaskStatus =
  | 'todo' | 'assigned' | 'running' | 'needs_you' | 'review' | 'changes'
  | 'approved' | 'integrated' | 'blocked' | 'failed' | 'paused_limit';
export type RunStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'paused_limit';
export type MessageRole = 'user' | 'agent' | 'boss' | 'system';
export type EventKind =
  | 'thinking' | 'text' | 'tool' | 'permission' | 'status' | 'limit' | 'error' | 'git' | 'test';
export type ApprovalRisk = 'ask' | 'never';
export type ApprovalStatus = 'pending' | 'approved' | 'denied';

export interface ProjectRow {
  id: string; path: string; name: string; base_branch: string; test_command: string | null; created_at: number;
}
export interface AgentRow {
  id: string; project_id: string; name: string; provider: Provider; api_base: string | null;
  model: string | null; role: string | null; color: string | null; is_boss: 0 | 1;
  relay_order: string | null; created_at: number;
}
export interface ObjectiveRow {
  id: string; project_id: string; text: string; status: ObjectiveStatus; boss_session_id: string | null; created_at: number;
}
export interface TaskRow {
  id: string; objective_id: string; title: string; description: string; agent_id: string | null;
  status: TaskStatus; branch: string | null; worktree_path: string | null; acceptance: string | null;
  depends_on: string | null; sort_order: number; updated_at: number;
}
export interface TaskFileRow { task_id: string; project_id: string; path: string; active: 0 | 1 }
export interface RunRow {
  id: string; task_id: string; agent_id: string; provider_session_id: string | null; status: RunStatus;
  cost_usd: number; input_tokens: number; output_tokens: number; resume_hint: string | null;
  started_at: number; ended_at: number | null;
}
export interface MessageRow {
  id: number; run_id: string | null; agent_id: string; role: MessageRole; text: string; created_at: number;
}
export interface EventRow {
  id: number; project_id: string; task_id: string | null; agent_id: string | null; run_id: string | null;
  kind: EventKind; payload: string; created_at: number;
}
export interface ApprovalRow {
  id: string; run_id: string | null; task_id: string | null; tool: string; input: string;
  risk: ApprovalRisk; status: ApprovalStatus; created_at: number; decided_at: number | null;
}
export interface TestRunRow {
  id: number; task_id: string; command: string; exit_code: number | null; output: string; created_at: number;
}
export interface IntegrationRow {
  id: number; task_id: string; before_sha: string; after_sha: string; created_at: number; reverted_at: number | null;
}

// Estados que terminan una tarea: sus archivos dejan de estar reservados.
const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ['integrated', 'failed'];
// Límite de la salida guardada de un test_run (PLAN sección 3).
const TEST_OUTPUT_MAX = 64 * 1024;

/** La reserva de archivos falló porque alguna ruta ya pertenece a otra tarea activa. */
export class FileClaimError extends Error {
  constructor(public readonly conflicts: Array<{ path: string; taskId: string }>) {
    super(`archivos ya reservados por otra tarea activa: ${conflicts.map((c) => c.path).join(', ')}`);
    this.name = 'FileClaimError';
  }
}

// ---------- Utilidades ----------

const now = (): number => Date.now();
const newId = (): string => randomUUID();

/** Ejecuta fn dentro de una transacción (si ya hay una abierta, simplemente la reutiliza). */
function tx<T>(db: DatabaseSync, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** UPDATE ... SET solo con las columnas de la lista blanca presentes en patch. */
function patchRow(
  db: DatabaseSync, table: string, id: string | number, patch: Record<string, unknown>,
  allowed: readonly string[], extra: Record<string, SQLInputValue> = {},
): void {
  const sets: string[] = [];
  const values: SQLInputValue[] = [];
  for (const [col, val] of Object.entries({ ...patch, ...extra })) {
    if (val === undefined) continue;
    if (!allowed.includes(col) && !(col in extra)) throw new Error(`campo no permitido en ${table}: ${col}`);
    sets.push(`${col} = ?`);
    values.push(val as SQLInputValue);
  }
  if (sets.length === 0) return;
  // table y col vienen de listas fijas del propio código, nunca de entrada externa.
  db.prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
}

// ---------- Repos ----------

export function createRepos(db: DatabaseSync) {
  const one = <T>(sql: string, ...params: SQLInputValue[]): T | undefined =>
    db.prepare(sql).get(...params) as T | undefined;
  const all = <T>(sql: string, ...params: SQLInputValue[]): T[] =>
    db.prepare(sql).all(...params) as T[];

  // --- projects ---
  const projects = {
    create(p: { path: string; name: string; baseBranch?: string; testCommand?: string | null }): ProjectRow {
      const id = newId();
      db.prepare(
        'INSERT INTO projects (id, path, name, base_branch, test_command, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(id, p.path, p.name, p.baseBranch ?? 'main', p.testCommand ?? null, now());
      return projects.get(id)!;
    },
    get: (id: string) => one<ProjectRow>('SELECT * FROM projects WHERE id = ?', id),
    getByPath: (path: string) => one<ProjectRow>('SELECT * FROM projects WHERE path = ?', path),
    list: () => all<ProjectRow>('SELECT * FROM projects ORDER BY created_at, id'),
    update(id: string, patch: { baseBranch?: string; testCommand?: string | null }): ProjectRow {
      patchRow(db, 'projects', id, { base_branch: patch.baseBranch, test_command: patch.testCommand }, ['base_branch', 'test_command']);
      return projects.get(id)!;
    },
  };

  // --- agents ---
  const AGENT_FIELDS = ['name', 'provider', 'api_base', 'model', 'role', 'color', 'is_boss', 'relay_order'] as const;
  const agents = {
    create(a: {
      projectId: string; name: string; provider: Provider; apiBase?: string | null; model?: string | null;
      role?: string | null; color?: string | null; isBoss?: boolean;
    }): AgentRow {
      const id = newId();
      db.prepare(
        `INSERT INTO agents (id, project_id, name, provider, api_base, model, role, color, is_boss, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, a.projectId, a.name, a.provider, a.apiBase ?? null, a.model ?? null, a.role ?? null,
        a.color ?? null, a.isBoss ? 1 : 0, now());
      return agents.get(id)!;
    },
    get: (id: string) => one<AgentRow>('SELECT * FROM agents WHERE id = ?', id),
    list: (projectId: string) =>
      all<AgentRow>('SELECT * FROM agents WHERE project_id = ? ORDER BY created_at, id', projectId),
    getBoss: (projectId: string) =>
      one<AgentRow>('SELECT * FROM agents WHERE project_id = ? AND is_boss = 1', projectId),
    /** patch usa nombres de columna (api_base, is_boss...). Un segundo is_boss=1 en el proyecto lanza error. */
    update(id: string, patch: Partial<Pick<AgentRow, (typeof AGENT_FIELDS)[number]>>): AgentRow | undefined {
      patchRow(db, 'agents', id, patch, AGENT_FIELDS);
      return agents.get(id);
    },
  };

  // --- task_files ---
  const taskFiles = {
    /**
     * Reserva todas las rutas para la tarea o ninguna: si alguna ya está activa en otra tarea
     * del mismo proyecto lanza FileClaimError (con todos los conflictos) y no queda nada reservado.
     */
    claim(taskId: string, paths: string[]): void {
      const owner = one<{ project_id: string }>(
        `SELECT o.project_id FROM tasks t JOIN objectives o ON o.id = t.objective_id WHERE t.id = ?`, taskId);
      if (!owner) throw new Error(`tarea inexistente: ${taskId}`);
      tx(db, () => {
        const conflicts: Array<{ path: string; taskId: string }> = [];
        for (const path of paths) {
          const c = one<{ task_id: string }>(
            'SELECT task_id FROM task_files WHERE project_id = ? AND path = ? AND active = 1 AND task_id <> ?',
            owner.project_id, path, taskId);
          if (c) conflicts.push({ path, taskId: c.task_id });
        }
        if (conflicts.length > 0) throw new FileClaimError(conflicts);
        const ins = db.prepare(
          `INSERT INTO task_files (task_id, project_id, path, active) VALUES (?, ?, ?, 1)
           ON CONFLICT(task_id, path) DO UPDATE SET active = 1`);
        for (const path of paths) ins.run(taskId, owner.project_id, path);
      });
    },
    /** Libera las rutas de la tarea (active = 0); las filas se conservan como historial. */
    release(taskId: string): void {
      db.prepare('UPDATE task_files SET active = 0 WHERE task_id = ?').run(taskId);
    },
    list: (taskId: string, onlyActive = false) =>
      all<TaskFileRow>(
        `SELECT * FROM task_files WHERE task_id = ? ${onlyActive ? 'AND active = 1' : ''} ORDER BY path`, taskId),
  };

  // --- objectives ---
  const objectives = {
    create(o: { projectId: string; text: string; status?: ObjectiveStatus; bossSessionId?: string | null }): ObjectiveRow {
      const id = newId();
      db.prepare(
        'INSERT INTO objectives (id, project_id, text, status, boss_session_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(id, o.projectId, o.text, o.status ?? 'planning', o.bossSessionId ?? null, now());
      return objectives.get(id)!;
    },
    get: (id: string) => one<ObjectiveRow>('SELECT * FROM objectives WHERE id = ?', id),
    list: (projectId: string) =>
      all<ObjectiveRow>('SELECT * FROM objectives WHERE project_id = ? ORDER BY created_at, id', projectId),
    setStatus(id: string, status: ObjectiveStatus): void {
      db.prepare('UPDATE objectives SET status = ? WHERE id = ?').run(status, id);
    },
    setBossSession(id: string, bossSessionId: string | null): void {
      db.prepare('UPDATE objectives SET boss_session_id = ? WHERE id = ?').run(bossSessionId, id);
    },
  };

  // --- tasks ---
  const TASK_FIELDS = [
    'title', 'description', 'agent_id', 'status', 'branch', 'worktree_path', 'acceptance', 'depends_on', 'sort_order',
  ] as const;
  const tasks = {
    create(t: {
      objectiveId: string; title: string; description?: string; agentId?: string | null; status?: TaskStatus;
      acceptance?: string | null; dependsOn?: string | null; sortOrder?: number;
    }): TaskRow {
      const id = newId();
      db.prepare(
        `INSERT INTO tasks (id, objective_id, title, description, agent_id, status, acceptance, depends_on, sort_order, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, t.objectiveId, t.title, t.description ?? '', t.agentId ?? null, t.status ?? 'todo',
        t.acceptance ?? null, t.dependsOn ?? null, t.sortOrder ?? 0, now());
      return tasks.get(id)!;
    },
    get: (id: string) => one<TaskRow>('SELECT * FROM tasks WHERE id = ?', id),
    listByObjective: (objectiveId: string) =>
      all<TaskRow>('SELECT * FROM tasks WHERE objective_id = ? ORDER BY sort_order, rowid', objectiveId),
    listByProject: (projectId: string) =>
      all<TaskRow>(
        `SELECT t.* FROM tasks t JOIN objectives o ON o.id = t.objective_id
         WHERE o.project_id = ? ORDER BY o.created_at, t.sort_order, t.rowid`, projectId),
    /** Actualiza campos (nombres de columna). Si el estado final es terminal, libera sus archivos. */
    update(id: string, patch: Partial<Pick<TaskRow, (typeof TASK_FIELDS)[number]>>): TaskRow | undefined {
      tx(db, () => {
        patchRow(db, 'tasks', id, patch, TASK_FIELDS, { updated_at: now() });
        if (patch.status && TERMINAL_TASK_STATUSES.includes(patch.status)) taskFiles.release(id);
      });
      return tasks.get(id);
    },
    setStatus: (id: string, status: TaskStatus) => tasks.update(id, { status }),
  };

  // --- runs ---
  const RUN_FIELDS = [
    'provider_session_id', 'status', 'cost_usd', 'input_tokens', 'output_tokens', 'resume_hint', 'ended_at',
  ] as const;
  const runs = {
    create(r: { taskId: string; agentId: string; providerSessionId?: string | null }): RunRow {
      const id = newId();
      db.prepare(
        'INSERT INTO runs (id, task_id, agent_id, provider_session_id, started_at) VALUES (?, ?, ?, ?, ?)',
      ).run(id, r.taskId, r.agentId, r.providerSessionId ?? null, now());
      return runs.get(id)!;
    },
    get: (id: string) => one<RunRow>('SELECT * FROM runs WHERE id = ?', id),
    listByTask: (taskId: string) => all<RunRow>('SELECT * FROM runs WHERE task_id = ? ORDER BY started_at, rowid', taskId),
    latestByTask: (taskId: string) =>
      one<RunRow>('SELECT * FROM runs WHERE task_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1', taskId),
    update(id: string, patch: Partial<Pick<RunRow, (typeof RUN_FIELDS)[number]>>): RunRow | undefined {
      patchRow(db, 'runs', id, patch, RUN_FIELDS);
      return runs.get(id);
    },
    /** Gasto acumulado de un agente en USD. */
    costByAgent: (agentId: string) =>
      one<{ total: number }>('SELECT COALESCE(SUM(cost_usd), 0) AS total FROM runs WHERE agent_id = ?', agentId)!.total,
  };

  // --- messages ---
  const messages = {
    create(m: { agentId: string; role: MessageRole; text: string; runId?: string | null }): MessageRow {
      const info = db.prepare(
        'INSERT INTO messages (run_id, agent_id, role, text, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run(m.runId ?? null, m.agentId, m.role, m.text, now());
      return one<MessageRow>('SELECT * FROM messages WHERE id = ?', Number(info.lastInsertRowid))!;
    },
    listByAgent: (agentId: string, limit = 200) =>
      all<MessageRow>(
        `SELECT * FROM (SELECT * FROM messages WHERE agent_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id`, agentId, limit),
  };

  // --- events ---
  const events = {
    append(e: {
      projectId: string; kind: EventKind; payload?: unknown;
      taskId?: string | null; agentId?: string | null; runId?: string | null;
    }): EventRow {
      const info = db.prepare(
        `INSERT INTO events (project_id, task_id, agent_id, run_id, kind, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(e.projectId, e.taskId ?? null, e.agentId ?? null, e.runId ?? null, e.kind,
        JSON.stringify(e.payload ?? {}), now());
      return one<EventRow>('SELECT * FROM events WHERE id = ?', Number(info.lastInsertRowid))!;
    },
    /**
     * Paginado por id, siempre devuelto en orden ascendente.
     *  - afterId: eventos con id > afterId (seguir el flujo en vivo).
     *  - beforeId: eventos con id < beforeId, los más recientes primero en la selección (historial hacia atrás).
     *  - ninguno: los últimos `limit`.
     */
    tail(projectId: string, o: {
      afterId?: number; beforeId?: number; limit?: number; agentId?: string; kind?: EventKind;
    } = {}): EventRow[] {
      const where = ['project_id = ?'];
      const params: SQLInputValue[] = [projectId];
      if (o.afterId !== undefined) { where.push('id > ?'); params.push(o.afterId); }
      if (o.beforeId !== undefined) { where.push('id < ?'); params.push(o.beforeId); }
      if (o.agentId !== undefined) { where.push('agent_id = ?'); params.push(o.agentId); }
      if (o.kind !== undefined) { where.push('kind = ?'); params.push(o.kind); }
      const limit = o.limit ?? 100;
      const forward = o.afterId !== undefined && o.beforeId === undefined;
      const sql = `SELECT * FROM events WHERE ${where.join(' AND ')} ORDER BY id ${forward ? 'ASC' : 'DESC'} LIMIT ?`;
      const rows = all<EventRow>(sql, ...params, limit);
      return forward ? rows : rows.reverse();
    },
  };

  // --- approvals ---
  const approvals = {
    create(a: { tool: string; risk: ApprovalRisk; input?: unknown; runId?: string | null; taskId?: string | null }): ApprovalRow {
      const id = newId();
      db.prepare(
        'INSERT INTO approvals (id, run_id, task_id, tool, input, risk, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(id, a.runId ?? null, a.taskId ?? null, a.tool, JSON.stringify(a.input ?? {}), a.risk, now());
      return approvals.get(id)!;
    },
    get: (id: string) => one<ApprovalRow>('SELECT * FROM approvals WHERE id = ?', id),
    listPending: () => all<ApprovalRow>("SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at, rowid"),
    /** Solo decide si sigue pendiente; devuelve false si ya estaba decidida. */
    decide(id: string, decision: 'approved' | 'denied'): boolean {
      const info = db.prepare(
        "UPDATE approvals SET status = ?, decided_at = ? WHERE id = ? AND status = 'pending'",
      ).run(decision, now(), id);
      return Number(info.changes) === 1;
    },
  };

  // --- test_runs ---
  const testRuns = {
    create(t: { taskId: string; command: string; exitCode: number | null; output: string }): TestRunRow {
      const info = db.prepare(
        'INSERT INTO test_runs (task_id, command, exit_code, output, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run(t.taskId, t.command, t.exitCode, t.output.slice(-TEST_OUTPUT_MAX), now()); // se conserva el final
      return one<TestRunRow>('SELECT * FROM test_runs WHERE id = ?', Number(info.lastInsertRowid))!;
    },
    latestByTask: (taskId: string) =>
      one<TestRunRow>('SELECT * FROM test_runs WHERE task_id = ? ORDER BY id DESC LIMIT 1', taskId),
  };

  // --- integrations ---
  const integrations = {
    create(i: { taskId: string; beforeSha: string; afterSha: string }): IntegrationRow {
      const info = db.prepare(
        'INSERT INTO integrations (task_id, before_sha, after_sha, created_at) VALUES (?, ?, ?, ?)',
      ).run(i.taskId, i.beforeSha, i.afterSha, now());
      return one<IntegrationRow>('SELECT * FROM integrations WHERE id = ?', Number(info.lastInsertRowid))!;
    },
    getByTask: (taskId: string) =>
      one<IntegrationRow>('SELECT * FROM integrations WHERE task_id = ? ORDER BY id DESC LIMIT 1', taskId),
    markReverted(id: number): void {
      db.prepare('UPDATE integrations SET reverted_at = ? WHERE id = ?').run(now(), id);
    },
  };

  // --- settings ---
  const settings = {
    get: (key: string) => one<{ value: string }>('SELECT value FROM settings WHERE key = ?', key)?.value,
    set(key: string, value: string): void {
      db.prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      ).run(key, value);
    },
  };

  return { projects, agents, objectives, tasks, taskFiles, runs, messages, events, approvals, testRuns, integrations, settings };
}

export type Repos = ReturnType<typeof createRepos>;
