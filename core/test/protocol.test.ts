import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));

type Line = Record<string, any>;

let child: ChildProcessWithoutNullStreams;
const lines: Line[] = [];
const waiters: Array<() => void> = [];

// Espera a que aparezca una línea que cumpla `match` (mira las ya recibidas y las nuevas).
async function waitFor(match: (l: Line) => boolean, ms = 5000): Promise<Line> {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = lines.find(match);
    if (found) return found;
    if (Date.now() > deadline) throw new Error('timeout esperando línea del core');
    await new Promise<void>((resolve) => {
      waiters.push(resolve);
      setTimeout(resolve, 50);
    });
  }
}

beforeAll(() => {
  // Compila el core para probar siempre el dist actual.
  execFileSync('npm', ['run', 'build:core'], { cwd: root, stdio: 'pipe' });
  child = spawn('node', ['core/dist/index.js'], { cwd: root });
  createInterface({ input: child.stdout }).on('line', (raw) => {
    lines.push(JSON.parse(raw)); // si stdout no es NDJSON, el test falla
    waiters.splice(0).forEach((w) => w());
  });
}, 60_000);

afterAll(() => {
  child.kill();
});

describe('protocolo NDJSON del core', () => {
  it('emite core.ready al arrancar', async () => {
    const ready = await waitFor((l) => l.type === 'event' && l.name === 'core.ready');
    expect(ready.payload).toBeDefined();
  });

  it('responde pong a ping', async () => {
    child.stdin.write(JSON.stringify({ id: 'p1', type: 'req', method: 'ping' }) + '\n');
    const res = await waitFor((l) => l.type === 'res' && l.id === 'p1');
    expect(res.result).toBe('pong');
    expect(res.error).toBeUndefined();
  });

  it('events.tail devuelve una lista vacía', async () => {
    child.stdin.write(JSON.stringify({ id: 't1', type: 'req', method: 'events.tail' }) + '\n');
    const res = await waitFor((l) => l.type === 'res' && l.id === 't1');
    expect(res.result).toEqual([]);
  });

  it('método desconocido -> unknown_method', async () => {
    child.stdin.write(JSON.stringify({ id: 'u1', type: 'req', method: 'no.existe' }) + '\n');
    const res = await waitFor((l) => l.type === 'res' && l.id === 'u1');
    expect(res.error?.code).toBe('unknown_method');
  });

  it('JSON inválido -> evento core.error', async () => {
    child.stdin.write('esto no es json\n');
    const ev = await waitFor((l) => l.type === 'event' && l.name === 'core.error');
    expect(ev.payload.code).toBe('invalid_json');
  });

  it('sigue respondiendo tras un JSON inválido', async () => {
    child.stdin.write(JSON.stringify({ id: 'p2', type: 'req', method: 'ping' }) + '\n');
    const res = await waitFor((l) => l.type === 'res' && l.id === 'p2');
    expect(res.result).toBe('pong');
  });
});
