// Provisión del relay de cada usuario: `static` (uno para todos) o `coolify` (un contenedor por usuario).
import { relayKey } from './pass.ts';
import { createHash } from 'node:crypto';

export interface Provisioned { relayUrl: string; appUuid: string }
export interface Provisioner { provision(sub: string): Promise<Provisioned> }

export function staticProvisioner(relayUrl: string): Provisioner {
  return { provision: async () => ({ relayUrl, appUuid: '' }) };
}

export interface CoolifyOpts {
  url: string; token: string; projectUuid: string; serverUuid: string; environment: string;
  image: string; domainTemplate: string; passSecret: string; fetch?: typeof fetch;
}

/** Id corto del dominio: hash del sub, nunca el sub en claro. */
export const domainId = (sub: string): string => createHash('sha256').update(sub).digest('hex').slice(0, 12);

export function coolifyProvisioner(o: CoolifyOpts): Provisioner {
  const f = o.fetch ?? fetch;
  const base = o.url.replace(/\/+$/, '');
  const call = async (method: string, path: string, body?: unknown): Promise<any> => {
    const res = await f(`${base}/api/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${o.token}`, 'content-type': 'application/json', accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Coolify ${method} ${path} -> ${res.status}`);
    return res.json().catch(() => ({}));
  };
  return {
    async provision(sub) {
      const domain = o.domainTemplate.replaceAll('{id}', domainId(sub));
      const cut = o.image.lastIndexOf(':');
      const tagged = cut > o.image.lastIndexOf('/');
      const created = await call('POST', '/applications/dockerimage', {
        project_uuid: o.projectUuid,
        server_uuid: o.serverUuid,
        environment_name: o.environment,
        docker_registry_image_name: tagged ? o.image.slice(0, cut) : o.image,
        docker_registry_image_tag: tagged ? o.image.slice(cut + 1) : 'latest',
        name: `kiji-relay-${domainId(sub)}`,
        domains: domain,
        ports_exposes: '8080',
        instant_deploy: false,
      });
      const uuid = created?.uuid;
      if (typeof uuid !== 'string' || !uuid) throw new Error('Coolify no devolvió uuid');
      for (const [key, value] of [['OWNER_SUB', sub], ['RELAY_KEY', relayKey(o.passSecret, sub)]] as const) {
        await call('POST', `/applications/${uuid}/envs`, { key, value, is_preview: false });
      }
      await call('GET', `/applications/${uuid}/start`);
      const host = domain.replace(/^https?:\/\//, '').replace(/\/+$/, '');
      return { relayUrl: `wss://${host}/ws`, appUuid: uuid };
    },
  };
}
