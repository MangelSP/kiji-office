// Prueba de conexión de los proveedores (`providers.test {provider}`) para el asistente de primera vez.
// Devuelve siempre `{ok, detail}`: `detail` es un texto para la persona usuaria y NUNCA lleva la clave ni cabeceras.
import { query as sdkQuery, type Options } from '@anthropic-ai/claude-agent-sdk';
import { type Ctx, type Handler, asParams, str } from './context.js';
import { ollamaUrl } from './settings.js';

export type ProviderName = 'claude' | 'ollama' | 'openai' | 'gemini';
export interface TestResult {
  ok: boolean;
  detail: string;
}

const KEY_ENV = { openai: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY' } as const;
const MODELS_URL = {
  openai: 'https://api.openai.com/v1/models',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai/models',
} as const;

/** Presupuesto máximo de la llamada de prueba a Claude (USD). */
export const CLAUDE_TEST_BUDGET_USD = 0.02;

export interface ProviderDeps {
  fetch?: typeof fetch;
  query?: typeof sdkQuery;
  env?: NodeJS.ProcessEnv;
  ollamaTimeoutMs?: number;
  apiTimeoutMs?: number;
  claudeTimeoutMs?: number;
}

/** Valores sensibles a ocultar en cualquier texto que salga hacia la UI: las claves del entorno y todo lo que parezca una. */
function redact(text: string, env: NodeJS.ProcessEnv): string {
  let out = text;
  for (const name of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY']) {
    const v = env[name];
    if (v && v.length >= 4) out = out.split(v).join('***');
  }
  return out
    .replace(/\b(sk|AIza|ya29|gsk)[-_A-Za-z0-9]{12,}/g, '***')
    .replace(/Bearer\s+\S+/gi, 'Bearer ***')
    .slice(0, 400);
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const isTimeout = (e: unknown): boolean => e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');

/** GET con tiempo máximo; traduce los fallos a un `TestResult` legible. */
async function getJson(
  f: typeof fetch,
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  who: string,
  env: NodeJS.ProcessEnv,
): Promise<{ res: Response } | { fail: TestResult }> {
  try {
    const res = await f(url, { method: 'GET', headers, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    return { res };
  } catch (e) {
    if (isTimeout(e)) return { fail: { ok: false, detail: `${who} no respondió en ${Math.round(timeoutMs / 1000)} s` } };
    return { fail: { ok: false, detail: redact(`${who}: no se pudo conectar (${errText(e)})`, env) } };
  }
}

function countModels(body: unknown): number | null {
  if (body && typeof body === 'object' && Array.isArray((body as { data?: unknown }).data)) return (body as { data: unknown[] }).data.length;
  if (body && typeof body === 'object' && Array.isArray((body as { models?: unknown }).models)) return (body as { models: unknown[] }).models.length;
  return null;
}

async function readModels(res: Response): Promise<number | null> {
  try {
    return countModels(await res.json());
  } catch {
    return null;
  }
}

export function createProviderTester(ctx: Ctx, deps: ProviderDeps = {}) {
  const env = () => deps.env ?? process.env;
  const doFetch = () => deps.fetch ?? fetch;

  async function testOllama(): Promise<TestResult> {
    const base = ollamaUrl(ctx);
    const r = await getJson(doFetch(), `${base}/models`, {}, deps.ollamaTimeoutMs ?? 3000, 'Ollama', env());
    if ('fail' in r) {
      if (r.fail.detail.includes('no se pudo conectar')) {
        return { ok: false, detail: `Ollama no responde en ${base}: ¿está instalado y en marcha? (instálalo desde ollama.com y ejecuta "ollama serve")` };
      }
      return r.fail;
    }
    if (!r.res.ok) return { ok: false, detail: `Ollama respondió HTTP ${r.res.status} en ${base}/models` };
    const n = await readModels(r.res);
    return { ok: true, detail: n === null ? 'Ollama responde' : `Ollama responde: ${n} modelo${n === 1 ? '' : 's'} instalado${n === 1 ? '' : 's'}` };
  }

  async function testApi(provider: 'openai' | 'gemini'): Promise<TestResult> {
    const label = provider === 'openai' ? 'OpenAI' : 'Gemini';
    const key = env()[KEY_ENV[provider]];
    if (!key) return { ok: false, detail: `${label}: no hay clave configurada (guárdala en el paso 2 del asistente)` };
    const r = await getJson(doFetch(), MODELS_URL[provider], { Authorization: `Bearer ${key}` }, deps.apiTimeoutMs ?? 5000, label, env());
    if ('fail' in r) return r.fail;
    const { res } = r;
    if (res.status === 401 || res.status === 403) return { ok: false, detail: `${label} rechazó la clave (HTTP ${res.status}): revísala` };
    if (res.status === 429) return { ok: false, detail: `${label}: demasiadas peticiones o sin saldo (HTTP 429)` };
    if (!res.ok) return { ok: false, detail: `${label} respondió HTTP ${res.status}` };
    const n = await readModels(res);
    return { ok: true, detail: n === null ? `${label}: clave válida` : `${label}: clave válida, ${n} modelos disponibles` };
  }

  /** Una llamada mínima con el Agent SDK: modelo barato, sin herramientas, tope de 0,02 USD. */
  async function testClaude(): Promise<TestResult> {
    const query = deps.query ?? sdkQuery;
    const abortController = new AbortController();
    const timeoutMs = deps.claudeTimeoutMs ?? 60_000;
    const timer = setTimeout(() => abortController.abort(), timeoutMs);
    const options: Options = {
      model: 'haiku',
      tools: [], // sin herramientas
      maxTurns: 1,
      maxBudgetUsd: CLAUDE_TEST_BUDGET_USD,
      settingSources: [], // ni CLAUDE.md ni ajustes del usuario
      systemPrompt: 'Responde solo con la palabra pedida.',
      persistSession: false,
      abortController,
      // Por si acaso: nada de herramientas, ni pidiendo permiso.
      canUseTool: async () => ({ behavior: 'deny', message: 'Prueba de conexión: sin herramientas.' }),
    };
    if (deps.env) options.env = { ...process.env, ...deps.env };
    let q: ReturnType<typeof sdkQuery> | undefined;
    try {
      q = query({ prompt: 'responde solo: ok', options });
      for await (const m of q) {
        const msg = m as { type?: string; subtype?: string; is_error?: boolean; result?: unknown; total_cost_usd?: number; errors?: unknown };
        if (msg.type !== 'result') continue;
        if (msg.subtype === 'success' && !msg.is_error) {
          const cost = typeof msg.total_cost_usd === 'number' ? ` (coste ${msg.total_cost_usd.toFixed(4)} USD)` : '';
          return { ok: true, detail: redact(`Claude responde: "${String(msg.result ?? '').trim().slice(0, 40)}"${cost}`, env()) };
        }
        const why = Array.isArray(msg.errors) && msg.errors.length > 0 ? msg.errors.map(String).join('; ') : String(msg.result ?? msg.subtype ?? 'error');
        return { ok: false, detail: redact(`Claude falló: ${why}`, env()) };
      }
      return { ok: false, detail: 'Claude terminó sin devolver resultado' };
    } catch (e) {
      if (abortController.signal.aborted) return { ok: false, detail: `Claude no respondió en ${Math.round(timeoutMs / 1000)} s` };
      return { ok: false, detail: redact(`Claude falló: ${errText(e)}`, env()) };
    } finally {
      clearTimeout(timer);
      try {
        q?.close();
      } catch {
        /* ya cerrado */
      }
    }
  }

  return async function test(provider: string): Promise<TestResult> {
    switch (provider) {
      case 'claude':
        return testClaude();
      case 'ollama':
        return testOllama();
      case 'openai':
      case 'gemini':
        return testApi(provider);
      default:
        throw new Error(`providers.test: proveedor desconocido "${provider}" (claude, ollama, openai, gemini)`);
    }
  };
}

export function providerHandlers(ctx: Ctx, deps: ProviderDeps = {}): Record<string, Handler> {
  const test = createProviderTester(ctx, deps);
  return {
    'providers.test': async (params) => test(str(asParams(params, 'providers.test').provider, 'provider', 'providers.test')),
  };
}
