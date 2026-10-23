// Registro de eventos: persiste en `events` (sin secretos) y avisa a la UI con `event.appended`.
import type { EventKind, EventRow } from '../db/repos.js';
import { type Ctx, type Handler, asParams } from './context.js';

const MAX_STRING = 8000;
const MAX_ITEMS = 200;
const MAX_DEPTH = 8;
// Claves cuyo valor nunca se guarda (el `env` del proceso del agente incluye la clave de API).
const SECRET_KEYS = /^(env|api[_-]?key|authorization|password|secret|token)$/i;
const SECRET_PATTERNS = [/sk-[A-Za-z0-9_-]{16,}/g, /AIza[0-9A-Za-z_-]{20,}/g, /\b(ANTHROPIC|OPENAI|GEMINI|GOOGLE)_API_KEY\s*=\s*\S+/g];

/** Copia del valor apta para guardar: sin claves secretas, con patrones de claves enmascarados y recortada. */
export function sanitize(value: unknown, depth = 0, maxString = MAX_STRING): unknown {
  if (typeof value === 'string') {
    let s = value;
    for (const re of SECRET_PATTERNS) s = s.replace(re, '[redacted]');
    return s.length > maxString ? `${s.slice(0, maxString)}… [recortado]` : s;
  }
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[…]';
  if (Array.isArray(value)) return value.slice(0, MAX_ITEMS).map((v) => sanitize(v, depth + 1, maxString));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEYS.test(k) ? '[redacted]' : sanitize(v, depth + 1, maxString);
  }
  return out;
}

/** Fila de `events` con el payload ya parseado, tal como viaja a la UI. */
export function eventView(row: EventRow): Omit<EventRow, 'payload'> & { payload: unknown } {
  let payload: unknown = {};
  try {
    payload = JSON.parse(row.payload);
  } catch {
    /* payload corrupto: se devuelve vacío */
  }
  return { ...row, payload };
}

export function logEvent(
  ctx: Ctx,
  e: {
    projectId: string; kind: EventKind; payload?: unknown; taskId?: string | null; agentId?: string | null; runId?: string | null;
    /** Tope de caracteres por texto del payload (por defecto 8000). */
    maxString?: number;
  },
): EventRow {
  const row = ctx.repos.events.append({ ...e, payload: sanitize(e.payload ?? {}, 0, e.maxString) });
  ctx.emit('event.appended', eventView(row));
  return row;
}

/** `events.tail {after_id?, before_id?, limit?, agent_id?, kind?}` del proyecto activo. */
export function eventHandlers(ctx: Ctx): Record<string, Handler> {
  return {
    'events.tail': (params) => {
      if (!ctx.activeProject) return [];
      const p = params == null ? {} : asParams(params, 'events.tail');
      const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
      return ctx.repos.events
        .tail(ctx.activeProject.id, {
          afterId: num(p.after_id),
          beforeId: num(p.before_id),
          limit: num(p.limit),
          agentId: typeof p.agent_id === 'string' ? p.agent_id : undefined,
          kind: typeof p.kind === 'string' ? (p.kind as EventKind) : undefined,
        })
        .map(eventView);
    },
  };
}
