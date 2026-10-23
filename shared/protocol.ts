// Protocolo NDJSON entre la UI (vía Rust) y el core: una línea JSON por mensaje.
// Solo tipos: este archivo no emite JS (el core lo importa con `import type`).

/** Petición UI -> core. */
export type Request = {
  id: string;
  type: 'req';
  method: string;
  params?: unknown;
};

export type ProtocolError = { code: string; message: string };

/** Respuesta core -> UI a una petición con el mismo `id`. */
export type Response = {
  id: string;
  type: 'res';
  result?: unknown;
  error?: ProtocolError;
};

/** Evento core -> UI sin petición previa. */
export type Event = {
  type: 'event';
  name: string;
  payload: unknown;
};

export type Message = Request | Response | Event;

/** Métodos de 0.1 (PLAN-0.1.md, sección 4) más `ping`, de prueba. */
export type MethodName =
  | 'ping'
  | 'project.open'
  | 'project.get'
  | 'providers.detect'
  | 'providers.test'
  | 'agent.create'
  | 'agent.list'
  | 'agent.update'
  | 'objective.create'
  | 'plan.accept'
  | 'task.list'
  | 'task.create'
  | 'task.diff'
  | 'task.assign'
  | 'task.start'
  | 'task.stop'
  | 'task.undo'
  | 'approval.answer'
  | 'integration.apply'
  | 'integration.revert'
  | 'chat.send'
  | 'chat.history'
  | 'events.tail'
  // 0.2a (PLAN-0.2a.md)
  | 'agent.metrics'
  | 'skills.list'
  | 'providers.status'
  | 'relays.list'
  | 'task.switch'
  | 'task.steps'
  | 'settings.get'
  | 'settings.set'
  // 0.2c: varios workspaces (proyectos abiertos a la vez)
  | 'project.list'
  | 'project.update'
  | 'project.close'
  | 'project.reopen'
  | 'workspaces.overview';

/** Eventos de 0.1 (sección 4) más los propios del servidor. */
export type EventName =
  | 'core.ready'
  | 'core.error'
  | 'plan.proposed'
  | 'task.changed'
  | 'agent.status'
  | 'event.appended'
  | 'approval.requested'
  | 'review.ready'
  // 0.2a
  | 'run.metrics'
  | 'limits.changed'
  | 'relay.happened'
  | 'agent.changed'
  // 0.2c
  | 'queue.changed'
  | 'workspaces.changed'
  | 'budget.reached';

// ---------------------------------------------------------------------------
// 0.2a: métricas, cupo, relevo y perfil (PLAN-0.2a.md, "Contrato core ⇄ UI")
// ---------------------------------------------------------------------------

export type RunMetrics = {
  projectId: string;
  runId: string;
  taskId: string;
  agentId: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  contextTokens: number;
  contextWindow: number;
  costUsd: number;
  live: boolean;
};

export type AgentMetrics = {
  agentId: string;
  /** Modelo en uso ahora: el del run vivo, o el preferido del agente. */
  model: string;
  runs: number;
  costUsd: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  lastContextTokens: number;
  lastContextWindow: number;
  /** Últimos 20 runs, el más nuevo primero. */
  recent: RunMetrics[];
};

export type LimitWindowType = 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet' | 'other';

export type LimitWindow = {
  type: LimitWindowType;
  status: 'allowed' | 'allowed_warning' | 'rejected';
  /** 0..1 tal como viene del SDK (la UI muestra %); null si no se conoce. */
  utilization: number | null;
  /** epoch ms */
  resetsAt: number | null;
  seenAt: number;
};

export type ProviderId = 'claude' | 'ollama' | 'openai' | 'gemini';

export type ProviderStatus = {
  id: ProviderId;
  label: string;
  /** claude: CLI o clave; ollama: responde; openai/gemini: hay clave. */
  configured: boolean;
  state: 'ok' | 'warning' | 'limited' | 'off' | 'unknown';
  /** Vacío = sin datos de cupo (p. ej. clave de API). */
  windows: LimitWindow[];
  models: { model: string; agents: string[]; liveRuns: number; costTodayUsd: number; limitedUntil: number | null }[];
};

export type RelayReason = 'limit' | 'manual' | 'resume_after_reset';

export type RelayRow = {
  id: number;
  projectId: string;
  taskId: string | null;
  fromAgentId: string | null;
  toAgentId: string | null;
  fromModel: string | null;
  toModel: string | null;
  reason: RelayReason;
  detail: string;
  createdAt: number;
};

export type SkillInfo = { name: string; description: string };

export type ToolStep = { name: string; target: string; ok: boolean | null; startedAt: number; endedAt: number | null };

export type AgentUpdateParams = {
  agentId: string;
  name?: string;
  model?: string;
  color?: string;
  persona?: string;
  skills?: string[];
  relayOrder?: string[];
  autoRelay?: boolean;
};

export type TaskSwitchParams = { taskId: string; model?: string; agentId?: string };

// ---------------------------------------------------------------------------
// 0.2c: varios workspaces (un workspace = un proyecto abierto), cola global y Home
// ---------------------------------------------------------------------------
//
// Reglas generales:
//  - Todo método de proyecto acepta `projectId` en sus params. Si falta, el core usa el último proyecto abierto
//    (`lastProjectId`), así la UI de 0.2a sigue funcionando con uno solo. Los métodos por id de tarea/agente
//    (`task.start {id}`, `agent.update {agentId}`...) deducen el proyecto del id; si además llega `projectId`
//    y no coincide, fallan.
//  - TODOS los eventos por proyecto llevan `projectId` (camelCase) en el payload: `task.changed`, `agent.status`,
//    `event.appended`, `approval.requested`, `review.ready`, `run.metrics`, `relay.happened`, `agent.changed`,
//    `plan.proposed`, `queue.changed`. `limits.changed` es de la cuenta (no lleva projectId).
//  - Las filas que ya viajaban con columnas de BD (tarea, agente, proyecto) conservan su snake_case y ganan
//    `projectId`; los tipos nuevos van en camelCase.

export type ProjectScene = 'oficina' | 'casa';

/** Recuento de tareas por estado (solo aparecen los estados con al menos una tarea). */
export type TasksByStatus = Record<string, number>;

/** `project.list`: todos los proyectos conocidos (abiertos primero, luego por `lastOpenedAt` descendente). */
export type ProjectListItem = {
  projectId: string;
  name: string;
  path: string;
  baseBranch: string;
  testCommand: string | null;
  createdAt: number;
  /** Abierto como workspace en esta sesión del core. */
  open: boolean;
  lastOpenedAt: number | null;
  /** Color de la pestaña (`#rrggbb`) o null. */
  color: string | null;
  scene: ProjectScene;
  /** Runs vivos ahora (sin contar el cierre de runs ya terminados). */
  liveRuns: number;
  /** Tareas en cola global. */
  queued: number;
  /** Tareas que esperan a la persona: estado `needs_you` o `review`. */
  needsYou: number;
  /** Aprobaciones de permiso sin contestar. */
  approvalsPending: number;
  tasksByStatus: TasksByStatus;
};

export type ProjectCloseParams = { projectId: string; force?: boolean };
export type ProjectCloseResult = { projectId: string; closed: true; stoppedRuns: number };
export type ProjectReopenResult = {
  /** Proyectos que estaban abiertos (is_open=1) y se han vuelto a abrir. */
  opened: ProjectListItem[];
  /** Los que ya no se pueden abrir (carpeta borrada, ya no es repo...): quedan cerrados. */
  failed: { projectId: string; path: string; error: string }[];
};
export type ProjectUpdateParams = {
  projectId?: string;
  base_branch?: string;
  test_command?: string | null;
  scene?: ProjectScene;
  /** `#rrggbb` o null para quitarlo. */
  color?: string | null;
};

/** Notificación `queue.changed`: una tarea entra, sale o cambia de sitio en la cola global. */
export type QueueChange = {
  projectId: string;
  taskId: string;
  queued: boolean;
  /** Posición 1-based; 0 si ya no está en cola. */
  position: number;
  /** Qué la retiene: 'slots' (tope de runs simultáneos) o 'budget' (tope de gasto diario). null si no está en cola. */
  blockedBy: 'slots' | 'budget' | null;
};

/** Notificación `budget.reached`: se bloqueó un arranque porque el gasto de hoy ya alcanzó el tope diario. */
export type BudgetNotice = {
  costTodayUsd: number;
  dailyBudgetUsd: number;
  message: string;
  projectId?: string;
  taskId?: string;
};

export type TokenTotals = { input: number; output: number; cacheRead: number; cacheWrite: number };

export type WorkspaceAgent = {
  id: string;
  name: string;
  /** Modelo en uso ahora (el del run vivo o el preferido). */
  model: string;
  /** Estado del robot: idle, thinking, writing, needs_you, error, done. */
  status: string;
  color: string | null;
  isBoss: boolean;
};

/** Una tarjeta del Home: un proyecto conocido con sus métricas. */
export type WorkspaceSummary = {
  projectId: string;
  name: string;
  path: string;
  open: boolean;
  color: string | null;
  scene: ProjectScene;
  agents: WorkspaceAgent[];
  liveRuns: number;
  queued: number;
  needsYou: number;
  approvalsPending: number;
  tasksByStatus: TasksByStatus;
  /** Gasto de hoy (día local) y total del proyecto, en USD. */
  costTodayUsd: number;
  costTotalUsd: number;
  tokensToday: TokenTotals;
  /** Último evento registrado del proyecto (epoch ms) o null. */
  lastActivityAt: number | null;
  /** Último relevo de modelo/agente del proyecto, si hubo. */
  lastRelay?: RelayRow;
};

export type WorkspaceTotals = {
  /** Gasto de hoy (día local) de todos los proyectos. */
  costTodayUsd: number;
  liveRuns: number;
  /** Tareas en cola global. */
  queued: number;
  maxConcurrentRuns: number;
  dailyBudgetUsd: number;
};

/** `workspaces.overview` y payload de `workspaces.changed` (como mucho 1 por segundo). */
export type WorkspaceOverview = { workspaces: WorkspaceSummary[]; totals: WorkspaceTotals };
