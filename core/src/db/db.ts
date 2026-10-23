// Apertura de la base SQLite (node:sqlite) y migraciones por PRAGMA user_version.
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

// El bundle (core/esbuild.mjs) inyecta el contenido de schema.sql en __KIJI_SCHEMA_SQL__. Sin bundle (tsc, vitest)
// se lee junto al .js compilado (`npm run build` lo copia, ver core/package.json) o desde src/.
declare const __KIJI_SCHEMA_SQL__: string | undefined;
const schemaSql = (): string =>
  typeof __KIJI_SCHEMA_SQL__ === 'string'
    ? __KIJI_SCHEMA_SQL__
    : readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

// Migración 2 (0.2a, PLAN-0.2a.md): perfil del agente, métricas del run y tabla de relevos.
// `agents.relay_order` ya existía desde la migración 1 (JSON string[]; null = orden por defecto).
const MIGRATION_2 = `
ALTER TABLE agents ADD COLUMN persona TEXT NOT NULL DEFAULT '';
ALTER TABLE agents ADD COLUMN skills TEXT NOT NULL DEFAULT '[]';
ALTER TABLE agents ADD COLUMN auto_relay INTEGER NOT NULL DEFAULT 1;
ALTER TABLE runs ADD COLUMN model TEXT;
ALTER TABLE runs ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN context_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN context_window INTEGER NOT NULL DEFAULT 200000;
CREATE TABLE relays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  from_agent_id TEXT, to_agent_id TEXT,
  from_model TEXT, to_model TEXT,
  reason TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX relays_project ON relays(project_id, id);
CREATE INDEX events_run ON events(run_id, kind);
`;

// Migración 3 (0.2c, PLAN-0.2b.md parte 2): workspaces. Escena y color de la pestaña, última apertura y si el
// proyecto estaba abierto al cerrar el core (para reabrirlo al arrancar con `project.reopen`).
const MIGRATION_3 = `
ALTER TABLE projects ADD COLUMN scene TEXT NOT NULL DEFAULT 'oficina' CHECK (scene IN ('oficina', 'casa'));
ALTER TABLE projects ADD COLUMN last_opened_at INTEGER;
ALTER TABLE projects ADD COLUMN color TEXT;
ALTER TABLE projects ADD COLUMN is_open INTEGER NOT NULL DEFAULT 0 CHECK (is_open IN (0, 1));
CREATE INDEX runs_started ON runs(started_at);
`;

// Migración 4 (0.2b, PLAN-0.2b.md parte 1, D15): conexiones (cualquier IA compatible con OpenAI) y agents.connection_id.
// La clave NUNCA se guarda aquí: vive en el llavero (cuenta `conn:<id>`) y llega al core en memoria (`secrets.put`).
// agents.api_base queda sin uso (se conserva por compatibilidad de la migración 1).
const MIGRATION_4 = `
CREATE TABLE connections (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  preset         TEXT NOT NULL,
  kind           TEXT NOT NULL DEFAULT 'openai_compat' CHECK (kind IN ('openai_compat')),
  base_url       TEXT NOT NULL,
  auth           TEXT NOT NULL CHECK (auth IN ('none', 'bearer', 'x-api-key')),
  has_secret     INTEGER NOT NULL DEFAULT 0 CHECK (has_secret IN (0, 1)),
  default_model  TEXT,
  context_window INTEGER NOT NULL DEFAULT 32768,
  tool_quality   TEXT NOT NULL DEFAULT 'unknown' CHECK (tool_quality IN ('unknown', 'ok', 'weak', 'none')),
  prices_json    TEXT NOT NULL DEFAULT '{}',
  last_test_at   INTEGER,
  last_test_ok   INTEGER,
  created_at     INTEGER NOT NULL
);
ALTER TABLE agents ADD COLUMN connection_id TEXT REFERENCES connections(id) ON DELETE SET NULL;
CREATE INDEX agents_connection ON agents(connection_id);
`;

// Migración 5 (0.2d, PLAN-0.2b.md parte 3, D24): política del gerente, memoria con FTS5, diario de ticks y acciones,
// avisos, `runs.started_by` y la tabla `integrations` rehecha (proyecto, estado y detalle; la de la migración 1 solo
// tenía task_id/shas/reverted_at). Las filas existentes se conservan: reverted_at -> status 'reverted'.
const MIGRATION_5 = `
ALTER TABLE projects ADD COLUMN manager_policy TEXT;
ALTER TABLE runs ADD COLUMN started_by TEXT NOT NULL DEFAULT 'user';
CREATE TABLE memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('fact', 'decision', 'preference', 'todo')),
  text TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'manager',
  archived INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE INDEX memory_project ON memory(project_id, archived, id);
CREATE VIRTUAL TABLE memory_fts USING fts5(text, content='memory', content_rowid='id');
CREATE TRIGGER memory_ai AFTER INSERT ON memory BEGIN
  INSERT INTO memory_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER memory_ad AFTER DELETE ON memory BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER memory_au AFTER UPDATE ON memory BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO memory_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TABLE manager_ticks (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  trigger TEXT NOT NULL, run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  summary TEXT NOT NULL DEFAULT '', cost_usd REAL NOT NULL DEFAULT 0, started_at INTEGER NOT NULL, ended_at INTEGER
);
CREATE INDEX manager_ticks_project ON manager_ticks(project_id, started_at);
CREATE TABLE manager_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, tick_id TEXT NOT NULL REFERENCES manager_ticks(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL, tool TEXT NOT NULL, input TEXT NOT NULL, result TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('auto', 'notify', 'ask')), decided_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX manager_actions_project ON manager_actions(project_id, id);
CREATE TABLE notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, level TEXT NOT NULL CHECK (level IN ('info', 'warn', 'ask')),
  title TEXT NOT NULL, body TEXT NOT NULL, approval_id TEXT, read_at INTEGER, created_at INTEGER NOT NULL
);
CREATE INDEX notifications_project ON notifications(project_id, id);
CREATE TABLE integrations_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  before_sha TEXT NOT NULL DEFAULT '', after_sha TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('applied', 'reverted', 'failed')),
  detail TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
);
INSERT INTO integrations_new (id, project_id, task_id, before_sha, after_sha, status, detail, created_at)
  SELECT i.id, o.project_id, i.task_id, i.before_sha, i.after_sha,
         CASE WHEN i.reverted_at IS NULL THEN 'applied' ELSE 'reverted' END, '', i.created_at
  FROM integrations i JOIN tasks t ON t.id = i.task_id JOIN objectives o ON o.id = t.objective_id;
DROP TABLE integrations;
ALTER TABLE integrations_new RENAME TO integrations;
CREATE INDEX integrations_project ON integrations(project_id, id);
CREATE INDEX integrations_task ON integrations(task_id, id);
`;

// Migraciones en orden; la posición + 1 es el valor de user_version tras aplicarla.
// Para cambiar el esquema en el futuro: añadir un elemento al final, nunca editar los anteriores.
export const migrations: Array<(db: DatabaseSync) => void> = [
  (db) => db.exec(schemaSql()),
  (db) => db.exec(MIGRATION_2),
  (db) => db.exec(MIGRATION_3),
  (db) => db.exec(MIGRATION_4),
  (db) => db.exec(MIGRATION_5),
];

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA journal_mode = WAL'); // en :memory: se queda en "memory", sin error
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let v = row.user_version; v < migrations.length; v++) {
    db.exec('BEGIN');
    try {
      migrations[v](db);
      db.exec(`PRAGMA user_version = ${v + 1}`); // PRAGMA no admite parámetros; v es un entero propio
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}
