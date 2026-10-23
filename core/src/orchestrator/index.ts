// Orquestador: tareas, runs, aprobaciones y agentes sobre la BD y los adaptadores.
// `createOrchestrator` no toca stdio: recibe la BD, el emisor de eventos y la fábrica de adaptadores (inyectable
// para las pruebas), y devuelve los handlers que `core/src/index.ts` registra en el router.
import type { DatabaseSync } from 'node:sqlite';
import { ClaudeAdapter } from '../adapters/claude.js';
import { createRepos } from '../db/repos.js';
import { agentHandlers } from './agents.js';
import { approvalHandlers } from './approvals.js';
import type { AdapterFactory, Ctx, Handler } from './context.js';
import { eventHandlers } from './events.js';
import { type ProviderDeps, providerHandlers } from './providers.js';
import { projectHandlers } from './projects.js';
import { runHandlers, stopAll, whenIdle } from './runs.js';
import { settingsHandlers } from './settings.js';
import { taskHandlers } from './tasks.js';

export interface OrchestratorOptions {
  db: DatabaseSync;
  emit: (name: string, payload: unknown) => void;
  /** Crea el adaptador de un agente. Por defecto: Claude para `provider: 'claude'`; el resto llega en los pasos 15/16. */
  adapterFactory?: AdapterFactory;
  /** Tiempo máximo del comando de tests (ms). Por defecto 5 minutos. */
  testTimeoutMs?: number;
  /** Dependencias de `providers.test` (fetch, SDK y entorno), inyectables en las pruebas. */
  providerDeps?: ProviderDeps;
}

export const defaultAdapterFactory: AdapterFactory = (agent) => {
  if (agent.provider === 'claude') return new ClaudeAdapter(); // la clave de API llega por el entorno del proceso
  throw new Error(`el proveedor "${agent.provider}" aún no está soportado (llega en los pasos 15 y 16)`);
};

export function createOrchestrator(opts: OrchestratorOptions) {
  const ctx: Ctx = {
    db: opts.db,
    repos: createRepos(opts.db),
    emit: opts.emit,
    adapterFactory: opts.adapterFactory ?? defaultAdapterFactory,
    testTimeoutMs: opts.testTimeoutMs ?? 5 * 60_000,
    activeProject: null,
    agentStatus: new Map(),
    live: new Map(),
    approvalIndex: new Map(),
  };
  const handlers: Record<string, Handler> = {
    ...projectHandlers(ctx),
    ...settingsHandlers(ctx),
    ...providerHandlers(ctx, opts.providerDeps),
    ...agentHandlers(ctx),
    ...taskHandlers(ctx),
    ...runHandlers(ctx),
    ...approvalHandlers(ctx),
    ...eventHandlers(ctx),
  };
  return {
    handlers,
    /** Espera a que terminen los runs en curso (pruebas). */
    whenIdle: () => whenIdle(ctx),
    /** Para los adaptadores en marcha (apagado del core). */
    shutdown: () => stopAll(ctx),
    ctx,
  };
}

export type Orchestrator = ReturnType<typeof createOrchestrator>;
