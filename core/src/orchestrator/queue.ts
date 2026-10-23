// Cola global de arranques (PLAN-0.2b parte 2, C3): tope de runs simultáneos (`max_concurrent_runs`) y tope de gasto
// diario (`daily_budget_usd`) para todos los proyectos abiertos. `task.start`, el relevo de modelo, el cambio manual y la
// reanudación al reset pasan por `requestStart`: si hay hueco arrancan ya; si no, la tarea espera en `ctx.queue`
// (conserva su estado: `assigned`, `paused_limit`...) y arranca sola cuando se libera un hueco (`pumpQueue`).
import type { BudgetNotice, QueueChange } from '../../../shared/protocol.js';
import { type Ctx, type Handler, type QueueEntry } from './context.js';
import { logEvent } from './events.js';
import { AgentBusyError, type StartOptions, checkStartable, startTask } from './runs.js';
import { type TaskView, getTask, publishTask, taskView } from './tasks.js';
import { scheduleWorkspacesNotify } from './workspaces.js';

export const DEFAULT_MAX_CONCURRENT_RUNS = 3;
export const DEFAULT_DAILY_BUDGET_USD = 10;
/** No se repite el aviso `budget.reached` más de una vez por este tiempo. */
const BUDGET_NOTICE_EVERY_MS = 10_000;

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function maxConcurrentRuns(ctx: Ctx): number {
  const v = Number.parseInt(ctx.repos.settings.get('max_concurrent_runs') ?? '', 10);
  return Number.isFinite(v) && v >= 1 ? v : DEFAULT_MAX_CONCURRENT_RUNS;
}

export function dailyBudgetUsd(ctx: Ctx): number {
  const v = Number.parseFloat(ctx.repos.settings.get('daily_budget_usd') ?? '');
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_DAILY_BUDGET_USD;
}

/** Medianoche local del día de `now` (epoch ms): "hoy" es el día local. */
export function startOfLocalDay(now = Date.now()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export interface Usage { cost: number; input: number; output: number; cacheRead: number; cacheWrite: number }
const zero = (): Usage => ({ cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

/**
 * Consumo por proyecto: hoy (runs que empezaron desde `since`) y total. Suma lo guardado en la BD más lo que los
 * runs vivos llevan en memoria y aún no se ha escrito (la escritura va como mucho cada 2 s).
 */
export function usageByProject(ctx: Ctx, since: number): { today: Map<string, Usage>; total: Map<string, number> } {
  const today = new Map<string, Usage>();
  const total = new Map<string, number>();
  for (const r of ctx.repos.runs.usageByProjectSince(since)) {
    today.set(r.project_id, { cost: r.cost, input: r.input, output: r.output, cacheRead: r.cache_read, cacheWrite: r.cache_write });
  }
  for (const r of ctx.repos.runs.costByProject()) total.set(r.project_id, r.cost);
  for (const l of ctx.live.values()) {
    if (!l.runId || l.ended) continue; // un run terminado ya escribió su consumo definitivo
    const row = ctx.repos.runs.get(l.runId);
    if (!row) continue;
    const u = l.usage;
    const d: Usage = {
      cost: Math.max(0, u.costUsd - row.cost_usd), input: Math.max(0, u.input - row.input_tokens),
      output: Math.max(0, u.output - row.output_tokens), cacheRead: Math.max(0, u.cacheRead - row.cache_read_tokens),
      cacheWrite: Math.max(0, u.cacheWrite - row.cache_write_tokens),
    };
    total.set(l.projectId, (total.get(l.projectId) ?? 0) + d.cost);
    if (row.started_at >= since) {
      const t = today.get(l.projectId) ?? zero();
      t.cost += d.cost; t.input += d.input; t.output += d.output; t.cacheRead += d.cacheRead; t.cacheWrite += d.cacheWrite;
      today.set(l.projectId, t);
    }
  }
  return { today, total };
}

/** Gasto de hoy de todos los proyectos (USD). */
export function costToday(ctx: Ctx, now = Date.now()): number {
  let n = 0;
  for (const u of usageByProject(ctx, startOfLocalDay(now)).today.values()) n += u.cost;
  return n;
}

/** Runs que ocupan hueco: los vivos que aún no terminaron (un run en su cierre de commit/tests ya no gasta IA). */
export function activeRunCount(ctx: Ctx): number {
  let n = 0;
  for (const l of ctx.live.values()) if (!l.ended) n++;
  return n;
}

/** Qué impide arrancar ahora mismo: el tope diario, el de runs simultáneos o nada. */
function blockedBy(ctx: Ctx): 'slots' | 'budget' | null {
  if (costToday(ctx) >= dailyBudgetUsd(ctx)) return 'budget';
  if (activeRunCount(ctx) >= maxConcurrentRuns(ctx)) return 'slots';
  return null;
}

/** Posición 1-based en la cola, o null. */
export function queuePosition(ctx: Ctx, taskId: string): number | null {
  const i = ctx.queue.findIndex((e) => e.taskId === taskId);
  return i === -1 ? null : i + 1;
}

export function queuedCount(ctx: Ctx, projectId?: string): number {
  return projectId === undefined ? ctx.queue.length : ctx.queue.filter((e) => e.projectId === projectId).length;
}

const change = (e: QueueEntry, pos: number): QueueChange => ({
  projectId: e.projectId, taskId: e.taskId, queued: pos > 0, position: pos, blockedBy: pos > 0 ? e.blockedBy : null,
});

/** Avisa (`queue.changed` + `task.changed`) de las tareas cuya posición o motivo cambió. */
function announce(ctx: Ctx): void {
  ctx.queue.forEach((e, i) => {
    const key = `${i + 1}|${e.blockedBy}`;
    if (e.announced === key) return;
    e.announced = key;
    ctx.emit('queue.changed', change(e, i + 1));
    if (ctx.repos.tasks.get(e.taskId)) publishTask(ctx, e.taskId);
  });
  scheduleWorkspacesNotify(ctx);
}

function removeEntry(ctx: Ctx, entry: QueueEntry): void {
  const i = ctx.queue.indexOf(entry);
  if (i === -1) return;
  ctx.queue.splice(i, 1);
  ctx.emit('queue.changed', change(entry, 0));
}

/** Saca la tarea de la cola (p. ej. `task.stop` sobre una tarea en cola). Devuelve true si estaba. */
export function dequeue(ctx: Ctx, taskId: string): boolean {
  const entry = ctx.queue.find((e) => e.taskId === taskId);
  if (!entry) return false;
  removeEntry(ctx, entry);
  announce(ctx);
  if (ctx.repos.tasks.get(taskId)) publishTask(ctx, taskId);
  return true;
}

/** Saca de la cola todas las tareas de un proyecto (al cerrarlo). */
export function dequeueProject(ctx: Ctx, projectId: string): void {
  for (const e of ctx.queue.filter((x) => x.projectId === projectId)) removeEntry(ctx, e);
  announce(ctx);
}

function noticeBudget(ctx: Ctx, entry: QueueEntry): void {
  const cost = costToday(ctx);
  const budget = dailyBudgetUsd(ctx);
  const message = `Tope de gasto diario alcanzado (${cost.toFixed(2)} de ${budget.toFixed(2)} USD hoy): no arranca ningún run nuevo hasta mañana o hasta que subas el tope en los ajustes.`;
  if (Date.now() - ctx.budgetNoticeAt >= BUDGET_NOTICE_EVERY_MS) {
    ctx.budgetNoticeAt = Date.now();
    const notice: BudgetNotice = { costTodayUsd: cost, dailyBudgetUsd: budget, message, projectId: entry.projectId, taskId: entry.taskId };
    ctx.emit('budget.reached', notice);
  }
}

function describe(entry: QueueEntry, pos: number): string {
  return entry.blockedBy === 'budget'
    ? 'en cola: tope de gasto diario alcanzado'
    : `en cola (posición ${pos}): se alcanzó el máximo de runs simultáneos`;
}

/** Medianoche local: las tareas retenidas por el tope diario se reintentan (el gasto de "hoy" vuelve a 0). */
function armBudgetTimer(ctx: Ctx): void {
  if (ctx.budgetTimer || ctx.closed || !ctx.queue.some((e) => e.blockedBy === 'budget')) return;
  const wait = Math.max(1000, Math.min(nextMidnight() - Date.now() + 1000, 2_000_000_000));
  ctx.budgetTimer = setTimeout(() => {
    ctx.budgetTimer = null;
    void pumpQueue(ctx);
  }, wait);
  ctx.budgetTimer.unref();
}

function nextMidnight(): number {
  const d = new Date();
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

/** Apagado del core: ni cola ni temporizadores. */
export function clearQueue(ctx: Ctx): void {
  if (ctx.budgetTimer) clearTimeout(ctx.budgetTimer);
  ctx.budgetTimer = null;
  ctx.queue.length = 0;
}

/**
 * Pide arrancar una tarea. Con hueco libre y sin nadie esperando arranca ya; si no, entra en la cola (el relevo y el
 * cambio manual van delante; el resto, al final) y devuelve su vista con `queued: true`.
 * Los errores de validación (estado, agente ocupado...) se lanzan aquí, antes de encolar.
 */
export async function requestStart(
  ctx: Ctx,
  taskId: string,
  opts: StartOptions = {},
  reason: QueueEntry['reason'] = 'start',
  hooks: { onStarted?: () => void; onFailed?: (err: unknown) => void } = {},
): Promise<TaskView> {
  const { task, project } = checkStartable(ctx, taskId);
  if (ctx.queue.some((e) => e.taskId === taskId)) throw new Error('la tarea ya está en la cola');
  const blocked = blockedBy(ctx);
  if (ctx.queue.length === 0 && blocked === null) {
    const view = await startTask(ctx, taskId, opts);
    hooks.onStarted?.();
    return view;
  }
  const entry: QueueEntry = { taskId, projectId: project.id, opts, reason, blockedBy: blocked ?? 'slots', queuedAt: Date.now(), ...hooks };
  if (reason === 'relay') ctx.queue.unshift(entry);
  else ctx.queue.push(entry);
  const pos = ctx.queue.indexOf(entry) + 1;
  logEvent(ctx, {
    projectId: project.id, kind: 'status', taskId, agentId: task.agent_id,
    payload: { type: 'queued', position: pos, blocked_by: entry.blockedBy, message: describe(entry, pos) },
  });
  if (entry.blockedBy === 'budget') noticeBudget(ctx, entry);
  announce(ctx);
  armBudgetTimer(ctx);
  await pumpQueue(ctx); // quizá ya le toca
  return taskView(ctx, getTask(ctx, taskId));
}

/** Arranca, por orden, las tareas de la cola mientras haya hueco y presupuesto. No lanza: los fallos se registran. */
export async function pumpQueue(ctx: Ctx): Promise<void> {
  if (ctx.closed) return;
  if (ctx.pumping) {
    ctx.pumpAgain = true;
    return;
  }
  ctx.pumping = true;
  try {
    do {
      ctx.pumpAgain = false;
      for (const entry of [...ctx.queue]) {
        if (ctx.closed) break;
        if (!ctx.queue.includes(entry)) continue;
        try {
          checkStartable(ctx, entry.taskId);
        } catch (err) {
          if (err instanceof AgentBusyError) continue; // su agente sigue ocupado: espera, sin bloquear a los demás
          removeEntry(ctx, entry); // la tarea ya no se puede iniciar (parada, integrada, proyecto cerrado...)
          entry.onFailed?.(err);
          continue;
        }
        const blocked = blockedBy(ctx);
        if (blocked !== null) {
          for (const e of ctx.queue) e.blockedBy = blocked;
          if (blocked === 'budget') noticeBudget(ctx, entry);
          break;
        }
        removeEntry(ctx, entry);
        try {
          await startTask(ctx, entry.taskId, entry.opts);
          entry.onStarted?.();
        } catch (err) {
          if (entry.onFailed) entry.onFailed(err);
          else {
            const task = ctx.repos.tasks.get(entry.taskId);
            logEvent(ctx, {
              projectId: entry.projectId, kind: 'error', taskId: entry.taskId, agentId: task?.agent_id ?? null,
              payload: { message: `no se pudo iniciar la tarea desde la cola: ${msg(err)}`, retryable: true },
            });
          }
        }
      }
    } while (ctx.pumpAgain && !ctx.closed);
  } finally {
    ctx.pumping = false;
  }
  announce(ctx);
  armBudgetTimer(ctx);
}

export function queueHandlers(ctx: Ctx): Record<string, Handler> {
  return {
    /** Cola global en orden: `{projectId, taskId, position, reason, blockedBy, queuedAt}[]`. */
    'queue.list': () =>
      ctx.queue.map((e, i) => ({
        projectId: e.projectId, taskId: e.taskId, position: i + 1, reason: e.reason, blockedBy: e.blockedBy, queuedAt: e.queuedAt,
      })),
  };
}
