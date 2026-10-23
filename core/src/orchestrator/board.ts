// Pizarra Scrum (0.4a): recálculo de la columna de cada tarea, evento `board.moved` y el método `board.move`.
import type { BoardColumn, BoardMovedEvent } from '../../../shared/protocol.js';
import { BOARD_COLUMN_LABELS, BOARD_COLUMNS, boardColumnFor, findingIsFailure, isBoardColumn } from '../board.js';
import type { TaskRow } from '../db/repos.js';
import { type Ctx, type Handler, asParams, assertSameProject, str } from './context.js';
import { logEvent } from './events.js';
import { getTask, projectOfTask, publishTask } from './tasks.js';

/** Columna que toca ahora a la tarea según su estado (sin tocar la BD). */
export function computeColumn(ctx: Ctx, task: TaskRow, from: string | null, integrationTests = false): BoardColumn {
  const findings = ctx.repos.events.findingsByTask(task.id);
  const agent = task.agent_id ? ctx.repos.agents.get(task.agent_id) : undefined;
  return boardColumnFor(task, {
    agentRole: agent?.role ?? null,
    hasFiles: ctx.repos.taskFiles.list(task.id).length > 0,
    from,
    current: task.board_column,
    hasFindings: findings.length > 0,
    lastFindingIsFailure: findings.length > 0 && findingIsFailure(findings.at(-1)!),
    integrationTests,
  });
}

function emitMoved(ctx: Ctx, task: TaskRow, from: BoardColumn | null, to: BoardColumn, auto: boolean): void {
  const projectId = projectOfTask(ctx, task).id;
  const boss = ctx.repos.agents.list(projectId).find((a) => a.is_boss === 1);
  ctx.emit('board.moved', { projectId, taskId: task.id, agentId: task.agent_id ?? boss?.id ?? null, from, to, auto } satisfies BoardMovedEvent);
}

/**
 * Recalcula la columna tras tocar la tarea. `statusFrom` = estado anterior si cambió el estado (apaga el modo manual y
 * lo deja en el registro); null si no cambió (el modo manual se respeta). `created`: primera columna (`from` = null).
 */
export function syncBoard(ctx: Ctx, taskId: string, opts: { statusFrom?: string | null; created?: boolean } = {}): void {
  const task = getTask(ctx, taskId);
  const statusChanged = opts.statusFrom !== undefined && opts.statusFrom !== null;
  if (task.board_manual === 1 && !statusChanged) return;
  const to = computeColumn(ctx, task, opts.statusFrom ?? null);
  const wasManual = task.board_manual === 1;
  if (wasManual) ctx.repos.tasks.update(taskId, { board_manual: 0 });
  if (to !== task.board_column || opts.created) ctx.repos.tasks.update(taskId, { board_column: to });
  if (wasManual) {
    logEvent(ctx, {
      projectId: projectOfTask(ctx, task).id, kind: 'status', taskId, agentId: task.agent_id,
      payload: { task_id: taskId, board_from: task.board_column, board_to: to, message: `«${task.title}» vuelve a la pizarra automática: ${BOARD_COLUMN_LABELS[to]}` },
    });
  }
  if (to !== task.board_column || opts.created) emitMoved(ctx, task, opts.created ? null : task.board_column, to, true);
}

/** La integración empieza los tests de una tarea aprobada: pasa a Doing (QA) hasta que acabe (no es un cambio de estado). */
export function markIntegrationTests(ctx: Ctx, taskId: string): void {
  const task = getTask(ctx, taskId);
  if (task.board_manual === 1) return;
  const to = computeColumn(ctx, task, null, true);
  if (to === task.board_column) return;
  ctx.repos.tasks.update(taskId, { board_column: to });
  emitMoved(ctx, task, task.board_column, to, true);
  publishTask(ctx, taskId);
}

/** Tras un intento de integración que no cambió el estado: vuelve a la columna que toca (p. ej. Prueba funcional). */
export function refreshBoard(ctx: Ctx, taskId: string): void {
  const before = getTask(ctx, taskId).board_column;
  syncBoard(ctx, taskId);
  if (getTask(ctx, taskId).board_column !== before) publishTask(ctx, taskId);
}

export function boardHandlers(ctx: Ctx): Record<string, Handler> {
  return {
    /** `{taskId, projectId?, column}`: Alexis arrastra una tarjeta. Modo manual hasta la siguiente transición de estado. */
    'board.move': (params) => {
      const p = asParams(params, 'board.move');
      const task = getTask(ctx, str(p.taskId, 'taskId', 'board.move'));
      const project = projectOfTask(ctx, task);
      assertSameProject(p, project.id, 'board.move');
      if (!isBoardColumn(p.column)) throw new Error(`board.move: columna no válida (${BOARD_COLUMNS.join(', ')})`);
      const to = p.column;
      const from = task.board_column;
      if (to === 'done_prod' && from !== 'done') throw new Error('board.move: solo se puede pasar a Done producción desde Done');
      ctx.repos.tasks.update(task.id, { board_column: to, board_manual: 1 });
      logEvent(ctx, {
        projectId: project.id, kind: 'status', taskId: task.id, agentId: task.agent_id,
        payload: {
          task_id: task.id, board_from: from, board_to: to,
          message: `Alexis movió «${task.title}» a ${BOARD_COLUMN_LABELS[to]}`,
        },
      });
      const view = publishTask(ctx, task.id);
      emitMoved(ctx, getTask(ctx, task.id), from, to, false);
      return view;
    },
  };
}
