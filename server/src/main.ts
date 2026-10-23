// Arranque: MODE=gateway (puerta) o MODE=relay (relay de un usuario). Config por entorno.
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createGateway, devVerifier, googleVerifier } from './gateway.ts';
import { coolifyProvisioner, staticProvisioner } from './provision.ts';
import { fcmPush } from './push.ts';
import { createRelay } from './relay.ts';
import { openStore } from './store.ts';

const env = process.env;
const need = (k: string): string => {
  const v = env[k];
  if (!v) { console.error(`Falta la variable ${k}`); process.exit(1); }
  return v;
};
const list = (v: string | undefined): string[] => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const port = Number(env.PORT ?? 8080);
// La puerta (y un relay compartido) usan PASS_SECRET; un relay por usuario solo tiene su RELAY_KEY derivada.
const secret = (name: string): string => {
  const v = need(name);
  if (v.length < 32) { console.error(`${name} debe tener al menos 32 caracteres`); process.exit(1); }
  return v;
};

if (env.MODE === 'gateway') {
  const passSecret = secret('PASS_SECRET');
  const verifyIdToken = env.DEV_INSECURE_TOKENS === '1' ? devVerifier(env) : googleVerifier(list(need('GOOGLE_CLIENT_IDS')));
  const provisioner = env.PROVISIONER === 'coolify'
    ? coolifyProvisioner({
        url: need('COOLIFY_URL'), token: need('COOLIFY_TOKEN'), projectUuid: need('COOLIFY_PROJECT_UUID'),
        serverUuid: need('COOLIFY_SERVER_UUID'), environment: env.COOLIFY_ENVIRONMENT ?? 'production',
        image: need('RELAY_IMAGE'), domainTemplate: need('RELAY_DOMAIN_TEMPLATE'), passSecret,
      })
    : staticProvisioner(need('RELAY_URL'));
  const store = openStore(join(env.DATA_DIR ?? './data', 'gateway.db'));
  const handler = createGateway({ verifyIdToken, allowedEmails: list(env.ALLOWED_EMAILS), provisioner, passSecret, store });
  createServer(handler).listen(port, () => console.log(`puerta en :${port}`));
} else if (env.MODE === 'relay') {
  const push = env.FCM_SERVICE_ACCOUNT ? fcmPush(env.FCM_SERVICE_ACCOUNT) : undefined;
  const relay = env.RELAY_KEY
    ? createRelay({ relayKey: secret('RELAY_KEY'), ownerSub: need('OWNER_SUB'), push })
    : createRelay({ passSecret: secret('PASS_SECRET'), push });
  relay.server.listen(port, () => console.log(`relay en :${port}`));
} else {
  console.error('MODE debe ser gateway o relay');
  process.exit(1);
}
