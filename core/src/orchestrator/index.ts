// Orquestador: tareas, runs, aprobaciones y agentes sobre la BD y los adaptadores.
// `createOrchestrator` no toca stdio: recibe la BD, el emisor de eventos y la fábrica de adaptadores (inyectable
// para las pruebas), y devuelve los handlers que `core/src/index.ts` registra en el router.
import type { DatabaseSync } from 'node:sqlite';
import { createRepos } from '../db/repos.js';
import { integrationHandlers } from './integration.js';
import { memoryHandlers } from './memory.js';
import { notificationHandlers } from './notifications.js';
import { objectiveHandlers } from './objectives.js';
import { agentHandlers } from './agents.js';
import { approvalHandlers } from './approvals.js';
import type { AdapterFactory, Ctx, Handler } from './context.js';
import { eventHandlers } from './events.js';
import { METRICS_NOTIFY_MS, METRICS_WRITE_MS, metricsHandlers } from './metrics.js';
import { type ConnectionDeps, autoCreateKeyConnections, connectionHandlers, createConnectionService, makeAdapterFactory } from './connections.js';
import { type ProviderDeps, providerHandlers } from './providers.js';
import { projectHandlers, recoverAllProjects } from './projects.js';
import { loadLimitsSnapshot } from './quota.js';
import { queueHandlers } from './queue.js';
import { relayHandlers } from './relay.js';
import { runHandlers, stopAll, whenIdle } from './runs.js';
import { requestSecrets, secretsHandlers } from './secrets.js';
import { settingsHandlers } from './settings.js';
import { defaultSkillsDir, skillHandlers } from './skills.js';
import { taskHandlers } from './tasks.js';
import { workspaceHandlers } from './workspaces.js';

export interface OrchestratorOptions {
  db: DatabaseSync;
  emit: (name: string, payload: unknown) => void;
  /** Crea el adaptador de un agente. Por defecto: Claude para `provider: 'claude'`; el resto llega en los pasos 15/16. */
  adapterFactory?: AdapterFactory;
  /** Tiempo máximo del comando de tests (ms). Por defecto 5 minutos. */
  testTimeoutMs?: number;
  /** Dependencias de `providers.test` (fetch, SDK y entorno), inyectables en las pruebas. */
  providerDeps?: ProviderDeps;
  /** Carpeta de skills del usuario (por defecto ~/.claude/skills). */
  skillsDir?: string;
  /** Frecuencias máximas (ms) de `run.metrics` por run y de escritura de métricas en la BD (pruebas). */
  metricsNotifyMs?: number;
  metricsWriteMs?: number;
  /** 0.2b: red de las conexiones (fetch, tiempos, puertos del descubrimiento): inyectable en las pruebas. */
  connectionDeps?: ConnectionDeps;
}

export function createOrchestrator(opts: OrchestratorOptions) {
  const ctx: Ctx = {
    db: opts.db,
    repos: createRepos(opts.db),
    emit: opts.emit,
    adapterFactory: opts.adapterFactory ?? (() => { throw new Error('adapterFactory sin inicializar'); }),
    testTimeoutMs: opts.testTimeoutMs ?? 5 * 60_000,
    projects: new Map(),
    lastProjectId: null,
    agentStatus: new Map(),
    live: new Map(),
    approvalIndex: new Map(),
    limits: new Map(),
    resumeTimers: new Map(),
    skillsDir: opts.skillsDir ?? defaultSkillsDir(),
    metricsNotifyMs: opts.metricsNotifyMs ?? METRICS_NOTIFY_MS,
    metricsWriteMs: opts.metricsWriteMs ?? METRICS_WRITE_MS,
    providerStatus: null,
    limitsNotifyTimer: null,
    limitsLastNotify: 0,
    queue: [],
    pumping: false,
    pumpAgain: false,
    budgetTimer: null,
    budgetNoticeAt: 0,
    workspacesTimer: null,
    workspacesLastNotify: 0,
    closed: false,
    secrets: new Map(),
    conn: null,
    integrationLocks: new Map(),
  };
  // Por defecto: Claude, o ApiLoopAdapter cuando el agente tiene connection_id (0.2b).
  if (!opts.adapterFactory) ctx.adapterFactory = makeAdapterFactory(ctx, opts.connectionDeps);
  // Claves ya presentes en el entorno (las inyecta Rust al arrancar): conexiones openai/gemini automáticas (D17).
  autoCreateKeyConnections(ctx, opts.providerDeps?.env ?? process.env);
  const connService = createConnectionService(ctx, opts.connectionDeps);
  ctx.conn = connService;
  loadLimitsSnapshot(ctx);
  recoverAllProjects(ctx); // un corte previo no deja tareas running ni aprobaciones pending fantasma, ni en proyectos cerrados
  const handlers: Record<string, Handler> = {
    ...projectHandlers(ctx),
    ...settingsHandlers(ctx),
    ...providerHandlers(ctx, opts.providerDeps),
    ...connectionHandlers(ctx, connService),
    ...secretsHandlers(ctx),
    ...agentHandlers(ctx),
    ...metricsHandlers(ctx),
    ...skillHandlers(ctx),
    ...taskHandlers(ctx),
    ...objectiveHandlers(ctx),
    ...integrationHandlers(ctx),
    ...memoryHandlers(ctx),
    ...notificationHandlers(ctx),
    ...runHandlers(ctx),
    ...relayHandlers(ctx),
    ...approvalHandlers(ctx),
    ...eventHandlers(ctx),
    ...queueHandlers(ctx),
    ...workspaceHandlers(ctx),
  };
  return {
    handlers,
    /** Espera a que terminen los runs en curso (pruebas). */
    whenIdle: () => whenIdle(ctx),
    /** Para los adaptadores en marcha (apagado del core). */
    shutdown: () => stopAll(ctx),
    /** Pide a Rust las claves `conn:*` del llavero (evento `secrets.request`); `core/src/index.ts` lo llama tras `core.ready`. */
    requestSecrets: () => requestSecrets(ctx),
    ctx,
  };
}

export type Orchestrator = ReturnType<typeof createOrchestrator>;
