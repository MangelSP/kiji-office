// Pizarra Scrum (0.4a, PLAN-0.4-pizarra.md): columna automática de una tarea. Módulo puro (sin BD ni ctx):
// lo usan la migración 6 (relleno de tareas existentes) y el orquestador (orchestrator/board.ts).
import type { BoardColumn, BoardFlag } from '../../shared/protocol.js';

/** En orden de flujo (el mismo orden que `BoardColumn` en shared/protocol.ts, que solo lleva tipos). */
export const BOARD_COLUMNS: readonly BoardColumn[] = [
  'refinement', 'refined', 'doing_dev', 'committed', 'doing_qa', 'bug', 'fix', 'functional', 'done', 'done_prod',
];

export const BOARD_COLUMN_LABELS: Readonly<Record<BoardColumn, string>> = {
  refinement: 'Refinamiento', refined: 'Refinado', doing_dev: 'Doing (Dev)', committed: 'Committed', doing_qa: 'Doing (QA)',
  bug: 'Bug', fix: 'Fix', functional: 'Prueba funcional', done: 'Done', done_prod: 'Done producción',
};

export const isBoardColumn = (v: unknown): v is BoardColumn => typeof v === 'string' && (BOARD_COLUMNS as readonly string[]).includes(v);

/** Roles que trabajan en QA: su tarea en marcha va a Doing (QA). */
export const QA_ROLES: readonly string[] = ['tester', 'revisor-critico'];

export interface BoardTaskInput {
  status: string;
  agent_id: string | null;
  acceptance: string | null;
  branch?: string | null;
}

export interface BoardContext {
  /** Rol del agente de la tarea. */
  agentRole: string | null;
  /** La tarea reserva algún archivo (activo o liberado). */
  hasFiles: boolean;
  /** Estado anterior en esta transición (null si no se conoce: relleno de la migración, recálculo sin transición). */
  from: string | null;
  /** Columna actual (para `blocked`/`failed`/`paused_limit`, que se quedan donde estaban, y para `fix` tras `bug`). */
  current: BoardColumn | null;
  /** Hallazgos guardados de la tarea y si el último describe un fallo. */
  hasFindings: boolean;
  lastFindingIsFailure: boolean;
  /** La integración está corriendo los tests de esta tarea (fase `tests`). */
  integrationTests?: boolean;
}

/** `acceptance` solo cuenta como criterio si trae algo más que el rol que guarda el gerente (`{"role": ...}`). */
export function hasAcceptanceCriterion(acceptance: string | null): boolean {
  if (acceptance === null || acceptance.trim() === '') return false;
  try {
    const v: unknown = JSON.parse(acceptance);
    if (v === null) return false;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === 'object') return Object.entries(v).some(([k, x]) => k !== 'role' && x !== null && x !== '' && !(Array.isArray(x) && x.length === 0));
    if (typeof v === 'string') return v.trim() !== '';
    return true;
  } catch {
    return true; // texto libre
  }
}

const FAILURE_TEXT = /fall[aoóe]|error|\bbug|crash|excepci|\brot[oa]\b|rompe|no funciona|regresi/i;

/** Un hallazgo describe un fallo si lo marca (`tests_failed`, `failure: true`) o su texto habla de un fallo. */
export function findingIsFailure(payload: { finding?: unknown; failure?: unknown; message?: unknown }): boolean {
  if (payload.failure === true) return true;
  if (payload.finding === 'tests_failed') return true;
  if (payload.finding === 'review' && typeof payload.message === 'string') return FAILURE_TEXT.test(payload.message);
  return false;
}

export function boardColumnFor(task: BoardTaskInput, c: BoardContext): BoardColumn {
  const raw = task.agent_id === null || !(c.hasFiles || hasAcceptanceCriterion(task.acceptance));
  switch (task.status) {
    case 'todo':
    case 'assigned':
      return raw ? 'refinement' : 'refined';
    case 'running':
    case 'needs_you': {
      if (c.agentRole !== null && QA_ROLES.includes(c.agentRole)) return 'doing_qa';
      const afterFailure = c.from === 'changes' || c.from === 'failed' || c.current === 'bug' || c.current === 'fix';
      if (task.status === 'running' && afterFailure && c.hasFindings) return 'fix';
      if (task.status === 'needs_you' && c.current === 'fix') return 'fix';
      return 'doing_dev';
    }
    case 'review':
      return 'committed';
    case 'changes':
      return c.hasFindings && c.lastFindingIsFailure ? 'bug' : 'committed';
    case 'approved':
      return c.integrationTests ? 'doing_qa' : 'functional';
    case 'integrated':
      return c.current === 'done_prod' ? 'done_prod' : 'done';
    default: // blocked, failed, paused_limit: se quedan donde estaban
      return c.current ?? (task.branch ? 'doing_dev' : task.agent_id ? 'refined' : 'refinement');
  }
}

export function boardFlagFor(status: string): BoardFlag {
  return status === 'blocked' || status === 'failed' || status === 'paused_limit' ? status : null;
}
