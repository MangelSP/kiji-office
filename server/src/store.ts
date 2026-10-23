// Base de la puerta: sub de Google -> relay del usuario (SQLite).
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface UserRow { sub: string; email: string; relay_url: string; app_uuid: string; created_at: number }
export interface Store { get(sub: string): UserRow | undefined; put(row: UserRow): void }

/** Abre (o crea) la base. `:memory:` sirve para pruebas. */
export function openStore(path: string): Store {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE IF NOT EXISTS users (
    sub TEXT PRIMARY KEY, email TEXT NOT NULL, relay_url TEXT NOT NULL, app_uuid TEXT NOT NULL, created_at INTEGER NOT NULL)`);
  const sel = db.prepare('SELECT sub, email, relay_url, app_uuid, created_at FROM users WHERE sub = ?');
  const ins = db.prepare('INSERT OR REPLACE INTO users (sub, email, relay_url, app_uuid, created_at) VALUES (?, ?, ?, ?, ?)');
  return {
    get: (sub) => sel.get(sub) as UserRow | undefined,
    put: (r) => { ins.run(r.sub, r.email, r.relay_url, r.app_uuid, r.created_at); },
  };
}
