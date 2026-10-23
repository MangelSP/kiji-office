// Tareas: máquina de estados (PLAN D4) y handlers task.create / list / assign. task.start / stop están en runs.ts.
import { posix } from 'node:path';
import { FileClaimError, type ObjectiveRow, type ProjectRow, type TaskRow, type TaskStatus } from '../db/repos.js';
import { type Ctx, type Handler, asParams, requireProject, str } from './context.js';
import { logEvent } from './events.js';

/**
 * Transiciones permitidas. Todo lo que no figure aquí se rechaza.
 *  - `todo -> assigned`: tiene agente. `assigned -> running`: task.start.
 *  - `running <-> needs_you`: el agente espera un clic y vuelve al contestar.
 *  - `running -> review | changes | failed | paused_limit | blocked | assigned`: fin del run, límite, reinicio del core, task.stop.
 *  - `review -> approved | changes`: el jefe (paso 12); `approved -> integrated | changes | blocked` (integración, rebase con conflicto).
 *  - `changes | paused_limit | blocked | failed -> running`: nuevo run (reutiliza el worktree); `-> assigned`: parada o reasignación.
 *  - `integrated` es final.
 */
export const TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  todo: ['assigned'],
  assigned: ['running'],
  running: ['needs_you', 'review', 'changes', 'failed', 'paused_limit', 'blocked', 'assigned'],
  needs_you: ['running', 'failed', 'paused_limit', 'blocked', 'assigned'],
  review: ['approved', 'changes', 'blocked'],
  changes: ['running', 'assigned'],
  approved: ['integrated', 'changes', 'blocked'],
  integrated: [],
  blocked: ['running', 'assigned'],
  failed: ['running', 'assigned'],
  paused_limit: ['running', 'assigned'],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Fila de tarea tal como viaja a la UI: columnas de la BD + `files` (rutas que posee). */
export function taskView(ctx: Ctx, task: TaskRow): TaskRow & { files: string[] } {
  return { ...task, files: ctx.repos.taskFiles.list(task.id).map((f) => f.path) };
}

/** Emite `task.changed` con la fila completa actual. */
export function publishTask(ctx: Ctx, taskId: string): TaskRow & { files: string[] } {
  const task = ctx.repos.tasks.get(taskId);
  if (!task) throw new Error(`tarea inexistente: ${taskId}`);
  const view = taskView(ctx, task);
  ctx.emit('task.changed', view);
  return view;
}

export function getTask(ctx: Ctx, id: string): TaskRow {
  const task = ctx.repos.tasks.get(id);
  if (!task) throw new Error(`tarea inexistente: ${id}`);
  return task;
}

export function projectOfTask(ctx: Ctx, task: TaskRow): ProjectRow {
  const objective = ctx.repos.objectives.get(task.objective_id);
  const project = objective && ctx.repos.projects.get(objective.project_id);
  if (!project) throw new Error(`la tarea ${task.id} no pertenece a ningún proyecto`);
  return project;
}

/**
 * Cambia el estado validando la transición, deja constancia en `events` (kind `status`) y emite `task.changed`.
 * `patch` aplica a la vez otros campos de la tarea (rama, worktree...). Pasar al mismo estado solo aplica `patch`.
 */
export function transition(
  ctx: Ctx,
  taskId: string,
  to: TaskStatus,
  reason?: string,
  patch: Partial<Pick<TaskRow, 'branch' | 'worktree_path' | 'agent_id'>> = {},
): TaskRow & { files: string[] } {
  const task = getTask(ctx, taskId);
  const from = task.status;
  if (from !== to) {
    if (!canTransition(from, to)) throw new Error(`transición de tarea no válida: ${from} -> ${to}`);
    ctx.repos.tasks.update(taskId, { ...patch, status: to });
    logEvent(ctx, {
      projectId: projectOfTask(ctx, task).id,
      kind: 'status',
      taskId,
      agentId: task.agent_id,
      payload: { task_id: taskId, from, to, ...(reason ? { reason } : {}) },
    });
  } else if (Object.keys(patch).length > 0) {
    ctx.repos.tasks.update(taskId, patch);
  }
  return publishTask(ctx, taskId);
}

const LOOSE_OBJECTIVE = 'Tareas sueltas';

/** Objetivo implícito para las tareas creadas a mano (el esquema exige `objective_id`). */
function looseObjective(ctx: Ctx, project: ProjectRow): ObjectiveRow {
  const found = ctx.repos.objectives.list(project.id).find((o) => o.text === LOOSE_OBJECTIVE);
  return found ?? ctx.repos.objectives.create({ projectId: project.id, text: LOOSE_OBJECTIVE, status: 'active' });
}

/** Normaliza una ruta de archivo permitido: relativa al repo, con `/`, sin `..` ni zonas internas de git/kiji. */
export function normalizeTaskPath(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '' || raw.includes('\0')) throw new Error(`ruta de archivo no válida: ${JSON.stringify(raw)}`);
  const p = posix.normalize(raw.trim().replace(/\\/g, '/')).replace(/\/+$/, '');
  if (p === '' || p === '.' || p.startsWith('/') || /^[A-Za-z]:/.test(p) || p === '..' || p.startsWith('../')) {
    throw new Error(`la ruta debe ser relativa al repositorio y quedar dentro de él: ${raw}`);
  }
  if (p === '.git' || p.startsWith('.git/') || p === '.kiji' || p.startsWith('.kiji/')) {
    throw new Error(`la ruta no puede apuntar a .git ni .kiji: ${raw}`);
  }
  return p;
}

function checkAssignable(ctx: Ctx, project: ProjectRow, agentId: string) {
  const agent = ctx.repos.agents.get(agentId);
  if (!agent || agent.project_id !== project.id) throw new Error(`agente inexistente en este proyecto: ${agentId}`);
  if (agent.is_boss === 1) throw new Error('el jefe planea y revisa, no ejecuta tareas: asigna un trabajador');
  return agent;
}

export function taskHandlers(ctx: Ctx): Record<string, Handler> {
  return {
    'task.list': () => {
      if (!ctx.activeProject) return [];
      return ctx.repos.tasks.listByProject(ctx.activeProject.id).map((t) => taskView(ctx, t));
    },

    'task.create': (params) => {
      const p = asParams(params, 'task.create');
      const project = requireProject(ctx);
      const title = str(p.title, 'title', 'task.create').trim();
      const description = typeof p.description === 'string' ? p.description : '';
      if (!Array.isArray(p.files) || p.files.length === 0) {
        throw new Error('task.create: indica al menos un archivo que la tarea puede modificar (files)');
      }
      const files = [...new Set(p.files.map(normalizeTaskPath))];
      const agentId = typeof p.agent_id === 'string' && p.agent_id !== '' ? p.agent_id : null;
      if (agentId) checkAssignable(ctx, project, agentId);

      // Tarea + reserva de archivos en una transacción: si hay conflicto no queda nada creado.
      ctx.db.exec('BEGIN IMMEDIATE');
      let created: TaskRow;
      try {
        created = ctx.repos.tasks.create({
          objectiveId: looseObjective(ctx, project).id,
          title,
          description,
          agentId,
          status: agentId ? 'assigned' : 'todo',
        });
        ctx.repos.taskFiles.claim(created.id, files);
        ctx.db.exec('COMMIT');
      } catch (err) {
        ctx.db.exec('ROLLBACK');
        if (err instanceof FileClaimError) {
          const detail = err.conflicts
            .map((c) => `${c.path} (tarea «${ctx.repos.tasks.get(c.taskId)?.title ?? c.taskId}»)`)
            .join(', ');
          throw new Error(`archivos ya reservados por otra tarea activa: ${detail}`);
        }
        throw err;
      }
      return publishTask(ctx, created.id);
    },

    'task.assign': (params) => {
      const p = asParams(params, 'task.assign');
      const task = getTask(ctx, str(p.id, 'id', 'task.assign'));
      const project = projectOfTask(ctx, task);
      checkAssignable(ctx, project, str(p.agent_id, 'agent_id', 'task.assign'));
      if (ctx.live.has(task.id) || task.status === 'running' || task.status === 'needs_you') {
        throw new Error('no se puede reasignar una tarea mientras se ejecuta: páralas antes (task.stop)');
      }
      if (task.status === 'review' || task.status === 'approved' || task.status === 'integrated') {
        throw new Error(`no se puede reasignar una tarea en estado ${task.status}`);
      }
      const agent_id = p.agent_id as string;
      // todo -> assigned; en los demás estados (changes, blocked...) solo cambia el agente.
      return transition(ctx, task.id, task.status === 'todo' ? 'assigned' : task.status, 'reasignada', { agent_id });
    },
  };
}
