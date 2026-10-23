// Estado de cupo (PLAN-0.2a, D9): último `rate_limit_info` por ventana, en memoria y copiado en
// `settings.limits_snapshot` para sobrevivir a los reinicios. Cada cambio avisa con `limits.changed`.
import type { LimitWindow, LimitWindowType } from '../../../shared/protocol.js';
import type { AgentEvent } from '../adapters/types.js';
import type { Ctx } from './context.js';

type RateEvent = Extract<AgentEvent, { type: 'rate' }>;

const SNAPSHOT_KEY = 'limits_snapshot';
const LIMITS_NOTIFY_MS = 1000;
/** Un `rejected` sin hora de reset se da por vigente este tiempo desde que se vio. */
const NO_RESET_GRACE_MS = 5 * 60_000;

const WINDOW_TYPES: readonly LimitWindowType[] = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet', 'other'];

/**
 * Tipo de ventana a partir del `rateLimitType` del SDK. `overage` (créditos extra) no es una ventana de uso:
 * devuelve null y no se guarda. Cualquier otro valor desconocido o ausente cuenta como `other`.
 */
export function windowTypeOf(raw: string | undefined | null): LimitWindowType | null {
  if (raw === 'overage') return null;
  return (WINDOW_TYPES as readonly string[]).includes(raw ?? '') ? (raw as LimitWindowType) : 'other';
}

/** Límite de un solo modelo (no de toda la cuenta): admite relevo entre modelos (D10). */
export const isModelWindow = (t: LimitWindowType): boolean => t === 'seven_day_opus' || t === 'seven_day_sonnet';

/** Familia del modelo (`sonnet`, `opus`, `haiku`) a partir de un alias o id (`opus[1m]`, `claude-sonnet-4-5`). */
export function modelFamily(model: string | null | undefined): 'sonnet' | 'opus' | 'haiku' | null {
  const m = (model ?? '').toLowerCase();
  if (m.includes('opus')) return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('haiku')) return 'haiku';
  return null;
}

/** Hasta cuándo dura el rechazo de una ventana (epoch ms), o null si no está limitada ahora. */
export function limitedUntilOf(w: LimitWindow | undefined, now = Date.now()): number | null {
  if (!w || w.status !== 'rejected') return null;
  const until = w.resetsAt ?? w.seenAt + NO_RESET_GRACE_MS;
  return until > now ? until : null;
}

/**
 * Hasta cuándo no se puede usar este modelo: la ventana propia (opus/sonnet) o cualquiera de toda la cuenta
 * (5 h, 7 días u otra desconocida). null = disponible.
 */
export function modelLimitedUntil(ctx: Ctx, model: string, now = Date.now()): number | null {
  const fam = modelFamily(model);
  const types: LimitWindowType[] = ['five_hour', 'seven_day', 'other'];
  if (fam === 'opus') types.push('seven_day_opus');
  if (fam === 'sonnet') types.push('seven_day_sonnet');
  let until: number | null = null;
  for (const t of types) {
    const u = limitedUntilOf(ctx.limits.get(t), now);
    if (u !== null && (until === null || u > until)) until = u;
  }
  return until;
}

const sameWindow = (a: LimitWindow | undefined, b: LimitWindow): boolean =>
  !!a && a.status === b.status && a.utilization === b.utilization && a.resetsAt === b.resetsAt;

function saveSnapshot(ctx: Ctx): void {
  try {
    ctx.repos.settings.set(SNAPSHOT_KEY, JSON.stringify([...ctx.limits.values()]));
  } catch {
    /* la copia es best-effort: el estado en memoria manda */
  }
}

/** Carga la copia guardada; descarta ventanas rechazadas cuyo reset ya pasó y entradas mal formadas. */
export function loadLimitsSnapshot(ctx: Ctx, now = Date.now()): void {
  let raw: unknown;
  try {
    raw = JSON.parse(ctx.repos.settings.get(SNAPSHOT_KEY) ?? '[]');
  } catch {
    return;
  }
  if (!Array.isArray(raw)) return;
  for (const w of raw as Array<Partial<LimitWindow>>) {
    if (!w || typeof w !== 'object' || !(WINDOW_TYPES as readonly unknown[]).includes(w.type)) continue;
    if (!['allowed', 'allowed_warning', 'rejected'].includes(w.status as string)) continue;
    const win: LimitWindow = {
      type: w.type!,
      status: w.status!,
      utilization: typeof w.utilization === 'number' ? w.utilization : null,
      resetsAt: typeof w.resetsAt === 'number' ? w.resetsAt : null,
      seenAt: typeof w.seenAt === 'number' ? w.seenAt : now,
    };
    if (win.resetsAt !== null && win.resetsAt <= now) continue; // esa ventana ya se reinició
    ctx.limits.set(win.type, win);
  }
}

/** Anota un `rate_limit_event`. Devuelve true si cambió algo visible. Avisa a la UI (con límite de frecuencia). */
export function recordRate(ctx: Ctx, ev: Pick<RateEvent, 'rateLimitType' | 'status' | 'utilization' | 'resetsAt'>, now = Date.now()): boolean {
  const type = windowTypeOf(ev.rateLimitType);
  if (type === null) return false;
  const w: LimitWindow = {
    type,
    status: ev.status,
    utilization: ev.utilization ?? null,
    resetsAt: ev.resetsAt ?? null,
    seenAt: now,
  };
  const changed = !sameWindow(ctx.limits.get(type), w);
  ctx.limits.set(type, w);
  if (changed) {
    saveSnapshot(ctx);
    scheduleLimitsNotify(ctx);
  }
  return changed;
}

/** `limits.changed` con los ProviderStatus actuales, como mucho una vez por segundo (con envío final diferido). */
export function scheduleLimitsNotify(ctx: Ctx): void {
  if (!ctx.providerStatus || ctx.limitsNotifyTimer || ctx.closed) return;
  const wait = Math.max(0, LIMITS_NOTIFY_MS - (Date.now() - ctx.limitsLastNotify));
  ctx.limitsNotifyTimer = setTimeout(() => {
    ctx.limitsNotifyTimer = null;
    ctx.limitsLastNotify = Date.now();
    if (ctx.closed) return;
    void ctx
      .providerStatus?.()
      .then((statuses) => {
        if (!ctx.closed) ctx.emit('limits.changed', statuses);
      })
      .catch((e) => {
        if (!ctx.closed) process.stderr.write(`limits.changed: ${e instanceof Error ? e.message : String(e)}\n`);
      });
  }, wait);
  ctx.limitsNotifyTimer.unref();
}
