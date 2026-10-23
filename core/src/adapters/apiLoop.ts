// Adaptador `api-loop`: OpenAI Chat Completions + tools sobre `fetch` nativo (PLAN-0.2b, D14/D16/D18).
//
// - Un adaptador = un run. Solo se emite UN evento terminal (`done` | `error` | `limit`); tras `stop()` ninguno.
// - Las herramientas (tools/index.ts) se ejecutan dentro de `spec.cwd`; escrituras por isPathAllowed y comandos por
//   classifyCommand, igual que el adaptador de Claude.
// - La clave de API nunca sale en eventos, errores ni logs: todo texto saliente pasa por `redact`.

import { randomUUID } from 'node:crypto';
import { AsyncQueue } from './queue.js';
import { parseSse } from './sse.js';
import { toLimit } from './limits.js';
import { isToolName, runTool, toolDefinitions, truncate } from './tools/index.js';
import type { AgentAdapter, AgentEvent, RunSpec } from './types.js';

export type ApiLoopOptions = {
  baseUrl: string;
  auth: 'none' | 'bearer' | 'x-api-key';
  apiKey?: string;
  model: string;
  contextWindow: number;
  /** USD por millón de tokens, por modelo. Sin entrada para el modelo: coste 0 (local = gratis). */
  prices?: Record<string, { in: number; out: number }>;
  toolQuality?: 'unknown' | 'ok' | 'weak' | 'none';
  fetch?: typeof fetch;
};

export const MAX_TURNS = 40;
export const SUMMARY_THRESHOLD = 0.8;

export const TOOLS_GUIDE = [
  'Herramientas: read_file, write_file, edit_file, list_dir, grep y run_command (solo las que se te ofrezcan).',
  '- Usa rutas relativas a la carpeta del proyecto; no puedes salir de ella.',
  '- Lee un archivo antes de editarlo; en edit_file copia old_string exacto y único.',
  '- Solo puedes escribir en tus archivos asignados.',
  '- Si una herramienta devuelve un error, lee el mensaje, corrige y reintenta; no repitas la misma llamada.',
  '- Cuando termines, responde con un resumen breve sin llamar a más herramientas.',
].join('\n');

type Msg = Record<string, any>;
/** `extra`: campos desconocidos del tool_call (p. ej. `extra_content.google.thought_signature` de Gemini 3), que se reenvían intactos. */
type Call = { id: string; name: string; args: string; extra?: Record<string, unknown> };
type Turn = { text: string; calls: Call[]; extra?: Record<string, unknown>; usage?: { prompt: number; completion: number }; finish?: string };

/** Error ya traducido a evento terminal. */
class Terminal extends Error {
  constructor(readonly event: AgentEvent) {
    super('terminal');
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Mezcla `src` en `dst` (objetos en profundidad, el resto se reemplaza): los campos extra pueden llegar repartidos en varios deltas. */
function mergeExtra(dst: Record<string, unknown>, src: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(src)) {
    const cur = dst[k];
    if (isObj(v) && isObj(cur)) mergeExtra(cur, v);
    else dst[k] = isObj(v) ? structuredClone(v) : v;
  }
}

const pickExtra = (o: Record<string, unknown>, known: readonly string[]): Record<string, unknown> | undefined => {
  const r: Record<string, unknown> = {};
  for (const k of Object.keys(o)) if (!known.includes(k)) r[k] = o[k];
  return Object.keys(r).length > 0 ? r : undefined;
};

const TOOL_CALL_KNOWN = ['index', 'id', 'type', 'function'] as const;
const FUNCTION_KNOWN = ['name', 'arguments'] as const;
// Campos del delta/mensaje que ya tratamos (o que no deben viajar de vuelta al proveedor).
const DELTA_KNOWN = ['role', 'content', 'tool_calls', 'reasoning_content', 'reasoning', 'refusal', 'function_call', 'audio', 'annotations'] as const;

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export class ApiLoopAdapter implements AgentAdapter {
  readonly provider = 'api' as const;

  private started = false;
  private aborted = false;
  private finished = false;
  private readonly abort = new AbortController();
  private out: AsyncQueue<AgentEvent> | null = null;
  private pump: Promise<void> = Promise.resolve();
  private pending = new Map<string, (r: { allow: boolean; reason?: string }) => void>();
  private userQueue: string[] = [];
  private spec: RunSpec | null = null;
  private tin = 0;
  private tout = 0;

  constructor(private readonly opts: ApiLoopOptions) {}

  start(spec: RunSpec): AsyncIterable<AgentEvent> {
    if (this.started) throw new Error('ApiLoopAdapter: un adaptador ejecuta un solo run; crea otro.');
    this.started = true;
    this.spec = spec;
    const out = new AsyncQueue<AgentEvent>();
    this.out = out;
    out.onReturn = () => void this.stop();
    this.pump = this.run(spec, out);
    return out;
  }

  async send(text: string): Promise<void> {
    if (!this.started || this.finished || this.aborted) {
      throw new Error('ApiLoopAdapter.send: el run ya terminó; lanza un start() nuevo.');
    }
    this.userQueue.push(text);
  }

  answerPermission(id: string, allow: boolean, reason?: string): void {
    const r = this.pending.get(id);
    if (!r) return;
    this.pending.delete(id);
    r(allow ? { allow: true } : { allow: false, reason: reason || 'El usuario denegó esta acción.' });
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.aborted = true;
    this.abort.abort();
    for (const [id, r] of this.pending) {
      r({ allow: false, reason: 'Run detenido.' });
      this.pending.delete(id);
    }
    await this.pump;
    this.out?.end();
  }

  // -------------------------------------------------------------------------

  private redact = (s: string): string => {
    const k = this.opts.apiKey;
    return k && k.length >= 4 ? s.split(k).join('***') : s;
  };

  private log(msg: string): void {
    console.error(`[api-loop] ${this.redact(msg)}`);
  }

  private origin(): string {
    try {
      return new URL(this.opts.baseUrl).origin;
    } catch {
      return 'el servidor';
    }
  }

  private ask(out: AsyncQueue<AgentEvent>) {
    return (tool: string, input: Record<string, unknown>) =>
      new Promise<{ allow: boolean; reason?: string }>((resolve) => {
        if (this.aborted) return resolve({ allow: false, reason: 'Run detenido.' });
        const id = randomUUID();
        this.pending.set(id, resolve);
        out.push({ type: 'permission_request', id, tool, input, risk: 'ask' });
      });
  }

  private cost(): number {
    const p = this.opts.prices?.[this.opts.model];
    return p ? (this.tin * p.in + this.tout * p.out) / 1e6 : 0;
  }

  private async run(spec: RunSpec, out: AsyncQueue<AgentEvent>): Promise<void> {
    const readOnly = !!spec.readOnly;
    // Herramientas propias del core (el gerente) además de las de archivos; el nombre de una propia nunca pisa a una integrada.
    const extra = new Map((spec.extraTools ?? []).filter((t) => !isToolName(t.name)).map((t) => [t.name, t]));
    const tools: unknown[] = [
      ...toolDefinitions(readOnly),
      ...[...extra.values()].map((t) => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: t.parameters } })),
    ];
    const weak = this.opts.toolQuality === 'weak' || this.opts.toolQuality === 'unknown';
    const messages: Msg[] = [
      { role: 'system', content: `${spec.systemPrompt}\n\n${TOOLS_GUIDE}` },
      { role: 'user', content: spec.prompt },
    ];
    const ctx = {
      cwd: spec.cwd,
      allowedPaths: spec.allowedPaths,
      signal: this.abort.signal,
      ask: this.ask(out),
      redact: this.redact,
    };
    const push = (ev: AgentEvent) => {
      if (!this.aborted) out.push(ev);
    };

    try {
      for (let turn = 1; turn <= MAX_TURNS; turn++) {
        for (const t of this.userQueue.splice(0)) messages.push({ role: 'user', content: t });

        let thinking = false;
        const res = await this.chat(messages, tools, {
          text: (d) => push({ type: 'text', delta: d }),
          thinking: () => {
            if (!thinking) push({ type: 'thinking' });
            thinking = true;
          },
        });
        if (this.aborted) return;
        let lastPrompt = 0;
        if (res.usage) {
          this.tin += res.usage.prompt;
          this.tout += res.usage.completion;
          lastPrompt = res.usage.prompt;
          push({
            type: 'usage',
            model: this.opts.model,
            input: this.tin,
            output: this.tout,
            cacheRead: 0,
            cacheWrite: 0,
            contextTokens: res.usage.prompt,
            contextWindow: this.opts.contextWindow,
          });
        }

        let calls = res.calls;
        if (calls.length === 0 && weak && res.text) {
          const r = rescueToolCall(res.text, readOnly);
          if (r) {
            this.log(`rescate weak: el modelo escribió la llamada a ${r.name} como texto; se ejecuta una vez`);
            calls = [{ id: `rescue_${randomUUID().slice(0, 8)}`, name: r.name, args: JSON.stringify(r.arguments) }];
          }
        }

        if (calls.length === 0) {
          if (this.userQueue.length > 0) {
            messages.push({ role: 'assistant', content: res.text });
            continue;
          }
          this.finished = true;
          push({ type: 'usage', model: this.opts.model, input: this.tin, output: this.tout, cacheRead: 0, cacheWrite: 0, contextTokens: lastPrompt, contextWindow: this.opts.contextWindow, costUsd: this.cost(), final: true });
          push({ type: 'done', text: res.text, costUsd: this.cost(), usage: { input: this.tin, output: this.tout } });
          return;
        }

        messages.push({
          role: 'assistant',
          content: res.text || null,
          ...(res.extra ?? {}),
          tool_calls: calls.map((c) => {
            const { function: fx, ...rest } = (c.extra ?? {}) as Record<string, any>;
            return { ...rest, id: c.id, type: 'function', function: { ...(fx ?? {}), name: c.name, arguments: c.args } };
          }),
        });
        for (const c of calls) {
          if (this.aborted) return;
          let input: unknown = {};
          let result: { output: string; isError: boolean };
          try {
            input = c.args.trim() === '' ? {} : JSON.parse(c.args);
            push({ type: 'tool', name: c.name, input, status: 'start' });
            const own = extra.get(c.name);
            if (own) {
              const r = await own.execute(input).catch((e: unknown) => ({ output: e instanceof Error ? e.message : String(e), isError: true }));
              result = { output: this.redact(truncate(r.output)), isError: r.isError };
            } else result = await runTool(c.name, input, readOnly, ctx);
          } catch {
            push({ type: 'tool', name: c.name, input: c.args, status: 'start' });
            result = {
              output: `Los argumentos de ${c.name} no son JSON válido. Vuelve a llamar a la herramienta con un objeto JSON completo.`,
              isError: true,
            };
          }
          if (this.aborted) return;
          push({ type: 'tool', name: c.name, input, status: 'end', output: result.output, isError: result.isError });
          messages.push({ role: 'tool', tool_call_id: c.id, content: result.output });
        }

        // El resumen sustituye TODO el hilo cuando ya no queda ninguna llamada en curso (todas las tool_calls tienen su
        // resultado), así que no se pierde ninguna thought_signature pendiente: Gemini solo las exige en el turno actual.
        if (lastPrompt > this.opts.contextWindow * SUMMARY_THRESHOLD) {
          await this.summarize(messages, tools, lastPrompt);
          push({ type: 'text', delta: `\n[Contexto al ${Math.round((lastPrompt / this.opts.contextWindow) * 100)} %: se resumió el hilo para seguir.]\n` });
        }
      }
      this.finished = true;
      push({ type: 'error', message: `Se alcanzó el máximo de ${MAX_TURNS} turnos sin terminar la tarea.`, retryable: false });
    } catch (e) {
      this.finished = true;
      if (this.aborted) return;
      if (e instanceof Terminal) push(e.event);
      else push({ type: 'error', message: this.redact(e instanceof Error ? e.message : String(e)), retryable: false });
    } finally {
      this.finished = true;
      out.end();
    }
  }

  /** Pide al propio modelo un resumen y sustituye el historial antiguo (conserva el system prompt). */
  private async summarize(messages: Msg[], tools: unknown[], promptTokens: number): Promise<void> {
    const ask: Msg = {
      role: 'user',
      content: 'Resume en español, de forma que puedas continuar la tarea sin el historial: objetivo, lo ya hecho (archivos tocados), lo que falta y datos clave. No llames a herramientas.',
    };
    try {
      const res = await this.chat([...messages, ask], tools, {}, true);
      if (res.usage) {
        this.tin += res.usage.prompt;
        this.tout += res.usage.completion;
      }
      const summary = res.text.trim();
      if (!summary) return;
      const first = messages[1]!;
      messages.splice(1, messages.length - 1, {
        role: 'user',
        content: `${first.content}\n\n[El hilo anterior se resumió (${promptTokens} tokens de contexto). Resumen de lo hecho hasta ahora:]\n${summary}`,
      });
    } catch (e) {
      if (e instanceof Terminal && !this.aborted) throw e;
      this.log('no se pudo resumir el hilo');
    }
  }

  // -------------------------------------------------------------------------
  // HTTP + SSE
  // -------------------------------------------------------------------------

  private async chat(
    messages: Msg[],
    tools: unknown[],
    cb: { text?: (d: string) => void; thinking?: () => void },
    noTools = false,
  ): Promise<Turn> {
    const { auth, apiKey } = this.opts;
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'text/event-stream' };
    if (apiKey && auth === 'bearer') headers.authorization = `Bearer ${apiKey}`;
    if (apiKey && auth === 'x-api-key') headers['x-api-key'] = apiKey;
    const body: Record<string, unknown> = {
      model: this.opts.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (tools.length > 0) {
      body.tools = tools;
      if (noTools) body.tool_choice = 'none';
    }

    let res: Response;
    try {
      res = await (this.opts.fetch ?? fetch)(`${this.opts.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        redirect: 'error',
        signal: this.abort.signal,
      });
    } catch (e) {
      throw this.networkError(e);
    }
    if (!res.ok) throw await this.httpError(res);
    if (!res.body) throw new Terminal({ type: 'error', message: 'El servidor respondió sin cuerpo.', retryable: true });

    const turn: Turn = { text: '', calls: [] };
    const slots: Call[] = [];
    let chunks = 0;
    try {
      for await (const data of parseSse(res.body)) {
        if (data.trim() === '[DONE]') break;
        let j: any;
        try {
          j = JSON.parse(data);
        } catch {
          this.log('fragmento SSE no válido, se ignora');
          continue;
        }
        chunks++;
        if (j?.error) throw this.bodyError(res.status, j, res.headers);
        if (j?.usage && typeof j.usage === 'object') {
          turn.usage = { prompt: num(j.usage.prompt_tokens), completion: num(j.usage.completion_tokens) };
        }
        const choice = j?.choices?.[0];
        if (!choice) continue;
        const d = choice.delta ?? choice.message ?? {};
        if (typeof d.reasoning_content === 'string' || typeof d.reasoning === 'string') cb.thinking?.();
        if (typeof d.content === 'string' && d.content) {
          turn.text += d.content;
          cb.text?.(d.content);
        }
        if (isObj(d)) {
          const ex = pickExtra(d, DELTA_KNOWN);
          if (ex) mergeExtra((turn.extra ??= {}), ex);
        }
        if (Array.isArray(d.tool_calls)) {
          for (const tc of d.tool_calls) {
            let idx: number = typeof tc.index === 'number' ? tc.index : slots.length - 1;
            // sin `index` (algunos servidores): un `id` nuevo abre otra llamada
            if (typeof tc.index !== 'number' && (idx < 0 || (tc.id && tc.id !== slots[idx]!.id))) idx = slots.length;
            const slot = (slots[idx] ??= { id: '', name: '', args: '' });
            if (isObj(tc)) {
              const ex = pickExtra(tc, TOOL_CALL_KNOWN);
              const fx = isObj(tc.function) ? pickExtra(tc.function, FUNCTION_KNOWN) : undefined;
              if (ex || fx) mergeExtra((slot.extra ??= {}), { ...ex, ...(fx ? { function: fx } : {}) });
            }
            if (tc.id) slot.id = tc.id;
            if (tc.function?.name) slot.name += tc.function.name;
            if (typeof tc.function?.arguments === 'string') slot.args += tc.function.arguments;
            else if (tc.function?.arguments && typeof tc.function.arguments === 'object') slot.args = JSON.stringify(tc.function.arguments);
          }
        }
        if (choice.finish_reason) turn.finish = choice.finish_reason;
      }
    } catch (e) {
      if (e instanceof Terminal) throw e;
      throw this.networkError(e, true);
    }
    if (chunks === 0 && !this.aborted) {
      throw new Terminal({ type: 'error', message: 'El servidor devolvió una respuesta vacía o rota.', retryable: true });
    }
    turn.calls = slots.filter((s) => s && s.name).map((s, i) => ({ ...s, id: s.id || `call_${i}_${randomUUID().slice(0, 6)}` }));
    return turn;
  }

  private networkError(e: unknown, midStream = false): Error {
    if (this.aborted) return new Error('abortado');
    const code = (e as any)?.cause?.code ?? (e as any)?.code;
    const msg = e instanceof Error ? e.message : String(e);
    if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ECONNRESET' || code === 'UND_ERR_CONNECT_TIMEOUT') {
      const text = midStream ? `Se cortó la conexión con ${this.origin()}.` : `${this.origin()} no responde: ¿está en marcha?`;
      return new Terminal({ type: 'error', message: this.redact(text), retryable: true });
    }
    if (/redirect/i.test(msg) || /redirect/i.test(String((e as any)?.cause?.message ?? ''))) {
      return new Terminal({ type: 'error', message: `${this.origin()} respondió con una redirección; revisa la URL base.`, retryable: false });
    }
    const text = midStream ? `Respuesta interrumpida de ${this.origin()}: ${msg}` : `No se pudo conectar con ${this.origin()}: ${msg}`;
    return new Terminal({ type: 'error', message: this.redact(text), retryable: true });
  }

  private async httpError(res: Response): Promise<Terminal> {
    let text = '';
    try {
      text = (await res.text()).slice(0, 4000);
    } catch {
      /* cuerpo ilegible */
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    return this.bodyError(res.status, parsed ?? { error: { message: text } }, res.headers);
  }

  private bodyError(status: number, body: any, headers: Headers): Terminal {
    const b = Array.isArray(body) ? body[0] : body; // Gemini devuelve [{ error }]
    const e = b?.error;
    const err = typeof e === 'string' ? { message: e } : e && typeof e === 'object' ? e : { message: typeof b?.message === 'string' ? b.message : '' };
    const raw = { status, error: err };
    const message = this.redact(String(err.message || `HTTP ${status}`));
    const limit = toLimit('api', raw);
    if (limit) {
      limit.message = this.redact(limit.message);
      const ra = parseRetryAfter(headers.get('retry-after'));
      if (ra !== undefined) limit.resetsAt = ra;
      return new Terminal(limit);
    }
    return new Terminal({
      type: 'error',
      message: status >= 500 ? `${this.origin()} falló (${status}): ${message}. ¿Está bien el modelo cargado?` : `El proveedor rechazó la petición (${status}): ${message}`,
      retryable: status >= 500 || status === 408,
    });
  }
}

function parseRetryAfter(v: string | null): number | undefined {
  if (!v) return undefined;
  const s = Number(v);
  if (Number.isFinite(s) && s >= 0) return Date.now() + s * 1000;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : t;
}

/** Busca en un texto un JSON `{name, arguments}` de una herramienta conocida (rescate de modelos `weak`). */
export function rescueToolCall(text: string, readOnly: boolean): { name: string; arguments: Record<string, unknown> } | null {
  const candidates: string[] = [];
  const t = text.trim();
  candidates.push(t);
  for (const m of t.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) candidates.push(m[1]!.trim());
  for (let i = t.indexOf('{'); i !== -1 && candidates.length < 12; i = t.indexOf('{', i + 1)) {
    let depth = 0;
    let inStr = false;
    for (let k = i; k < t.length; k++) {
      const c = t[k];
      if (inStr) {
        if (c === '\\') k++;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        candidates.push(t.slice(i, k + 1));
        break;
      }
    }
  }
  for (const c of candidates) {
    let j: any;
    try {
      j = JSON.parse(c);
    } catch {
      continue;
    }
    const o = j?.function && typeof j.function === 'object' ? j.function : j;
    const name = o?.name;
    if (!isToolName(name)) continue;
    if (readOnly && !toolDefinitions(true).some((d) => d.function.name === name)) continue;
    let args = o.arguments ?? o.parameters ?? {};
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        continue;
      }
    }
    if (typeof args !== 'object' || args === null || Array.isArray(args)) continue;
    return { name, arguments: args as Record<string, unknown> };
  }
  return null;
}
