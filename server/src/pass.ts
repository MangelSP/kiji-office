// Pase: JWT HS256 firmado por la puerta y verificado por los relays. Cada usuario tiene su propia clave de firma,
// derivada de PASS_SECRET (`relayKey`): un relay por usuario solo recibe la suya, así que si se compromete un
// contenedor no se pueden forjar pases para los relays de otros usuarios.
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface PassClaims { sub: string; email: string; dev: 'mac' | 'phone'; iat: number; exp: number }

const b64u = (b: Buffer | string): string => Buffer.from(b).toString('base64url');
const mac = (data: string, secret: string): Buffer => createHmac('sha256', secret).update(data).digest();

/** Clave de firma de los pases de un usuario: HMAC(PASS_SECRET, "relay:" + sub), en hex. */
export function relayKey(passSecret: string, sub: string): string {
  return createHmac('sha256', passSecret).update(`relay:${sub}`).digest('hex');
}

/** `sub` declarado en un pase, sin verificar (solo para elegir la clave con la que verificarlo). */
export function claimedSub(token: unknown): string | null {
  if (typeof token !== 'string' || token.length > 2048) return null;
  try {
    const c = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'));
    return typeof c?.sub === 'string' && c.sub ? c.sub : null;
  } catch {
    return null;
  }
}

/** Firma un pase. `iat` y `exp` en segundos Unix. */
export function signPass(claims: PassClaims, secret: string): string {
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify(claims));
  return `${head}.${body}.${b64u(mac(`${head}.${body}`, secret))}`;
}

/** Devuelve los claims si el pase es válido; `null` si no (firma, alg distinto de HS256, vencido o mal formado). */
export function verifyPass(token: unknown, secret: string, nowMs: number = Date.now()): PassClaims | null {
  if (typeof token !== 'string' || token.length > 2048) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [head, body, sig] = parts as [string, string, string];
  try {
    const header = JSON.parse(Buffer.from(head, 'base64url').toString('utf8'));
    if (header?.alg !== 'HS256') return null;
    const given = Buffer.from(sig, 'base64url');
    const want = mac(`${head}.${body}`, secret);
    if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
    const c = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (typeof c?.sub !== 'string' || !c.sub || typeof c.email !== 'string') return null;
    if (c.dev !== 'mac' && c.dev !== 'phone') return null;
    if (typeof c.exp !== 'number' || typeof c.iat !== 'number' || c.exp * 1000 <= nowMs) return null;
    return c as PassClaims;
  } catch {
    return null;
  }
}
