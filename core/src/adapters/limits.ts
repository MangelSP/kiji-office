// "Límite alcanzado" ≠ error (PLAN-0.1, D2). `toLimit` devuelve un evento `limit` solo para las señales de la
// tabla; para todo lo demás devuelve null y el adaptador lo trata como `error`.

import type { AgentEvent, LimitKind, Provider } from './types.js';

type LimitEvent = Extract<AgentEvent, { type: 'limit' }>;

const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Texto de error de Claude que indica un límite (no un fallo). */
export const CLAUDE_LIMIT_TEXT = /rate limit|usage limit|overloaded/i;
const CODEX_TEXT = /usage limit|rate limit|429|quota|insufficient_quota/i;

/** El SDK da `resetsAt` en segundos epoch; el core usa milisegundos. */
function toMillis(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  return v < 1e11 ? Math.round(v * 1000) : v;
}

function limit(kind: LimitKind, message: string, resetsAt?: number): LimitEvent {
  const ev: LimitEvent = { type: 'limit', kind, message };
  if (resetsAt !== undefined) ev.resetsAt = resetsAt;
  return ev;
}

function fromClaude(raw: Record<string, any>): LimitEvent | null {
  // rate_limit_event
  if (raw.type === 'rate_limit_event' && isObj(raw.rate_limit_info)) {
    const info = raw.rate_limit_info;
    if (info.errorCode === 'credits_required') {
      return limit('credits', 'La cuenta necesita créditos para continuar.', toMillis(info.resetsAt));
    }
    if (info.status === 'rejected') {
      const which = str(info.rateLimitType).replace(/_/g, ' ');
      return limit('rate', `Límite de uso de Claude alcanzado${which ? ` (${which})` : ''}.`, toMillis(info.resetsAt));
    }
    return null;
  }

  // system/api_retry: solo cuando se agotaron los reintentos
  if (raw.type === 'system' && raw.subtype === 'api_retry') {
    if (raw.attempt !== raw.max_retries) return null;
    if (raw.error === 'rate_limit') return limit('rate', 'Claude rechazó la petición por límite de uso (reintentos agotados).');
    if (raw.error === 'billing_error') return limit('credits', 'Error de facturación de Claude (reintentos agotados).');
    return null;
  }

  // result
  if (raw.type === 'result') {
    if (raw.subtype === 'error_max_budget_usd') {
      return limit('budget', 'Se alcanzó el presupuesto máximo del run (maxBudgetUsd).');
    }
    if (raw.is_error) {
      const errors: string[] = Array.isArray(raw.errors) ? raw.errors.map(String) : [];
      const text = [...errors, str(raw.result)].join('\n');
      if (CLAUDE_LIMIT_TEXT.test(text)) return limit('rate', errors[0] || str(raw.result) || 'Límite de uso de Claude.');
    }
    return null;
  }

  return null;
}

function fromCodex(raw: unknown): LimitEvent | null {
  let message = '';
  if (typeof raw === 'string') message = raw;
  else if (raw instanceof Error) message = raw.message;
  else if (isObj(raw)) {
    // turn.failed → { error: { message } }, error → { message }
    message = str(raw.error?.message) || str(raw.message);
  }
  if (!CODEX_TEXT.test(message)) return null;
  const kind: LimitKind = /quota|insufficient_quota/i.test(message) ? 'quota' : 'rate';
  return limit(kind, message);
}

function fromApi(raw: unknown): LimitEvent | null {
  if (!isObj(raw)) return null;
  const err = isObj(raw.error) ? raw.error : raw;
  const status = raw.status ?? raw.statusCode ?? err.status ?? err.code;
  const code = str(err.code) || str(err.type);
  const message = str(err.message) || str(raw.message) || 'Límite del proveedor alcanzado.';
  const name = str(raw.name) || str(raw.constructor?.name);

  // Ollama caído o fallo del servidor: es un error, no un límite
  if (raw.code === 'ECONNREFUSED' || err.code === 'ECONNREFUSED') return null;
  if (typeof status === 'number' && status >= 500) return null;

  if (code === 'insufficient_quota') return limit('quota', message);
  if (/billing|insufficient_funds|credit/i.test(code)) return limit('credits', message);

  // Gemini: RESOURCE_EXHAUSTED (HTTP 429)
  if (code === 'RESOURCE_EXHAUSTED' || str(err.status) === 'RESOURCE_EXHAUSTED' || /RESOURCE_EXHAUSTED/.test(message)) {
    return limit(/quota/i.test(message) ? 'quota' : 'rate', message);
  }

  if (name === 'RateLimitError' || status === 429) return limit('rate', message);
  return null;
}

/**
 * Convierte una señal cruda de un proveedor en un evento `limit`, o devuelve null si no es un límite.
 * - `claude`: un mensaje del SDK (`rate_limit_event`, `system/api_retry` o `result`).
 * - `codex`: el evento `turn.failed`/`error`, un `Error` o su texto.
 * - `api`: el error lanzado por el cliente `openai` (o el cuerpo de error HTTP).
 */
export function toLimit(provider: Provider, raw: unknown): LimitEvent | null {
  switch (provider) {
    case 'claude':
      return isObj(raw) ? fromClaude(raw) : null;
    case 'codex':
      return fromCodex(raw);
    case 'api':
      return fromApi(raw);
    default:
      return null;
  }
}
