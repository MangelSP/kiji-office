// kiji-core: servidor NDJSON por stdio. Stdout es solo para protocolo; los logs van a stderr.
import { createInterface } from 'node:readline';
import type { Request, Response } from '../../shared/protocol.js';
import { emit, writeLine } from './bus.js';

type Handler = (params: unknown) => unknown | Promise<unknown>;

// Los demás métodos de 0.1 se irán registrando aquí en pasos posteriores.
const handlers: Record<string, Handler> = {
  ping: () => 'pong',
  'events.tail': () => [],
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
      res.result = await handler(msg.params);
    } catch (err) {
      res.error = { code: 'handler_error', message: err instanceof Error ? err.message : String(err) };
    }
  }
  writeLine(res);
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  void handle(line);
});
rl.on('close', () => process.exit(0));

emit('core.ready', { version: '0.1.0' });
