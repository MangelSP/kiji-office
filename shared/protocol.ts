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
  | 'workspaces.overview'
  // 0.2b: Conexiones (PLAN-0.2b.md, parte 1; migración 4)
  | 'connection.list'
  | 'connection.create'
  | 'connection.update'
  | 'connection.delete'
  | 'connection.test'
  | 'connection.models'
  | 'connections.discover'
  | 'secrets.put'
  // 0.2d: objetivos, revisión, integración (hito 3) y Gerente autónomo (PLAN-0.2b.md parte 3; migración 5)
  | 'objective.list'
  | 'task.review'
  | 'integration.list'
  | 'manager.get'
  | 'manager.set'
  | 'manager.tick'
  | 'manager.stopAll'
  | 'manager.resume'
  | 'manager.diary'
  | 'memory.list'
  | 'memory.add'
  | 'memory.archive'
  | 'notifications.list'
  | 'notifications.markRead';

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
  | 'budget.reached'
  // 0.2b
  | 'connections.changed'
  /** core → Rust (nunca llega a la UI): pide las claves `conn:<id>` del llavero. */
  | 'secrets.request'
  // 0.2d
  | 'objective.changed'
  | 'integration.changed'
  | 'manager.tick'
  | 'manager.action'
  | 'manager.halted'
  | 'notify';

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
  /** 'claude' | 'ollama' | 'openai' | 'gemini' (0.2a) o 'conn:<uuid>' (una tarjeta por conexión, 0.2b). */
  id: ProviderId | `conn:${string}`;
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
  /** 0.2b: conexión del agente; null = Claude nativo (Agent SDK). Con conexión, `model` es libre (de connection.models). */
  connectionId?: string | null;
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


// ---------------------------------------------------------------------------
// 0.2b: Conexiones — cualquier IA compatible con OpenAI Chat Completions (PLAN-0.2b.md, D14–D18)
// ---------------------------------------------------------------------------

export type ConnectionPreset =
  | 'ollama' | 'lmstudio' | 'llamacpp' | 'vllm'
  | 'openai' | 'groq' | 'together' | 'deepseek' | 'mistral' | 'gemini' | 'openrouter' | 'litellm' | 'custom';
export type ConnectionAuth = 'none' | 'bearer' | 'x-api-key';
export type ToolQuality = 'unknown' | 'ok' | 'weak' | 'none';

export type ConnectionView = {
  id: string;
  name: string;
  preset: ConnectionPreset;
  baseUrl: string;
  auth: ConnectionAuth;
  /** Hay clave en el llavero (cuenta `conn:<id>`). La clave NUNCA viaja a la UI. */
  hasSecret: boolean;
  defaultModel: string | null;
  contextWindow: number;
  toolQuality: ToolQuality;
  lastTestAt: number | null;
  lastTestOk: boolean | null;
  /** Nombres de los agentes que la usan (de todos los proyectos). */
  agents: string[];
  /** Precios opcionales por modelo, USD por millón de tokens. Vacío = gratis / desconocido. */
  prices: Record<string, { in: number; out: number }>;
};

export type ConnectionTestStep = { name: 'models' | 'chat' | 'tools'; ok: boolean; detail: string };
export type ConnectionTest = {
  ok: boolean;
  detail: string;
  steps: ConnectionTestStep[];
  models?: string[];
  toolQuality?: ToolQuality;
  latencyMs?: number;
};
export type DiscoveredServer = {
  preset: ConnectionPreset;
  baseUrl: string;
  models: string[];
  alreadyConnected: boolean;
  /** Binario detectado pero el puerto no responde ("ejecuta `ollama serve`"). */
  installedNotRunning?: boolean;
};

export type ConnectionCreateParams = {
  name: string;
  preset: ConnectionPreset;
  baseUrl?: string;
  auth?: ConnectionAuth;
  defaultModel?: string;
  contextWindow?: number;
};
export type ConnectionUpdateParams = {
  id: string;
  name?: string;
  baseUrl?: string;
  auth?: ConnectionAuth;
  defaultModel?: string | null;
  contextWindow?: number;
  prices?: Record<string, { in: number; out: number }>;
};
export type ConnectionTestParams = { id: string; model?: string };

/** Elemento de `agents.relay_order`: alias de Claude o `conn:<uuid>/<modelo>`. */
export type RelayTarget = 'opus' | 'sonnet' | 'haiku' | `conn:${string}/${string}`;


// ---------------------------------------------------------------------------
// 0.2d: objetivos, revisión e integración (hito 3) y Gerente autónomo (PLAN-0.2b.md, D21–D24)
// ---------------------------------------------------------------------------

export type ObjectiveView = {
  id: string;
  projectId: string;
  text: string;
  status: 'planning' | 'active' | 'done';
  createdAt: number;
  /** Tareas del objetivo por estado. */
  tasksByStatus: Record<string, number>;
};
export type ObjectiveCreateParams = { projectId?: string; text: string };

/** Revisión de una tarea en `review`: aprobar (pasa a `approved`) o pedir cambios con hallazgos. */
export type TaskReviewParams = { id: string; projectId?: string; verdict: 'approve' | 'changes'; findings?: string[] };

export type IntegrationView = {
  id: string;
  projectId: string;
  taskId: string;
  beforeSha: string;
  afterSha: string;
  status: 'applied' | 'reverted' | 'failed';
  detail: string;
  createdAt: number;
  /** Solo en un intento fallido (la respuesta de `integration.apply` y el evento; no se guarda en la lista). */
  reason?: IntegrationFailReason;
  files?: string[];
  output?: string;
};
export type IntegrationFailReason = 'conflict' | 'tests_failed' | 'dirty' | 'merge';
export type IntegrationPhase = 'rebase' | 'tests' | 'merge' | 'done' | 'failed';
/** Payload de `integration.changed`: las fases intermedias solo llevan `projectId`, `taskId` y `phase`. */
export type IntegrationChangedEvent = { projectId: string; taskId: string; phase?: IntegrationPhase } & Partial<IntegrationView>;
/** `integration.apply {id: taskId}` integra una tarea `approved`: rebase, tests, merge ff-only a la rama base. */
export type IntegrationApplyParams = { id: string; projectId?: string };
export type IntegrationRevertParams = { integrationId: string; projectId?: string };

export type AutonomyLevel = 'auto' | 'notify' | 'ask';
export type ManagerLevels = {
  plan: AutonomyLevel;
  assign: AutonomyLevel;
  start: AutonomyLevel;
  retry: AutonomyLevel;
  relay: AutonomyLevel;
  integrate: AutonomyLevel;
  spend: AutonomyLevel;
};
export type ManagerPolicy = {
  enabled: boolean;
  /** Agente del proyecto que hace de cerebro (el jefe u otro); su IA/conexión y modelo deciden. */
  brain: { agentId: string };
  levels: ManagerLevels;
  /** Gasto del día del proyecto a partir del cual `spend` aplica. */
  spendAskUsd: number;
  /** Tope duro del día para el gerente + los runs que él arrancó: al llegar, para y avisa. */
  dayBudgetUsd: number;
  maxTickMinutes: number;
  maxTicksPerHour: number;
  /** "HH:MM" locales: en silencio solo avisa, no arranca nada. */
  quietHours?: { from: string; to: string };
  /** Una pregunta sin respuesta en este tiempo se da por NO (fail-closed). */
  askTimeoutMinutes: number;
};
/** Plantillas del deslizador de la UI. */
export type ManagerPreset = 'prudente' | 'equilibrado' | 'autonomo';

export type ManagerTickView = {
  id: string;
  projectId: string;
  trigger: string;
  summary: string;
  costUsd: number;
  startedAt: number;
  endedAt: number | null;
};
export type ManagerState = {
  projectId: string;
  policy: ManagerPolicy | null;
  halted: boolean;
  running: boolean;
  lastTick: ManagerTickView | null;
  todayCostUsd: number;
};
export type ManagerSetParams = { projectId?: string; policy: ManagerPolicy };
export type ManagerTickParams = { projectId?: string; message?: string };

export type ManagerActionView = {
  id: number;
  tickId: string;
  projectId: string;
  tool: string;
  input: string;
  result: string;
  level: AutonomyLevel;
  decidedBy: 'policy' | 'user' | 'timeout' | null;
  createdAt: number;
};
export type ManagerDiaryEntry = ManagerTickView & { actions: ManagerActionView[] };

export type MemoryKind = 'fact' | 'decision' | 'preference' | 'todo';
export type MemoryRow = {
  id: number;
  projectId: string;
  kind: MemoryKind;
  text: string;
  source: 'manager' | 'user';
  archived: boolean;
  createdAt: number;
};
export type MemoryListParams = { projectId?: string; query?: string; includeArchived?: boolean; limit?: number };
export type MemoryArchiveParams = { projectId?: string; id: number };
export type MemoryAddParams = { projectId?: string; kind: MemoryKind; text: string };

export type NotificationsMarkReadParams = { projectId?: string; ids: number[] | 'all' };
export type NotificationLevel = 'info' | 'warn' | 'ask';
export type NotificationRow = {
  id: number;
  projectId: string;
  level: NotificationLevel;
  title: string;
  /** Máx. 120 caracteres, sin rutas absolutas ni contenido de archivos (sale en la pantalla de bloqueo). */
  body: string;
  approvalId: string | null;
  readAt: number | null;
  createdAt: number;
};
/** Evento `notify`: Rust lanza la notificación del sistema; la UI la añade a la campana. */
export type NotifyEvent = { projectId: string; id: number; level: NotificationLevel; title: string; body: string; approvalId?: string };
