// Apertura de la base SQLite (node:sqlite) y migraciones por PRAGMA user_version.
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

// schema.sql se copia junto al .js compilado en `npm run build` (ver core/package.json),
// así que esta misma ruta relativa vale para src/ (vitest) y para dist/.
const schemaSql = (): string => readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

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

// Migraciones en orden; la posición + 1 es el valor de user_version tras aplicarla.
// Para cambiar el esquema en el futuro: añadir un elemento al final, nunca editar los anteriores.
export const migrations: Array<(db: DatabaseSync) => void> = [
  (db) => db.exec(schemaSql()),
  (db) => db.exec(MIGRATION_2),
  (db) => db.exec(MIGRATION_3),
  (db) => db.exec(MIGRATION_4),
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
