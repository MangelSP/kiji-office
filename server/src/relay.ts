// Relay: sala por usuario (sub). Empareja Mac y móvil y reenvía cajas cifradas sin abrirlas ni registrarlas.
import { createServer, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { claimedSub, relayKey, verifyPass } from './pass.ts';
import { logPush, type Push } from './push.ts';

/**
 * Relay de un usuario: `relayKey` (su clave derivada) + `ownerSub`. Relay compartido (desarrollo o self-host):
 * `passSecret`, del que deriva la clave de cada pase según su `sub`.
 */
export interface RelayOpts { passSecret?: string; relayKey?: string; ownerSub?: string; push?: Push; now?: () => number; helloTimeoutMs?: number }
export interface Relay { server: Server; close(): Promise<void> }

const HELLO_TIMEOUT_MS = 10_000;
const PING_MS = 30_000;
const PAIR_TTL_MS = 5 * 60_000;
const RATE_MAX = 50; // mensajes por segundo y conexión
const MAX_OFFERS = 8; // ofertas vivas por Mac
const MAX_TOKENS = 20; // tokens de push por sub

interface Conn { ws: WebSocket; sub: string; dev: 'mac' | 'phone'; pubkey: string; alive: boolean; winStart: number; winCount: number }
interface Offer { sub: string; mac: string; expires: number }

/** Base64 estándar canónico que decodifica a exactamente `bytes` bytes. */
const isB64 = (v: unknown, bytes: number): v is string =>
  typeof v === 'string' && v.length < 200 && Buffer.from(v, 'base64').length === bytes && Buffer.from(v, 'base64').toString('base64') === v;
const isBox = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(v);
const isPairId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{22}$/.test(v);

export function createRelay(o: RelayOpts): Relay {
  const now = o.now ?? Date.now;
  const push = o.push ?? logPush;
  const rooms = new Map<string, Map<string, Conn>>(); // sub -> pubkey -> conexión
  const offers = new Map<string, Offer>();
  const tokens = new Map<string, Set<string>>(); // sub -> tokens de push

  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); return; }
    res.writeHead(404); res.end();
  });
  server.on('upgrade', (req, socket: Duplex, head) => {
    if ((req.url ?? '').split('?')[0] !== '/ws') { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws));
  });

  const sendRaw = (ws: WebSocket, msg: object): void => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); };
  const err = (ws: WebSocket, code: string, extra: object = {}): void => sendRaw(ws, { type: 'error', code, ...extra });
  const others = (c: Conn): Conn[] => [...(rooms.get(c.sub)?.values() ?? [])].filter((x) => x !== c);

  function sweepOffers(): void {
    const t = now();
    for (const [id, of] of offers) if (of.expires <= t) offers.delete(id);
  }

  function onConnection(ws: WebSocket): void {
    let conn: Conn | null = null;
    const helloTimer = setTimeout(() => { if (!conn) ws.close(4001, 'hello timeout'); }, o.helloTimeoutMs ?? HELLO_TIMEOUT_MS);

    ws.on('pong', () => { if (conn) conn.alive = true; });
    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (!conn) return;
      const room = rooms.get(conn.sub);
      if (room?.get(conn.pubkey) !== conn) return; // ya reemplazada
      room.delete(conn.pubkey);
      if (!room.size) rooms.delete(conn.sub);
      for (const [id, of] of offers) if (of.sub === conn.sub && of.mac === conn.pubkey) offers.delete(id);
      for (const p of others(conn)) sendRaw(p.ws, { type: 'peer.offline', pubkey: conn.pubkey });
    });
    ws.on('error', () => { /* el cierre ya limpia */ });

    ws.on('message', (data, isBinary) => {
      let m: any;
      try {
        if (isBinary) throw new Error('binario');
        m = JSON.parse(data.toString());
        if (!m || typeof m !== 'object' || typeof m.type !== 'string') throw new Error('forma');
      } catch { err(ws, 'bad_request'); return; }

      if (!conn) {
        if (m.type !== 'hello') { err(ws, 'unauthorized'); ws.close(); return; }
        const sub = claimedSub(m.pass);
        const key = o.relayKey ?? (o.passSecret && sub ? relayKey(o.passSecret, sub) : undefined);
        const claims = key ? verifyPass(m.pass, key, now()) : null;
        if (!claims || (o.ownerSub !== undefined && claims.sub !== o.ownerSub) || !isB64(m.pubkey, 32)) {
          err(ws, 'unauthorized'); ws.close(); return;
        }
        clearTimeout(helloTimer);
        const c: Conn = { ws, sub: claims.sub, dev: claims.dev, pubkey: m.pubkey, alive: true, winStart: now(), winCount: 0 };
        let room = rooms.get(c.sub);
        if (!room) rooms.set(c.sub, (room = new Map()));
        const old = room.get(c.pubkey);
        room.set(c.pubkey, c);
        conn = c;
        if (old) old.ws.close(4000, 'replaced');
        sendRaw(ws, { type: 'welcome', peers: others(c).map((p) => ({ pubkey: p.pubkey, dev: p.dev })) });
        for (const p of others(c)) sendRaw(p.ws, { type: 'peer.online', pubkey: c.pubkey, dev: c.dev });
        return;
      }

      const t = now();
      if (t - conn.winStart >= 1000) { conn.winStart = t; conn.winCount = 0; }
      if (++conn.winCount > RATE_MAX) { err(ws, 'rate_limited'); return; }
      handle(conn, m);
    });
  }

  function handle(c: Conn, m: any): void {
    switch (m.type) {
      case 'pair.offer': {
        sweepOffers();
        if (c.dev !== 'mac' || !isPairId(m.pairId) || offers.has(m.pairId)) return err(c.ws, 'bad_request');
        let mine = 0;
        for (const of of offers.values()) if (of.sub === c.sub && of.mac === c.pubkey) mine++;
        if (mine >= MAX_OFFERS) return err(c.ws, 'bad_request');
        offers.set(m.pairId, { sub: c.sub, mac: c.pubkey, expires: now() + PAIR_TTL_MS });
        return;
      }
      case 'pair.claim': {
        if (!isPairId(m.pairId) || !isB64(m.to, 32) || !isB64(m.nonce, 24) || !isBox(m.box)) return err(c.ws, 'bad_request');
        sweepOffers();
        const of = offers.get(m.pairId);
        // Mismo error para todo fallo: no se filtra qué existe.
        if (c.dev !== 'phone' || !of || of.sub !== c.sub || of.mac !== m.to) return err(c.ws, 'pair_invalid');
        const mac = rooms.get(c.sub)?.get(m.to);
        if (!mac) return err(c.ws, 'offline', { to: m.to });
        offers.delete(m.pairId); // un solo uso
        sendRaw(mac.ws, { type: 'pair.claim', pairId: m.pairId, from: c.pubkey, nonce: m.nonce, box: m.box });
        return;
      }
      case 'msg': {
        if (!isB64(m.to, 32) || !isB64(m.nonce, 24) || !isBox(m.box)) return err(c.ws, 'bad_request');
        const dst = rooms.get(c.sub)?.get(m.to); // solo dentro del mismo sub
        if (!dst) return err(c.ws, 'offline', { to: m.to });
        sendRaw(dst.ws, { type: 'msg', from: c.pubkey, nonce: m.nonce, box: m.box });
        return;
      }
      case 'push.register': {
        if (typeof m.token !== 'string' || !m.token || m.token.length > 4096 || m.platform !== 'fcm') return err(c.ws, 'bad_request');
        let set = tokens.get(c.sub);
        if (!set) tokens.set(c.sub, (set = new Set()));
        if (!set.has(m.token) && set.size >= MAX_TOKENS) return err(c.ws, 'bad_request');
        set.add(m.token);
        return;
      }
      case 'push.wake': {
        if (c.dev !== 'mac') return err(c.ws, 'bad_request');
        const list = [...(tokens.get(c.sub) ?? [])];
        if (list.length) Promise.resolve(push(list)).catch(() => console.error('push fallido'));
        return;
      }
      default:
        return err(c.ws, 'bad_request');
    }
  }

  const ping = setInterval(() => {
    for (const room of rooms.values()) for (const c of room.values()) {
      if (!c.alive) { c.ws.terminate(); continue; }
      c.alive = false;
      c.ws.ping();
    }
  }, PING_MS);
  ping.unref();

  return {
    server,
    close: () => new Promise((resolve) => {
      clearInterval(ping);
      for (const client of wss.clients) client.terminate();
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}
