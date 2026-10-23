// Cliente de prueba del puente remoto (M0 de PLAN-movil.md). Habla con Kiji en marcha (`npm run tauri dev`) por el
// socket de desarrollo, como lo hará el móvil: pide lo permitido, comprueba que lo prohibido se rechaza y escucha
// eventos unos segundos.
//   node tools/remote-client.mjs [ruta del socket]
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const sock = process.argv[2] ?? join(homedir(), 'Library/Application Support/com.kiji.office/remote-dev.sock');
const conn = createConnection(sock);
const pending = new Map();
let events = 0;
let n = 0;

createInterface({ input: conn }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'event') return void events++;
  pending.get(msg.id)?.(msg);
  pending.delete(msg.id);
});
conn.on('error', (e) => {
  console.error(`No se pudo conectar a ${sock}: ${e.message}. ¿Está Kiji abierta con \`npm run tauri dev\`?`);
  process.exit(1);
});

const call = (method, params) =>
  new Promise((resolve) => {
    const id = `m${++n}`;
    pending.set(id, resolve);
    conn.write(JSON.stringify({ id, type: 'req', method, ...(params ? { params } : {}) }) + '\n');
  });

let fails = 0;
const check = (ok, what) => {
  console.log(`${ok ? '✓' : '✗'} ${what}`);
  if (!ok) fails++;
};

const ping = await call('ping');
check(ping.result === 'pong', 'ping → pong');
const ov = await call('workspaces.overview');
check(!ov.error && Array.isArray(ov.result?.workspaces), `workspaces.overview (${ov.result?.workspaces?.length ?? '?'} workspaces)`);
const ap = await call('approval.list');
check(!ap.error && Array.isArray(ap.result), `approval.list (${ap.result?.length ?? '?'} pendientes)`);
for (const [method, params] of [
  ['secrets.put', { account: 'openai', value: 'kiji-test-123' }],
  ['connection.list'],
  ['settings.set', { key: 'x', value: 1 }],
  ['integration.apply', { taskId: 'x' }],
  ['project.open', { path: '/' }],
]) {
  const r = await call(method, params);
  check(r.error?.code === 'forbidden', `${method} rechazado`);
}
await new Promise((r) => setTimeout(r, 3000));
console.log(`eventos recibidos en 3 s: ${events}`);
conn.end();
process.exit(fails ? 1 : 0);
