// Ajustes del core: settings.get / settings.set / settings.all con lista blanca de claves.
// Las claves de API NUNCA pasan por aquí: viven en el llavero del sistema y llegan al core por el entorno.
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, sep } from 'node:path';
import type { SettingKey, SettingSpec, SettingsAll } from '../../../shared/protocol.js';
import { classifyPath } from '../adapters/classify.js';
import { type Ctx, type Handler, asParams, str } from './context.js';
import { parseConnTarget } from './connections.js';
import { pumpQueue } from './queue.js';
import { scheduleWorkspacesNotify } from './workspaces.js';

export const OLLAMA_URL_DEFAULT = 'http://localhost:11434/v1';
export const DEFAULT_BUDGET_USD = 2;
export const NOTIFY_LEVELS = ['info', 'warn', 'ask'] as const;
export const MAX_EXTRA_SKILL_ROOTS = 5;
const CLAUDE_ALIASES = ['sonnet', 'opus', 'haiku'];
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

type Section = SettingSpec['section'];
interface Def {
  section: Section;
  /** Valor por defecto (texto, como se guarda). */
  default: (ctx: Ctx) => string;
  /** Devuelve el valor normalizado o lanza un error claro. */
  validate: (value: string, ctx: Ctx) => string;
}

const fail = (key: string, why: string): never => { throw new Error(`settings.set: ${key} ${why}`); };
const flag = (key: string) => (value: string): string => {
  const v = value.trim();
  if (v !== '0' && v !== '1') fail(key, 'debe ser "0" o "1"');
  return v;
};

// --- rutas de confianza (extra_skill_roots) ---------------------------------------------------------------------

/** Carpetas que nunca pueden ser raíz de confianza ni contener una (relativas al HOME). */
const FORBIDDEN_UNDER_HOME = [
  '.ssh', '.aws', '.gnupg', '.kube', '.docker', '.config/gcloud', '.config/gh', '.claude/projects', 'Library/Keychains',
];

const isInside = (root: string, p: string): boolean => p !== root && p.startsWith(root.endsWith(sep) ? root : root + sep);

/** Ruta absoluta de un directorio existente dentro del HOME, sin credenciales; devuelve su realpath o lanza. */
export function validateTrustedRoot(raw: string, key = 'extra_skill_roots'): string {
  if (typeof raw !== 'string' || raw.trim() === '' || CONTROL_RE.test(raw)) fail(key, 'lleva una ruta no válida');
  if (!isAbsolute(raw)) fail(key, `solo admite rutas absolutas ("${raw}")`);
  let real: string;
  let home: string;
  try {
    real = realpathSync(raw);
    if (!statSync(real).isDirectory()) fail(key, `"${raw}" no es una carpeta`);
    home = realpathSync(homedir());
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('settings.set:')) throw e;
    return fail(key, `la carpeta "${raw}" no existe o no se puede leer`);
  }
  if (!isInside(home, real)) fail(key, `"${raw}" debe estar dentro de tu carpeta de usuario`);
  for (const rel of FORBIDDEN_UNDER_HOME) {
    const f = join(home, ...rel.split('/'));
    if (real === f || isInside(f, real) || isInside(real, f)) fail(key, `"${raw}" es o contiene una carpeta de credenciales o historiales`);
  }
  if (classifyPath(real) !== 'ok' || classifyPath(raw) !== 'ok') fail(key, `"${raw}" es una ruta sensible`);
  return real;
}

function validateExtraRoots(value: string): string {
  let list: unknown;
  try {
    list = JSON.parse(value);
  } catch {
    return fail('extra_skill_roots', 'debe ser un JSON con una lista de rutas');
  }
  if (!Array.isArray(list) || !list.every((x) => typeof x === 'string')) fail('extra_skill_roots', 'debe ser una lista de rutas (texto)');
  const out: string[] = [];
  for (const r of list as string[]) {
    const real = validateTrustedRoot(r);
    if (!out.includes(real)) out.push(real);
  }
  if (out.length > MAX_EXTRA_SKILL_ROOTS) fail('extra_skill_roots', `admite como máximo ${MAX_EXTRA_SKILL_ROOTS} carpetas`);
  return JSON.stringify(out);
}

/** Raíces extra de confianza para skills: las guardadas que siguen siendo válidas (se vuelven a comprobar al leer). */
export function extraSkillRoots(ctx: Ctx): string[] {
  const raw = ctx.repos.settings.get('extra_skill_roots');
  if (!raw) return [];
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const r of list.slice(0, MAX_EXTRA_SKILL_ROOTS)) {
    try {
      const real = validateTrustedRoot(String(r));
      if (!out.includes(real)) out.push(real);
    } catch {
      /* la carpeta ya no existe o dejó de ser válida: se ignora */
    }
  }
  return out;
}

// --- definiciones ------------------------------------------------------------------------------------------------

const hhmm = (key: string, v: unknown): string => {
  const m = typeof v === 'string' ? /^([01]\d|2[0-3]):([0-5]\d)$/.exec(v) : null;
  if (!m) fail(key, 'debe llevar horas HH:MM (00:00–23:59)');
  return v as string;
};

const DEFS: Record<SettingKey, Def> = {
  user_name: {
    section: 'general', default: () => '',
    validate(value) {
      const v = value.trim();
      if (v.length > 40) fail('user_name', 'admite como máximo 40 caracteres');
      if (CONTROL_RE.test(v)) fail('user_name', 'no puede llevar saltos de línea ni caracteres de control');
      return v;
    },
  },
  start_view: {
    section: 'general', default: () => 'home',
    validate(value) {
      const v = value.trim();
      if (v !== 'home' && v !== 'last') fail('start_view', 'debe ser "home" o "last"');
      return v;
    },
  },
  max_concurrent_runs: {
    section: 'trabajo', default: () => '3',
    validate(value) {
      const n = Number(value.trim());
      if (!Number.isInteger(n) || n < 1 || n > 32) fail('max_concurrent_runs', 'debe ser un entero entre 1 y 32');
      return String(n);
    },
  },
  daily_budget_usd: {
    section: 'trabajo', default: () => '10',
    validate(value) {
      const n = Number(value.trim());
      if (!Number.isFinite(n) || n <= 0 || n > 100_000) fail('daily_budget_usd', 'debe ser un número mayor que 0 y como máximo 100000');
      return String(n);
    },
  },
  default_budget_usd: {
    section: 'trabajo', default: () => String(DEFAULT_BUDGET_USD),
    validate(value) {
      const n = Number(value.trim());
      if (!Number.isFinite(n) || n <= 0 || n > 1000) fail('default_budget_usd', 'debe ser un número entre 0 y 1000');
      return String(n);
    },
  },
  default_model: {
    section: 'trabajo', default: () => 'sonnet',
    validate(value, ctx) {
      const v = value.trim();
      if (CLAUDE_ALIASES.includes(v)) return v;
      const t = parseConnTarget(v);
      if (!t || t.model.length > 200 || CONTROL_RE.test(t.model)) {
        return fail('default_model', `debe ser ${CLAUDE_ALIASES.join(', ')} o conn:<id>/<modelo>`);
      }
      if (!ctx.repos.connections.get(t.connectionId)) fail('default_model', 'apunta a una conexión que no existe');
      return v;
    },
  },
  auto_relay_default: { section: 'trabajo', default: () => '1', validate: flag('auto_relay_default') },
  test_timeout_min: {
    // El tiempo que ya usaba la integración (ctx.testTimeoutMs; 5 min salvo pruebas).
    section: 'trabajo', default: (ctx) => String(Math.max(1, Math.round(ctx.testTimeoutMs / 60_000))),
    validate(value) {
      const n = Number(value.trim());
      if (!Number.isInteger(n) || n < 1 || n > 120) fail('test_timeout_min', 'debe ser un entero entre 1 y 120 (minutos)');
      return String(n);
    },
  },
  ollama_url: {
    section: 'ias', default: () => OLLAMA_URL_DEFAULT,
    validate(value) {
      const v = value.trim().replace(/\/+$/, '');
      let url: URL;
      try {
        url = new URL(v);
      } catch {
        return fail('ollama_url', 'no es una URL válida (ejemplo: http://localhost:11434/v1)');
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') fail('ollama_url', 'debe empezar por http:// o https://');
      if (url.username || url.password) fail('ollama_url', 'no debe llevar usuario ni contraseña');
      return v;
    },
  },
  claude_path: {
    section: 'ias', default: () => '',
    validate(value) {
      const v = value.trim();
      if (v === '') return '';
      if (CONTROL_RE.test(v) || !isAbsolute(v)) fail('claude_path', 'debe ser una ruta absoluta (o vacío para autodetectar)');
      try {
        if (!statSync(v).isFile()) fail('claude_path', 'no apunta a un archivo');
        accessSync(v, constants.X_OK); // solo se comprueba; nunca se ejecuta al guardar
      } catch (e) {
        if (e instanceof Error && e.message.startsWith('settings.set:')) throw e;
        fail('claude_path', 'no existe o no es ejecutable');
      }
      if (classifyPath(v) === 'never') fail('claude_path', 'es una ruta sensible');
      return v;
    },
  },
  extra_skill_roots: { section: 'skills', default: () => '[]', validate: validateExtraRoots },
  notify_system: { section: 'avisos', default: () => '1', validate: flag('notify_system') },
  notify_levels: {
    section: 'avisos', default: () => '["warn","ask"]',
    validate(value) {
      let list: unknown;
      try {
        list = JSON.parse(value);
      } catch {
        return fail('notify_levels', 'debe ser un JSON, por ejemplo ["warn","ask"]');
      }
      if (!Array.isArray(list) || !list.every((l) => (NOTIFY_LEVELS as readonly unknown[]).includes(l))) {
        fail('notify_levels', `solo admite ${NOTIFY_LEVELS.join(', ')}`);
      }
      return JSON.stringify(NOTIFY_LEVELS.filter((l) => (list as string[]).includes(l)));
    },
  },
  quiet_hours: {
    section: 'avisos', default: () => '',
    validate(value) {
      const v = value.trim();
      if (v === '') return '';
      let o: unknown;
      try {
        o = JSON.parse(v);
      } catch {
        return fail('quiet_hours', 'debe ser vacío o un JSON {"from":"22:00","to":"08:00"}');
      }
      if (o === null || typeof o !== 'object' || Array.isArray(o)) return fail('quiet_hours', 'debe ser un objeto {"from","to"}');
      const { from, to } = o as { from?: unknown; to?: unknown };
      const f = hhmm('quiet_hours.from', from);
      const t = hhmm('quiet_hours.to', to);
      if (f === t) fail('quiet_hours', '"from" y "to" no pueden ser iguales');
      return JSON.stringify({ from: f, to: t });
    },
  },
  events_retention_days: {
    section: 'datos', default: () => '0',
    validate(value) {
      const n = Number(value.trim());
      if (!Number.isInteger(n) || n < 0 || n > 3650) fail('events_retention_days', 'debe ser un entero entre 0 y 3650 (0 = sin límite)');
      return String(n);
    },
  },
  update_auto_check: { section: 'actualizaciones', default: () => '1', validate: flag('update_auto_check') },
};

export const SETTING_KEYS = Object.keys(DEFS) as SettingKey[];

function allowedKey(raw: unknown, method: string): SettingKey {
  const key = str(raw, 'key', method);
  if (!Object.hasOwn(DEFS, key)) throw new Error(`${method}: la clave "${key}" no está permitida (permitidas: ${SETTING_KEYS.join(', ')})`);
  return key as SettingKey;
}

// --- lectura efectiva ---------------------------------------------------------------------------------------------

/** Valor guardado o el defecto. */
export function settingValue(ctx: Ctx, key: SettingKey): string {
  return ctx.repos.settings.get(key) ?? DEFS[key].default(ctx);
}

/** URL base de Ollama configurada (o la de por defecto). */
export function ollamaUrl(ctx: Ctx): string {
  return ctx.repos.settings.get('ollama_url') ?? OLLAMA_URL_DEFAULT;
}

/** Ruta manual de `claude` (ajuste `claude_path`), o undefined si está vacía. Tiene prioridad sobre KIJI_CLAUDE_PATH. */
export function claudePathSetting(ctx: Ctx): string | undefined {
  const v = ctx.repos.settings.get('claude_path')?.trim();
  return v ? v : undefined;
}

/** Tiempo máximo de los tests al integrar: el ajuste `test_timeout_min` o, sin él, el de arranque (`ctx.testTimeoutMs`). */
export function testTimeoutMsOf(ctx: Ctx): number {
  const n = Number.parseInt(ctx.repos.settings.get('test_timeout_min') ?? '', 10);
  return Number.isInteger(n) && n >= 1 && n <= 120 ? n * 60_000 : ctx.testTimeoutMs;
}

/** Modelo por defecto para robots nuevos: alias de Claude, o la conexión indicada (si aún existe). */
export function defaultModelTarget(ctx: Ctx): { alias: string } | { connectionId: string; model: string } {
  const v = settingValue(ctx, 'default_model');
  const t = parseConnTarget(v);
  if (t && ctx.repos.connections.get(t.connectionId)) return t;
  return { alias: CLAUDE_ALIASES.includes(v) ? v : 'sonnet' };
}

export function autoRelayDefault(ctx: Ctx): boolean {
  return settingValue(ctx, 'auto_relay_default') !== '0';
}

// --- retención de eventos -----------------------------------------------------------------------------------------

export const RETENTION_EVERY_MS = 24 * 60 * 60_000;
const retentionTimers = new WeakMap<Ctx, NodeJS.Timeout>();

/** Borra los eventos de registro más antiguos que `events_retention_days` (0 = nunca). Devuelve cuántos. */
export function pruneEvents(ctx: Ctx, now = Date.now()): number {
  const days = Number.parseInt(settingValue(ctx, 'events_retention_days'), 10);
  if (!Number.isInteger(days) || days <= 0) return 0;
  try {
    return ctx.repos.events.deleteOlderThan(now - days * 86_400_000);
  } catch {
    return 0; // la limpieza nunca debe tumbar el core
  }
}

/** Limpieza al arrancar y cada 24 h. */
export function startRetention(ctx: Ctx): void {
  stopRetention(ctx);
  pruneEvents(ctx);
  const t = setInterval(() => { if (!ctx.closed) pruneEvents(ctx); }, RETENTION_EVERY_MS);
  t.unref();
  retentionTimers.set(ctx, t);
}

export function stopRetention(ctx: Ctx): void {
  const t = retentionTimers.get(ctx);
  if (t) clearInterval(t);
  retentionTimers.delete(ctx);
}

// --- handlers -----------------------------------------------------------------------------------------------------

export function settingsHandlers(ctx: Ctx): Record<string, Handler> {
  return {
    /** `{key}` -> valor guardado o `null` si no hay. */
    'settings.get': async (params) => {
      const p = asParams(params, 'settings.get');
      return ctx.repos.settings.get(allowedKey(p.key, 'settings.get')) ?? null;
    },
    /** `{key, value}` -> `{key, value}` normalizado. Emite `settings.changed`. */
    'settings.set': async (params) => {
      const p = asParams(params, 'settings.set');
      const key = allowedKey(p.key, 'settings.set');
      if (typeof p.value !== 'string') throw new Error('settings.set: falta "value" (texto)');
      const value = DEFS[key].validate(p.value, ctx);
      ctx.repos.settings.set(key, value);
      if (key === 'max_concurrent_runs' || key === 'daily_budget_usd') {
        void pumpQueue(ctx); // un tope más alto puede liberar tareas de la cola
        scheduleWorkspacesNotify(ctx);
      }
      if (key === 'events_retention_days') pruneEvents(ctx);
      ctx.emit('settings.changed', { key, value });
      return { key, value };
    },
    /** Todas las claves con valor guardado (o null), defecto y sección. */
    'settings.all': async (): Promise<SettingsAll> =>
      SETTING_KEYS.map((key): SettingSpec => ({
        key, value: ctx.repos.settings.get(key) ?? null, default: DEFS[key].default(ctx), section: DEFS[key].section,
      })),
  };
}
