import { describe, expect, it } from 'vitest';
import { toLimit } from '../../src/adapters/limits.js';

// Una prueba por fila de la tabla "Límite alcanzado ≠ error" (PLAN-0.1, D2).
describe('toLimit — claude', () => {
  it('rate_limit_event rejected -> rate con resetsAt en ms', () => {
    const ev = toLimit('claude', {
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', resetsAt: 1_800_000_000, rateLimitType: 'five_hour' },
    });
    expect(ev).toMatchObject({ type: 'limit', kind: 'rate', resetsAt: 1_800_000_000_000 });
  });

  it('resetsAt que ya viene en ms se respeta', () => {
    const ev = toLimit('claude', {
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', resetsAt: 1_800_000_000_000 },
    });
    expect(ev).toMatchObject({ kind: 'rate', resetsAt: 1_800_000_000_000 });
  });

  it('rate_limit_event allowed / allowed_warning -> null', () => {
    expect(toLimit('claude', { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } })).toBeNull();
    expect(toLimit('claude', { type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning' } })).toBeNull();
  });

  it('errorCode credits_required -> credits', () => {
    const ev = toLimit('claude', {
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', errorCode: 'credits_required' },
    });
    expect(ev).toMatchObject({ type: 'limit', kind: 'credits' });
  });

  it('api_retry rate_limit en el último intento -> rate', () => {
    const ev = toLimit('claude', { type: 'system', subtype: 'api_retry', error: 'rate_limit', attempt: 10, max_retries: 10 });
    expect(ev).toMatchObject({ kind: 'rate' });
  });

  it('api_retry billing_error en el último intento -> credits', () => {
    const ev = toLimit('claude', { type: 'system', subtype: 'api_retry', error: 'billing_error', attempt: 3, max_retries: 3 });
    expect(ev).toMatchObject({ kind: 'credits' });
  });

  it('api_retry antes del último intento, u otro error, -> null', () => {
    expect(toLimit('claude', { type: 'system', subtype: 'api_retry', error: 'rate_limit', attempt: 2, max_retries: 10 })).toBeNull();
    expect(toLimit('claude', { type: 'system', subtype: 'api_retry', error: 'server_error', attempt: 10, max_retries: 10 })).toBeNull();
  });

  it('result error_max_budget_usd -> budget', () => {
    expect(toLimit('claude', { type: 'result', subtype: 'error_max_budget_usd', is_error: false, errors: [] })).toMatchObject({ kind: 'budget' });
  });

  it('result is_error con texto de límite -> rate', () => {
    for (const text of ['Claude AI usage limit reached', '429 rate limit exceeded', 'API Error: Overloaded']) {
      expect(toLimit('claude', { type: 'result', subtype: 'error_during_execution', is_error: true, errors: [text] })).toMatchObject({ kind: 'rate' });
    }
    expect(toLimit('claude', { type: 'result', subtype: 'success', is_error: true, result: 'You have hit your usage limit' })).toMatchObject({ kind: 'rate' });
  });

  it('result con otro error, éxito u otros mensajes -> null (es error)', () => {
    expect(toLimit('claude', { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['boom'] })).toBeNull();
    expect(toLimit('claude', { type: 'result', subtype: 'error_max_turns', is_error: true, errors: [] })).toBeNull();
    expect(toLimit('claude', { type: 'result', subtype: 'success', is_error: false, result: 'rate limit en el texto' })).toBeNull();
    expect(toLimit('claude', { type: 'assistant' })).toBeNull();
    expect(toLimit('claude', null)).toBeNull();
  });
});

describe('toLimit — codex', () => {
  it('turn.failed con usage limit / rate limit / 429 -> rate', () => {
    expect(toLimit('codex', { type: 'turn.failed', error: { message: 'You hit your usage limit' } })).toMatchObject({ kind: 'rate' });
    expect(toLimit('codex', { type: 'error', message: 'rate limit reached' })).toMatchObject({ kind: 'rate' });
    expect(toLimit('codex', new Error('HTTP 429 Too Many Requests'))).toMatchObject({ kind: 'rate' });
  });

  it('quota / insufficient_quota -> quota', () => {
    expect(toLimit('codex', { type: 'turn.failed', error: { message: 'insufficient_quota' } })).toMatchObject({ kind: 'quota' });
    expect(toLimit('codex', { type: 'error', message: 'You exceeded your current quota' })).toMatchObject({ kind: 'quota' });
  });

  it('otros errores -> null', () => {
    expect(toLimit('codex', { type: 'turn.failed', error: { message: 'sandbox denied write' } })).toBeNull();
    expect(toLimit('codex', undefined)).toBeNull();
  });
});

describe('toLimit — api-loop', () => {
  class RateLimitError extends Error {
    status = 429;
  }

  it('RateLimitError (HTTP 429) -> rate', () => {
    expect(toLimit('api', new RateLimitError('Too many requests'))).toMatchObject({ kind: 'rate' });
    expect(toLimit('api', { status: 429, message: 'slow down' })).toMatchObject({ kind: 'rate' });
  });

  it('OpenAI insufficient_quota -> quota', () => {
    expect(toLimit('api', { status: 429, code: 'insufficient_quota', message: 'You exceeded your current quota' })).toMatchObject({ kind: 'quota' });
    expect(toLimit('api', { status: 429, error: { code: 'insufficient_quota', message: 'x' } })).toMatchObject({ kind: 'quota' });
  });

  it('Gemini RESOURCE_EXHAUSTED -> rate o quota según el mensaje', () => {
    expect(toLimit('api', { status: 429, error: { status: 'RESOURCE_EXHAUSTED', message: 'Resource has been exhausted' } })).toMatchObject({ kind: 'rate' });
    expect(toLimit('api', { status: 429, error: { status: 'RESOURCE_EXHAUSTED', message: 'You exceeded your current quota' } })).toMatchObject({ kind: 'quota' });
  });

  it('facturación -> credits', () => {
    expect(toLimit('api', { status: 429, code: 'billing_not_active', message: 'x' })).toMatchObject({ kind: 'credits' });
  });

  it('Ollama ECONNREFUSED o 5xx -> null (es error)', () => {
    expect(toLimit('api', Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), { code: 'ECONNREFUSED' }))).toBeNull();
    expect(toLimit('api', { status: 500, message: 'internal' })).toBeNull();
    expect(toLimit('api', { status: 503, message: 'unavailable' })).toBeNull();
    expect(toLimit('api', 'texto')).toBeNull();
  });
});
