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
  | 'task.steps';

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
  | 'agent.changed';

// ---------------------------------------------------------------------------
// 0.2a: métricas, cupo, relevo y perfil (PLAN-0.2a.md, "Contrato core ⇄ UI")
// ---------------------------------------------------------------------------

export type RunMetrics = {
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
