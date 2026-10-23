// Estado compartido del orquestador: una sola instancia por proceso del core (un proyecto activo a la vez en 0.1).
import type { DatabaseSync } from 'node:sqlite';
import type { AgentAdapter } from '../adapters/types.js';
import type { AgentRow, ProjectRow, Repos } from '../db/repos.js';

/** Run en curso de una tarea (vive en memoria; la BD guarda el resto). */
export interface LiveRun {
  taskId: string;
  runId: string;
  agentId: string;
  projectId: string;
  adapter: AgentAdapter;
  worktree: string;
  /** Aprobaciones pendientes: id de la fila en `approvals` -> id que el adaptador espera en answerPermission. */
  pending: Map<string, string>;
  /** `task.stop` en curso o ya hecho: lo que siga llegando del adaptador se ignora. */
  stopping: boolean;
  /** El run ya llegó a un estado terminal (done/error/limit/stop): solo queda la limpieza. */
  ended: boolean;
  /** Tras `done` el core hace commit y tests; mientras tanto no se puede parar. */
  finishing: boolean;
  /** Se resuelve cuando el bucle de eventos y el procesado posterior han terminado. */
  finished: Promise<void>;
}

export type AdapterFactory = (agent: AgentRow) => AgentAdapter;

export interface Ctx {
  db: DatabaseSync;
  repos: Repos;
  /** Emite un evento hacia la UI (por defecto, bus.emit). */
  emit: (name: string, payload: unknown) => void;
  adapterFactory: AdapterFactory;
  /** Tiempo máximo del comando de tests del proyecto. */
  testTimeoutMs: number;
  activeProject: ProjectRow | null;
  /** Estado del robot por agente (`idle` si no consta). */
  agentStatus: Map<string, string>;
  /** Runs en curso por id de tarea. */
  live: Map<string, LiveRun>;
  /** id de aprobación (fila) -> run al que pertenece. */
  approvalIndex: Map<string, LiveRun>;
}

export type Handler = (params: unknown) => unknown | Promise<unknown>;

/** Lee un objeto de parámetros; lanza un error claro si no lo es. */
export function asParams(params: unknown, method: string): Record<string, unknown> {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    throw new Error(`${method}: se esperaba un objeto de parámetros`);
  }
  return params as Record<string, unknown>;
}

export function str(value: unknown, field: string, method: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${method}: falta "${field}" (texto)`);
  return value;
}

export function requireProject(ctx: Ctx): ProjectRow {
  if (!ctx.activeProject) throw new Error('no hay un proyecto abierto: llama antes a project.open');
  return ctx.activeProject;
}
