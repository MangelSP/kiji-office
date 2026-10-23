// Objetivos (0.2d, hito 3): objective.create / objective.list y el evento objective.changed.
import type { ObjectiveView } from '../../../shared/protocol.js';
import type { ObjectiveRow } from '../db/repos.js';
import { type Ctx, type Handler, asParams, optionalProject, projectIdOf, requireProject, str } from './context.js';

export const OBJECTIVE_TEXT_MAX = 4000;

export function objectiveView(ctx: Ctx, o: ObjectiveRow): ObjectiveView {
  const tasksByStatus: Record<string, number> = {};
  for (const t of ctx.repos.tasks.listByObjective(o.id)) tasksByStatus[t.status] = (tasksByStatus[t.status] ?? 0) + 1;
  return { id: o.id, projectId: o.project_id, text: o.text, status: o.status, createdAt: o.created_at, tasksByStatus };
}

/** Emite `objective.changed` con el objetivo completo actual (contadores incluidos). */
export function publishObjective(ctx: Ctx, objectiveId: string): ObjectiveView | null {
  const o = ctx.repos.objectives.get(objectiveId);
  if (!o) return null;
  const view = objectiveView(ctx, o);
  ctx.emit('objective.changed', view);
  return view;
}

/** Crea un objetivo en `planning` (lo usan `objective.create` y el gerente). */
export function createObjective(ctx: Ctx, projectId: string, text: string): ObjectiveView {
  const t = text.trim();
  if (t.length > OBJECTIVE_TEXT_MAX) throw new Error(`el objetivo supera ${OBJECTIVE_TEXT_MAX} caracteres`);
  const o = ctx.repos.objectives.create({ projectId, text: t, status: 'planning' });
  return publishObjective(ctx, o.id)!;
}

/**
 * Ajusta el estado del objetivo según sus tareas: `planning -> active` al tener alguna tarea sin integrar; `done` cuando
 * todas están integradas (y vuelve a `active` si llega otra). Los objetivos "Tareas sueltas" también pasan por aquí. Emite `objective.changed` si cambia algo.
 */
export function refreshObjective(ctx: Ctx, objectiveId: string): void {
  const o = ctx.repos.objectives.get(objectiveId);
  if (!o) return;
  const tasks = ctx.repos.tasks.listByObjective(o.id);
  if (tasks.length > 0) {
    const allDone = tasks.every((t) => t.status === 'integrated');
    if (allDone && o.status !== 'done') ctx.repos.objectives.setStatus(o.id, 'done');
    else if (!allDone && o.status !== 'active') ctx.repos.objectives.setStatus(o.id, 'active'); // planning -> active; done -> active si llega otra tarea
  }
  publishObjective(ctx, o.id);
}

export function objectiveHandlers(ctx: Ctx): Record<string, Handler> {
  return {
    /** `{projectId?, text}` -> ObjectiveView (estado `planning`). */
    'objective.create': (params) => {
      const p = asParams(params, 'objective.create');
      const project = requireProject(ctx, projectIdOf(p));
      return createObjective(ctx, project.id, str(p.text, 'text', 'objective.create'));
    },
    /** `{projectId?}` -> ObjectiveView[] (el más antiguo primero). Sin proyecto abierto: []. */
    'objective.list': (params) => {
      const p = params == null ? {} : asParams(params, 'objective.list');
      const project = optionalProject(ctx, projectIdOf(p));
      if (!project) return [];
      return ctx.repos.objectives.list(project.id).map((o) => objectiveView(ctx, o));
    },
  };
}
