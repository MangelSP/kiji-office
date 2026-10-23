import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGateway, devVerifier, googleVerifier, type VerifyIdToken } from '../src/gateway.ts';
import { relayKey, verifyPass } from '../src/pass.ts';
import { coolifyProvisioner, domainId, staticProvisioner, type Provisioner } from '../src/provision.ts';
import { openStore } from '../src/store.ts';

const SECRET = 'secreto-de-prueba-secreto-de-prueba';
let srv: Server | undefined;
afterEach(() => { srv?.close(); srv = undefined; });

const verify: VerifyIdToken = async (t) => {
  if (t === 'ok') return { sub: 'g-1', email: 'Ana@Example.com', emailVerified: true };
  if (t === 'unverified') return { sub: 'g-2', email: 'ana@example.com', emailVerified: false };
  if (t === 'other') return { sub: 'g-3', email: 'otro@example.com', emailVerified: true };
  throw new Error('mal');
};

async function start(prov: Provisioner = staticProvisioner('ws://relay.test/ws')) {
  const store = openStore(':memory:');
  srv = createServer(createGateway({ verifyIdToken: verify, allowedEmails: ['ana@example.com'], provisioner: prov, passSecret: SECRET, store }));
  await new Promise<void>((r) => srv!.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const post = (body: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }) =>
    fetch(`${base}/session`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { base, post, store };
}

describe('puerta', () => {
  it('token válido -> relayUrl y pase', async () => {
    const { post } = await start();
    const res = await post({ idToken: 'ok', device: 'phone' });
    expect(res.status).toBe(200);
    const j = await res.json() as any;
    expect(j.relayUrl).toBe('ws://relay.test/ws');
    expect(j.email).toBe('ana@example.com');
    expect(verifyPass(j.pass, relayKey(SECRET, 'g-1'))).toMatchObject({ sub: 'g-1', dev: 'phone' });
    expect(verifyPass(j.pass, SECRET)).toBeNull(); // firmado con la clave del usuario, no con la global
  });
  it('rechaza token inválido, sin verificar y correo no permitido', async () => {
    const { post } = await start();
    expect((await post({ idToken: 'basura', device: 'mac' })).status).toBe(401);
    expect((await post({ idToken: 'unverified', device: 'mac' })).status).toBe(401);
    const r = await post({ idToken: 'other', device: 'mac' });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: 'not_allowed' });
  });
  it('valida forma, tipo y tamaño del cuerpo', async () => {
    const { post, base } = await start();
    expect((await post({ idToken: 'ok', device: 'tablet' })).status).toBe(400);
    expect((await post('{', { 'content-type': 'application/json' })).status).toBe(400);
    expect((await post('x', { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await post({ idToken: 'x'.repeat(20_000), device: 'mac' })).status).toBe(413);
    expect(await (await fetch(`${base}/health`)).text()).toBe('ok');
  });
  it('mismo sub -> mismo relay sin reprovisionar', async () => {
    const provision = vi.fn(async () => ({ relayUrl: 'wss://r1/ws', appUuid: 'u' }));
    const { post, store } = await start({ provision });
    await post({ idToken: 'ok', device: 'mac' });
    const j = await (await post({ idToken: 'ok', device: 'phone' })).json() as any;
    expect(j.relayUrl).toBe('wss://r1/ws');
    expect(provision).toHaveBeenCalledTimes(1);
    expect(store.get('g-1')?.relay_url).toBe('wss://r1/ws');
  });
  it('503 provisioning durante la creación concurrente', async () => {
    let done!: () => void;
    const gate = new Promise<void>((r) => { done = r; });
    const provision = vi.fn(async () => { await gate; return { relayUrl: 'wss://r/ws', appUuid: 'u' }; });
    const { post } = await start({ provision });
    const first = post({ idToken: 'ok', device: 'mac' });
    await vi.waitFor(() => expect(provision).toHaveBeenCalled());
    const second = await post({ idToken: 'ok', device: 'phone' });
    expect(second.status).toBe(503);
    expect(await second.json()).toEqual({ error: 'provisioning' });
    done();
    expect((await first).status).toBe(200);
    expect(provision).toHaveBeenCalledTimes(1);
  });
});

describe('verificadores', () => {
  const fakeClient = (payload: object | undefined) => ({ verifyIdToken: async (o: any) => ({ getPayload: () => payload, o }) }) as any;
  it('google: pasa aud y exige email_verified', async () => {
    const spy = vi.fn(async () => ({ getPayload: () => ({ sub: 's', email: 'a@b.c', email_verified: true }) }));
    const v = googleVerifier(['cid1', 'cid2'], { verifyIdToken: spy } as any);
    expect(await v('t')).toEqual({ sub: 's', email: 'a@b.c', emailVerified: true });
    expect(spy).toHaveBeenCalledWith({ idToken: 't', audience: ['cid1', 'cid2'] });
    expect((await googleVerifier(['c'], fakeClient({ sub: 's', email: 'a@b.c' }))('t')).emailVerified).toBe(false);
    await expect(googleVerifier(['c'], fakeClient(undefined))('t')).rejects.toThrow();
  });
  it('google: el aud inválido (la librería lanza) se rechaza', async () => {
    const client = { verifyIdToken: async () => { throw new Error('Wrong recipient'); } } as any;
    await expect(googleVerifier(['c'], client)('t')).rejects.toThrow();
  });
  it('dev: solo acepta dev:<correo> y no arranca en producción', async () => {
    const v = devVerifier({});
    expect((await v('dev:a@b.c')).email).toBe('a@b.c');
    await expect(v('otro')).rejects.toThrow();
    expect(() => devVerifier({ NODE_ENV: 'production' })).toThrow();
  });
});

describe('provisión coolify', () => {
  it('crea app, variables y arranca; el dominio sale de un hash', async () => {
    const calls: { url: string; method: string; body: any; auth: string }[] = [];
    const fake = (async (url: string, init: any) => {
      calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined, auth: init.headers.authorization });
      return new Response(JSON.stringify({ uuid: 'app-1' }), { status: 200 });
    }) as unknown as typeof fetch;
    const p = coolifyProvisioner({
      url: 'https://cool.test/', token: 'tok', projectUuid: 'P', serverUuid: 'S', environment: 'production',
      image: 'ghcr.io/x/kiji-server:1.2', domainTemplate: 'https://kiji-{id}.example.com', passSecret: SECRET, fetch: fake,
    });
    const out = await p.provision('google-sub-123');
    const id = domainId('google-sub-123');
    expect(out).toEqual({ relayUrl: `wss://kiji-${id}.example.com/ws`, appUuid: 'app-1' });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST https://cool.test/api/v1/applications/dockerimage',
      'POST https://cool.test/api/v1/applications/app-1/envs',
      'POST https://cool.test/api/v1/applications/app-1/envs',
      'GET https://cool.test/api/v1/applications/app-1/start',
    ]);
    expect(calls.every((c) => c.auth === 'Bearer tok')).toBe(true);
    expect(calls[0]!.body).toMatchObject({
      project_uuid: 'P', server_uuid: 'S', environment_name: 'production', docker_registry_image_name: 'ghcr.io/x/kiji-server',
      docker_registry_image_tag: '1.2', ports_exposes: '8080', instant_deploy: false,
    });
    expect(JSON.stringify(calls[0]!.body)).not.toContain('google-sub-123');
    expect(calls[1]!.body).toEqual({ key: 'OWNER_SUB', value: 'google-sub-123', is_preview: false });
    expect(calls[2]!.body).toEqual({ key: 'RELAY_KEY', value: relayKey(SECRET, 'google-sub-123'), is_preview: false });
    expect(JSON.stringify(calls)).not.toContain(SECRET); // el secreto global nunca sale de la puerta
  });
  it('falla si Coolify responde error', async () => {
    const fake = (async () => new Response('{}', { status: 500 })) as unknown as typeof fetch;
    const p = coolifyProvisioner({ url: 'https://c', token: 't', projectUuid: 'P', serverUuid: 'S', environment: 'e', image: 'i', domainTemplate: 'https://{id}.x', passSecret: 's', fetch: fake });
    await expect(p.provision('s')).rejects.toThrow();
  });
});
