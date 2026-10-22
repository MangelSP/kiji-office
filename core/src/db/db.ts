// Apertura de la base SQLite (node:sqlite) y migraciones por PRAGMA user_version.
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

// schema.sql se copia junto al .js compilado en `npm run build` (ver core/package.json),
// así que esta misma ruta relativa vale para src/ (vitest) y para dist/.
const schemaSql = (): string => readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

// Migraciones en orden; la posición + 1 es el valor de user_version tras aplicarla.
// Para cambiar el esquema en el futuro: añadir un elemento al final, nunca editar los anteriores.
const migrations: Array<(db: DatabaseSync) => void> = [(db) => db.exec(schemaSql())];

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
