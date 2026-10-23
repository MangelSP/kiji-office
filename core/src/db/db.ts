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

// Migraciones en orden; la posición + 1 es el valor de user_version tras aplicarla.
// Para cambiar el esquema en el futuro: añadir un elemento al final, nunca editar los anteriores.
const migrations: Array<(db: DatabaseSync) => void> = [(db) => db.exec(schemaSql()), (db) => db.exec(MIGRATION_2)];

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
