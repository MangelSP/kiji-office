// Política de autonomía del gerente (PLAN-0.2b, D22): niveles por categoría, validación estricta de `manager.set`,
// preguntas al humano (ask = fila en `approvals` con tool `manager:<accion>`) y caducidad fail-closed.
//
// Candados fijos (no configurables): `manager.set` no admite claves fuera de las del plan; los permisos de los robots
// (`permission_request`) siguen yendo a la persona y el gerente no tiene herramienta para contestarlos.
import type {
  AutonomyLevel, ManagerActionView, ManagerLevels, ManagerPolicy, ManagerTickView,
} from '../../../shared/protocol.js';
import type { ManagerActionRow, ManagerTickRow } from '../db/repos.js';
import type { Ctx } from '../orchestrator/context.js';
import { sanitize } from '../orchestrator/events.js';
import { notify } from '../orchestrator/notifications.js';
import { startOfLocalDay, usageByProject } from '../orchestrator/queue.js';

// ---------------------------------------------------------------------------
// Tiempos (inyectables en las pruebas)
// ---------------------------------------------------------------------------

export interface ManagerOptions {
  /** Mínimo entre el inicio de dos ticks de un proyecto (por defecto 30 s). */
  minTickGapMs?: number;
  /** Espera para agrupar disparadores que llegan casi a la vez (por defecto 1,5 s). */
  settleMs?: number;
  /** Temporizador con objetivos abiertos (por defecto 15 min). */
  timerMs?: number;
  /** Caducidad de una pregunta; por defecto `policy.askTimeoutMinutes`. */
  askTimeoutMs?: number;
  /** Duración máxima de un tick; por defecto `policy.maxTickMinutes`. */
  maxTickMs?: number;
  /** Tope de gasto de UN tick en USD (por defecto 1). */
  tickBudgetUsd?: number;
  /** Reloj (horas de silencio). */
  now?: () => number;
}
export type ManagerOptionsResolved = Required<Omit<ManagerOptions, 'askTimeoutMs' | 'maxTickMs'>> & Pick<ManagerOptions, 'askTimeoutMs' | 'maxTickMs'>;

export function resolveManagerOptions(o: ManagerOptions = {}): ManagerOptionsResolved {
  return {
    minTickGapMs: o.minTickGapMs ?? 30_000,
    settleMs: o.settleMs ?? 1_500,
    timerMs: o.timerMs ?? 15 * 60_000,
    tickBudgetUsd: o.tickBudgetUsd ?? 1,
    now: o.now ?? Date.now,
    ...(o.askTimeoutMs !== undefined ? { askTimeoutMs: o.askTimeoutMs } : {}),
    ...(o.maxTickMs !== undefined ? { maxTickMs: o.maxTickMs } : {}),
  };
}

// ---------------------------------------------------------------------------
// Niveles
// ---------------------------------------------------------------------------

export const LEVEL_KEYS = ['plan', 'assign', 'start', 'retry', 'relay', 'integrate', 'spend'] as const satisfies ReadonlyArray<keyof ManagerLevels>;
export type LevelKey = (typeof LEVEL_KEYS)[number];
const LEVELS: readonly AutonomyLevel[] = ['auto', 'notify', 'ask'];
const RANK: Record<AutonomyLevel, number> = { auto: 0, notify: 1, ask: 2 };

/** El más restrictivo de los dos. */
export const stricter = (a: AutonomyLevel, b: AutonomyLevel): AutonomyLevel => (RANK[a] >= RANK[b] ? a : b);

export function defaultPolicy(brainAgentId: string): ManagerPolicy {
  return {
    enabled: true,
    brain: { agentId: brainAgentId },
    levels: { plan: 'auto', assign: 'auto', start: 'auto', retry: 'auto', relay: 'notify', integrate: 'ask', spend: 'ask' },
    spendAskUsd: 5,
    dayBudgetUsd: 15,
    maxTickMinutes: 5,
    maxTicksPerHour: 20,
    askTimeoutMinutes: 60,
  };
}

const POLICY_KEYS = ['enabled', 'brain', 'levels', 'spendAskUsd', 'dayBudgetUsd', 'maxTickMinutes', 'maxTicksPerHour', 'quietHours', 'askTimeoutMinutes'];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function object(v: unknown, what: string): Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error(`manager.set: "${what}" debe ser un objeto`);
  return v as Record<string, unknown>;
}
function exactKeys(o: Record<string, unknown>, allowed: readonly string[], what: string): void {
  for (const k of Object.keys(o)) {
    if (!allowed.includes(k)) throw new Error(`manager.set: la clave "${k}" no se admite en ${what} (admitidas: ${allowed.join(', ')})`);
  }
}
function number(v: unknown, what: string, min: number, max: number, integer = false): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max || (integer && !Number.isInteger(v))) {
    throw new Error(`manager.set: "${what}" debe ser un ${integer ? 'entero' : 'número'} entre ${min} y ${max}`);
  }
  return v;
}

/**
 * Valida una política completa (claves exactas, rangos razonables, `brain.agentId` de este proyecto y con una IA que
 * sepa llamar a herramientas). Devuelve una copia normalizada; no admite nada fuera de las claves del plan.
 */
export function validatePolicy(ctx: Ctx, projectId: string, input: unknown): ManagerPolicy {
  const p = object(input, 'policy');
  exactKeys(p, POLICY_KEYS, 'policy');
  if (typeof p.enabled !== 'boolean') throw new Error('manager.set: "enabled" debe ser true o false');

  const brain = object(p.brain, 'brain');
  exactKeys(brain, ['agentId'], 'brain');
  if (typeof brain.agentId !== 'string' || brain.agentId === '') throw new Error('manager.set: falta "brain.agentId"');
  const agent = ctx.repos.agents.get(brain.agentId);
  if (!agent || agent.project_id !== projectId) throw new Error(`manager.set: el agente cerebro ${brain.agentId} no existe en este proyecto`);
  const conn = agent.connection_id ? ctx.repos.connections.get(agent.connection_id) : undefined;
  if (agent.connection_id && !conn) throw new Error('manager.set: la conexión del agente cerebro ya no existe');
  if (conn?.tool_quality === 'none') throw new Error(`manager.set: la conexión «${conn.name}» no sabe llamar a herramientas: elige otro cerebro`);

  const lv = object(p.levels, 'levels');
  exactKeys(lv, LEVEL_KEYS, 'levels');
  const levels = {} as ManagerLevels;
  for (const k of LEVEL_KEYS) {
    const v = lv[k];
    if (typeof v !== 'string' || !LEVELS.includes(v as AutonomyLevel)) throw new Error(`manager.set: levels.${k} debe ser ${LEVELS.join(' | ')}`);
    levels[k] = v as AutonomyLevel;
  }

  const out: ManagerPolicy = {
    enabled: p.enabled,
    brain: { agentId: brain.agentId },
    levels,
    spendAskUsd: number(p.spendAskUsd, 'spendAskUsd', 0, 100_000),
    dayBudgetUsd: number(p.dayBudgetUsd, 'dayBudgetUsd', 0.01, 100_000),
    maxTickMinutes: number(p.maxTickMinutes, 'maxTickMinutes', 1, 60),
    maxTicksPerHour: number(p.maxTicksPerHour, 'maxTicksPerHour', 1, 120, true),
    askTimeoutMinutes: number(p.askTimeoutMinutes ?? 60, 'askTimeoutMinutes', 1, 1440),
  };
  if (p.quietHours !== undefined && p.quietHours !== null) {
    const q = object(p.quietHours, 'quietHours');
    exactKeys(q, ['from', 'to'], 'quietHours');
    if (typeof q.from !== 'string' || !HHMM.test(q.from) || typeof q.to !== 'string' || !HHMM.test(q.to)) {
      throw new Error('manager.set: quietHours.from y quietHours.to deben ser "HH:MM" (00:00–23:59)');
    }
    if (q.from === q.to) throw new Error('manager.set: quietHours.from y quietHours.to no pueden ser iguales');
    out.quietHours = { from: q.from, to: q.to };
  }
  return out;
}

/** Política guardada del proyecto o null (apagado, ausente o ilegible). */
export function readPolicy(ctx: Ctx, projectId: string): ManagerPolicy | null {
  const raw = ctx.repos.projects.get(projectId)?.manager_policy;
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as ManagerPolicy;
    return p && typeof p === 'object' && p.levels && p.brain ? p : null;
  } catch {
    return null;
  }
}

const minutesOf = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** ¿Estamos en horas de silencio? (hora local; el tramo puede cruzar la medianoche). */
export function inQuietHours(q: ManagerPolicy['quietHours'], at: number): boolean {
  if (!q) return false;
  const d = new Date(at);
  const m = d.getHours() * 60 + d.getMinutes();
  const from = minutesOf(q.from);
  const to = minutesOf(q.to);
  return from < to ? m >= from && m < to : m >= from || m < to;
}

/** Milisegundos hasta la próxima vez que sean las `hhmm` locales. */
export function msUntil(hhmm: string, at: number): number {
  const d = new Date(at);
  const t = new Date(at);
  t.setHours(Number(hhmm.slice(0, 2)), Number(hhmm.slice(3, 5)), 0, 0);
  if (t.getTime() <= d.getTime()) t.setDate(t.getDate() + 1);
  return t.getTime() - at;
}

/** La política contada para el prompt del tick. */
export function policyInWords(p: ManagerPolicy): string {
  const how: Record<AutonomyLevel, string> = {
    auto: 'lo haces tú directamente',
    notify: 'lo haces y la persona recibe un aviso',
    ask: 'NO lo haces todavía: se le pregunta a la persona y esperas su respuesta (si no contesta a tiempo, cuenta como NO)',
  };
  const what: Record<LevelKey, string> = {
    plan: 'Crear las tareas de un plan',
    assign: 'Elegir qué robot hace cada tarea',
    start: 'Arrancar tareas',
    retry: 'Reintentar tareas falladas o con cambios pedidos (máximo 2 veces por tarea)',
    relay: 'Cambiar de IA o de robot una tarea en marcha',
    integrate: 'Integrar en la rama base una tarea aprobada',
    spend: `Seguir gastando cuando el gasto de hoy del proyecto supera ${p.spendAskUsd} USD`,
  };
  const lines = LEVEL_KEYS.map((k) => `- ${what[k]}: ${how[p.levels[k]]}.`);
  lines.push(
    `- Tope del día para ti y los robots que arranques: ${p.dayBudgetUsd} USD; al llegar, no se arranca nada más.`,
    `- Como mucho ${p.maxTicksPerHour} despertares por hora y ${p.maxTickMinutes} min por despertar.`,
  );
  if (p.quietHours) lines.push(`- Horas de silencio ${p.quietHours.from}–${p.quietHours.to}: solo se avisa, no se arranca nada.`);
  lines.push(
    '- Siempre, sin excepción: los permisos que piden los robots (push, borrar, instalar, red, secretos) los contesta SOLO la persona; tú no puedes verlos ni contestarlos. Tampoco puedes deshacer integraciones ni tocar proyectos, conexiones, ajustes ni claves.',
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Gasto
// ---------------------------------------------------------------------------

/** Gasto de hoy del proyecto (todos sus runs, también los que van en vuelo). */
export function projectSpendToday(ctx: Ctx, projectId: string): number {
  return usageByProject(ctx, startOfLocalDay()).today.get(projectId)?.cost ?? 0;
}

/** Gasto de hoy del gerente: sus ticks + los runs que él arrancó (`started_by = 'manager'`), con lo que aún va en vuelo. */
export function managerCostToday(ctx: Ctx, projectId: string): number {
  const since = startOfLocalDay();
  let cost = ctx.repos.managerTicks.costSince(projectId, since) + ctx.repos.runs.costByStartedBySince(projectId, 'manager', since);
  for (const l of ctx.live.values()) {
    if (l.projectId !== projectId || !l.runId || l.ended) continue;
    const row = ctx.repos.runs.get(l.runId);
    if (row?.started_by === 'manager') cost += Math.max(0, l.usage.costUsd - row.cost_usd);
  }
  return cost;
}

// ---------------------------------------------------------------------------
// Diario y vistas
// ---------------------------------------------------------------------------

export function actionView(r: ManagerActionRow): ManagerActionView {
  return {
    id: r.id, tickId: r.tick_id, projectId: r.project_id, tool: r.tool, input: r.input, result: r.result,
    level: r.level, decidedBy: r.decided_by, createdAt: r.created_at,
  };
}
export function tickView(r: ManagerTickRow): ManagerTickView {
  return {
    id: r.id, projectId: r.project_id, trigger: r.trigger, summary: r.summary, costUsd: r.cost_usd,
    startedAt: r.started_at, endedAt: r.ended_at,
  };
}

const RESULT_MAX = 1500;
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const asText = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(sanitize(v) ?? null));

/** Una línea del diario (`manager_actions`) + evento `manager.action`. */
export function recordAction(
  ctx: Ctx,
  a: { tickId: string; projectId: string; tool: string; input: unknown; result: unknown; level: AutonomyLevel; decidedBy: ManagerActionView['decidedBy'] },
): ManagerActionView {
  const row = ctx.repos.managerActions.create({
    tickId: a.tickId, projectId: a.projectId, tool: a.tool, input: clip(asText(a.input), 4000), result: clip(asText(a.result), RESULT_MAX),
    level: a.level, decidedBy: a.decidedBy,
  });
  const view = actionView(row);
  ctx.emit('manager.action', view);
  return view;
}

/** Cuando llega la respuesta de una pregunta (o su caducidad): completa la línea y vuelve a emitir `manager.action`. */
export function resolveAction(ctx: Ctx, id: number, r: { result: unknown; decidedBy: 'policy' | 'user' | 'timeout' }): void {
  ctx.repos.managerActions.resolve(id, { result: clip(asText(r.result), RESULT_MAX), decidedBy: r.decidedBy });
  const row = ctx.repos.managerActions.get(id);
  if (row) ctx.emit('manager.action', actionView(row));
}

// ---------------------------------------------------------------------------
// Preguntas a la persona (ask)
// ---------------------------------------------------------------------------

export interface PendingAsk {
  approvalId: string;
  projectId: string;
  tickId: string;
  actionId: number;
  /** Nombre de la herramienta del gerente (sin el prefijo `manager:`). */
  tool: string;
  summary: string;
  /** Opciones que se ofrecieron (ask_user); vacío si es sí/no. */
  options: string[];
  /** Clave para no preguntar dos veces lo mismo mientras siga pendiente. */
  key: string;
  timer: NodeJS.Timeout | null;
  /** Revalida y ejecuta la acción guardada (solo tras un sí de la persona). */
  execute: () => Promise<unknown>;
}

export interface AskRequest {
  projectId: string;
  tickId: string;
  tool: string;
  args: unknown;
  summary: string;
  question?: string;
  options?: string[];
  taskId: string | null;
  kind: 'manager' | 'integrate';
  key: string;
  execute: () => Promise<unknown>;
}

export function findPendingAsk(ctx: Ctx, projectId: string, key: string): PendingAsk | undefined {
  for (const a of ctx.managerAsks.values()) if (a.projectId === projectId && a.key === key) return a;
  return undefined;
}

/** Crea la aprobación (tool `manager:<accion>`), la anuncia a la UI y arma la caducidad fail-closed. NO ejecuta nada. */
export function requestApproval(ctx: Ctx, r: AskRequest): { approvalId: string; actionId: number } {
  const action = recordAction(ctx, {
    tickId: r.tickId, projectId: r.projectId, tool: r.tool, input: r.args,
    result: { ok: false, pending: true, message: 'Esperando la respuesta de la persona.' }, level: 'ask', decidedBy: null,
  });
  const question = r.question ?? `${r.summary}. ¿Lo hago?`;
  const input = sanitize({
    projectId: r.projectId, tickId: r.tickId, actionId: action.id, tool: r.tool, summary: r.summary, question,
    ...(r.options ? { options: r.options } : {}), ...(r.taskId ? { taskId: r.taskId } : {}), args: r.args,
  });
  const row = ctx.repos.approvals.create({ tool: `manager:${r.tool}`, risk: 'ask', input, runId: null, taskId: r.taskId });
  const pending: PendingAsk = {
    approvalId: row.id, projectId: r.projectId, tickId: r.tickId, actionId: action.id, tool: r.tool, summary: r.summary,
    key: r.key, options: r.options ?? [], timer: null, execute: r.execute,
  };
  ctx.managerAsks.set(row.id, pending);
  const policy = readPolicy(ctx, r.projectId);
  const ms = ctx.managerOptions.askTimeoutMs ?? (policy?.askTimeoutMinutes ?? 60) * 60_000;
  pending.timer = setTimeout(() => void expireAsk(ctx, row.id), Math.min(ms, 2_000_000_000));
  pending.timer.unref();
  notify(ctx, { projectId: r.projectId, level: 'ask', title: 'El gerente pregunta', body: question, approvalId: row.id });
  ctx.emit('approval.requested', {
    projectId: r.projectId, id: row.id, tool: `manager:${r.tool}`, input, risk: 'ask', kind: r.kind, agent_id: null, task_id: r.taskId,
  });
  return { approvalId: row.id, actionId: action.id };
}

function settle(ctx: Ctx, id: string): PendingAsk | undefined {
  const ask = ctx.managerAsks.get(id);
  if (!ask) return undefined;
  if (ask.timer) clearTimeout(ask.timer);
  ask.timer = null;
  ctx.managerAsks.delete(id);
  return ask;
}

const wake = (ctx: Ctx, ask: PendingAsk, text: string): void => ctx.manager?.trigger(ask.projectId, 'answer', text);

/**
 * La persona contestó (`approval.answer` sobre una `manager:*`). Decide y responde ya; si es sí, la acción guardada
 * (p. ej. rebase+tests+merge) corre en segundo plano para no congelar el router: al terminar se anota en el diario y
 * se despierta al gerente; un error va al diario y a un aviso.
 */
export async function answerManagerAsk(ctx: Ctx, id: string, allow: boolean, option?: unknown): Promise<{ ok: true; status: 'approved' | 'denied'; option?: string; pending?: true }> {
  const ask = ctx.managerAsks.get(id);
  if (!ask) throw new Error('la aprobación ya está resuelta');
  let chosen: string | undefined;
  if (option !== undefined && option !== null) {
    if (typeof option !== 'string') throw new Error('approval.answer: "option" debe ser texto');
    if (!ask.options.includes(option)) throw new Error(`approval.answer: "option" debe ser una de: ${ask.options.join(' | ') || '(la pregunta no tiene opciones)'}`);
    if (!allow) throw new Error('approval.answer: una opción solo se elige con allow:true');
    chosen = option;
  }
  // Con la parada global activa un SÍ no se puede ejecutar: se rechaza sin decidir (la aprobación sigue pendiente).
  if (allow && ctx.halted) throw new Error('Parada global activa: reanuda antes de aprobar.');
  if (!ctx.repos.approvals.decide(id, allow ? 'approved' : 'denied')) {
    settle(ctx, id);
    throw new Error('la aprobación ya está resuelta');
  }
  settle(ctx, id);
  if (!allow) {
    resolveAction(ctx, ask.actionId, { result: { ok: false, denied: true, message: 'La persona respondió que NO.' }, decidedBy: 'user' });
    wake(ctx, ask, `La persona respondió NO a: ${ask.summary}`);
    return { ok: true, status: 'denied' };
  }
  void (async () => {
    let result: unknown;
    let failed: string | undefined;
    try {
      if (ctx.halted) throw new Error('Parada global activa: no se ejecuta.');
      result = await ask.execute();
      if (chosen !== undefined) result = { ...(result as object), option: chosen };
    } catch (e) {
      failed = e instanceof Error ? e.message : String(e);
      result = { ok: false, error: failed };
    }
    try {
      resolveAction(ctx, ask.actionId, { result, decidedBy: 'user' });
      if (failed !== undefined) notify(ctx, { projectId: ask.projectId, level: 'warn', title: 'No se pudo hacer lo aprobado', body: `${ask.summary}: ${clip(failed, 300)}` });
      wake(ctx, ask, chosen !== undefined
        ? `La persona eligió «${chosen}» a: ${ask.summary}`
        : `La persona respondió SÍ a: ${ask.summary}. Resultado: ${clip(asText(result), 300)}`);
    } catch (e) {
      process.stderr.write(`kiji-core: falló cerrar la acción aprobada: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  })();
  return { ok: true, status: 'approved', pending: true, ...(chosen !== undefined ? { option: chosen } : {}) };
}

/** Sin respuesta a tiempo: se da por NO (fail-closed) y queda en el diario con decided_by 'timeout'. */
async function expireAsk(ctx: Ctx, id: string): Promise<void> {
  const ask = settle(ctx, id);
  if (!ask) return;
  ctx.repos.approvals.decide(id, 'denied');
  resolveAction(ctx, ask.actionId, { result: { ok: false, denied: true, message: 'Sin respuesta a tiempo: se da por NO.' }, decidedBy: 'timeout' });
  notify(ctx, { projectId: ask.projectId, level: 'info', title: 'Pregunta caducada', body: `Sin respuesta, se da por NO: ${ask.summary}` });
  wake(ctx, ask, `La pregunta caducó sin respuesta (cuenta como NO): ${ask.summary}`);
}

/** Parada global o cierre: deniega todas las preguntas pendientes (no despierta al gerente). */
export function denyManagerAsks(ctx: Ctx, message: string, projectId?: string): number {
  let n = 0;
  for (const ask of [...ctx.managerAsks.values()]) {
    if (projectId !== undefined && ask.projectId !== projectId) continue;
    settle(ctx, ask.approvalId);
    ctx.repos.approvals.decide(ask.approvalId, 'denied');
    resolveAction(ctx, ask.actionId, { result: { ok: false, denied: true, message }, decidedBy: 'user' });
    n++;
  }
  return n;
}

/** Apagado del core: cancela las caducidades (las filas pendientes las deniega el siguiente arranque). */
export function clearAskTimers(ctx: Ctx): void {
  for (const a of ctx.managerAsks.values()) if (a.timer) clearTimeout(a.timer);
}
