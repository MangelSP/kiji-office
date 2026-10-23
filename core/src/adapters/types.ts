// Interfaz común de los adaptadores de agente (PLAN-0.1, sección 4).

export type RunSpec = {
  runId: string;
  cwd: string; // worktree (o el repo para el jefe)
  model: string;
  systemPrompt: string;
  prompt: string;
  allowedPaths: string[]; // propiedad de archivos
  readOnly?: boolean; // jefe
  outputSchema?: object; // Plan / Review
  resumeSessionId?: string;
  budgetUsd: number;
  /**
   * Skills elegidas para el agente (0.2a, D12): nombre y carpeta ya validada por el core (dentro de
   * ~/.claude/skills). El adaptador de Claude las monta en un plugin local temporal; si no puede, las describe
   * en el system prompt (plan B). `description` solo se usa en ese plan B.
   */
  skills?: Array<{ name: string; dir: string; description?: string }>;
};

export type LimitKind = 'rate' | 'quota' | 'credits' | 'budget';

export type AgentEvent =
  | { type: 'thinking' }
  | { type: 'text'; delta: string }
  | { type: 'tool'; name: string; input: unknown; status: 'start' | 'end'; output?: string; isError?: boolean }
  /**
   * Consumo del run (0.2a, D8). Se emite con cada mensaje `assistant` del hilo principal y, al llegar el
   * `result`, una vez más con `final: true` y las cifras exactas de `modelUsage`.
   * input/output/cacheRead/cacheWrite son acumulados del run; contextTokens es el del último turno
   * (input + cache_read + cache_creation).
   */
  | {
      type: 'usage';
      model: string;
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      contextTokens: number;
      contextWindow: number;
      /** Solo en el evento final: coste total del run en USD. */
      costUsd?: number;
      final?: boolean;
      sessionId?: string;
    }
  /** Estado de cupo que informa el SDK (`rate_limit_event`), también con `allowed` y `allowed_warning` (0.2a, D9). */
  | {
      type: 'rate';
      rateLimitType?: string;
      status: 'allowed' | 'allowed_warning' | 'rejected';
      utilization?: number; // 0..1
      resetsAt?: number; // epoch en milisegundos
    }
  | { type: 'permission_request'; id: string; tool: string; input: unknown; risk: 'ask' }
  | {
      type: 'done';
      text: string;
      structured?: unknown;
      sessionId?: string;
      costUsd?: number;
      usage?: { input: number; output: number };
    }
  // sessionId (extra respecto al plan): el core lo guarda en run.resume_hint al pausar.
  | { type: 'error'; message: string; retryable: boolean; sessionId?: string }
  | {
      type: 'limit';
      kind: LimitKind;
      resetsAt?: number; // epoch en milisegundos
      message: string;
      sessionId?: string;
      /** five_hour | seven_day | seven_day_opus | seven_day_sonnet... tal como lo da el SDK (0.2a). */
      rateLimitType?: string;
    };

export type Provider = 'claude' | 'codex' | 'api';

export interface AgentAdapter {
  readonly provider: Provider;
  /** Arranca el run. Un adaptador = un run: llamarlo dos veces lanza. */
  start(spec: RunSpec): AsyncIterable<AgentEvent>;
  /** Chat durante el run. Lanza si el run ya terminó (entonces: nuevo start con resumeSessionId). */
  send(text: string): Promise<void>;
  /**
   * Responde a un `permission_request`. `updatedInput` (extra respecto al plan) solo se usa con
   * `AskUserQuestion`: debe llevar `answers`.
   */
  answerPermission(
    id: string,
    allow: boolean,
    reason?: string,
    updatedInput?: Record<string, unknown>,
  ): void;
  stop(): Promise<void>;
}
