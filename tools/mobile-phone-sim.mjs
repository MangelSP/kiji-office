// "Móvil" de prueba (M1 de PLAN-movil.md): hace lo que hará la app Flutter. Con el enlace del QR abre sesión en la
// puerta (token de desarrollo), saluda al relay, se vincula con el Mac y le pide cosas al core por el canal cifrado.
//   node tools/mobile-phone-sim.mjs "kiji://pair?g=...&m=...&p=...&s=..." [dev:<correo>]
import nacl from 'tweetnacl';
import WebSocket from 'ws';

const [uri, idToken = 'dev:test@example.com'] = process.argv.slice(2);
if (!uri?.startsWith('kiji://pair?')) {
  console.error('Uso: node tools/mobile-phone-sim.mjs "<enlace kiji://pair del QR>" [dev:<correo>]');
  process.exit(2);
}
const q = new URL(uri.replace('kiji://', 'http://x/')).searchParams;
const [gateway, macPub, pairId, secret] = ['g', 'm', 'p', 's'].map((k) => q.get(k));
const b64 = (u) => Buffer.from(u).toString('base64');
const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));
const me = nacl.box.keyPair();
const mac = unb64(macPub);

const seal = (obj) => {
  const nonce = nacl.randomBytes(24);
  return { nonce: b64(nonce), box: b64(nacl.box(Buffer.from(JSON.stringify(obj)), nonce, mac, me.secretKey)) };
};
const open = (m) => {
  const plain = nacl.box.open(unb64(m.box), unb64(m.nonce), mac, me.secretKey);
  return plain && JSON.parse(Buffer.from(plain).toString());
};

const res = await fetch(`${gateway}/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idToken, device: 'phone' }) });
const session = await res.json();
if (!res.ok) throw new Error(`puerta ${res.status}: ${JSON.stringify(session)}`);
console.log(`✓ sesión en la puerta (${session.email}) → ${session.relayUrl}`);

const ws = new WebSocket(session.relayUrl);
const pending = new Map();
let events = 0;
let paired;
const isPaired = new Promise((r) => (paired = r));
// Id de sesión que manda el Mac (cifrado) al vernos conectados: va en cada petición, con un `n` creciente.
let macSession;
let gotSession;
const hasSession = new Promise((r) => (gotSession = r));
ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', pass: session.pass, pubkey: b64(me.publicKey) })));
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw));
  if (m.type === 'welcome') {
    console.log(`✓ relay: welcome (${m.peers.length} conectado/s)`);
    ws.send(JSON.stringify({ type: 'pair.claim', pairId, to: macPub, ...seal({ secret, name: 'Móvil de prueba' }) }));
  } else if (m.type === 'msg' && m.from === macPub) {
    const inner = open(m);
    if (!inner) return console.log('✗ caja del Mac que no abre');
    if (inner.t === 'pair.ok') paired();
    if (inner.t === 'session') {
      macSession = inner.s;
      gotSession();
    }
    if (inner.t === 'line') {
      const line = JSON.parse(inner.line);
      if (line.type === 'event') events++;
      else pending.get(line.id)?.(line);
    }
  } else if (m.type === 'error') {
    console.log(`relay error: ${m.code}`);
  }
});

let n = 0;
const call = (method, params) =>
  new Promise((resolve, reject) => {
    const id = `p${++n}`;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ type: 'msg', to: macPub, ...seal({ t: 'req', s: macSession, n, id, type: 'req', method, ...(params ? { params } : {}) }) }));
    setTimeout(() => reject(new Error(`${method}: sin respuesta en 10 s`)), 10_000).unref();
  });

let fails = 0;
const check = (ok, what) => {
  console.log(`${ok ? '✓' : '✗'} ${what}`);
  if (!ok) fails++;
};
await Promise.race([isPaired, new Promise((_, r) => setTimeout(() => r(new Error('el Mac no confirmó la vinculación')), 10_000))]);
console.log('✓ vinculado (pair.ok cifrado del Mac)');
await Promise.race([hasSession, new Promise((_, r) => setTimeout(() => r(new Error('el Mac no mandó la sesión')), 10_000))]);
console.log('✓ sesión recibida');
check((await call('ping')).result === 'pong', 'ping → pong por el canal cifrado');
const ov = await call('workspaces.overview');
check(Array.isArray(ov.result?.workspaces), `workspaces.overview (${ov.result?.workspaces?.length ?? '?'} workspaces)`);
const ap = await call('approval.list');
check(Array.isArray(ap.result), `approval.list (${ap.result?.length ?? '?'} pendientes)`);
check((await call('secrets.put', { account: 'openai', value: 'kiji-test-123' })).error?.code === 'forbidden', 'secrets.put rechazado');
check((await call('settings.set', { key: 'x', value: 1 })).error?.code === 'forbidden', 'settings.set rechazado');
// Reproducción: la misma caja de un `ping` enviada dos veces solo se contesta una vez.
{
  const id = `p${++n}`;
  const frame = JSON.stringify({ type: 'msg', to: macPub, ...seal({ t: 'req', s: macSession, n, id, type: 'req', method: 'ping' }) });
  let answers = 0;
  pending.set(id, () => answers++);
  ws.send(frame);
  await new Promise((r) => setTimeout(r, 800));
  pending.set(id, () => answers++);
  ws.send(frame);
  await new Promise((r) => setTimeout(r, 1500));
  check(answers === 1, `caja repetida descartada (${answers} respuesta/s)`);
}
await new Promise((r) => setTimeout(r, 1000));
console.log(`eventos recibidos: ${events}`);
ws.close();
process.exit(fails ? 1 : 0);
