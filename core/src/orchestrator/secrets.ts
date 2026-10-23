// Secretos en memoria (PLAN-0.2b, D15). El llavero es de Rust; el core solo recibe copias en `ctx.secrets`.
//
//  - Rust las empuja por stdin con `{"id":"rust:<n>","method":"secrets.put","params":{account,value}}`.
//  - Garantía de origen: el core no distingue qué escribió en su stdin. Lo que impide que el webview falsifique
//    un `secrets.put` es que `core_send` (Rust) rechaza cualquier id con el prefijo `rust:`. Aquí solo se acepta
//    el método si el id lleva ese prefijo; y las respuestas `rust:*` no se reenvían al webview.
//  - El core NUNCA devuelve ni emite un valor: `secrets.put` responde `true`, `ConnectionView` solo lleva `hasSecret`.
//
// Cómo se resuelve el secreto de una conexión (`secretFor`):
//   1) `ctx.secrets['conn:<id>']`  (la normal, empujada por Rust)
//   2) conexiones `openai`/`gemini` con la URL del preset (las creadas automáticamente al migrar): el alias de la
//      cuenta de llavero ya existente (`openai`/`gemini`), que el core ya tiene desde el entorno que Rust inyecta
//      al arrancar. La clave no se mueve ni se copia a `conn:<id>`.
import type { ConnectionRow } from '../db/repos.js';
import { PRESETS } from './connections.js';
import { type Ctx, type Handler, asParams, str } from './context.js';
import { notifyConnections } from './connections.js';

export const CONN_ACCOUNT_RE = /^conn:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const RUST_ID_PREFIX = 'rust:';
export const SECRET_MAX_LEN = 8192;

/** Preset -> cuenta del llavero antigua y variable de entorno que Rust inyecta (keyring.rs `ALLOWED`). */
export const KEY_ALIASES = {
  openai: { account: 'openai', env: 'OPENAI_API_KEY' },
  gemini: { account: 'gemini', env: 'GEMINI_API_KEY' },
} as const;

export const connAccount = (id: string): string => `conn:${id}`;

/** Copia al mapa los alias de cuenta (`openai`, `gemini`) presentes en el entorno del proceso. */
export function loadEnvSecrets(ctx: Ctx, env: NodeJS.ProcessEnv): void {
  for (const a of Object.values(KEY_ALIASES)) {
    const v = env[a.env];
    if (v && v.length >= 4) ctx.secrets.set(a.account, v);
  }
}

/** Alias de cuenta aplicable a esta conexión (solo openai/gemini con la URL oficial del preset). */
function aliasOf(c: ConnectionRow): string | null {
  const alias = (KEY_ALIASES as Record<string, { account: string } | undefined>)[c.preset];
  return alias && c.auth !== 'none' && c.base_url === PRESETS[c.preset as keyof typeof PRESETS]?.baseUrl ? alias.account : null;
}

/** Clave de la conexión, o undefined. Solo para armar peticiones salientes: nunca devolverla ni registrarla. */
export function secretFor(ctx: Ctx, c: ConnectionRow): string | undefined {
  const own = ctx.secrets.get(connAccount(c.id));
  if (own) return own;
  const alias = aliasOf(c);
  return alias ? ctx.secrets.get(alias) : undefined;
}

/** ¿Hay clave resoluble ahora mismo? */
export const hasUsableSecret = (ctx: Ctx, c: ConnectionRow): boolean => secretFor(ctx, c) !== undefined;

/** Tapa en `text` todos los secretos conocidos (los de `ctx.secrets`). */
export function maskSecrets(ctx: Ctx, text: string): string {
  let out = text;
  for (const v of ctx.secrets.values()) if (v.length >= 4) out = out.split(v).join('***');
  return out;
}

/** Cuentas `conn:*` de toda conexión con auth != none sin valor en memoria (has_secret solo se sabe al llegar el valor). */
export function missingAccounts(ctx: Ctx): string[] {
  return ctx.repos.connections
    .list()
    .filter((c) => c.auth !== 'none' && !ctx.secrets.has(connAccount(c.id)))
    .filter((c) => aliasOf(c) === null || !ctx.secrets.has(aliasOf(c)!))
    .map((c) => connAccount(c.id));
}

/** Evento core -> Rust (nunca llega a la UI): "empújame estas cuentas del llavero". */
export function requestSecrets(ctx: Ctx, accounts: string[] = missingAccounts(ctx)): void {
  if (accounts.length > 0) ctx.emit('secrets.request', { accounts });
}

export function secretsHandlers(ctx: Ctx): Record<string, Handler> {
  return {
    /** `{account, value}`; solo con id `rust:*`. Responde `true`; value vacío = borrar. */
    'secrets.put': (params, req) => {
      if (!req || typeof req.id !== 'string' || !req.id.startsWith(RUST_ID_PREFIX)) {
        throw new Error('secrets.put: solo lo puede enviar el proceso nativo (id "rust:*")');
      }
      const p = asParams(params, 'secrets.put');
      const account = str(p.account, 'account', 'secrets.put');
      if (!CONN_ACCOUNT_RE.test(account)) throw new Error('secrets.put: cuenta no válida (se espera conn:<uuid>)');
      // null o '' = borrar (Rust manda '' al borrar; null se acepta por compatibilidad)
      if (p.value !== null && p.value !== undefined && typeof p.value !== 'string') throw new Error('secrets.put: "value" debe ser texto');
      const value: string = typeof p.value === 'string' ? p.value : '';
      if (value.length > SECRET_MAX_LEN) throw new Error('secrets.put: valor demasiado largo');
      const conn = ctx.repos.connections.get(account.slice('conn:'.length));
      if (!conn) throw new Error('secrets.put: la conexión no existe');
      if (value === '') ctx.secrets.delete(account);
      else ctx.secrets.set(account, value);
      const has = value === '' ? 0 : 1;
      if (conn.has_secret !== has) {
        ctx.repos.connections.update(conn.id, { has_secret: has });
        notifyConnections(ctx);
      }
      return true;
    },
  };
}
