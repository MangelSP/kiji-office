// Tareas: máquina de estados (PLAN D4) y handlers task.create / list / assign. task.start / stop están en runs.ts.
import { posix } from 'node:path';
import type { ToolStep } from '../../../shared/protocol.js';
import { FileClaimError, type EventRow, type ObjectiveRow, type ProjectRow, type TaskRow, type TaskStatus } from '../db/repos.js';
import { type Ctx, type Handler, asParams, assertSameProject, optionalProject, projectIdOf, requireProject, str } from './context.js';
import { logEvent } from './events.js';
import { contextPct } from './metrics.js';
import { notify } from './notifications.js';
import { refreshObjective } from './objectives.js';
import { queuePosition } from './queue.js';
import { scheduleWorkspacesNotify } from './workspaces.js';

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

/** Tope de caracteres de `result` en `task.list` / `task.changed`. */
export const MAX_RESULT_CHARS = 20_000;

/** Una tarea sin ninguna fila en `task_files` (ni activa ni liberada) es de solo lectura ("consulta"). */
export function isReadOnlyTask(ctx: Ctx, taskId: string): boolean {
  return ctx.repos.taskFiles.list(taskId).length === 0;
}

export type TaskView = TaskRow & {
  /** Proyecto al que pertenece (0.2c). */
  projectId: string;
  /** En la cola global esperando hueco (0.2c, C3); la tarea conserva su estado (`assigned`, `paused_limit`...). */
  queued: boolean;
  /** Posición en la cola, 1-based; null si no está en cola. */
  queue_position: number | null;
  files: string[];
  read_only: boolean;
  result: string | null;
  /** Modelo del último run (o el del run vivo); si aún no hay runs, el preferido del agente. */
  model: string | null;
  /** Gasto de todos los runs de la tarea. */
  cost_usd: number;
  /** Contexto usado del último run, en % (0..100). */
  context_pct: number;
  /** Llamadas a herramientas del último run. */
  steps_count: number;
};

/**
 * Fila de tarea tal como viaja a la UI: columnas de la BD + `files` (rutas que posee), `read_only`, `result`
 * (respuesta final) y, desde 0.2a, `model`, `cost_usd`, `context_pct` y `steps_count`.
 */
export function taskView(ctx: Ctx, task: TaskRow): TaskView {
  const files = ctx.repos.taskFiles.list(task.id).map((f) => f.path);
  const live = ctx.live.get(task.id);
  const last = ctx.repos.runs.latestByTask(task.id);
  const agent = task.agent_id ? ctx.repos.agents.get(task.agent_id) : undefined;
  const tokens = live && live.runId === last?.id ? live.usage.contextTokens : (last?.context_tokens ?? 0);
  const window = live && live.runId === last?.id ? live.usage.contextWindow : (last?.context_window ?? 0);
  const position = queuePosition(ctx, task.id);
  return {
    ...task,
    projectId: ctx.repos.objectives.get(task.objective_id)?.project_id ?? '',
    queued: position !== null,
    queue_position: position,
    files,
    read_only: files.length === 0,
    result: ctx.repos.events.lastDoneText(task.id)?.slice(0, MAX_RESULT_CHARS) ?? null,
    model: live?.model ?? last?.model ?? agent?.model ?? null,
    cost_usd: ctx.repos.runs.costByTask(task.id),
    context_pct: contextPct(tokens, window),
    steps_count: last ? ctx.repos.events.countToolStarts(last.id) : 0,
  };
}

const TARGET_MAX = 80;
const DENIED_OUTPUT = /^(Acción prohibida|No puedes modificar|El usuario denegó|Run detenido|Cancelado|Este agente es de solo lectura)/;

/** Objetivo de una llamada a herramienta para mostrarlo en la cronología (archivo, ruta, comando o patrón), recortado. */
export function stepTarget(input: unknown): string {
  if (input === null || typeof input !== 'object') return '';
  const i = input as Record<string, unknown>;
  for (const k of ['file_path', 'path', 'notebook_path', 'command', 'pattern', 'url']) {
    const v = i[k];
    if (typeof v === 'string' && v.trim() !== '') {
      const t = v.replace(/\s+/g, ' ').trim();
      return t.length > TARGET_MAX ? `${t.slice(0, TARGET_MAX - 1)}…` : t;
    }
  }
  return '';
}

/** Cronología de herramientas de un run a partir de sus eventos `tool` (cada `end` cierra el `start` abierto más antiguo del mismo nombre). */
export function buildSteps(rows: EventRow[]): ToolStep[] {
  const steps: ToolStep[] = [];
  const open: number[] = [];
  for (const row of rows) {
    let p: { name?: string; status?: string; input?: unknown; output?: unknown; is_error?: boolean };
    try {
      p = JSON.parse(row.payload);
    } catch {
      continue;
    }
    const name = typeof p.name === 'string' ? p.name : 'unknown';
    if (p.status === 'start') {
      steps.push({ name, target: stepTarget(p.input), ok: null, startedAt: row.created_at, endedAt: null });
      open.push(steps.length - 1);
    } else if (p.status === 'end') {
      let at = open.findIndex((i) => steps[i]!.name === name);
      if (at === -1 && name === 'unknown' && open.length > 0) at = 0;
      if (at === -1) continue;
      const step = steps[open[at]!]!;
      open.splice(at, 1);
      step.endedAt = row.created_at;
      step.ok = !(p.is_error === true || (typeof p.output === 'string' && DENIED_OUTPUT.test(p.output)));
    }
  }
  return steps;
}

/** Emite `task.changed` con la fila completa actual. */
export function publishTask(ctx: Ctx, taskId: string): TaskView {
  const task = ctx.repos.tasks.get(taskId);
  if (!task) throw new Error(`tarea inexistente: ${taskId}`);
  const view = taskView(ctx, task);
  ctx.emit('task.changed', view);
  refreshObjective(ctx, task.objective_id); // estado del objetivo + `objective.changed` con los contadores nuevos
  scheduleWorkspacesNotify(ctx);
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
): TaskView {
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
    if (to === 'review') {
      const project = projectOfTask(ctx, task);
      notify(ctx, { projectId: project.id, level: 'info', title: `Clau terminó: «${task.title}»`, body: 'Lista para revisar.' });
    }
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

export function checkAssignable(ctx: Ctx, project: ProjectRow, agentId: string) {
  const agent = ctx.repos.agents.get(agentId);
  if (!agent || agent.project_id !== project.id) throw new Error(`agente inexistente en este proyecto: ${agentId}`);
  if (agent.is_boss === 1) throw new Error('el jefe planea y revisa, no ejecuta tareas: asigna un trabajador');
  return agent;
}

const MAX_FINDINGS = 50;
const FINDING_MAX = 2000;

/**
 * Guarda los hallazgos de una revisión como evento `git` (`finding`), que el prompt del siguiente run recoge
 * (`buildPrompt` en runs.ts). Devuelve el texto guardado.
 */
export function recordFinding(ctx: Ctx, task: TaskRow, finding: string, message: string): void {
  logEvent(ctx, {
    projectId: projectOfTask(ctx, task).id, kind: 'git', taskId: task.id, agentId: task.agent_id,
    payload: { finding, task_id: task.id, message },
  });
}

/** Veredicto sobre una tarea en `review` (lo llama `task.review`: la persona o el gerente). */
export function reviewTask(ctx: Ctx, taskId: string, verdict: 'approve' | 'changes', findings: string[] = []): TaskView {
  const task = getTask(ctx, taskId);
  if (task.status !== 'review') throw new Error(`task.review: la tarea está en ${task.status}; solo se revisan las que están en review`);
  if (verdict === 'approve') return transition(ctx, taskId, 'approved', 'aprobada');
  const list = findings.map((f) => f.trim()).filter((f) => f !== '').slice(0, MAX_FINDINGS).map((f) => f.slice(0, FINDING_MAX));
  const message = list.length === 0 ? 'Se pidieron cambios sin más detalle.' : list.length === 1 ? list[0]! : list.map((f) => `- ${f}`).join('\n');
  recordFinding(ctx, task, 'review', message);
  return transition(ctx, taskId, 'changes', list.length === 0 ? 'cambios pedidos' : `cambios pedidos: ${list.length} hallazgo(s)`);
}

export function taskHandlers(ctx: Ctx): Record<string, Handler> {
  return {
    /** `{projectId?}` */
    'task.list': (params) => {
      const project = optionalProject(ctx, projectIdOf(params == null ? {} : asParams(params, 'task.list')));
      if (!project) return [];
      return ctx.repos.tasks.listByProject(project.id).map((t) => taskView(ctx, t));
    },

    /** `{taskId}` -> cronología de herramientas del último run. */
    'task.steps': (params) => {
      const p = asParams(params, 'task.steps');
      const task = getTask(ctx, str(p.taskId, 'taskId', 'task.steps'));
      assertSameProject(p, projectOfTask(ctx, task).id, 'task.steps');
      const last = ctx.repos.runs.latestByTask(task.id);
      return last ? buildSteps(ctx.repos.events.listByRun(last.id, 'tool')) : [];
    },

    'task.create': (params) => {
      const p = asParams(params, 'task.create');
      const project = requireProject(ctx, projectIdOf(p));
      const title = str(p.title, 'title', 'task.create').trim();
      const description = typeof p.description === 'string' ? p.description : '';
      // Sin `files` (ausente o vacío) la tarea es de solo lectura: no reserva archivos.
      if (p.files != null && !Array.isArray(p.files)) throw new Error('task.create: "files" debe ser una lista de rutas');
      const files = [...new Set(((p.files as unknown[] | undefined) ?? []).map(normalizeTaskPath))];
      const agentId = typeof p.agent_id === 'string' && p.agent_id !== '' ? p.agent_id : null;
      if (agentId) checkAssignable(ctx, project, agentId);
      // 0.2d: `objectiveId` opcional (debe ser de este proyecto); sin él, el objetivo implícito "Tareas sueltas".
      let objectiveId: string | null = null;
      if (p.objectiveId != null && p.objectiveId !== '') {
        const objective = ctx.repos.objectives.get(str(p.objectiveId, 'objectiveId', 'task.create'));
        if (!objective || objective.project_id !== project.id) throw new Error(`task.create: el objetivo ${String(p.objectiveId)} no existe en este proyecto`);
        objectiveId = objective.id;
      }

      // Tarea + reserva de archivos en una transacción: si hay conflicto no queda nada creado.
      ctx.db.exec('BEGIN IMMEDIATE');
      let created: TaskRow;
      try {
        created = ctx.repos.tasks.create({
          objectiveId: objectiveId ?? looseObjective(ctx, project).id,
          title,
          description,
          agentId,
          status: agentId ? 'assigned' : 'todo',
        });
        if (files.length > 0) ctx.repos.taskFiles.claim(created.id, files);
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

    /** `{id, projectId?, verdict: 'approve' | 'changes', findings?: string[]}` sobre una tarea en `review`. */
    'task.review': (params) => {
      const p = asParams(params, 'task.review');
      const task = getTask(ctx, str(p.id, 'id', 'task.review'));
      assertSameProject(p, projectOfTask(ctx, task).id, 'task.review');
      if (p.verdict !== 'approve' && p.verdict !== 'changes') throw new Error('task.review: "verdict" debe ser "approve" o "changes"');
      if (p.findings != null && (!Array.isArray(p.findings) || !p.findings.every((f) => typeof f === 'string'))) {
        throw new Error('task.review: "findings" debe ser una lista de textos');
      }
      return reviewTask(ctx, task.id, p.verdict, (p.findings as string[] | undefined) ?? []);
    },

    'task.assign': (params) => {
      const p = asParams(params, 'task.assign');
      const task = getTask(ctx, str(p.id, 'id', 'task.assign'));
      const project = projectOfTask(ctx, task);
      assertSameProject(p, project.id, 'task.assign');
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
