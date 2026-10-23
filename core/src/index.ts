// kiji-core: servidor NDJSON por stdio. Stdout es solo para protocolo; los logs van a stderr.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import type { Request, Response } from '../../shared/protocol.js';
import { emit, writeLine } from './bus.js';
import { openDb } from './db/db.js';
import { createOrchestrator } from './orchestrator/index.js';

type Handler = (params: unknown, req?: { id: string }) => unknown | Promise<unknown>;

/** Ruta de la BD: `--db <ruta>` o `--db=<ruta>`. Sin ella, memoria (los datos se pierden al salir). */
function dbPathFromArgv(argv: string[]): string {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--db' && argv[i + 1]) return argv[i + 1]!;
    if (argv[i]!.startsWith('--db=') && argv[i]!.length > 5) return argv[i]!.slice(5);
  }
  process.stderr.write('kiji-core: falta --db <ruta>; uso una base de datos en memoria (se perderá al salir)\n');
  return ':memory:';
}

const dbPath = dbPathFromArgv(process.argv.slice(2));
if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
const orchestrator = createOrchestrator({ db: openDb(dbPath), emit });

const handlers: Record<string, Handler> = {
  ping: () => 'pong',
  ...orchestrator.handlers,
};

async function handle(line: string): Promise<void> {
  if (line.trim() === '') return;

  let msg: Partial<Request>;
  try {
    msg = JSON.parse(line);
  } catch (err) {
    emit('core.error', { code: 'invalid_json', message: String(err), line });
    return;
  }
  if (msg === null || typeof msg !== 'object' || msg.type !== 'req' || typeof msg.id !== 'string') {
    emit('core.error', { code: 'invalid_request', message: 'se esperaba {id, type:"req", method}', line });
    return;
  }

  const res: Response = { id: msg.id, type: 'res' };
  const handler = typeof msg.method === 'string' && Object.hasOwn(handlers, msg.method) ? handlers[msg.method] : undefined;
  if (!handler) {
    res.error = { code: 'unknown_method', message: `método desconocido: ${String(msg.method)}` };
  } else {
    try {
      res.result = await handler(msg.params, { id: msg.id }); // `secrets.put` exige id "rust:*"
    } catch (err) {
      res.error = { code: typeof (err as { code?: unknown })?.code === 'string' ? (err as { code: string }).code : 'handler_error', message: err instanceof Error ? err.message : String(err) };
    }
  }
  writeLine(res);
}

const rl = createInterface({ input: process.stdin });
// Las peticiones se atienden de una en una, en orden de llegada: así `project.open` termina antes de que
// `agent.list` mire el proyecto activo y dos `task.start` seguidos no compiten. Los runs de los agentes
// van por su cuenta (en segundo plano), así que una petición nunca espera a que un agente termine.
let queue: Promise<void> = Promise.resolve();
rl.on('line', (line) => {
  queue = queue.then(() => handle(line)).catch(() => undefined);
});
// Al cerrarse stdin (la app se cierra): se contestan las peticiones pendientes (p. ej. `echo ... | node core`) y se
// paran los agentes en marcha antes de salir, para que no queden procesos huérfanos.
rl.on('close', () => {
  void queue.then(() => orchestrator.shutdown()).finally(() => process.exit(0));
});
process.on('unhandledRejection', (err) => {
  process.stderr.write(`kiji-core: promesa rechazada sin capturar: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
});

emit('core.ready', { version: '0.1.0' });
// 0.2b: pide a Rust las claves `conn:*` del llavero (llegan por `secrets.put` con id "rust:*").
orchestrator.requestSecrets();
orchestrator.announceHalted();
