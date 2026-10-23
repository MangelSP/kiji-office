// Adaptador `claude`: Agent SDK de Anthropic (`query()`) -> AgentEvent (PLAN-0.1, D2 y D4).
//
// Notas de diseño (verificadas contra los tipos de @anthropic-ai/claude-agent-sdk 0.3.x):
// - La entrada va en modo streaming (AsyncIterable<SDKUserMessage>): así `send()` puede inyectar mensajes
//   mientras el run está activo y `canUseTool` funciona. Al llegar el `result` final se cierra la entrada y
//   el proceso termina; después de eso `send()` lanza y el core debe hacer un `start()` nuevo con
//   `resumeSessionId` (es lo que hará el chat del paso 17 cuando no hay run activo).
// - `result.subtype === 'error_max_budget_usd'` y las demás señales de D2 pasan por `toLimit`.
// - Solo se emite UN evento terminal (`done` | `error` | `limit`) por run.

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { CLAUDE_LIMIT_TEXT, toLimit, toMillis } from './limits.js';
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
const SAFE_TOOLS = new Set(['Skill', 'TodoWrite', 'Agent', 'Task', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate', 'TaskStop']);

const MAX_TOOL_OUTPUT = 4000;

/** Ventana de contexto por defecto; la de 1M va marcada con `[1m]` en el id del modelo (D8). Se corrige con `modelUsage`. */
export const DEFAULT_CONTEXT_WINDOW = 200_000;
export const LONG_CONTEXT_WINDOW = 1_000_000;
export const contextWindowFor = (...models: Array<string | undefined>): number =>
  models.some((m) => typeof m === 'string' && m.toLowerCase().includes('[1m]')) ? LONG_CONTEXT_WINDOW : DEFAULT_CONTEXT_WINDOW;

/** Nombre del plugin local temporal que agrupa las skills del agente (D12): se ven como `kiji-skills:<skill>`. */
export const SKILLS_PLUGIN = 'kiji-skills';

/** Quita `allowed-tools` / `allowed_tools` del frontmatter de un SKILL.md (el resto del texto no cambia). */
export function stripAllowedTools(text: string): string {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return text;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end === -1) return text;
  const out: string[] = [lines[0]];
  let skipping = false;
  for (let i = 1; i < end; i++) {
    const l = lines[i]!;
    if (/^["']?allowed[-_]tools["']?\s*:/i.test(l)) {
      skipping = true;
      continue;
    }
    // continuación del valor omitido: líneas con sangría, vacías o elementos de lista
    if (skipping && (/^\s+\S/.test(l) || l.trim() === '' || /^-\s/.test(l))) continue;
    skipping = false;
    out.push(l);
  }
  return [...out, ...lines.slice(end)].join('\n');
}

/**
 * Monta un plugin local temporal con una carpeta por skill elegida (SKILL.md saneado + enlaces al resto) (D12, opción b: con `settingSources: []`
 * el SDK no descubre ~/.claude/skills, y su opción `skills` solo filtra lo que ya se ve). Devuelve la carpeta.
 */
export function createSkillsPlugin(skills: Array<{ name: string; dir: string }>): string {
  const root = mkdtempSync(join(tmpdir(), 'kiji-skills-'));
  try {
    mkdirSync(join(root, '.claude-plugin'));
    mkdirSync(join(root, 'skills'));
    writeFileSync(
      join(root, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: SKILLS_PLUGIN, version: '0.0.1', description: 'Skills elegidas para un agente de Kiji' }),
    );
    for (const sk of skills) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(sk.name)) throw new Error(`nombre de skill no válido: ${sk.name}`);
      // Carpeta real con un SKILL.md saneado (sin `allowed-tools`, que concedería herramientas sin pasar por canUseTool);
      // el resto de archivos de la skill se enlazan.
      const target = join(root, 'skills', sk.name);
      mkdirSync(target);
      writeFileSync(join(target, 'SKILL.md'), stripAllowedTools(readFileSync(join(sk.dir, 'SKILL.md'), 'utf8')));
      for (const f of readdirSync(sk.dir)) {
        if (f !== 'SKILL.md') symlinkSync(join(sk.dir, f), join(target, f));
      }
    }
  } catch (e) {
    rmSync(root, { recursive: true, force: true });
    throw e;
  }
  return root;
}

/** Plan B (D12c): la skill descrita en el system prompt, para que el agente lea su SKILL.md con Read. */
function skillsPromptFallback(skills: Array<{ name: string; dir: string; description?: string }>): string {
  const lines = skills.map((s) => `- ${s.name}${s.description ? `: ${s.description}` : ''} (${join(s.dir, 'SKILL.md')})`);
  return `Tienes estas skills; cuando apliquen, lee su SKILL.md con Read y sigue sus instrucciones:\n${lines.join('\n')}`;
}

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
  private skillsDir: string | null = null;
  private hasSkills = false;

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

    let systemPrompt = spec.readOnly ? spec.systemPrompt : `${spec.systemPrompt}\n\n${WORKER_TOOLS_HINT}`;
    let plugins: Options['plugins'];
    let skillNames: string[] | undefined;
    if (spec.skills && spec.skills.length > 0) {
      try {
        this.skillsDir = createSkillsPlugin(spec.skills);
        plugins = [{ type: 'local', path: this.skillsDir }];
        skillNames = spec.skills.map((s) => `${SKILLS_PLUGIN}:${s.name}`);
        this.hasSkills = true;
      } catch {
        systemPrompt += `\n\n${skillsPromptFallback(spec.skills)}`; // plan B
      }
    }

    const options: Options = {
      cwd: spec.cwd,
      model: spec.model,
      abortController: this.abortController,
      permissionMode: 'default',
      settingSources: [], // aislamiento: ni CLAUDE.md ni settings del usuario
      // Sin la memoria automática de Claude Code (~/.claude/projects/<repo>/memory): el CLI la deja leer sin
      // preguntar y son notas de las sesiones del usuario, no del repo.
      settings: { autoMemoryEnabled: false },
      systemPrompt: { type: 'preset', preset: 'claude_code', append: systemPrompt },
      disallowedTools: [...NEVER_TOOLS, ...SECRET_READ_RULES],
      maxBudgetUsd: spec.budgetUsd,
      includePartialMessages: true,
      canUseTool: this.canUseTool,
      // sin MCP del usuario (~/.claude.json, conectores claude.ai) ni del proyecto (.mcp.json)
      strictMcpConfig: true,
      // solo los servidores que el core pasa en el RunSpec (el gerente: `kiji`); nunca los del usuario
      mcpServers: (spec.mcpServers ?? {}) as NonNullable<Options['mcpServers']>,
      stderr: (data) => {
        this.stderrTail = (this.stderrTail + data).slice(-2000);
      },
    };
    if (plugins) options.plugins = plugins;
    if (skillNames) options.skills = skillNames; // además de montarlas, oculta las demás skills del listado
    if (spec.readOnly) options.tools = this.hasSkills ? [...READ_ONLY_TOOLS, 'Skill'] : READ_ONLY_TOOLS; // el jefe solo lee
    if (spec.outputSchema) options.outputFormat = { type: 'json_schema', schema: spec.outputSchema as Record<string, unknown> };
    if (spec.resumeSessionId) options.resume = spec.resumeSessionId;
    if (this.opts.pathToClaudeCodeExecutable) options.pathToClaudeCodeExecutable = this.opts.pathToClaudeCodeExecutable;
    if (this.opts.env) options.env = { ...process.env, ...this.opts.env };

    let q: Query;
    try {
      q = sdkQuery({ prompt: input, options });
    } catch (e) {
      this.removeSkillsDir();
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

    // Herramientas MCP del core (RunSpec.mcpServers): se deciden dentro del propio servidor, no pasan por el clasificador.
    if (this.isCoreMcpTool(toolName)) return allow;

    if (this.spec?.readOnly && !READ_TOOLS.has(toolName) && !(toolName === 'Skill' && this.hasSkills)) {
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

  private isCoreMcpTool(toolName: string): boolean {
    return Object.keys(this.spec?.mcpServers ?? {}).some((name) => toolName.startsWith(`mcp__${name}__`));
  }

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
    // Consumo: último `usage` de cada mensaje del hilo principal (el SDK repite el mismo id por cada bloque).
    const turns = new Map<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>();
    let lastModel = spec.model;
    let contextTokens = 0;
    let contextWindow = contextWindowFor(spec.model);

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
            const u = m.message?.usage;
            if (u && !m.parent_tool_use_id) {
              const turn = {
                input: num(u.input_tokens),
                output: num(u.output_tokens),
                cacheRead: num(u.cache_read_input_tokens),
                cacheWrite: num(u.cache_creation_input_tokens),
              };
              turns.set(id || `anon-${turns.size}`, turn);
              lastModel = str(m.message?.model) || lastModel;
              contextTokens = turn.input + turn.cacheRead + turn.cacheWrite;
              if (contextWindowFor(spec.model, lastModel) > contextWindow) contextWindow = LONG_CONTEXT_WINDOW;
              const sum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
              for (const t of turns.values()) {
                sum.input += t.input;
                sum.output += t.output;
                sum.cacheRead += t.cacheRead;
                sum.cacheWrite += t.cacheWrite;
              }
              out.push({ type: 'usage', model: lastModel, ...sum, contextTokens, contextWindow, ...(sessionId ? { sessionId } : {}) });
            }
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
                  ...(b.is_error === true ? { isError: true } : {}),
                });
              }
            }
            break;
          }

          case 'rate_limit_event':
          case 'system': {
            if (m.type === 'system' && m.subtype !== 'api_retry') break;
            if (m.type === 'rate_limit_event') {
              const info = m.rate_limit_info;
              if (info && typeof info === 'object' && ['allowed', 'allowed_warning', 'rejected'].includes(info.status)) {
                const rate: Extract<AgentEvent, { type: 'rate' }> = { type: 'rate', status: info.status };
                if (typeof info.rateLimitType === 'string') rate.rateLimitType = info.rateLimitType;
                if (typeof info.utilization === 'number' && Number.isFinite(info.utilization)) rate.utilization = info.utilization;
                const resetsAt = toMillis(info.resetsAt);
                if (resetsAt !== undefined) rate.resetsAt = resetsAt;
                out.push(rate);
              }
            }
            const lim = toLimit('claude', m);
            if (lim) pendingLimit = lim;
            break;
          }

          case 'result': {
            if ((m.queued_turn_count ?? 0) > 0 && m.subtype === 'success' && !m.is_error) break; // vendrá otro result
            const fin = finalUsage(m, lastModel, contextTokens, contextWindow, sessionId);
            if (fin && !this.aborted) {
              contextWindow = fin.contextWindow;
              out.push(fin);
            }
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
              const own = toLimit('claude', m);
              // El límite del `result` (por texto) no sabe qué ventana saltó: se completa con el aviso previo.
              const lim = own && own.kind === 'rate' && pendingLimit?.kind === 'rate' ? { ...pendingLimit, ...own, rateLimitType: pendingLimit.rateLimitType, resetsAt: own.resetsAt ?? pendingLimit.resetsAt } : own ?? (pendingLimitApplies(m) ? pendingLimit : null);
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
      this.removeSkillsDir();
      out.end();
    }
  }

  /** Borra el plugin temporal de skills (solo enlaces simbólicos: no toca las carpetas originales). */
  private removeSkillsDir(): void {
    if (!this.skillsDir) return;
    try {
      rmSync(this.skillsDir, { recursive: true, force: true });
    } catch {
      /* limpieza best-effort */
    }
    this.skillsDir = null;
  }
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

function userMessage(text: string): SDKUserMessage {
  return { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null };
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
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

/**
 * Cifras exactas del `result` (`modelUsage`, suma de todos los modelos del run) como un último evento `usage`.
 * La ventana de contexto es la del modelo principal (el del último mensaje; si no, el de mayor coste).
 */
function finalUsage(m: any, lastModel: string, contextTokens: number, fallbackWindow: number, sessionId?: string): Extract<AgentEvent, { type: 'usage' }> | null {
  const mu = m.modelUsage;
  if (!mu || typeof mu !== 'object') return null;
  const entries = Object.entries(mu as Record<string, any>).filter(([, v]) => v && typeof v === 'object');
  if (entries.length === 0) return null;
  const sum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const [, v] of entries) {
    sum.input += num(v.inputTokens);
    sum.output += num(v.outputTokens);
    sum.cacheRead += num(v.cacheReadInputTokens);
    sum.cacheWrite += num(v.cacheCreationInputTokens);
    sum.cost += num(v.costUSD);
  }
  const main =
    entries.find(([k]) => k === lastModel) ??
    entries.find(([k]) => lastModel !== '' && (k.includes(lastModel) || lastModel.includes(k))) ??
    [...entries].sort((a, b) => num(b[1].costUSD) - num(a[1].costUSD))[0]!;
  const window = num(main[1].contextWindow) > 0 ? num(main[1].contextWindow) : fallbackWindow;
  return {
    type: 'usage',
    model: lastModel || main[0],
    input: sum.input,
    output: sum.output,
    cacheRead: sum.cacheRead,
    cacheWrite: sum.cacheWrite,
    contextTokens,
    contextWindow: window,
    costUsd: typeof m.total_cost_usd === 'number' ? m.total_cost_usd : sum.cost,
    final: true,
    ...(sessionId ? { sessionId } : {}),
  };
}
