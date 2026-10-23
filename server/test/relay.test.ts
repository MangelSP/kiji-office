import type { AddressInfo } from 'node:net';
import nacl from 'tweetnacl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { relayKey, signPass } from '../src/pass.ts';
import { createRelay, type Relay } from '../src/relay.ts';

const SECRET = 'secreto-de-prueba-secreto-de-prueba';
const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');
const pairId = () => Buffer.from(nacl.randomBytes(16)).toString('base64url');
const pass = (sub: string, dev: 'mac' | 'phone', expOffsetS = 300) => {
  const iat = Math.floor(Date.now() / 1000);
  return signPass({ sub, email: `${sub}@x.c`, dev, iat, exp: iat + expOffsetS }, relayKey(SECRET, sub));
};

let relay: Relay | undefined;
const sockets: WebSocket[] = [];
afterEach(async () => { sockets.forEach((s) => s.terminate()); sockets.length = 0; await relay?.close(); relay = undefined; });

async function boot(opts: Partial<Parameters<typeof createRelay>[0]> = {}) {
  relay = createRelay({ passSecret: SECRET, ...opts });
  await new Promise<void>((r) => relay!.server.listen(0, '127.0.0.1', r));
  return `ws://127.0.0.1:${(relay.server.address() as AddressInfo).port}/ws`;
}

/** Cliente de prueba con cola de mensajes. */
class Client {
  ws: WebSocket; kp = nacl.box.keyPair(); inbox: any[] = []; closed = false; waiters: (() => void)[] = [];
  constructor(url: string) {
    this.ws = new WebSocket(url);
    sockets.push(this.ws);
    this.ws.on('message', (d) => { this.inbox.push(JSON.parse(d.toString())); this.waiters.splice(0).forEach((w) => w()); });
    this.ws.on('close', () => { this.closed = true; this.waiters.splice(0).forEach((w) => w()); });
  }
  get pub() { return b64(this.kp.publicKey); }
  open() { return new Promise<void>((r) => this.ws.once('open', () => r())); }
  send(m: object) { this.ws.send(JSON.stringify(m)); }
  async next(pred: (m: any) => boolean = () => true): Promise<any> {
    for (let i = 0; i < 200; i++) {
      const k = this.inbox.findIndex(pred);
      if (k >= 0) return this.inbox.splice(k, 1)[0];
      await new Promise<void>((r) => { this.waiters.push(r); setTimeout(r, 25); });
    }
    throw new Error('sin mensaje');
  }
  async waitClosed() { for (let i = 0; i < 100 && !this.closed; i++) await new Promise<void>((r) => { this.waiters.push(r); setTimeout(r, 25); }); return this.closed; }
}

async function join(url: string, sub: string, dev: 'mac' | 'phone') {
  const c = new Client(url);
  await c.open();
  c.send({ type: 'hello', pass: pass(sub, dev), pubkey: c.pub });
  const w = await c.next();
  expect(w.type).toBe('welcome');
  return c;
}
const seal = (obj: object, to: Client, from: Client) => {
  const nonce = nacl.randomBytes(24);
  return { nonce: b64(nonce), box: b64(nacl.box(Buffer.from(JSON.stringify(obj)), nonce, to.kp.publicKey, from.kp.secretKey)) };
};
const open = (m: { nonce: string; box: string }, from: Client, to: Client) =>
  JSON.parse(Buffer.from(nacl.box.open(Buffer.from(m.box, 'base64'), Buffer.from(m.nonce, 'base64'), from.kp.publicKey, to.kp.secretKey)!).toString());

describe('relay: saludo', () => {
  it('rechaza pase inválido, vencido, de otro OWNER_SUB y pubkey mala', async () => {
    const url = await boot({ ownerSub: 'dueno' });
    for (const p of ['basura', pass('dueno', 'mac', -10), pass('intruso', 'mac')]) {
      const c = new Client(url); await c.open();
      c.send({ type: 'hello', pass: p, pubkey: c.pub });
      expect(await c.next()).toEqual({ type: 'error', code: 'unauthorized' });
      expect(await c.waitClosed()).toBe(true);
    }
    const c = new Client(url); await c.open();
    c.send({ type: 'hello', pass: pass('dueno', 'mac'), pubkey: 'corta' });
    expect((await c.next()).code).toBe('unauthorized');
  });
  it('relay de un usuario: solo su clave derivada; un pase firmado con PASS_SECRET o con la clave de otro no entra', async () => {
    const url = await boot({ passSecret: undefined, relayKey: relayKey(SECRET, 'dueno'), ownerSub: 'dueno' });
    const iat = Math.floor(Date.now() / 1000);
    const forged = [
      signPass({ sub: 'dueno', email: 'e', dev: 'mac', iat, exp: iat + 300 }, SECRET),
      signPass({ sub: 'dueno', email: 'e', dev: 'mac', iat, exp: iat + 300 }, relayKey(SECRET, 'otro')),
    ];
    for (const p of forged) {
      const c = new Client(url); await c.open();
      c.send({ type: 'hello', pass: p, pubkey: c.pub });
      expect(await c.next()).toEqual({ type: 'error', code: 'unauthorized' });
    }
    const ok = new Client(url); await ok.open();
    ok.send({ type: 'hello', pass: pass('dueno', 'mac'), pubkey: ok.pub });
    expect((await ok.next()).type).toBe('welcome');
  });
  it('relay compartido: un pase firmado con la clave de otro usuario no vale', async () => {
    const url = await boot();
    const iat = Math.floor(Date.now() / 1000);
    const c = new Client(url); await c.open();
    c.send({ type: 'hello', pass: signPass({ sub: 'victima', email: 'e', dev: 'mac', iat, exp: iat + 300 }, relayKey(SECRET, 'atacante')), pubkey: c.pub });
    expect(await c.next()).toEqual({ type: 'error', code: 'unauthorized' });
  });
  it('welcome con pares y presencia online/offline', async () => {
    const url = await boot();
    const mac = await join(url, 'u', 'mac');
    const ph = new Client(url); await ph.open();
    ph.send({ type: 'hello', pass: pass('u', 'phone'), pubkey: ph.pub });
    expect(await ph.next()).toEqual({ type: 'welcome', peers: [{ pubkey: mac.pub, dev: 'mac' }] });
    expect(await mac.next()).toEqual({ type: 'peer.online', pubkey: ph.pub, dev: 'phone' });
    ph.ws.close();
    expect(await mac.next()).toEqual({ type: 'peer.offline', pubkey: ph.pub });
  });
  it('una segunda conexión con la misma pubkey reemplaza a la anterior', async () => {
    const url = await boot();
    const a = await join(url, 'u', 'phone');
    const b = new Client(url); b.kp = a.kp; await b.open();
    b.send({ type: 'hello', pass: pass('u', 'phone'), pubkey: b.pub });
    expect((await b.next()).type).toBe('welcome');
    expect(await a.waitClosed()).toBe(true);
  });
  it('cierra si no hay hello a tiempo', async () => {
    const url = await boot({ helloTimeoutMs: 100 });
    const c = new Client(url); await c.open();
    expect(await c.waitClosed()).toBe(true);
  });
});

describe('relay: emparejamiento', () => {
  it('flujo completo: el Mac abre la caja y ve el secreto', async () => {
    const url = await boot();
    const mac = await join(url, 'u', 'mac');
    const ph = await join(url, 'u', 'phone');
    const id = pairId();
    mac.send({ type: 'pair.offer', pairId: id });
    await new Promise((r) => setTimeout(r, 30));
    const secret = Buffer.from(nacl.randomBytes(32)).toString('base64url');
    ph.send({ type: 'pair.claim', pairId: id, to: mac.pub, ...seal({ secret, name: 'Pixel' }, mac, ph) });
    const got = await mac.next((m) => m.type === 'pair.claim');
    expect(got.from).toBe(ph.pub);
    expect(open(got, ph, mac)).toEqual({ secret, name: 'Pixel' });
    // el Mac responde pair.ok y llega con from
    mac.send({ type: 'msg', to: ph.pub, ...seal({ t: 'pair.ok' }, ph, mac) });
    const ok = await ph.next((m) => m.type === 'msg');
    expect(ok.from).toBe(mac.pub);
    expect(open(ok, mac, ph)).toEqual({ t: 'pair.ok' });
  });
  it('un pairId usado no se puede reutilizar', async () => {
    const url = await boot();
    const mac = await join(url, 'u', 'mac');
    const ph = await join(url, 'u', 'phone');
    const id = pairId();
    mac.send({ type: 'pair.offer', pairId: id });
    await new Promise((r) => setTimeout(r, 30));
    const claim = { type: 'pair.claim', pairId: id, to: mac.pub, ...seal({ secret: 's' }, mac, ph) };
    ph.send(claim);
    await mac.next((m) => m.type === 'pair.claim');
    ph.send(claim);
    expect((await ph.next((m) => m.type === 'error')).code).toBe('pair_invalid');
  });
  it('un pairId caducado (5 min) se rechaza', async () => {
    let t = 1_000_000;
    const url = await boot({ now: () => t });
    const mac = new Client(url); await mac.open();
    mac.send({ type: 'hello', pass: signPass({ sub: 'u', email: 'e', dev: 'mac', iat: t / 1000, exp: t / 1000 + 100_000 }, relayKey(SECRET, 'u')), pubkey: mac.pub });
    await mac.next();
    const ph = new Client(url); await ph.open();
    ph.send({ type: 'hello', pass: signPass({ sub: 'u', email: 'e', dev: 'phone', iat: t / 1000, exp: t / 1000 + 100_000 }, relayKey(SECRET, 'u')), pubkey: ph.pub });
    await ph.next();
    const id = pairId();
    mac.send({ type: 'pair.offer', pairId: id });
    await new Promise((r) => setTimeout(r, 30));
    t += 5 * 60_000 + 1;
    ph.send({ type: 'pair.claim', pairId: id, to: mac.pub, ...seal({ secret: 's' }, mac, ph) });
    expect((await ph.next((m) => m.type === 'error')).code).toBe('pair_invalid');
  });
  it('pair.claim desde otro sub se rechaza y no consume la oferta', async () => {
    const url = await boot();
    const mac = await join(url, 'u', 'mac');
    const intruso = await join(url, 'otro', 'phone');
    const ph = await join(url, 'u', 'phone');
    const id = pairId();
    mac.send({ type: 'pair.offer', pairId: id });
    await new Promise((r) => setTimeout(r, 30));
    intruso.send({ type: 'pair.claim', pairId: id, to: mac.pub, ...seal({ secret: 's' }, mac, intruso) });
    expect((await intruso.next((m) => m.type === 'error')).code).toBe('pair_invalid');
    ph.send({ type: 'pair.claim', pairId: id, to: mac.pub, ...seal({ secret: 's' }, mac, ph) });
    expect((await mac.next((m) => m.type === 'pair.claim')).from).toBe(ph.pub);
  });
  it('el claim a otro Mac (pubkey distinta de la oferta) se rechaza', async () => {
    const url = await boot();
    const mac = await join(url, 'u', 'mac');
    const mac2 = await join(url, 'u', 'mac');
    const ph = await join(url, 'u', 'phone');
    const id = pairId();
    mac.send({ type: 'pair.offer', pairId: id });
    await new Promise((r) => setTimeout(r, 30));
    ph.send({ type: 'pair.claim', pairId: id, to: mac2.pub, ...seal({ secret: 's' }, mac2, ph) });
    expect((await ph.next((m) => m.type === 'error')).code).toBe('pair_invalid');
  });
});

describe('relay: mensajes', () => {
  it('entrega msg dentro del mismo sub con from correcto', async () => {
    const url = await boot();
    const mac = await join(url, 'u', 'mac');
    const ph = await join(url, 'u', 'phone');
    ph.send({ type: 'msg', to: mac.pub, ...seal({ t: 'req', id: 1 }, mac, ph) });
    const m = await mac.next((x) => x.type === 'msg');
    expect(m.from).toBe(ph.pub);
    expect(open(m, ph, mac)).toEqual({ t: 'req', id: 1 });
  });
  it('a otro sub o a alguien no conectado responde offline igual', async () => {
    const url = await boot();
    const a = await join(url, 'u', 'phone');
    const b = await join(url, 'otro', 'mac');
    a.send({ type: 'msg', to: b.pub, ...seal({ t: 'x' }, b, a) });
    expect(await a.next((m) => m.type === 'error')).toEqual({ type: 'error', code: 'offline', to: b.pub });
    const ghost = nacl.box.keyPair();
    a.send({ type: 'msg', to: b64(ghost.publicKey), ...seal({ t: 'x' }, b, a) });
    expect((await a.next((m) => m.type === 'error')).code).toBe('offline');
    expect(b.inbox.filter((m) => m.type === 'msg')).toHaveLength(0);
  });
  it('valida nonce y destino', async () => {
    const url = await boot();
    const a = await join(url, 'u', 'phone');
    a.send({ type: 'msg', to: a.pub, nonce: 'corto', box: 'AAAA' });
    expect((await a.next((m) => m.type === 'error')).code).toBe('bad_request');
  });
  it('rate limit de 50/s', async () => {
    const url = await boot();
    const a = await join(url, 'u', 'phone');
    for (let i = 0; i < 80; i++) a.send({ type: 'msg', to: a.pub, ...seal({ i }, a, a) });
    const e = await a.next((m) => m.type === 'error' && m.code === 'rate_limited');
    expect(e.code).toBe('rate_limited');
  });
});

describe('relay: push', () => {
  it('push.wake llama a push con los tokens del mismo sub', async () => {
    const push = vi.fn();
    const url = await boot({ push });
    const mac = await join(url, 'u', 'mac');
    const ph = await join(url, 'u', 'phone');
    const otro = await join(url, 'otro', 'phone');
    ph.send({ type: 'push.register', token: 'tok-1', platform: 'fcm' });
    otro.send({ type: 'push.register', token: 'tok-otro', platform: 'fcm' });
    await new Promise((r) => setTimeout(r, 50));
    mac.send({ type: 'push.wake' });
    await vi.waitFor(() => expect(push).toHaveBeenCalledWith(['tok-1']));
  });
  it('un móvil no puede despertar', async () => {
    const push = vi.fn();
    const url = await boot({ push });
    const ph = await join(url, 'u', 'phone');
    ph.send({ type: 'push.register', token: 't', platform: 'fcm' });
    ph.send({ type: 'push.wake' });
    expect((await ph.next((m) => m.type === 'error')).code).toBe('bad_request');
    expect(push).not.toHaveBeenCalled();
  });
});
