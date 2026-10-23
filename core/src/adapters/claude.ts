// Adaptador `claude`: Agent SDK de Anthropic (`query()`) -> AgentEvent (PLAN-0.1, D2 y D4).
//
// Notas de diseño (verificadas contra los tipos de @anthropic-ai/claude-agent-sdk 0.3.x):
// - La entrada va en modo streaming (AsyncIterable<SDKUserMessage>): así `send()` puede inyectar mensajes
//   mientras el run está activo y `canUseTool` funciona. Al llegar el `result` final se cierra la entrada y
//   el proceso termina; después de eso `send()` lanza y el core debe hacer un `start()` nuevo con
//   `resumeSessionId` (es lo que hará el chat del paso 17 cuando no hay run activo).
// - `result.subtype === 'error_max_budget_usd'` y las demás señales de D2 pasan por `toLimit`.
// - Solo se emite UN evento terminal (`done` | `error` | `limit`) por run.

import { realpathSync } from 'node:fs';
import {
  query as sdkQuery,
  type CanUseTool,
  type Options,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { classifyCommand, classifyPath, isInsideCwd, isPathAllowed, type Risk } from './classify.js';
import { CLAUDE_LIMIT_TEXT, toLimit } from './limits.js';
import { AsyncQueue } from './queue.js';
import type { AgentAdapter, AgentEvent, RunSpec } from './types.js';

type LimitEvent = Extract<AgentEvent, { type: 'limit' }>;

export type ClaudeAdapterOptions = {
  /** Ruta de un `claude` concreto; por defecto el SDK usa el binario que trae empaquetado. */
  pathToClaudeCodeExecutable?: string;
  /** Variables de entorno extra para el proceso (p. ej. ANTHROPIC_API_KEY que el core recibe del llavero). */
  env?: Record<string, string | undefined>;
};

/**
 * Reglas de denegación fija ("nunca", D4). El clasificador las repite en `canUseTool`.
 * `rm -rf /` y `rm -rf ~` van en forma exacta: con `*` serían prefijos y denegarían sin opción
 * `rm -rf /Users/…/worktree/dist`; las variantes (`//`, `/.`, `~/..`, `~usuario`, `/*`) las resuelve el clasificador.
 */
export const NEVER_TOOLS: string[] = [
  'Bash(git push --force*)',
  'Bash(git push -f*)',
  'Bash(git push --force-with-lease*)',
  'Bash(rm -rf /)',
  'Bash(rm -rf ~)',
  'Edit(//**/.env*)',
  'Write(//**/.env*)',
];

/**
 * Lecturas de secretos denegadas en el propio CLI. Hacen falta porque en `permissionMode: 'default'` el SDK
 * aprueba solo los `Read`/`Grep`/`Glob` dentro del cwd sin pasar por `canUseTool`, así que el clasificador
 * nunca vería un `Read .env` del worktree. Las reglas de `Read(...)` también se aplican a Grep y Glob.
 */
export const SECRET_READ_RULES: string[] = [
  'Read(./.env)',
  'Read(./.env.*)',
  'Read(./**/.env)',
  'Read(./**/.env.*)',
  'Read(**/*.pem)',
  'Read(**/*.key)',
  'Read(~/.ssh/**)',
  'Read(~/.aws/**)',
  'Read(~/.gnupg/**)',
  'Read(~/.netrc)',
  'Read(~/.git-credentials)',
  'Read(~/.kube/config)',
  'Read(~/.docker/config.json)',
  'Read(~/.config/gh/**)',
  'Read(~/.config/gcloud/**)',
];

/**
 * Línea extra para los trabajadores (no para el jefe, que es de solo lectura). `npx` sin TTY asume `--yes` y
 * puede descargar paquetes, por eso el clasificador lo deja en ask; así el agente no tropieza con él.
 */
export const WORKER_TOOLS_HINT = 'Para herramientas del proyecto usa `npm run <script>` o `node_modules/.bin/<herramienta>`, no `npx`.';

const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep'];
const WRITE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const READ_TOOLS = new Set(READ_ONLY_TOOLS);
/** Herramientas internas sin efectos sobre el disco ni la red. */
const SAFE_TOOLS = new Set(['TodoWrite', 'ToolSearch', 'Agent', 'Task', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate', 'TaskStop']);

const MAX_TOOL_OUTPUT = 4000;

type Pending = {
  tool: string;
  input: Record<string, unknown>;
  resolve: (r: PermissionResult) => void;
};

export class ClaudeAdapter implements AgentAdapter {
  readonly provider = 'claude' as const;

  private started = false;
  private aborted = false;
  private abortController = new AbortController();
  private input: AsyncQueue<SDKUserMessage> | null = null;
  private out: AsyncQueue<AgentEvent> | null = null;
  private pump: Promise<void> = Promise.resolve();
  private pending = new Map<string, Pending>();
  private spec: RunSpec | null = null;
  private roots: string[] = [];
  private stderrTail = '';

  constructor(private readonly opts: ClaudeAdapterOptions = {}) {}

  start(spec: RunSpec): AsyncIterable<AgentEvent> {
    if (this.started) throw new Error('ClaudeAdapter: un adaptador ejecuta un solo run; crea otro.');
    this.started = true;
    this.spec = spec;

    // En macOS /var -> /private/var: se aceptan ambas formas del cwd.
    this.roots = [spec.cwd];
    try {
      const real = realpathSync(spec.cwd);
      if (real !== spec.cwd) this.roots.push(real);
    } catch {
      /* el cwd puede no existir aún; el SDK fallará con su propio error */
    }

    const out = new AsyncQueue<AgentEvent>();
    const input = new AsyncQueue<SDKUserMessage>();
    this.out = out;
    this.input = input;
    out.onReturn = () => void this.stop();
    input.push(userMessage(spec.prompt));

    const options: Options = {
      cwd: spec.cwd,
      model: spec.model,
      abortController: this.abortController,
      permissionMode: 'default',
      settingSources: [], // aislamiento: ni CLAUDE.md ni settings del usuario
      systemPrompt: { type: 'preset', preset: 'claude_code', append: spec.readOnly ? spec.systemPrompt : `${spec.systemPrompt}\n\n${WORKER_TOOLS_HINT}` },
      disallowedTools: [...NEVER_TOOLS, ...SECRET_READ_RULES],
      maxBudgetUsd: spec.budgetUsd,
      includePartialMessages: true,
      canUseTool: this.canUseTool,
      stderr: (data) => {
        this.stderrTail = (this.stderrTail + data).slice(-2000);
      },
    };
    if (spec.readOnly) options.tools = READ_ONLY_TOOLS; // el jefe solo lee
    if (spec.outputSchema) options.outputFormat = { type: 'json_schema', schema: spec.outputSchema as Record<string, unknown> };
    if (spec.resumeSessionId) options.resume = spec.resumeSessionId;
    if (this.opts.pathToClaudeCodeExecutable) options.pathToClaudeCodeExecutable = this.opts.pathToClaudeCodeExecutable;
    if (this.opts.env) options.env = { ...process.env, ...this.opts.env };

    let q: Query;
    try {
      q = sdkQuery({ prompt: input, options });
    } catch (e) {
      out.push({ type: 'error', message: errMessage(e), retryable: false });
      out.end();
      return out;
    }
    this.pump = this.run(q, out, input, spec);
    return out;
  }

  async send(text: string): Promise<void> {
    if (!this.input || this.input.isClosed) {
      throw new Error('ClaudeAdapter.send: el run ya terminó; lanza un start() nuevo con resumeSessionId.');
    }
    this.input.push(userMessage(text));
  }

  answerPermission(id: string, allow: boolean, reason?: string, updatedInput?: Record<string, unknown>): void {
    const p = this.pending.get(id);
    if (!p) return; // respuesta tardía (tras stop) o id desconocido
    this.pending.delete(id);
    if (allow) p.resolve({ behavior: 'allow', updatedInput: updatedInput ?? p.input });
    else p.resolve({ behavior: 'deny', message: reason || 'El usuario denegó esta acción.' });
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.aborted = true;
    this.abortController.abort();
    for (const [id, p] of this.pending) {
      p.resolve({ behavior: 'deny', message: 'Run detenido.', interrupt: true });
      this.pending.delete(id);
    }
    this.input?.end();
    await this.pump;
    this.out?.end();
  }

  // -------------------------------------------------------------------------
  // Permisos
  // -------------------------------------------------------------------------

  private allowedHere(p: string): boolean {
    const spec = this.spec!;
    return this.roots.some((root) => isPathAllowed(p, spec.allowedPaths, root));
  }

  private insideCwd(p: string): boolean {
    return this.roots.some((root) => isInsideCwd(p, root));
  }

  // El SDK llama a `canUseTool` también para las herramientas de los subagentes (Agent/Task): esas llamadas
  // traen `opts.agentID` y sus mensajes `parent_tool_use_id`, pero se deciden con exactamente las mismas reglas
  // (no hay atajo para subagentes). Lo comprueba el test "subagentes" de claude.test.ts.
  private canUseTool: CanUseTool = async (toolName, input, opts) => {
    const allow: PermissionResult = { behavior: 'allow', updatedInput: input };
    const deny = (message: string): PermissionResult => ({ behavior: 'deny', message });
    const decide = (risk: Risk, why: string): Promise<PermissionResult> | PermissionResult => {
      if (risk === 'ok') return allow;
      if (risk === 'never') return deny(`Acción prohibida: ${why}.`);
      return this.request(opts.toolUseID, toolName, input, opts.signal);
    };

    if (this.spec?.readOnly && !READ_TOOLS.has(toolName)) {
      return deny('Este agente es de solo lectura: solo puede usar Read, Glob y Grep.');
    }

    if (WRITE_TOOLS.has(toolName)) {
      const p = str(input.file_path) || str(input.notebook_path) || str(input.path);
      if (!p || !this.allowedHere(p)) {
        const list = this.spec?.allowedPaths.join(', ') || '(ninguno)';
        return deny(`No puedes modificar ${p || 'ese archivo'}: no está entre tus archivos asignados. Archivos permitidos: ${list}.`);
      }
      return decide(classifyPath(p), `archivo sensible ${p}`);
    }

    if (toolName === 'Bash') {
      const cmd = str(input.command);
      return decide(classifyCommand(cmd), 'el comando está en la lista de acciones que nunca se ejecutan');
    }

    if (toolName === 'AskUserQuestion') return this.request(opts.toolUseID, toolName, input, opts.signal);

    if (READ_TOOLS.has(toolName)) {
      const p = str(input.file_path) || str(input.path);
      if (!p) return allow; // Glob/Grep sobre el cwd
      const risk = classifyPath(p);
      if (risk !== 'ok') return decide(risk, `lectura de archivo sensible ${p}`);
      return this.insideCwd(p) ? allow : this.request(opts.toolUseID, toolName, input, opts.signal);
    }

    if (SAFE_TOOLS.has(toolName)) return allow;

    // WebFetch, WebSearch, MCP, desconocidas…: lo dudoso se pregunta
    return this.request(opts.toolUseID, toolName, input, opts.signal);
  };

  private request(id: string, tool: string, input: Record<string, unknown>, signal: AbortSignal): Promise<PermissionResult> {
    return new Promise<PermissionResult>((resolve) => {
      this.pending.set(id, { tool, input, resolve });
      signal.addEventListener(
        'abort',
        () => {
          if (this.pending.delete(id)) resolve({ behavior: 'deny', message: 'Cancelado.', interrupt: true });
        },
        { once: true },
      );
      this.out?.push({ type: 'permission_request', id, tool, input, risk: 'ask' });
    });
  }

  // -------------------------------------------------------------------------
  // Mapeo SDKMessage -> AgentEvent
  // -------------------------------------------------------------------------

  private async run(q: Query, out: AsyncQueue<AgentEvent>, input: AsyncQueue<SDKUserMessage>, spec: RunSpec): Promise<void> {
    let sessionId = spec.resumeSessionId;
    let terminal = false;
    let pendingLimit: LimitEvent | null = null;
    const toolNames = new Map<string, string>();
    const streamedText = new Set<string>();
    const streamedThinking = new Set<string>();
    let streamMsgId = '';

    const finish = (ev: AgentEvent) => {
      if (terminal || this.aborted) return;
      terminal = true;
      out.push(ev);
      input.end(); // el proceso termina cuando se cierra la entrada
    };

    try {
      for await (const msg of q as AsyncIterable<SDKMessage>) {
        if (this.aborted) break;
        const m = msg as any;
        if (typeof m.session_id === 'string' && m.session_id) sessionId = m.session_id;

        switch (m.type) {
          case 'stream_event': {
            if (m.parent_tool_use_id) break; // texto de subagentes: no se muestra
            const ev = m.event;
            if (ev?.type === 'message_start') streamMsgId = ev.message?.id ?? '';
            else if (ev?.type === 'content_block_start' && (ev.content_block?.type === 'thinking' || ev.content_block?.type === 'redacted_thinking')) {
              streamedThinking.add(streamMsgId);
              out.push({ type: 'thinking' });
            } else if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
              streamedText.add(streamMsgId);
              out.push({ type: 'text', delta: ev.delta.text });
            }
            break;
          }

          case 'assistant': {
            const id: string = m.message?.id ?? '';
            const blocks: any[] = Array.isArray(m.message?.content) ? m.message.content : [];
            for (const b of blocks) {
              if (b.type === 'thinking' || b.type === 'redacted_thinking') {
                if (!m.parent_tool_use_id && !streamedThinking.has(id)) out.push({ type: 'thinking' });
              } else if (b.type === 'text') {
                if (!m.parent_tool_use_id && b.text && !streamedText.has(id)) out.push({ type: 'text', delta: b.text });
              } else if (b.type === 'tool_use') {
                toolNames.set(b.id, b.name);
                out.push({ type: 'tool', name: b.name, input: b.input, status: 'start' });
              }
            }
            break;
          }

          case 'user': {
            const content = m.message?.content;
            if (!Array.isArray(content)) break;
            for (const b of content) {
              if (b?.type === 'tool_result') {
                out.push({
                  type: 'tool',
                  name: toolNames.get(b.tool_use_id) ?? 'unknown',
                  input: undefined,
                  status: 'end',
                  output: toolOutput(b.content),
                });
              }
            }
            break;
          }

          case 'rate_limit_event':
          case 'system': {
            if (m.type === 'system' && m.subtype !== 'api_retry') break;
            const lim = toLimit('claude', m);
            if (lim) pendingLimit = lim;
            break;
          }

          case 'result': {
            if ((m.queued_turn_count ?? 0) > 0 && m.subtype === 'success' && !m.is_error) break; // vendrá otro result
            const success = m.subtype === 'success' && !m.is_error;
            if (success) {
              const ev: AgentEvent = {
                type: 'done',
                text: String(m.result ?? ''),
                sessionId,
                costUsd: m.total_cost_usd,
              };
              if (m.structured_output !== undefined) ev.structured = m.structured_output;
              const u = m.usage;
              if (u) {
                ev.usage = {
                  input: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
                  output: u.output_tokens ?? 0,
                };
              }
              finish(ev);
            } else {
              const lim = toLimit('claude', m) ?? (pendingLimitApplies(m) ? pendingLimit : null);
              if (lim) finish({ ...lim, sessionId });
              else finish(resultError(m, sessionId));
            }
            break;
          }
        }
      }

      if (!terminal && !this.aborted) {
        if (pendingLimit) finish({ ...pendingLimit, sessionId });
        else finish({ type: 'error', message: withStderr('El proceso de Claude terminó sin devolver un resultado.', this.stderrTail), retryable: true, sessionId });
      }
    } catch (e) {
      if (!this.aborted && !terminal) {
        const message = errMessage(e);
        const lim = toLimit('claude', { type: 'result', is_error: true, errors: [message] }) ?? pendingLimit;
        if (lim) finish({ ...lim, sessionId });
        else finish({ type: 'error', message: withStderr(message, this.stderrTail), retryable: false, sessionId });
      }
    } finally {
      input.end();
      try {
        q.close();
      } catch {
        /* ya cerrado */
      }
      out.end();
    }
  }
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

function userMessage(text: string): SDKUserMessage {
  return { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null };
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const withStderr = (msg: string, stderr: string): string => (stderr.trim() ? `${msg}\n${stderr.trim().slice(-500)}` : msg);

function toolOutput(content: unknown): string {
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) text = content.map((c) => (c?.type === 'text' ? c.text : '')).join('');
  return text.length > MAX_TOOL_OUTPUT ? text.slice(0, MAX_TOOL_OUTPUT) + '…' : text;
}

/**
 * Un límite rechazado antes (rate_limit_event / api_retry agotado) solo explica un `result` de error si este no
 * trae otra causa: sin `errors[]`, o con errores que son de límite. `error_max_turns` y compañía son errores
 * propios del run aunque antes hubiera un aviso de límite.
 */
function pendingLimitApplies(m: any): boolean {
  if (m.subtype === 'error_max_turns' || m.subtype === 'error_max_structured_output_retries') return false;
  const errors: string[] = Array.isArray(m.errors) ? m.errors.map(String).filter(Boolean) : [];
  return errors.length === 0 || errors.every((e) => CLAUDE_LIMIT_TEXT.test(e));
}

function resultError(m: any, sessionId?: string): AgentEvent {
  const errors: string[] = Array.isArray(m.errors) ? m.errors.map(String) : [];
  const message = errors.join('; ') || str(m.result) || `El run terminó con error (${m.subtype}).`;
  const status = m.api_error_status;
  const retryable = status === 429 || (typeof status === 'number' && status >= 500) || /overloaded|timed? ?out|ECONN/i.test(message);
  return { type: 'error', message, retryable, sessionId };
}
