// Estado compartido del orquestador: una sola instancia por proceso del core, con varios proyectos abiertos a la vez (0.2c).
import type { DatabaseSync } from 'node:sqlite';
import type { LimitWindow, LimitWindowType, ProviderStatus } from '../../../shared/protocol.js';
import type { AgentAdapter } from '../adapters/types.js';
import type { AgentRow, ProjectRow, Repos } from '../db/repos.js';
import type { StartOptions } from './runs.js';

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
  /**
   * Con `resume`, el `result` del SDK trae `total_cost_usd` y `modelUsage` ACUMULADOS de toda la sesión (medido en 0.2b):
   * aquí van los totales de los runs anteriores de la misma sesión, que se restan para guardar solo lo de este run.
   */
  baseline: { input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number };
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

/** Tarea esperando un hueco en la cola global (0.2c, C3). */
export interface QueueEntry {
  taskId: string;
  projectId: string;
  opts: StartOptions;
  /** Quién la pidió: la persona (`start`), un relevo de modelo o la reanudación al reset. */
  reason: 'start' | 'relay' | 'resume';
  /** Qué la retiene ahora mismo. */
  blockedBy: 'slots' | 'budget';
  queuedAt: number;
  /** Última posición|motivo anunciados con `queue.changed` (para no repetir avisos). */
  announced?: string;
  /** Se llama cuando el run ya arrancó (p. ej. registrar el relevo). */
  onStarted?: () => void;
  /** Se llama si al llegar su turno falla el arranque. */
  onFailed?: (err: unknown) => void;
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
  /** Proyectos abiertos (workspaces) por id. */
  projects: Map<string, ProjectRow>;
  /** Último proyecto abierto: respaldo cuando una petición no trae `projectId` (transición de la UI de 0.2a). */
  lastProjectId: string | null;
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
  // --- 0.2c ---
  /** Cola global de arranques (FIFO). */
  queue: QueueEntry[];
  pumping: boolean;
  pumpAgain: boolean;
  /** Reintento de la cola a medianoche local cuando hay tareas retenidas por el tope diario. */
  budgetTimer: NodeJS.Timeout | null;
  /** Último `budget.reached` emitido (para no repetirlo en cada intento). */
  budgetNoticeAt: number;
  workspacesTimer: NodeJS.Timeout | null;
  workspacesLastNotify: number;
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

/** `projectId` opcional de los parámetros de una petición (texto no vacío) o undefined. */
export function projectIdOf(params: Record<string, unknown> | null | undefined): string | undefined {
  const v = params?.projectId;
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

/**
 * Proyecto abierto al que va la petición: `projectId` si llega (debe estar abierto) o, si falta (transición:
 * la UI de 0.2a no lo manda), el último abierto.
 */
export function requireProject(ctx: Ctx, projectId?: string): ProjectRow {
  if (projectId !== undefined) {
    const p = ctx.projects.get(projectId);
    if (!p) throw new Error(`el proyecto ${projectId} no está abierto: llama antes a project.open`);
    return p;
  }
  const last = ctx.lastProjectId ? ctx.projects.get(ctx.lastProjectId) : undefined;
  if (!last) throw new Error('no hay un proyecto abierto: llama antes a project.open');
  return last;
}

/** Como `requireProject`, pero devuelve null si no hay proyecto (listados que responden vacío sin proyecto). */
export function optionalProject(ctx: Ctx, projectId?: string): ProjectRow | null {
  if (projectId === undefined && !ctx.lastProjectId) return null;
  return requireProject(ctx, projectId);
}

/** Falla si la petición trae un `projectId` distinto del proyecto al que pertenece el recurso (tarea, agente...). */
export function assertSameProject(params: Record<string, unknown>, actualProjectId: string, method: string): void {
  const given = projectIdOf(params);
  if (given !== undefined && given !== actualProjectId) throw new Error(`${method}: el recurso no pertenece al proyecto ${given}`);
}

/** El proyecto abierto más reciente (para reponer `lastProjectId` al cerrar). */
export function mostRecentOpen(ctx: Ctx): string | null {
  let best: ProjectRow | null = null;
  for (const p of ctx.projects.values()) if (!best || (p.last_opened_at ?? 0) >= (best.last_opened_at ?? 0)) best = p;
  return best?.id ?? null;
}
