// Puerta: valida el ID token de Google, aprovisiona el relay del usuario y emite el pase.
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { OAuth2Client } from 'google-auth-library';
import { relayKey, signPass } from './pass.ts';
import type { Provisioner } from './provision.ts';
import type { Store } from './store.ts';

export interface VerifiedToken { sub: string; email: string; emailVerified: boolean }
export type VerifyIdToken = (idToken: string) => Promise<VerifiedToken>;

export interface GatewayOpts {
  verifyIdToken: VerifyIdToken;
  allowedEmails: string[];
  provisioner: Provisioner;
  passSecret: string;
  store: Store;
  now?: () => number;
}

export const PASS_TTL_S = 5 * 60;
const MAX_BODY = 16 * 1024;

/** Verificador real: firma, `aud`, `iss` y `exp` los comprueba google-auth-library; `email_verified` lo miramos aquí. */
export function googleVerifier(clientIds: string[], client: Pick<OAuth2Client, 'verifyIdToken'> = new OAuth2Client()): VerifyIdToken {
  return async (idToken) => {
    const ticket = await client.verifyIdToken({ idToken, audience: clientIds });
    const p = ticket.getPayload();
    if (!p?.sub || !p.email) throw new Error('token sin sub o correo');
    return { sub: p.sub, email: p.email, emailVerified: p.email_verified === true };
  };
}

/** Solo para probar en local: `dev:<correo>`. Se niega a existir en producción. */
export function devVerifier(env: NodeJS.ProcessEnv = process.env): VerifyIdToken {
  if (env.NODE_ENV === 'production') throw new Error('DEV_INSECURE_TOKENS no se puede usar con NODE_ENV=production');
  return async (idToken) => {
    if (!idToken.startsWith('dev:') || idToken.length < 6) throw new Error('token dev inválido');
    const email = idToken.slice(4);
    return { sub: `dev-${email}`, email, emailVerified: true };
  };
}

class HttpError extends Error {
  status: number; code: string;
  constructor(status: number, code: string) { super(code); this.status = status; this.code = code; }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'json_only');
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'too_large');
    chunks.push(c as Buffer);
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch { /* cae abajo */ }
  throw new HttpError(400, 'bad_request');
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/plain' : 'application/json', 'cache-control': 'no-store' });
  res.end(text);
}

export function createGateway(o: GatewayOpts): RequestListener {
  const now = o.now ?? Date.now;
  const allowed = new Set(o.allowedEmails.map((e) => e.trim().toLowerCase()).filter(Boolean));
  const pending = new Set<string>(); // subs con relay en creación

  async function session(req: IncomingMessage): Promise<unknown> {
    const body = await readJson(req);
    const { idToken, device } = body;
    if (typeof idToken !== 'string' || !idToken || idToken.length > 8192) throw new HttpError(400, 'bad_request');
    if (device !== 'mac' && device !== 'phone') throw new HttpError(400, 'bad_request');
    let who: VerifiedToken;
    try { who = await o.verifyIdToken(idToken); } catch { throw new HttpError(401, 'invalid_token'); }
    if (!who.sub || !who.emailVerified) throw new HttpError(401, 'invalid_token');
    const email = who.email.toLowerCase();
    if (!allowed.has(email)) throw new HttpError(403, 'not_allowed');

    // La clave es el sub de Google; el correo puede cambiar.
    let row = o.store.get(who.sub);
    if (!row) {
      if (pending.has(who.sub)) throw new HttpError(503, 'provisioning');
      pending.add(who.sub);
      try {
        const p = await o.provisioner.provision(who.sub);
        row = { sub: who.sub, email, relay_url: p.relayUrl, app_uuid: p.appUuid, created_at: now() };
        o.store.put(row);
      } catch (e) {
        console.error('provisión fallida:', e instanceof Error ? e.message : 'error');
        throw new HttpError(502, 'provision_failed');
      } finally {
        pending.delete(who.sub);
      }
    }
    const iat = Math.floor(now() / 1000);
    const exp = iat + PASS_TTL_S;
    const pass = signPass({ sub: who.sub, email, dev: device, iat, exp }, relayKey(o.passSecret, who.sub));
    return { relayUrl: row.relay_url, pass, expiresAt: exp, email };
  }

  return (req, res) => {
    const path = (req.url ?? '').split('?')[0];
    if (req.method === 'GET' && path === '/health') return send(res, 200, 'ok');
    if (path !== '/session') return send(res, 404, { error: 'not_found' });
    if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
    session(req).then(
      (out) => send(res, 200, out),
      (e) => {
        if (e instanceof HttpError) send(res, e.status, { error: e.code });
        else { console.error('error interno en /session'); send(res, 500, { error: 'internal' }); }
      },
    );
  };
}
