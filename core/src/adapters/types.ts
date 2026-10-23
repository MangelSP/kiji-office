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
};

export type LimitKind = 'rate' | 'quota' | 'credits' | 'budget';

export type AgentEvent =
  | { type: 'thinking' }
  | { type: 'text'; delta: string }
  | { type: 'tool'; name: string; input: unknown; status: 'start' | 'end'; output?: string }
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
