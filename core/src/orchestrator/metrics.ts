// Métricas en vivo de los runs (PLAN-0.2a, D8): consumo y contexto sin tabla nueva.
// La fila de `runs` se actualiza como mucho cada `metricsWriteMs` (2 s) y al cerrar el run; la notificación
// `run.metrics` sale como mucho cada `metricsNotifyMs` (500 ms) por run, con un envío final diferido para que la
// UI nunca se quede con una cifra vieja.
import type { AgentMetrics, RunMetrics } from '../../../shared/protocol.js';
import { DEFAULT_CONTEXT_WINDOW } from '../adapters/claude.js';
import type { AgentEvent } from '../adapters/types.js';
import type { AgentRow, RunRow } from '../db/repos.js';
import { runModelOf } from './connections.js';
import { type Ctx, type Handler, type LiveRun, type RunUsageState, asParams, assertSameProject, str } from './context.js';
import { scheduleWorkspacesNotify } from './workspaces.js';

type UsageEvent = Extract<AgentEvent, { type: 'usage' }>;

export const METRICS_NOTIFY_MS = 500;
export const METRICS_WRITE_MS = 2000;
const RECENT_RUNS = 20;

export function newUsageState(model: string, contextWindow = DEFAULT_CONTEXT_WINDOW): RunUsageState {
  return {
    model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, contextTokens: 0, contextWindow, costUsd: 0,
    baseline: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 },
    seen: false, lastWrite: 0, lastNotify: 0, notifyTimer: null,
  };
}

/** Modelo preferido de un agente (el que usa si no hay relevo): alias de Claude o `conn:<id>/<modelo>` (0.2b). */
export const preferredModel = (a: Pick<AgentRow, 'model' | 'connection_id'>): string => runModelOf(a);

/** RunMetrics en vivo a partir del estado en memoria. */
export function liveMetrics(live: LiveRun, isLive: boolean): RunMetrics {
  const u = live.usage;
  return {
    projectId: live.projectId, runId: live.runId, taskId: live.taskId, agentId: live.agentId, model: u.model,
    input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite,
    contextTokens: u.contextTokens, contextWindow: u.contextWindow, costUsd: u.costUsd, live: isLive,
  };
}

/** RunMetrics a partir de la fila guardada (`fallbackModel` para los runs anteriores a 0.2a, sin `model`). */
export function rowMetrics(r: RunRow, fallbackModel: string, projectId: string, isLive = false): RunMetrics {
  return {
    projectId, runId: r.id, taskId: r.task_id, agentId: r.agent_id, model: r.model ?? fallbackModel,
    input: r.input_tokens, output: r.output_tokens, cacheRead: r.cache_read_tokens, cacheWrite: r.cache_write_tokens,
    contextTokens: r.context_tokens, contextWindow: r.context_window, costUsd: r.cost_usd, live: isLive,
  };
}

/** Porcentaje de contexto usado (0..100, un decimal). */
export function contextPct(tokens: number, window: number): number {
  if (!(window > 0)) return 0;
  return Math.min(100, Math.round((tokens / window) * 1000) / 10);
}

/** Totales ya guardados de los runs anteriores de la misma sesión (el `result` con `resume` acumula toda la sesión). */
export function sessionBaseline(ctx: Ctx, taskId: string, sessionId: string, exceptRunId: string): RunUsageState['baseline'] {
  const b = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
  for (const r of ctx.repos.runs.listByTask(taskId)) {
    if (r.id === exceptRunId || r.provider_session_id !== sessionId) continue;
    b.input += r.input_tokens;
    b.output += r.output_tokens;
    b.cacheRead += r.cache_read_tokens;
    b.cacheWrite += r.cache_write_tokens;
    b.costUsd += r.cost_usd;
  }
  return b;
}

/** Escribe el consumo en la fila del run. */
export function writeUsage(ctx: Ctx, live: LiveRun): void {
  const u = live.usage;
  if (!live.runId) return;
  u.lastWrite = Date.now();
  ctx.repos.runs.update(live.runId, {
    model: u.model, cost_usd: u.costUsd, input_tokens: u.input, output_tokens: u.output,
    cache_read_tokens: u.cacheRead, cache_write_tokens: u.cacheWrite,
    context_tokens: u.contextTokens, context_window: u.contextWindow,
  });
}

function emitMetrics(ctx: Ctx, live: LiveRun, isLive: boolean): void {
  const u = live.usage;
  u.lastNotify = Date.now();
  ctx.emit('run.metrics', liveMetrics(live, isLive));
  scheduleWorkspacesNotify(ctx);
}

/** Aplica un evento `usage` del adaptador: estado en memoria, escritura limitada y notificación limitada. */
export function applyUsage(ctx: Ctx, live: LiveRun, ev: UsageEvent): void {
  const u = live.usage;
  u.seen = true;
  u.model = live.model; // el modelo "en uso" es el del spec (alias), no el id largo que devuelve la API
  // El evento final (del `result`) es acumulado de la sesión: se resta lo de los runs anteriores de esa sesión.
  const b = ev.final ? u.baseline : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
  u.input = Math.max(0, ev.input - b.input);
  u.output = Math.max(0, ev.output - b.output);
  u.cacheRead = Math.max(0, ev.cacheRead - b.cacheRead);
  u.cacheWrite = Math.max(0, ev.cacheWrite - b.cacheWrite);
  u.contextTokens = ev.contextTokens;
  u.contextWindow = ev.contextWindow;
  if (ev.costUsd !== undefined) u.costUsd = Math.max(0, ev.costUsd - b.costUsd);
  if (ev.sessionId) live.sessionId = ev.sessionId;

  const now = Date.now();
  if (ev.final || now - u.lastWrite >= ctx.metricsWriteMs) writeUsage(ctx, live);

  if (now - u.lastNotify >= ctx.metricsNotifyMs) {
    if (u.notifyTimer) {
      clearTimeout(u.notifyTimer);
      u.notifyTimer = null;
    }
    emitMetrics(ctx, live, true);
  } else if (!u.notifyTimer) {
    // Envío diferido: lleva la última cifra en cuanto se cumple el intervalo.
    u.notifyTimer = setTimeout(() => {
      u.notifyTimer = null;
      if (!live.ended) emitMetrics(ctx, live, true);
    }, ctx.metricsNotifyMs - (now - u.lastNotify));
    u.notifyTimer.unref();
  }
}

/** Al cerrar el run: cancela el envío diferido y notifica la cifra definitiva con `live: false`. */
export function finalizeMetrics(ctx: Ctx, live: LiveRun): void {
  const u = live.usage;
  if (u.notifyTimer) {
    clearTimeout(u.notifyTimer);
    u.notifyTimer = null;
  }
  emitMetrics(ctx, live, false);
}

export function metricsHandlers(ctx: Ctx): Record<string, Handler> {
  return {
    'agent.metrics': (params) => {
      const p = asParams(params, 'agent.metrics');
      const agent = ctx.repos.agents.get(str(p.agentId, 'agentId', 'agent.metrics'));
      if (!agent) throw new Error('agent.metrics: agente inexistente');
      assertSameProject(p, agent.project_id, 'agent.metrics');
      return agentMetrics(ctx, agent);
    },
  };
}

export function agentMetrics(ctx: Ctx, agent: AgentRow): AgentMetrics {
  const live = [...ctx.live.values()].find((l) => l.agentId === agent.id && l.runId !== '');
  const totals = ctx.repos.runs.totalsByAgent(agent.id);
  const recent = ctx.repos.runs.listByAgent(agent.id, RECENT_RUNS).map((r) =>
    live && live.runId === r.id ? liveMetrics(live, true) : rowMetrics(r, preferredModel(agent), agent.project_id),
  );
  const last = recent[0];
  return {
    agentId: agent.id,
    model: live ? live.usage.model : preferredModel(agent),
    runs: totals.runs,
    costUsd: totals.cost,
    input: totals.input,
    output: totals.output,
    cacheRead: totals.cache_read,
    cacheWrite: totals.cache_write,
    lastContextTokens: last?.contextTokens ?? 0,
    lastContextWindow: last?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    recent,
  };
}
