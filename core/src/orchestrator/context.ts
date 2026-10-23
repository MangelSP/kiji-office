// Estado compartido del orquestador: una sola instancia por proceso del core (un proyecto activo a la vez en 0.1).
import type { DatabaseSync } from 'node:sqlite';
import type { LimitWindow, LimitWindowType, ProviderStatus } from '../../../shared/protocol.js';
import type { AgentAdapter } from '../adapters/types.js';
import type { AgentRow, ProjectRow, Repos } from '../db/repos.js';

/** Consumo acumulado de un run en memoria (D8); la fila de `runs` se actualiza con límite de frecuencia. */
export interface RunUsageState {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  contextTokens: number;
  contextWindow: number;
  costUsd: number;
  /** Ya llegó algún evento `usage` (si no, al cerrar se usa el `usage` del `done`, como en 0.1). */
  seen: boolean;
  lastWrite: number;
  lastNotify: number;
  notifyTimer: NodeJS.Timeout | null;
}

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
  /** Modelo con el que corre este run (puede ser un relevo; el preferido del agente no cambia). */
  model: string;
  /** Sesión del SDK, en cuanto el adaptador la conoce (para reanudar con otro modelo). */
  sessionId: string | null;
  usage: RunUsageState;
  /** Se ejecuta cuando el run ya salió de `ctx.live` (p. ej. el relanzamiento tras un relevo). */
  onEnded: (() => Promise<void>) | null;
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
  // --- 0.2a ---
  /** Último estado de cupo visto por ventana (D9); se copia en `settings.limits_snapshot`. */
  limits: Map<LimitWindowType, LimitWindow>;
  /** Reanudación automática al reset, por tarea (D10). */
  resumeTimers: Map<string, NodeJS.Timeout>;
  /** Carpeta de skills del usuario (por defecto ~/.claude/skills). */
  skillsDir: string;
  /** Frecuencia máxima de `run.metrics` por run y de escritura de métricas en la BD (D8). */
  metricsNotifyMs: number;
  metricsWriteMs: number;
  /** `providers.status`: lo asigna el módulo de proveedores (hace falta para `limits.changed`). */
  providerStatus: (() => Promise<ProviderStatus[]>) | null;
  limitsNotifyTimer: NodeJS.Timeout | null;
  limitsLastNotify: number;
  /** El core se está apagando: no se programan más avisos ni reanudaciones. */
  closed: boolean;
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
