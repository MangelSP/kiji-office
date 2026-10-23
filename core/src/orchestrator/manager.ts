// Handlers del gerente (0.2d, D24): manager.get / set / tick / stopAll / resume / diary y la parada global (`ctx.halted`).
import type { ManagerDiaryEntry, ManagerState } from '../../../shared/protocol.js';
import { denyManagerAsks, managerCostToday, actionView, readPolicy, recordAction, tickView, validatePolicy } from '../manager/policy.js';
import { type Ctx, type Handler, asParams, projectIdOf, requireProject } from './context.js';
import { dequeue, pumpQueue } from './queue.js';
import { clearResumeTimers, rescheduleResumes } from './relay.js';
import { stopTask } from './runs.js';
import { scheduleWorkspacesNotify } from './workspaces.js';

const HALT_KEY = 'manager_halted';

export function managerState(ctx: Ctx, projectId: string): ManagerState {
  const last = ctx.repos.managerTicks.latest(projectId);
  return {
    projectId,
    policy: readPolicy(ctx, projectId),
    halted: ctx.halted,
    running: ctx.manager?.isRunning(projectId) ?? false,
    lastTick: last ? tickView(last) : null,
    todayCostUsd: Number(managerCostToday(ctx, projectId).toFixed(4)),
  };
}

/** Una línea en el diario de cada proyecto abierto (tick de mentira, sin coste ni modelo). */
function journal(ctx: Ctx, label: 'halt' | 'resume', summary: string): void {
  for (const projectId of ctx.projects.keys()) {
    const tick = ctx.repos.managerTicks.create({ projectId, trigger: label });
    const live = [...ctx.live.values()].filter((l) => l.projectId === projectId).length;
    recordAction(ctx, {
      tickId: tick.id, projectId, tool: label === 'halt' ? 'stopAll' : 'resume',
      input: {}, result: { ok: true, message: summary, ...(label === 'halt' ? { runsStopped: live } : {}) }, level: 'auto', decidedBy: 'user',
    });
    const ended = ctx.repos.managerTicks.end(tick.id, { summary, costUsd: 0 })!;
    ctx.emit('manager.tick', { projectId, phase: 'ended', tick: tickView(ended) });
  }
}

/** Parada global: nada arranca, el gerente calla, los runs vivos paran (tareas a `assigned`, proyectos abiertos). */
export async function haltAll(ctx: Ctx): Promise<{ halted: boolean }> {
  if (ctx.halted) return { halted: true };
  ctx.halted = true;
  ctx.repos.settings.set(HALT_KEY, '1');
  for (const e of [...ctx.queue]) dequeue(ctx, e.taskId);
  clearResumeTimers(ctx);
  if (ctx.budgetTimer) clearTimeout(ctx.budgetTimer);
  ctx.budgetTimer = null;
  await ctx.manager?.halt();
  const denied = denyManagerAsks(ctx, 'Parada global: se da por NO.');
  const lives = [...ctx.live.values()];
  for (const l of lives) l.onEnded = null; // un relevo pendiente no debe relanzar nada
  await Promise.allSettled(lives.map(async (l) => {
    if (l.finishing || l.ended) return void (await l.finished.catch(() => undefined));
    await stopTask(ctx, l.taskId, 'parada global', { pump: false });
  }));
  journal(ctx, 'halt', `Parada global: ${lives.length} run(s) parados${denied ? `, ${denied} pregunta(s) denegadas` : ''}.`);
  ctx.emit('manager.halted', { halted: true });
  scheduleWorkspacesNotify(ctx);
  return { halted: true };
}

export function resumeAll(ctx: Ctx): { halted: boolean } {
  if (!ctx.halted) return { halted: false };
  ctx.halted = false;
  ctx.repos.settings.set(HALT_KEY, '0');
  ctx.manager?.resume();
  for (const p of ctx.projects.values()) rescheduleResumes(ctx, p);
  journal(ctx, 'resume', 'Parada global quitada: todo vuelve a funcionar.');
  ctx.emit('manager.halted', { halted: false });
  void pumpQueue(ctx);
  scheduleWorkspacesNotify(ctx);
  return { halted: false };
}

export function managerHandlers(ctx: Ctx): Record<string, Handler> {
  return {
    /** `{projectId?}` -> ManagerState */
    'manager.get': (params) => {
      const p = params == null ? {} : asParams(params, 'manager.get');
      return managerState(ctx, requireProject(ctx, projectIdOf(p)).id);
    },
    /** `{projectId?, policy}`: valida (claves exactas, rangos, cerebro del proyecto) y guarda. */
    'manager.set': (params) => {
      const p = asParams(params, 'manager.set');
      const project = requireProject(ctx, projectIdOf(p));
      const policy = validatePolicy(ctx, project.id, p.policy);
      ctx.projects.set(project.id, ctx.repos.projects.setManagerPolicy(project.id, JSON.stringify(policy)));
      ctx.manager?.syncProject(project.id);
      return managerState(ctx, project.id);
    },
    /** `{projectId?, message?}` -> `{tickId}`: «Habla con el gerente». */
    'manager.tick': (params) => {
      const p = asParams(params, 'manager.tick');
      const project = requireProject(ctx, projectIdOf(p));
      if (p.message !== undefined && typeof p.message !== 'string') throw new Error('manager.tick: "message" debe ser texto');
      if (!ctx.manager) throw new Error('manager.tick: el gerente no está disponible');
      return { tickId: ctx.manager.manualTick(project.id, p.message as string | undefined) };
    },
    'manager.stopAll': () => haltAll(ctx),
    'manager.resume': () => resumeAll(ctx),
    /** `{projectId?, limit?}` -> ManagerDiaryEntry[] (el tick más nuevo primero, con sus acciones). */
    'manager.diary': (params) => {
      const p = params == null ? {} : asParams(params, 'manager.diary');
      const project = requireProject(ctx, projectIdOf(p));
      const limit = typeof p.limit === 'number' && p.limit >= 1 ? Math.min(Math.floor(p.limit), 200) : 50;
      return ctx.repos.managerTicks.list(project.id, limit).map((t): ManagerDiaryEntry => ({
        ...tickView(t), actions: ctx.repos.managerActions.listByTick(t.id).map(actionView),
      }));
    },
  };
}

