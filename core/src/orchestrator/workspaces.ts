// Workspaces (0.2c): contadores por proyecto para `project.list`, el resumen del Home (`workspaces.overview`) y la
// notificación `workspaces.changed` (como mucho una por segundo).
import type { ProjectListItem, TasksByStatus, WorkspaceOverview, WorkspaceSummary } from '../../../shared/protocol.js';
import type { ProjectRow } from '../db/repos.js';
import { agentView } from './agents.js';
import type { Ctx, Handler } from './context.js';
import { dailyBudgetUsd, maxConcurrentRuns, queuedCount, startOfLocalDay, usageByProject } from './queue.js';
import { relayView } from './relay.js';

const NOTIFY_MS = 1000;
const lastSent = new WeakMap<Ctx, string>();

interface Counters {
  tasks: Map<string, TasksByStatus>;
  approvals: Map<string, number>;
}

function counters(ctx: Ctx): Counters {
  const tasks = new Map<string, TasksByStatus>();
  for (const r of ctx.repos.tasks.countsByProjectStatus()) {
    const m = tasks.get(r.project_id) ?? {};
    m[r.status] = r.n;
    tasks.set(r.project_id, m);
  }
  const approvals = new Map<string, number>();
  for (const r of ctx.repos.approvals.pendingByProject()) approvals.set(r.project_id, r.n);
  return { tasks, approvals };
}

const liveRunsOf = (ctx: Ctx, projectId: string): number => {
  let n = 0;
  for (const l of ctx.live.values()) if (l.projectId === projectId && !l.ended) n++;
  return n;
};

/** Tareas que esperan a la persona: pendientes de un permiso o de revisión. */
const needsYouOf = (t: TasksByStatus): number => (t.needs_you ?? 0) + (t.review ?? 0);

/** Abiertos primero; después por última apertura (más reciente antes) y por antigüedad. */
function ordered(ctx: Ctx): ProjectRow[] {
  return ctx.repos.projects.list().sort((a, b) => {
    const oa = ctx.projects.has(a.id) ? 1 : 0;
    const ob = ctx.projects.has(b.id) ? 1 : 0;
    return ob - oa || (b.last_opened_at ?? -1) - (a.last_opened_at ?? -1) || a.created_at - b.created_at;
  });
}

export function listProjects(ctx: Ctx): ProjectListItem[] {
  const c = counters(ctx);
  return ordered(ctx).map((p) => projectItem(ctx, p, c));
}

export function projectItem(ctx: Ctx, p: ProjectRow, c: Counters = counters(ctx)): ProjectListItem {
  const tasksByStatus = c.tasks.get(p.id) ?? {};
  return {
    projectId: p.id, name: p.name, path: p.path, baseBranch: p.base_branch, testCommand: p.test_command, createdAt: p.created_at,
    open: ctx.projects.has(p.id), lastOpenedAt: p.last_opened_at, color: p.color, scene: p.scene,
    liveRuns: liveRunsOf(ctx, p.id), queued: queuedCount(ctx, p.id), needsYou: needsYouOf(tasksByStatus),
    approvalsPending: c.approvals.get(p.id) ?? 0, tasksByStatus,
  };
}

/** Resumen del Home: una tarjeta por proyecto conocido y los totales globales. "Hoy" es el día local. */
export function buildOverview(ctx: Ctx, now = Date.now()): WorkspaceOverview {
  const c = counters(ctx);
  const usage = usageByProject(ctx, startOfLocalDay(now));
  const activity = new Map(ctx.repos.events.lastActivityByProject().map((r) => [r.project_id, r.at]));
  let costTodayUsd = 0;
  let liveRuns = 0;
  const workspaces: WorkspaceSummary[] = ordered(ctx).map((p) => {
    const item = projectItem(ctx, p, c);
    const today = usage.today.get(p.id);
    const relay = ctx.repos.relays.latest(p.id);
    costTodayUsd += today?.cost ?? 0;
    liveRuns += item.liveRuns;
    return {
      projectId: p.id, name: p.name, path: p.path, open: item.open, color: p.color, scene: p.scene,
      agents: ctx.repos.agents.list(p.id).map((a) => {
        const v = agentView(ctx, a);
        return { id: a.id, name: a.name, model: v.current_model, status: v.status, color: a.color, isBoss: a.is_boss === 1 };
      }),
      liveRuns: item.liveRuns, queued: item.queued, needsYou: item.needsYou, approvalsPending: item.approvalsPending,
      tasksByStatus: item.tasksByStatus,
      costTodayUsd: today?.cost ?? 0,
      costTotalUsd: usage.total.get(p.id) ?? 0,
      tokensToday: { input: today?.input ?? 0, output: today?.output ?? 0, cacheRead: today?.cacheRead ?? 0, cacheWrite: today?.cacheWrite ?? 0 },
      lastActivityAt: activity.get(p.id) ?? null,
      ...(relay ? { lastRelay: relayView(relay) } : {}),
    };
  });
  return {
    workspaces,
    totals: { costTodayUsd, liveRuns, queued: ctx.queue.length, maxConcurrentRuns: maxConcurrentRuns(ctx), dailyBudgetUsd: dailyBudgetUsd(ctx) },
  };
}

/** `workspaces.changed` con el resumen actual, como mucho una vez por segundo (con envío final diferido y sin repetir lo igual). */
export function scheduleWorkspacesNotify(ctx: Ctx): void {
  if (ctx.workspacesTimer || ctx.closed) return;
  const wait = Math.max(0, NOTIFY_MS - (Date.now() - ctx.workspacesLastNotify));
  ctx.workspacesTimer = setTimeout(() => {
    ctx.workspacesTimer = null;
    ctx.workspacesLastNotify = Date.now();
    if (ctx.closed) return;
    try {
      const overview = buildOverview(ctx);
      const json = JSON.stringify(overview);
      if (lastSent.get(ctx) === json) return;
      lastSent.set(ctx, json);
      ctx.emit('workspaces.changed', overview);
    } catch (e) {
      process.stderr.write(`workspaces.changed: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }, wait);
  ctx.workspacesTimer.unref();
}

export function workspaceHandlers(ctx: Ctx): Record<string, Handler> {
  return {
    /** Sin parámetros -> WorkspaceOverview. */
    'workspaces.overview': () => buildOverview(ctx),
  };
}
