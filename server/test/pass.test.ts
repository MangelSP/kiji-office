import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signPass, verifyPass, type PassClaims } from '../src/pass.ts';

const S = 'secreto-de-prueba-secreto-de-prueba';
const claims = (o: Partial<PassClaims> = {}): PassClaims => ({ sub: 'u1', email: 'a@b.c', dev: 'mac', iat: 1000, exp: 1300, ...o });
const b64u = (s: string) => Buffer.from(s).toString('base64url');

describe('pase', () => {
  it('acepta uno válido', () => {
    expect(verifyPass(signPass(claims(), S), S, 1_100_000)).toMatchObject({ sub: 'u1', dev: 'mac' });
  });
  it('rechaza uno vencido', () => {
    expect(verifyPass(signPass(claims(), S), S, 1_300_000)).toBeNull();
  });
  it('rechaza firma mala o secreto distinto', () => {
    const t = signPass(claims(), S);
    expect(verifyPass(t.slice(0, -2) + 'xx', S, 1_100_000)).toBeNull();
    expect(verifyPass(t, 'otro-secreto-otro-secreto-otro-x', 1_100_000)).toBeNull();
  });
  it('rechaza alg none y alg distinto de HS256', () => {
    const body = b64u(JSON.stringify(claims()));
    expect(verifyPass(`${b64u('{"alg":"none"}')}.${body}.`, S, 1_100_000)).toBeNull();
    const head = b64u('{"alg":"HS512"}');
    const sig = createHmac('sha512', S).update(`${head}.${body}`).digest('base64url');
    expect(verifyPass(`${head}.${body}.${sig}`, S, 1_100_000)).toBeNull();
  });
  it('rechaza basura', () => {
    expect(verifyPass('a.b', S)).toBeNull();
    expect(verifyPass(42, S)).toBeNull();
  });
});
