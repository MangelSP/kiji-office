-- Esquema de Kiji Office 0.1 (migración 1). Ver PLAN-0.1.md, sección 3.
-- Convenciones:
--   * Todos los timestamps son INTEGER en milisegundos desde epoch (Date.now()).
--   * Los ids de entidades son TEXT (uuid generado por el core); events y messages usan
--     INTEGER autoincremental porque se paginan por id.
--   * Los campos JSON (acceptance, depends_on, resume_hint, payload, input) se guardan como TEXT.
--   * Este fichero NO activa pragmas: db.ts activa foreign_keys y WAL al abrir.

CREATE TABLE projects (
  id           TEXT PRIMARY KEY,
  path         TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  base_branch  TEXT NOT NULL DEFAULT 'main',
  test_command TEXT,
  created_at   INTEGER NOT NULL
);

CREATE TABLE agents (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  provider    TEXT NOT NULL CHECK (provider IN ('claude', 'codex', 'api')),
  api_base    TEXT,                       -- solo para provider = 'api' (Ollama/Gemini/OpenAI)
  model       TEXT,
  role        TEXT,                       -- nombre del agente del kit
  color       TEXT,
  is_boss     INTEGER NOT NULL DEFAULT 0 CHECK (is_boss IN (0, 1)),
  relay_order TEXT,                       -- reservado para 0.2
  created_at  INTEGER NOT NULL
);
-- Un solo jefe por proyecto: índice único parcial sobre los agentes con is_boss = 1.
CREATE UNIQUE INDEX agents_one_boss_per_project ON agents(project_id) WHERE is_boss = 1;
CREATE INDEX agents_project ON agents(project_id);

CREATE TABLE objectives (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  text            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'planning' CHECK (status IN ('planning', 'active', 'done')),
  boss_session_id TEXT,
  created_at      INTEGER NOT NULL
);
CREATE INDEX objectives_project ON objectives(project_id);

CREATE TABLE tasks (
  id            TEXT PRIMARY KEY,
  objective_id  TEXT NOT NULL REFERENCES objectives(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  agent_id      TEXT REFERENCES agents(id) ON DELETE SET NULL,
  status        TEXT NOT NULL DEFAULT 'todo' CHECK (status IN (
                  'todo', 'assigned', 'running', 'needs_you', 'review', 'changes',
                  'approved', 'integrated', 'blocked', 'failed', 'paused_limit')),
  branch        TEXT,
  worktree_path TEXT,
  acceptance    TEXT,                     -- JSON
  depends_on    TEXT,                     -- JSON (array de ids de tarea)
  sort_order    INTEGER NOT NULL DEFAULT 0, -- "order" del plan; se evita la palabra reservada
  updated_at    INTEGER NOT NULL
);
CREATE INDEX tasks_objective ON tasks(objective_id);
CREATE INDEX tasks_agent ON tasks(agent_id);

-- Propiedad de archivos (PLAN D4). Una ruta no puede pertenecer a dos tareas activas.
-- SQLite no admite subconsultas en un índice parcial, así que no se puede escribir
-- "WHERE la tarea no ha terminado". En su lugar la fila lleva `active` (1 mientras la tarea
-- sigue viva; el repo lo pone a 0 al terminar la tarea) y `project_id` desnormalizado, y el
-- índice único parcial es sobre (project_id, path) WHERE active = 1.
CREATE TABLE task_files (
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path       TEXT NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  PRIMARY KEY (task_id, path)
);
CREATE UNIQUE INDEX task_files_active_path ON task_files(project_id, path) WHERE active = 1;

CREATE TABLE runs (
  id                  TEXT PRIMARY KEY,
  task_id             TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id            TEXT NOT NULL REFERENCES agents(id),
  provider_session_id TEXT,               -- para resume / resumeThread
  status              TEXT NOT NULL DEFAULT 'running' CHECK (status IN (
                        'running', 'done', 'failed', 'cancelled', 'paused_limit')),
  cost_usd            REAL NOT NULL DEFAULT 0,
  input_tokens        INTEGER NOT NULL DEFAULT 0,
  output_tokens       INTEGER NOT NULL DEFAULT 0,
  resume_hint         TEXT,               -- JSON
  started_at          INTEGER NOT NULL,
  ended_at            INTEGER
);
CREATE INDEX runs_task ON runs(task_id);

-- Chat por robot. run_id puede ser NULL (mensaje enviado sin run activo).
CREATE TABLE messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id     TEXT REFERENCES runs(id) ON DELETE SET NULL,
  agent_id   TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('user', 'agent', 'boss', 'system')),
  text       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX messages_agent ON messages(agent_id, id);

-- Registro general y por robot.
CREATE TABLE events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id    TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  agent_id   TEXT REFERENCES agents(id) ON DELETE SET NULL,
  run_id     TEXT REFERENCES runs(id) ON DELETE SET NULL,
  kind       TEXT NOT NULL CHECK (kind IN (
               'thinking', 'text', 'tool', 'permission', 'status', 'limit', 'error', 'git', 'test')),
  payload    TEXT NOT NULL DEFAULT '{}',  -- JSON
  created_at INTEGER NOT NULL
);
CREATE INDEX events_project ON events(project_id, id);
CREATE INDEX events_agent ON events(agent_id, id);

CREATE TABLE approvals (
  id         TEXT PRIMARY KEY,
  run_id     TEXT REFERENCES runs(id) ON DELETE CASCADE,
  task_id    TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  tool       TEXT NOT NULL,
  input      TEXT NOT NULL DEFAULT '{}',  -- JSON
  risk       TEXT NOT NULL CHECK (risk IN ('ask', 'never')),
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE INDEX approvals_status ON approvals(status);

CREATE TABLE test_runs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  command    TEXT NOT NULL,
  exit_code  INTEGER,
  output     TEXT NOT NULL DEFAULT '',    -- recortada a 64 KB por quien inserta
  created_at INTEGER NOT NULL
);
CREATE INDEX test_runs_task ON test_runs(task_id, id);

CREATE TABLE integrations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  before_sha  TEXT NOT NULL,
  after_sha   TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  reverted_at INTEGER
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
