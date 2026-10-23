// Conexiones (PLAN-0.2b, D14-D17): servidores compatibles con OpenAI Chat Completions, locales o en la nube.
// Son GLOBALES (no por proyecto). Aquí: presets, validación de URL, prueba en tres pasos, descubrimiento local,
// handlers `connection.*` / `connections.discover`, fábrica de adaptadores y tarjetas de `providers.status`.
// La clave nunca se devuelve ni se registra: se lee de `ctx.secrets` (ver secrets.ts) solo para firmar peticiones.
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type {
  ConnectionAuth, ConnectionCreateParams, ConnectionPreset, ConnectionTest, ConnectionTestStep, ConnectionUpdateParams,
  ConnectionView, DiscoveredServer, ProviderStatus, ToolQuality,
} from '../../../shared/protocol.js';
import { ApiLoopAdapter } from '../adapters/apiLoop.js';
import { ClaudeAdapter } from '../adapters/claude.js';
import type { AgentAdapter } from '../adapters/types.js';
import type { AgentRow, ConnectionRow } from '../db/repos.js';
import { type Ctx, type Handler, asParams, str } from './context.js';
import { KEY_ALIASES, connAccount, hasUsableSecret, loadEnvSecrets, maskSecrets, requestSecrets, secretFor } from './secrets.js';
import { claudePathSetting } from './settings.js';

// ---------------------------------------------------------------------------
// Presets (tabla D17; espejo en la UI)
// ---------------------------------------------------------------------------

export interface PresetInfo {
  label: string;
  /** null = lo escribe la persona (custom). */
  baseUrl: string | null;
  auth: ConnectionAuth;
  /** Servidor en este equipo: lo busca `connections.discover`. */
  port?: number;
}

export const PRESETS: Record<ConnectionPreset, PresetInfo> = {
  ollama: { label: 'Ollama', baseUrl: 'http://localhost:11434/v1', auth: 'none', port: 11434 },
  lmstudio: { label: 'LM Studio', baseUrl: 'http://localhost:1234/v1', auth: 'none', port: 1234 },
  llamacpp: { label: 'llama.cpp', baseUrl: 'http://localhost:8080/v1', auth: 'none', port: 8080 },
  vllm: { label: 'vLLM', baseUrl: 'http://localhost:8000/v1', auth: 'none', port: 8000 },
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', auth: 'bearer' },
  groq: { label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', auth: 'bearer' },
  together: { label: 'Together', baseUrl: 'https://api.together.xyz/v1', auth: 'bearer' },
  deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', auth: 'bearer' },
  mistral: { label: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', auth: 'bearer' },
  gemini: { label: 'Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', auth: 'bearer' },
  openrouter: { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', auth: 'bearer' },
  litellm: { label: 'LiteLLM', baseUrl: 'http://localhost:4000/v1', auth: 'bearer' },
  custom: { label: 'Personalizada', baseUrl: null, auth: 'bearer' },
};

const AUTHS: readonly ConnectionAuth[] = ['none', 'bearer', 'x-api-key'];
const DEFAULT_CONTEXT_WINDOW = 32768;
const NAME_MAX = 40;
const MODEL_MAX = 200;
export const MODELS_TTL_MS = 60_000;
/** Pregunta de la sonda de herramientas (D16). */
const PING_N = 7;

const isPreset = (v: unknown): v is ConnectionPreset => typeof v === 'string' && Object.hasOwn(PRESETS, v);

// ---------------------------------------------------------------------------
// Validación de URL
// ---------------------------------------------------------------------------

/** localhost, loopback o red privada (RFC 1918, enlace local, ULA de IPv6, nombres .local). */
export function isLocalOrLanHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  if (h === '::1') return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  return /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h);
}

/** Valida y normaliza (sin barra final) la URL base de una conexión; lanza un error claro si no sirve. */
export function validateBaseUrl(raw: string, method = 'connection'): string {
  const v = raw.trim().replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    throw new Error(`${method}: la URL no es válida (ejemplo: http://localhost:1234/v1)`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`${method}: la URL debe empezar por http:// o https://`);
  if (url.username || url.password) throw new Error(`${method}: la URL no debe llevar usuario ni contraseña`);
  if (url.search || url.hash) throw new Error(`${method}: la URL no debe llevar parámetros ni #`);
  if (url.protocol === 'http:' && !isLocalOrLanHost(url.hostname)) {
    throw new Error(`${method}: http:// solo se admite en localhost o en la red local; para "${url.hostname}" usa https://`);
  }
  return v;
}

// ---------------------------------------------------------------------------
// Vistas
// ---------------------------------------------------------------------------

type Prices = Record<string, { in: number; out: number }>;

function parsePrices(raw: string): Prices {
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const out: Prices = {};
    for (const [k, p] of Object.entries(v as Record<string, unknown>)) {
      const q = p as { in?: unknown; out?: unknown };
      if (q && typeof q.in === 'number' && typeof q.out === 'number') out[k] = { in: q.in, out: q.out };
    }
    return out;
  } catch {
    return {};
  }
}

export function connectionView(ctx: Ctx, c: ConnectionRow): ConnectionView {
  return {
    id: c.id, name: c.name, preset: c.preset as ConnectionPreset, baseUrl: c.base_url, auth: c.auth,
    hasSecret: c.auth !== 'none' && c.has_secret === 1,
    defaultModel: c.default_model, contextWindow: c.context_window, toolQuality: c.tool_quality,
    lastTestAt: c.last_test_at, lastTestOk: c.last_test_ok === null ? null : c.last_test_ok === 1,
    agents: ctx.repos.connections.agentNames(c.id), prices: parsePrices(c.prices_json),
  };
}

/** Evento `connections.changed`: lleva la lista completa (global, sin projectId). */
export function notifyConnections(ctx: Ctx): void {
  ctx.emit('connections.changed', ctx.repos.connections.list().map((c) => connectionView(ctx, c)));
}

function requireConnection(ctx: Ctx, id: unknown, method: string): ConnectionRow {
  const c = ctx.repos.connections.get(str(id, 'id', method));
  if (!c) throw new Error(`${method}: la conexión no existe`);
  return c;
}

// ---------------------------------------------------------------------------
// Destinos `conn:<uuid>/<modelo>`
// ---------------------------------------------------------------------------

const CONN_TARGET_RE = /^conn:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(.+)$/;

export function parseConnTarget(model: string | null | undefined): { connectionId: string; model: string } | null {
  const m = CONN_TARGET_RE.exec(model ?? '');
  return m ? { connectionId: m[1]!, model: m[2]! } : null;
}
export const connTarget = (connectionId: string, model: string): string => `conn:${connectionId}/${model}`;

/** Modelo con el que corre un agente por defecto: alias de Claude o `conn:<id>/<modelo>` si usa una conexión. */
export function runModelOf(a: Pick<AgentRow, 'model' | 'connection_id'>): string {
  return a.connection_id && a.model ? connTarget(a.connection_id, a.model) : (a.model ?? 'sonnet');
}

// ---------------------------------------------------------------------------
// Red
// ---------------------------------------------------------------------------

export interface ConnectionDeps {
  fetch?: typeof fetch;
  /** Tiempos máximos (ms). */
  modelsTimeoutMs?: number;
  chatTimeoutMs?: number;
  discoverTimeoutMs?: number;
  /** Puertos a sondear en `connections.discover` (por defecto los de los presets locales). */
  discoverTargets?: Array<{ preset: ConnectionPreset; baseUrl: string }>;
  /** ¿Está instalado el binario/app de este preset? (por defecto: busca `ollama` en PATH y rutas habituales). */
  detectInstalled?: (preset: ConnectionPreset) => boolean | Promise<boolean>;
}

class ConnError extends Error {
  constructor(message: string, readonly fatal = true) {
    super(message);
  }
}

function headersFor(ctx: Ctx, c: ConnectionRow, json: boolean): Record<string, string> {
  const h: Record<string, string> = {};
  if (json) h['Content-Type'] = 'application/json';
  const key = c.auth === 'none' ? undefined : secretFor(ctx, c);
  if (key) {
    if (c.auth === 'bearer') h.Authorization = `Bearer ${key}`;
    else h['x-api-key'] = key;
  }
  return h;
}

function netErrorText(e: unknown, c: Pick<ConnectionRow, 'base_url'>): string {
  const err = e as { name?: string; code?: string; cause?: { code?: string }; message?: string };
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return `${c.base_url} no respondió a tiempo`;
  const code = err?.cause?.code ?? err?.code;
  if (code === 'ECONNREFUSED') return `no se pudo conectar a ${c.base_url}: el servidor no está en marcha`;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `no se encontró el servidor de ${c.base_url}`;
  if (/redirect/i.test(String(err?.message))) return 'el servidor intentó redirigir la petición; por seguridad no se sigue';
  return `no se pudo conectar a ${c.base_url} (${err?.cause?.code ?? err?.message ?? String(e)})`;
}

async function bodyHint(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { error?: unknown; message?: unknown };
    const e = j?.error;
    const t = typeof e === 'string' ? e : e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string' ? (e as { message: string }).message : typeof j?.message === 'string' ? j.message : '';
    return t ? `: ${t.slice(0, 160)}` : '';
  } catch {
    return '';
  }
}

function httpErrorText(status: number, hint: string): string {
  if (status === 401 || status === 403) return `el servidor rechazó la clave (HTTP ${status})${hint}`;
  if (status === 429) return `demasiadas peticiones o sin saldo (HTTP 429)${hint}`;
  if (status === 404) return `ruta no encontrada (HTTP 404): revisa que la URL termine en /v1${hint}`;
  return `el servidor respondió HTTP ${status}${hint}`;
}

interface ModelsInfo {
  ids: string[];
  /** Ventana de contexto informada por el servidor, por modelo. */
  windows: Record<string, number>;
}

function parseModels(body: unknown): ModelsInfo {
  const b = body as { data?: unknown; models?: unknown } | null;
  const list = Array.isArray(b?.data) ? b!.data : Array.isArray(b?.models) ? b!.models : [];
  const ids: string[] = [];
  const windows: Record<string, number> = {};
  for (const m of list as Array<Record<string, unknown>>) {
    const id = typeof m === 'string' ? m : typeof m?.id === 'string' ? m.id : typeof m?.name === 'string' ? m.name : null;
    if (!id) continue;
    ids.push(id);
    for (const f of ['context_length', 'max_context_length', 'max_model_len', 'context_window']) {
      const n = m[f];
      if (typeof n === 'number' && Number.isFinite(n) && n >= 512) {
        windows[id] = Math.floor(n);
        break;
      }
    }
  }
  return { ids, windows };
}

const sameModel = (a: string, b: string): boolean => a === b || a.replace(/^models\//, '') === b.replace(/^models\//, '');

function toolArgsN(args: unknown): number | null {
  try {
    const v = typeof args === 'string' ? JSON.parse(args) : args;
    const n = (v as { n?: unknown } | null)?.n;
    return typeof n === 'number' || typeof n === 'string' ? Number(n) : null;
  } catch {
    return null;
  }
}

/** Clasifica la respuesta de la sonda `kiji_ping` (D16). */
export function classifyPing(body: unknown): ToolQuality {
  const msg = (body as { choices?: Array<{ message?: Record<string, unknown> }> } | null)?.choices?.[0]?.message;
  const calls = msg?.tool_calls;
  if (Array.isArray(calls)) {
    for (const c of calls as Array<{ function?: { name?: unknown; arguments?: unknown } }>) {
      if (c?.function?.name === 'kiji_ping') return toolArgsN(c.function.arguments) === PING_N ? 'ok' : 'weak';
    }
  }
  const text = [msg?.content, msg?.reasoning_content, msg?.reasoning].filter((x): x is string => typeof x === 'string').join('\n');
  return /kiji_ping/.test(text) ? 'weak' : 'none';
}

// ---------------------------------------------------------------------------
// Servicio
// ---------------------------------------------------------------------------

export interface ConnectionService {
  models(c: ConnectionRow, opts?: { timeoutMs?: number; force?: boolean }): Promise<string[]>;
  test(c: ConnectionRow, model?: string): Promise<ConnectionTest>;
  discover(): Promise<DiscoveredServer[]>;
  /** Comprueba `model` contra connection.models: lanza si el servidor responde y no lo tiene; devuelve un aviso si no pudo comprobarlo. */
  checkModel(c: ConnectionRow, model: string): Promise<string | null>;
}

export function createConnectionService(ctx: Ctx, deps: ConnectionDeps = {}): ConnectionService {
  const doFetch = () => deps.fetch ?? fetch;
  const cache = new Map<string, { at: number; url: string; info: ModelsInfo }>();
  const mask = (t: string) => maskSecrets(ctx, t);

  async function fetchModels(c: ConnectionRow, timeoutMs: number): Promise<ModelsInfo> {
    let res: Response;
    try {
      res = await doFetch()(`${c.base_url}/models`, { method: 'GET', headers: headersFor(ctx, c, false), signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    } catch (e) {
      throw new ConnError(mask(netErrorText(e, c)));
    }
    if (!res.ok) throw new ConnError(mask(httpErrorText(res.status, await bodyHint(res))), [401, 403, 429].includes(res.status));
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new ConnError('la respuesta de /models no es JSON: ¿la URL es de un servidor compatible con OpenAI?');
    }
    const info = parseModels(body);
    cache.set(c.id, { at: Date.now(), url: c.base_url, info });
    return info;
  }

  async function models(c: ConnectionRow, opts: { timeoutMs?: number; force?: boolean } = {}): Promise<string[]> {
    const hit = cache.get(c.id);
    if (!opts.force && hit && hit.url === c.base_url && Date.now() - hit.at < MODELS_TTL_MS) return hit.info.ids;
    return (await fetchModels(c, opts.timeoutMs ?? deps.modelsTimeoutMs ?? 8000)).ids;
  }

  async function post(c: ConnectionRow, body: unknown, timeoutMs: number): Promise<{ res: Response; json: unknown }> {
    let res: Response;
    try {
      res = await doFetch()(`${c.base_url}/chat/completions`, {
        method: 'POST', headers: headersFor(ctx, c, true), body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs), redirect: 'error',
      });
    } catch (e) {
      throw new ConnError(mask(netErrorText(e, c)));
    }
    let json: unknown = null;
    const text = await res.text().catch(() => '');
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { res, json };
  }

  const errHint = (json: unknown): string => {
    const e = (json as { error?: unknown } | null)?.error;
    const t = typeof e === 'string' ? e : e && typeof e === 'object' ? String((e as { message?: unknown }).message ?? '') : '';
    return t ? `: ${t.slice(0, 160)}` : '';
  };

  async function test(c: ConnectionRow, modelParam?: string): Promise<ConnectionTest> {
    const steps: ConnectionTestStep[] = [];
    const out: ConnectionTest = { ok: false, detail: '', steps };
    const finish = (): ConnectionTest => {
      out.detail = mask(out.detail);
      for (const s of steps) s.detail = mask(s.detail);
      const patch: Parameters<typeof ctx.repos.connections.update>[1] = { last_test_at: Date.now(), last_test_ok: out.ok ? 1 : 0 };
      if (out.toolQuality) patch.tool_quality = out.toolQuality;
      ctx.repos.connections.update(c.id, patch);
      notifyConnections(ctx);
      return out;
    };

    if (c.auth !== 'none' && !hasUsableSecret(ctx, c)) {
      steps.push({ name: 'models', ok: false, detail: 'No hay clave guardada para esta conexión' });
      out.detail = 'Falta la clave: guárdala en la conexión y vuelve a probar';
      return finish();
    }

    // 1) models
    let info: ModelsInfo | null = null;
    try {
      info = await fetchModels(c, deps.modelsTimeoutMs ?? 8000);
      out.models = info.ids;
      steps.push({ name: 'models', ok: true, detail: `${info.ids.length} modelo${info.ids.length === 1 ? '' : 's'} disponible${info.ids.length === 1 ? '' : 's'}` });
    } catch (e) {
      const ce = e instanceof ConnError ? e : new ConnError(String(e));
      steps.push({ name: 'models', ok: false, detail: ce.message });
      if (ce.fatal) {
        out.detail = ce.message;
        return finish();
      }
    }

    // 2) chat de un token
    const model = modelParam?.trim() || c.default_model || info?.ids[0] || '';
    if (!model) {
      steps.push({ name: 'chat', ok: false, detail: 'No hay modelo: elige uno' });
      out.detail = 'Elige un modelo para probar';
      return finish();
    }
    const chatMs = deps.chatTimeoutMs ?? 60_000;
    const t0 = Date.now();
    try {
      const { res, json } = await post(c, { model, messages: [{ role: 'user', content: 'Responde solo: ok' }], max_tokens: 1, stream: false }, chatMs);
      if (!res.ok || !Array.isArray((json as { choices?: unknown } | null)?.choices)) {
        const why = res.ok ? 'la respuesta no tiene el formato de chat/completions' : mask(httpErrorText(res.status, errHint(json)));
        steps.push({ name: 'chat', ok: false, detail: why });
        out.detail = `${model}: ${why}`;
        return finish();
      }
      out.latencyMs = Date.now() - t0;
      steps.push({ name: 'chat', ok: true, detail: `${model} responde en ${out.latencyMs} ms` });
    } catch (e) {
      const why = e instanceof ConnError ? e.message : String(e);
      steps.push({ name: 'chat', ok: false, detail: why });
      out.detail = why;
      return finish();
    }
    out.ok = true; // alcanzable, clave válida y el modelo responde; la calidad de herramientas se informa aparte
    if (info) {
      const w = info.windows[model];
      if (w && w !== c.context_window) ctx.repos.connections.update(c.id, { context_window: w });
    }

    // 3) sonda de herramientas
    try {
      const { res, json } = await post(
        c,
        {
          model, stream: false, max_tokens: 200,
          messages: [{ role: 'user', content: `Llama a la herramienta kiji_ping con n=${PING_N}.` }],
          tools: [{
            type: 'function',
            function: {
              name: 'kiji_ping', description: 'Herramienta de prueba: devuelve pong.',
              parameters: { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] },
            },
          }],
        },
        chatMs,
      );
      const quality: ToolQuality = res.ok ? classifyPing(json) : 'none';
      out.toolQuality = quality;
      steps.push({
        name: 'tools', ok: quality === 'ok' || quality === 'weak',
        detail: !res.ok
          ? `el servidor no acepta herramientas con este modelo (HTTP ${res.status}${errHint(json)})`
          : quality === 'ok' ? 'usa herramientas bien' : quality === 'weak' ? 'llama a herramientas a medias (puede fallar al editar archivos)' : 'no sabe llamar a herramientas: solo servirá para consultas',
      });
    } catch (e) {
      steps.push({ name: 'tools', ok: false, detail: e instanceof ConnError ? e.message : String(e) });
    }
    out.detail = out.toolQuality === 'ok' ? `${model}: conexión correcta, usa herramientas bien`
      : out.toolQuality === 'weak' ? `${model}: conexión correcta, herramientas a medias`
      : out.toolQuality === 'none' ? `${model}: conexión correcta, pero solo servirá para consultas`
      : `${model}: conexión correcta, no se pudo medir las herramientas`;
    return finish();
  }

  async function checkModel(c: ConnectionRow, model: string): Promise<string | null> {
    let list: string[];
    try {
      list = await models(c, { timeoutMs: Math.min(deps.modelsTimeoutMs ?? 8000, 3000) });
    } catch (e) {
      return mask(`No se pudo comprobar que "${model}" exista en «${c.name}» (${e instanceof Error ? e.message : String(e)}); se acepta tal cual`);
    }
    if (list.length === 0) return `«${c.name}» no lista modelos; se acepta "${model}" sin comprobar`;
    if (!list.some((m) => sameModel(m, model))) {
      throw new Error(`el modelo "${model}" no está en «${c.name}» (hay: ${list.slice(0, 8).join(', ')}${list.length > 8 ? '…' : ''})`);
    }
    return null;
  }

  const defaultDetect = (preset: ConnectionPreset): boolean => {
    const names: Record<string, string[]> = { ollama: ['ollama'], lmstudio: ['lms'] };
    const apps: Record<string, string[]> = { ollama: ['/Applications/Ollama.app'], lmstudio: ['/Applications/LM Studio.app'] };
    const dirs = (process.env.PATH ?? '').split(delimiter).concat(['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin']);
    for (const n of names[preset] ?? []) for (const d of dirs) if (d && existsSync(join(d, n))) return true;
    return (apps[preset] ?? []).some((p) => existsSync(p));
  };

  /** Clave de comparación: host (localhost y loopback son lo mismo) + puerto + ruta. */
  const sameServer = (a: string, b: string): boolean => {
    const norm = (u: string) => {
      try {
        const x = new URL(u);
        const h = ['localhost', '127.0.0.1', '[::1]', '0.0.0.0'].includes(x.hostname) ? 'localhost' : x.hostname;
        return `${h}:${x.port || (x.protocol === 'https:' ? '443' : '80')}${x.pathname.replace(/\/+$/, '')}`;
      } catch {
        return u;
      }
    };
    return norm(a) === norm(b);
  };

  async function discover(): Promise<DiscoveredServer[]> {
    const targets = deps.discoverTargets
      ?? (Object.entries(PRESETS) as Array<[ConnectionPreset, PresetInfo]>)
        .filter(([, p]) => p.port !== undefined)
        .map(([preset, p]) => ({ preset, baseUrl: p.baseUrl! }));
    const existing = ctx.repos.connections.list();
    const detect = deps.detectInstalled ?? defaultDetect;
    const probed = await Promise.all(
      targets.map(async (t): Promise<DiscoveredServer | null> => {
        const already = existing.some((c) => sameServer(c.base_url, t.baseUrl));
        try {
          const res = await doFetch()(`${t.baseUrl}/models`, { method: 'GET', signal: AbortSignal.timeout(deps.discoverTimeoutMs ?? 800), redirect: 'error' });
          if (res.ok) return { preset: t.preset, baseUrl: t.baseUrl, models: parseModels(await res.json()).ids, alreadyConnected: already };
        } catch {
          /* no responde */
        }
        if (await detect(t.preset)) return { preset: t.preset, baseUrl: t.baseUrl, models: [], alreadyConnected: already, installedNotRunning: true };
        return null;
      }),
    );
    return probed.filter((x): x is DiscoveredServer => x !== null);
  }

  return { models, test, discover, checkModel };
}

// ---------------------------------------------------------------------------
// Creación automática de openai/gemini (D17: sustituyen a las claves fijas del asistente)
// ---------------------------------------------------------------------------

/**
 * Si la variable de entorno de la clave existe, crea (una sola vez, aunque luego se borre) la conexión openai/gemini
 * marcada con clave. El secreto se resuelve con el alias de la cuenta existente (ver secrets.ts): no se mueve.
 */
export function autoCreateKeyConnections(ctx: Ctx, env: NodeJS.ProcessEnv): void {
  loadEnvSecrets(ctx, env);
  for (const [preset, alias] of Object.entries(KEY_ALIASES) as Array<[keyof typeof KEY_ALIASES, (typeof KEY_ALIASES)[keyof typeof KEY_ALIASES]]>) {
    if (!ctx.secrets.has(alias.account)) continue;
    const marker = `auto_conn_${preset}`;
    if (ctx.repos.settings.get(marker)) continue;
    ctx.repos.settings.set(marker, '1');
    const url = PRESETS[preset].baseUrl!;
    if (ctx.repos.connections.list().some((c) => c.preset === preset && c.base_url === url)) continue;
    ctx.repos.connections.create({ name: PRESETS[preset].label, preset, baseUrl: url, auth: 'bearer', hasSecret: true });
  }
}

// ---------------------------------------------------------------------------
// Fábrica de adaptadores
// ---------------------------------------------------------------------------

/** Claude (Agent SDK) sin conexión; `ApiLoopAdapter` con `connection_id`. */
export function makeAdapterFactory(ctx: Ctx, deps: ConnectionDeps = {}): (agent: AgentRow) => AgentAdapter {
  return (agent) => {
    if (!agent.connection_id) {
      if (agent.provider === 'claude') {
        const claudePath = claudePathSetting(ctx); // el ajuste manda sobre KIJI_CLAUDE_PATH
        return new ClaudeAdapter(claudePath ? { pathToClaudeCodeExecutable: claudePath } : {});
      }
      throw new Error(`el proveedor "${agent.provider}" no está soportado: usa Claude o una conexión`);
    }
    const c = ctx.repos.connections.get(agent.connection_id);
    if (!c) throw new Error('la conexión de este agente ya no existe');
    const apiKey = c.auth === 'none' ? undefined : secretFor(ctx, c);
    if (c.auth !== 'none' && !apiKey) throw new Error(`falta la clave de la conexión «${c.name}»: guárdala en Conexiones`);
    if (!agent.model) throw new Error(`el agente no tiene modelo para la conexión «${c.name}»`);
    return new ApiLoopAdapter({
      baseUrl: c.base_url, auth: c.auth, apiKey, model: agent.model, contextWindow: c.context_window,
      prices: parsePrices(c.prices_json), toolQuality: c.tool_quality, ...(deps.fetch ? { fetch: deps.fetch } : {}),
    });
  };
}

// ---------------------------------------------------------------------------
// providers.status: una tarjeta por conexión
// ---------------------------------------------------------------------------

const RECENT_ERRORS_WINDOW_MS = 60 * 60_000;

export function connectionCards(ctx: Ctx, now = Date.now()): ProviderStatus[] {
  return ctx.repos.connections.list().map((c) => {
    const configured = c.auth === 'none' || hasUsableSecret(ctx, c);
    let state: ProviderStatus['state'];
    if (!configured || c.last_test_ok === 0) state = 'off';
    else if (c.last_test_ok === null) state = 'unknown';
    else state = ctx.repos.connections.failedRunsSince(c.id, now - RECENT_ERRORS_WINDOW_MS) > 0 ? 'warning' : 'ok';
    return { id: `conn:${c.id}`, label: c.name, configured, state, windows: [], models: [] };
  });
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function cleanName(raw: unknown, method: string): string {
  const name = str(raw, 'name', method).trim();
  if (name === '' || name.length > NAME_MAX) throw new Error(`${method}: el nombre debe tener entre 1 y ${NAME_MAX} caracteres`);
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new Error(`${method}: el nombre no puede llevar caracteres de control`);
  return name;
}
function cleanModel(raw: unknown, method: string): string | null {
  if (raw === null || raw === '') return null;
  if (typeof raw !== 'string') throw new Error(`${method}: "defaultModel" debe ser texto`);
  const m = raw.trim();
  if (m.length > MODEL_MAX || /[\u0000-\u001f\u007f]/.test(m)) throw new Error(`${method}: nombre de modelo no válido`);
  return m === '' ? null : m;
}
function cleanContext(raw: unknown, method: string): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 512 || raw > 10_000_000) {
    throw new Error(`${method}: "contextWindow" debe ser un entero entre 512 y 10000000`);
  }
  return raw;
}
function cleanAuth(raw: unknown, method: string): ConnectionAuth {
  if (typeof raw !== 'string' || !(AUTHS as readonly string[]).includes(raw)) throw new Error(`${method}: auth no válido (${AUTHS.join(', ')})`);
  return raw as ConnectionAuth;
}
function cleanPrices(raw: unknown, method: string): Prices {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${method}: "prices" debe ser un objeto {modelo: {in, out}}`);
  const out: Prices = {};
  for (const [k, v] of Object.entries(raw)) {
    const p = v as { in?: unknown; out?: unknown };
    const ok = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n < 100_000;
    if (!p || !ok(p.in) || !ok(p.out)) throw new Error(`${method}: precio no válido para "${k}" (in y out numéricos ≥ 0, USD por millón de tokens)`);
    out[k] = { in: p.in as number, out: p.out as number };
  }
  return out;
}

export function connectionHandlers(ctx: Ctx, svc: ConnectionService): Record<string, Handler> {
  return {
    'connection.list': () => ctx.repos.connections.list().map((c) => connectionView(ctx, c)),

    /** `ConnectionCreateParams`: los presets rellenan lo que falte. Emite `secrets.request` si lleva clave. */
    'connection.create': (params) => {
      const p = asParams(params, 'connection.create') as unknown as Partial<ConnectionCreateParams> & Record<string, unknown>;
      if (!isPreset(p.preset)) throw new Error(`connection.create: preset no válido (${Object.keys(PRESETS).join(', ')})`);
      const preset = PRESETS[p.preset];
      const name = cleanName(p.name, 'connection.create');
      const rawUrl = p.baseUrl ?? preset.baseUrl;
      if (typeof rawUrl !== 'string' || rawUrl.trim() === '') throw new Error('connection.create: falta "baseUrl"');
      const baseUrl = validateBaseUrl(rawUrl, 'connection.create');
      const auth = p.auth === undefined ? preset.auth : cleanAuth(p.auth, 'connection.create');
      const c = ctx.repos.connections.create({
        name, preset: p.preset, baseUrl, auth,
        defaultModel: p.defaultModel === undefined ? null : cleanModel(p.defaultModel, 'connection.create'),
        contextWindow: p.contextWindow === undefined ? DEFAULT_CONTEXT_WINDOW : cleanContext(p.contextWindow, 'connection.create'),
      });
      if (auth !== 'none') requestSecrets(ctx, [connAccount(c.id)]);
      notifyConnections(ctx);
      return connectionView(ctx, c);
    },

    'connection.update': (params) => {
      const p = asParams(params, 'connection.update') as unknown as ConnectionUpdateParams & Record<string, unknown>;
      const c = requireConnection(ctx, p.id, 'connection.update');
      const patch: Parameters<typeof ctx.repos.connections.update>[1] = {};
      if (p.name !== undefined) patch.name = cleanName(p.name, 'connection.update');
      if (p.baseUrl !== undefined) {
        const url = validateBaseUrl(str(p.baseUrl, 'baseUrl', 'connection.update'), 'connection.update');
        if (url !== c.base_url) Object.assign(patch, { base_url: url, tool_quality: 'unknown', last_test_at: null, last_test_ok: null });
      }
      if (p.auth !== undefined) {
        patch.auth = cleanAuth(p.auth, 'connection.update');
        if (patch.auth === 'none') {
          ctx.secrets.delete(connAccount(c.id));
          patch.has_secret = 0;
        }
      }
      if (p.defaultModel !== undefined) patch.default_model = cleanModel(p.defaultModel, 'connection.update');
      if (p.contextWindow !== undefined) patch.context_window = cleanContext(p.contextWindow, 'connection.update');
      if (p.prices !== undefined) patch.prices_json = JSON.stringify(cleanPrices(p.prices, 'connection.update'));
      if (Object.keys(patch).length === 0) throw new Error('connection.update: indica al menos un campo que cambiar');
      const row = ctx.repos.connections.update(c.id, patch)!;
      notifyConnections(ctx);
      return connectionView(ctx, row);
    },

    'connection.delete': (params) => {
      const c = requireConnection(ctx, asParams(params, 'connection.delete').id, 'connection.delete');
      const users = ctx.repos.connections.agentNames(c.id);
      if (users.length > 0) throw new Error(`connection.delete: la usan estos agentes: ${users.join(', ')}; reasígnalos antes`);
      ctx.repos.connections.delete(c.id);
      ctx.secrets.delete(connAccount(c.id));
      notifyConnections(ctx);
      return true;
    },

    /** `{id, model?}` -> ConnectionTest (guarda tool_quality y last_test_*). */
    'connection.test': async (params) => {
      const p = asParams(params, 'connection.test');
      const c = requireConnection(ctx, p.id, 'connection.test');
      if (p.model !== undefined && typeof p.model !== 'string') throw new Error('connection.test: "model" debe ser texto');
      return svc.test(c, p.model as string | undefined);
    },

    'connection.models': async (params) => {
      const c = requireConnection(ctx, asParams(params, 'connection.models').id, 'connection.models');
      return svc.models(c);
    },

    'connections.discover': () => svc.discover(),
  };
}
