// Ajustes del core: settings.get / settings.set con lista blanca de claves.
// Las claves de API NUNCA pasan por aquí: viven en el llavero del sistema y llegan al core por el entorno.
import { type Ctx, type Handler, asParams, str } from './context.js';

export const OLLAMA_URL_DEFAULT = 'http://localhost:11434/v1';

/** Claves permitidas y su validación; devuelve el valor normalizado o lanza un error claro. */
const ALLOWED: Record<string, (value: string) => string> = {
  ollama_url(value) {
    const v = value.trim().replace(/\/+$/, '');
    let url: URL;
    try {
      url = new URL(v);
    } catch {
      throw new Error('settings.set: ollama_url no es una URL válida (ejemplo: http://localhost:11434/v1)');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('settings.set: ollama_url debe empezar por http:// o https://');
    if (url.username || url.password) throw new Error('settings.set: ollama_url no debe llevar usuario ni contraseña');
    return v;
  },
  default_budget_usd(value) {
    const n = Number(value.trim());
    if (!Number.isFinite(n) || n <= 0 || n > 1000) throw new Error('settings.set: default_budget_usd debe ser un número entre 0 y 1000');
    return String(n);
  },
};

export const SETTING_KEYS = Object.keys(ALLOWED);

function allowedKey(raw: unknown, method: string): string {
  const key = str(raw, 'key', method);
  if (!Object.hasOwn(ALLOWED, key)) throw new Error(`${method}: la clave "${key}" no está permitida (permitidas: ${SETTING_KEYS.join(', ')})`);
  return key;
}

/** URL base de Ollama configurada (o la de por defecto). */
export function ollamaUrl(ctx: Ctx): string {
  return ctx.repos.settings.get('ollama_url') ?? OLLAMA_URL_DEFAULT;
}

export function settingsHandlers(ctx: Ctx): Record<string, Handler> {
  return {
    /** `{key}` -> valor guardado o `null` si no hay. */
    'settings.get': async (params) => {
      const p = asParams(params, 'settings.get');
      return ctx.repos.settings.get(allowedKey(p.key, 'settings.get')) ?? null;
    },
    /** `{key, value}` -> `{key, value}` normalizado. */
    'settings.set': async (params) => {
      const p = asParams(params, 'settings.set');
      const key = allowedKey(p.key, 'settings.set');
      const value = ALLOWED[key]!(str(p.value, 'value', 'settings.set'));
      ctx.repos.settings.set(key, value);
      return { key, value };
    },
  };
}
