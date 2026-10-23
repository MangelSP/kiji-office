import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiLoopAdapter, MAX_TURNS, rescueToolCall, type ApiLoopOptions } from '../../src/adapters/apiLoop.js';
import { parseSse } from '../../src/adapters/sse.js';
import type { AgentEvent, RunSpec } from '../../src/adapters/types.js';

const FIX = join(import.meta.dirname, '..', 'fixtures', 'apiLoop');
const fixture = (n: string) => readFileSync(join(FIX, n), 'utf8');

// --- servidor falso ---------------------------------------------------------------------------------------------

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, body: any) => void;
let server: http.Server;
let baseUrl: string;
let script: Handler[] = [];
let requests: Array<{ headers: http.IncomingHttpHeaders; body: any; url?: string }> = [];

beforeEach(async () => {
  script = [];
  requests = [];
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body: any = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        /* sin cuerpo */
      }
      requests.push({ headers: req.headers, body, url: req.url });
      const h = script.shift();
      if (!h) {
        res.writeHead(500, { 'content-type': 'application/json' }).end('{"error":{"message":"sin guion"}}');
        return;
      }
      h(req, res, body);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

const sseRaw =
  (text: string): Handler =>
  (_q, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(text);
  };
const sseFile = (name: string) => sseRaw(fixture(name));
const chunk = (delta: object, finish: string | null = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const usageChunk = (p: number, c: number) => `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: p, completion_tokens: c } })}\n\n`;
const textSse = (text: string, p = 10, c = 2) => sseRaw(chunk({ role: 'assistant', content: text }) + chunk({}, 'stop') + usageChunk(p, c) + 'data: [DONE]\n\n');
const callSse = (name: string, args: object | string, p = 10, c = 2): Handler =>
  sseRaw(
    chunk({ tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } }] }) +
      chunk({}, 'tool_calls') +
      usageChunk(p, c) +
      'data: [DONE]\n\n',
  );
const jsonErr =
  (status: number, body: unknown, headers: Record<string, string> = {}): Handler =>
  (_q, res) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
  };

// --- helpers ----------------------------------------------------------------------------------------------------

let cwd: string;
beforeEach(() => {
  cwd = realpathSync(mkdtempSync(join(tmpdir(), 'kiji-apiloop-')));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const spec = (over: Partial<RunSpec> = {}): RunSpec => ({
  runId: 'r1',
  cwd,
  model: 'm',
  systemPrompt: 'Eres un programador.',
  prompt: 'haz algo',
  allowedPaths: ['hola.txt'],
  budgetUsd: 1,
  ...over,
});
const adapter = (over: Partial<ApiLoopOptions> = {}) =>
  new ApiLoopAdapter({ baseUrl, auth: 'none', model: 'qwen3', contextWindow: 32_000, toolQuality: 'ok', ...over });

async function collect(a: ApiLoopAdapter, s: RunSpec, onEvent?: (e: AgentEvent) => void): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const e of a.start(s)) {
    events.push(e);
    onEvent?.(e);
  }
  return events;
}
const ofType = <T extends AgentEvent['type']>(evs: AgentEvent[], t: T) => evs.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === t);
const terminal = (evs: AgentEvent[]) => evs.filter((e) => e.type === 'done' || e.type === 'error' || e.type === 'limit');
/** Último mensaje `tool` que recibió el servidor. */
const lastToolMsg = (i = requests.length - 1): string => {
  const m = requests[i]!.body.messages.filter((x: any) => x.role === 'tool');
  return m[m.length - 1]?.content ?? '';
};

// --- tests ------------------------------------------------------------------------------------------------------

describe('parseSse', () => {
  it('une eventos partidos en trozos arbitrarios, CRLF, comentarios y UTF-8 partido', async () => {
    const bytes = new TextEncoder().encode(': hola\r\ndata: {"a":"ñ"}\r\n\r\ndata: uno\ndata: dos\n\ndata: sin-final');
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < bytes.length; i += 3) c.enqueue(bytes.slice(i, i + 3));
        c.close();
      },
    });
    const out: string[] = [];
    for await (const d of parseSse(stream)) out.push(d);
    expect(out).toEqual(['{"a":"ñ"}', 'uno\ndos', 'sin-final']);
  });
});

describe('ApiLoopAdapter: protocolo', () => {
  it('Ollama: tool_call completo en un chunk; escribe, emite eventos y usage con coste', async () => {
    script = [sseFile('ollama-toolcall.sse'), textSse('hecho', 150, 4)];
    const a = adapter({ prices: { qwen3: { in: 1, out: 2 } } });
    const evs = await collect(a, spec());
    expect(readFileSync(join(cwd, 'hola.txt'), 'utf8')).toBe('hola');
    const tools = ofType(evs, 'tool');
    expect(tools.map((t) => t.status)).toEqual(['start', 'end']);
    expect(tools[1]).toMatchObject({ name: 'write_file', isError: false });
    expect(ofType(evs, 'usage')[0]).toMatchObject({ model: 'qwen3', input: 120, output: 18, contextTokens: 120, contextWindow: 32_000 });
    const done = ofType(evs, 'done')[0]!;
    expect(done.text).toBe('hecho');
    expect(done.costUsd).toBeCloseTo((270 * 1 + 22 * 2) / 1e6, 10);
    expect(terminal(evs)).toHaveLength(1);

    const r = requests[0]!;
    expect(r.url).toBe('/v1/chat/completions');
    expect(r.body).toMatchObject({ stream: true, stream_options: { include_usage: true }, model: 'qwen3' });
    expect(r.body.tools.map((t: any) => t.function.name)).toEqual(['read_file', 'write_file', 'edit_file', 'list_dir', 'grep', 'run_command']);
    expect(r.body.messages[0].content).toContain('Eres un programador.');
    expect(r.body.messages[0].content).toContain('Herramientas');
    expect(r.body.messages[1]).toEqual({ role: 'user', content: 'haz algo' });
    expect(r.headers.authorization).toBeUndefined();
  });

  it('LM Studio: argumentos troceados con index y CRLF; el resultado vuelve como mensaje tool', async () => {
    writeFileSync(join(cwd, 'a.txt'), 'contenido A');
    script = [sseFile('lmstudio-toolcall.sse'), textSse('ok')];
    const evs = await collect(adapter(), spec());
    expect(ofType(evs, 'tool')[0]).toMatchObject({ name: 'read_file', input: { path: 'a.txt' } });
    expect(lastToolMsg()).toBe('contenido A');
    const asst = requests[1]!.body.messages.find((m: any) => m.role === 'assistant');
    expect(asst.tool_calls[0]).toMatchObject({ id: '361549378', function: { name: 'read_file' } });
    expect(requests[1]!.body.messages.find((m: any) => m.role === 'tool').tool_call_id).toBe('361549378');
  });

  it('Groq: dos tool_calls intercalados por index', async () => {
    writeFileSync(join(cwd, 'a.txt'), 'AAA');
    script = [sseFile('groq-toolcalls.sse'), textSse('fin')];
    const evs = await collect(adapter({ auth: 'bearer', apiKey: 'gsk_secret123' }), spec());
    const ends = ofType(evs, 'tool').filter((t) => t.status === 'end');
    expect(ends.map((t) => t.name)).toEqual(['list_dir', 'read_file']);
    expect(ends[0]!.output).toContain('a.txt');
    expect(ends[1]!.output).toBe('AAA');
    expect(requests[0]!.headers.authorization).toBe('Bearer gsk_secret123');
  });

  it('Gemini: extra_content.google.thought_signature se reenvía intacto en el historial', async () => {
    writeFileSync(join(cwd, 'a.txt'), 'AAA');
    script = [sseFile('gemini-thought-signature.sse'), textSse('fin')];
    const evs = await collect(adapter(), spec());
    expect(ofType(evs, 'done')).toHaveLength(1);
    const asst = requests[1]!.body.messages.find((m: any) => m.role === 'assistant');
    expect(asst.tool_calls[0].extra_content).toEqual({ google: { thought_signature: 'SIG_abc/+==' } });
    expect(asst.tool_calls[0]).toMatchObject({ id: 'c1', type: 'function', function: { name: 'list_dir', arguments: '{"path":"."}' } });
    // sin campos extra (otros proveedores) no se añade nada
    script = [callSse('list_dir', { path: '.' }), textSse('fin')];
    requests = [];
    await collect(adapter(), spec());
    const plain = requests[1]!.body.messages.find((m: any) => m.role === 'assistant');
    expect(Object.keys(plain.tool_calls[0]).sort()).toEqual(['function', 'id', 'type']);
    expect(Object.keys(plain).sort()).toEqual(['content', 'role', 'tool_calls']);
  });

  it('x-api-key va en su cabecera', async () => {
    script = [textSse('x')];
    await collect(adapter({ auth: 'x-api-key', apiKey: 'k-12345' }), spec());
    expect(requests[0]!.headers['x-api-key']).toBe('k-12345');
    expect(requests[0]!.headers.authorization).toBeUndefined();
  });

  it('fragmento SSE roto: se ignora y el resto del texto llega', async () => {
    script = [sseFile('broken.sse')];
    const evs = await collect(adapter(), spec());
    expect(ofType(evs, 'done')[0]!.text).toBe('vamos bien');
  });

  it('argumentos JSON rotos: error de herramienta devuelto al modelo con instrucción', async () => {
    script = [sseFile('broken-args.sse'), textSse('lo reintento')];
    const evs = await collect(adapter(), spec());
    const end = ofType(evs, 'tool').find((t) => t.status === 'end')!;
    expect(end.isError).toBe(true);
    expect(lastToolMsg()).toMatch(/no son JSON válido/);
    expect(ofType(evs, 'done')).toHaveLength(1);
  });

  it('herramienta inexistente: error con la lista de las disponibles', async () => {
    script = [callSse('borrar_todo', {}), textSse('ok')];
    await collect(adapter(), spec());
    expect(lastToolMsg()).toMatch(/no existe.*read_file/);
  });

  it('respuesta vacía (cuerpo sin eventos): error retryable', async () => {
    script = [sseRaw('')];
    const evs = await collect(adapter(), spec());
    expect(terminal(evs)).toEqual([expect.objectContaining({ type: 'error', retryable: true })]);
  });
});

describe('ApiLoopAdapter: errores y límites', () => {
  it('429 con Retry-After -> limit rate con resetsAt', async () => {
    script = [jsonErr(429, { error: { message: 'Rate limit reached', type: 'tokens', code: 'rate_limit_exceeded' } }, { 'retry-after': '30' })];
    script = Array(4).fill(script[0]);
    const t0 = Date.now();
    const evs = await collect(adapter({ sleep: async () => {} }), spec());
    const lim = ofType(evs, 'limit')[0]!;
    expect(lim.kind).toBe('rate');
    expect(lim.resetsAt).toBeGreaterThanOrEqual(t0 + 30_000);
    expect(lim.resetsAt).toBeLessThan(Date.now() + 31_000);
    expect(terminal(evs)).toHaveLength(1);
  });

  it('429 sin Retry-After -> limit sin resetsAt', async () => {
    script = Array(4).fill(jsonErr(429, { error: { message: 'slow down' } }));
    const lim = ofType(await collect(adapter({ sleep: async () => {} }), spec()), 'limit')[0]!;
    expect(lim.kind).toBe('rate');
    expect(lim.resetsAt).toBeUndefined();
  });

  it('insufficient_quota -> limit quota', async () => {
    script = [jsonErr(429, { error: { message: 'You exceeded your current quota', type: 'insufficient_quota', code: 'insufficient_quota' } })];
    expect(ofType(await collect(adapter(), spec()), 'limit')[0]!.kind).toBe('quota');
  });

  it('Gemini RESOURCE_EXHAUSTED (cuerpo en array) -> limit', async () => {
    script = [jsonErr(429, [{ error: { code: 429, message: 'Quota exceeded for metric', status: 'RESOURCE_EXHAUSTED' } }])];
    const lim = ofType(await collect(adapter(), spec()), 'limit')[0]!;
    expect(lim.kind).toBe('quota');
  });

  it('ECONNREFUSED -> error "no responde", no limit', async () => {
    const dead = http.createServer();
    await new Promise<void>((r) => dead.listen(0, '127.0.0.1', r));
    const port = (dead.address() as AddressInfo).port;
    await new Promise((r) => dead.close(r));
    const evs = await collect(adapter({ baseUrl: `http://127.0.0.1:${port}/v1` }), spec());
    expect(ofType(evs, 'limit')).toHaveLength(0);
    expect(terminal(evs)).toEqual([expect.objectContaining({ type: 'error', retryable: true, message: expect.stringContaining('no responde: ¿está en marcha?') })]);
  });

  it('5xx -> error (no limit)', async () => {
    script = Array(4).fill(jsonErr(503, { error: { message: 'model loading' } }));
    const evs = await collect(adapter({ sleep: async () => {} }), spec());
    expect(ofType(evs, 'limit')).toHaveLength(0);
    expect(terminal(evs)).toEqual([expect.objectContaining({ type: 'error', retryable: true })]);
  });

  describe('reintentos transitorios', () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => void waits.push(ms);
    beforeEach(() => void (waits.length = 0));
    const texts = (evs: AgentEvent[]) => ofType(evs, 'text').map((e) => e.delta).join('');
    const GEMINI = 'https://generativelanguage.googleapis.com/v1beta/openai';
    const busy = () => new Response(JSON.stringify([{ error: { code: 503, message: 'This model is currently experiencing high demand. Please try again later.' } }]), { status: 503 });

    it('503 -> 503 -> 200 completa la tarea y avisa', async () => {
      script = [jsonErr(503, { error: { message: 'busy' } }), jsonErr(503, { error: { message: 'busy' } }), textSse('listo')];
      const evs = await collect(adapter({ sleep }), spec());
      expect(terminal(evs)).toEqual([expect.objectContaining({ type: 'done', text: 'listo' })]);
      expect(requests).toHaveLength(3);
      expect(waits).toHaveLength(2);
      expect(texts(evs)).toContain('reintento 2/4 en');
      expect(texts(evs)).toContain('reintento 3/4 en');
    });

    it('el reintento no repite herramientas: el historial no cambia', async () => {
      script = [callSse('list_dir', { path: '.' }), jsonErr(502, { error: { message: 'x' } }), textSse('ok')];
      const evs = await collect(adapter({ sleep }), spec());
      expect(ofType(evs, 'tool').filter((t) => t.status === 'end')).toHaveLength(1);
      expect(requests[2]!.body.messages).toEqual(requests[1]!.body.messages);
    });

    it('503 x4 falla con mensaje final (nube: sin "modelo cargado")', async () => {
      let n = 0;
      const f = (async () => (n++, busy())) as unknown as typeof fetch;
      const evs = await collect(adapter({ baseUrl: GEMINI, fetch: f, sleep }), spec());
      expect(n).toBe(4);
      expect(waits).toHaveLength(3);
      const t = terminal(evs)[0] as any;
      expect(t.type).toBe('error');
      expect(t.retryable).toBe(true);
      expect(t.message).toContain('inténtalo más tarde o cambia de IA');
      expect(t.message).not.toContain('modelo cargado');
      expect(texts(evs)).toContain('Gemini está saturado (503); reintento 2/4 en');
    });

    it('servidor local conserva "¿Está bien el modelo cargado?"', async () => {
      script = Array(4).fill(jsonErr(500, { error: { message: 'boom' } }));
      const evs = await collect(adapter({ sleep }), spec());
      expect((terminal(evs)[0] as any).message).toContain('¿Está bien el modelo cargado?');
    });

    it('respeta Retry-After (con tope de 60 s)', async () => {
      script = [jsonErr(503, { error: { message: 'b' } }, { 'retry-after': '7' }), jsonErr(503, { error: { message: 'b' } }, { 'retry-after': '999' }), textSse('ok')];
      await collect(adapter({ sleep }), spec());
      expect(waits[0]).toBeGreaterThan(5000);
      expect(waits[0]).toBeLessThanOrEqual(7000);
      expect(waits[1]).toBe(60_000);
    });

    it('stop() durante la espera aborta sin evento terminal', async () => {
      script = [jsonErr(503, { error: { message: 'b' } }), textSse('no debe llegar')];
      const a = adapter();
      const evs: AgentEvent[] = [];
      const it = (async () => {
        for await (const e of a.start(spec())) {
          evs.push(e);
          if (e.type === 'text') void a.stop();
        }
      })();
      await it;
      expect(requests).toHaveLength(1);
      expect(terminal(evs)).toHaveLength(0);
    });

    it('429 insufficient_quota -> limit sin reintento', async () => {
      script = [jsonErr(429, { error: { message: 'You exceeded your current quota', code: 'insufficient_quota' } })];
      const evs = await collect(adapter({ sleep }), spec());
      expect(requests).toHaveLength(1);
      expect(waits).toHaveLength(0);
      expect(ofType(evs, 'limit')[0]!.kind).toBe('quota');
    });

    it('429 puntual se reintenta', async () => {
      script = [jsonErr(429, { error: { message: 'slow down' } }), textSse('ok')];
      const evs = await collect(adapter({ sleep }), spec());
      expect(terminal(evs)).toEqual([expect.objectContaining({ type: 'done' })]);
    });

    it('ECONNRESET se reintenta', async () => {
      script = [(q) => q.socket.destroy(), textSse('ok')];
      const evs = await collect(adapter({ sleep }), spec());
      expect(terminal(evs)).toEqual([expect.objectContaining({ type: 'done' })]);
      expect(requests).toHaveLength(2);
    });
  });

  it('401 -> error no retryable; la clave nunca aparece aunque el servidor la devuelva', async () => {
    const key = 'sk-SUPERSECRETO-123';
    script = [jsonErr(401, { error: { message: `Incorrect API key provided: ${key}` } })];
    const evs = await collect(adapter({ auth: 'bearer', apiKey: key }), spec());
    expect(terminal(evs)).toEqual([expect.objectContaining({ type: 'error', retryable: false })]);
    expect(JSON.stringify(evs)).not.toContain(key);
    const logged = vi.mocked(console.error).mock.calls.flat().join(' ');
    expect(logged).not.toContain(key);
  });

  it('la clave se tapa también en la salida de herramientas', async () => {
    const key = 'sk-SUPERSECRETO-123';
    writeFileSync(join(cwd, 'n.txt'), `la clave es ${key}`);
    script = [callSse('read_file', { path: 'n.txt' }), textSse('ok')];
    const evs = await collect(adapter({ auth: 'bearer', apiKey: key }), spec());
    expect(JSON.stringify(evs)).not.toContain(key);
    expect(JSON.stringify(requests[1]!.body)).not.toContain(key);
  });

  it('redirección -> error (redirect: error)', async () => {
    script = [(_q, res) => res.writeHead(302, { location: 'http://127.0.0.1:1/x' }).end()];
    const evs = await collect(adapter(), spec());
    expect(terminal(evs)).toEqual([expect.objectContaining({ type: 'error', message: expect.stringMatching(/redirecci/) })]);
  });

  it('maxTurns: tras 40 turnos con herramientas, error', async () => {
    script = Array.from({ length: MAX_TURNS + 5 }, () => callSse('list_dir', {}));
    const evs = await collect(adapter(), spec());
    expect(requests).toHaveLength(MAX_TURNS);
    expect(terminal(evs)).toEqual([expect.objectContaining({ type: 'error', message: expect.stringContaining('40') })]);
  });
});

describe('ApiLoopAdapter: herramientas y permisos', () => {
  it('rm -rf -> permission_request; allow lo ejecuta', async () => {
    mkdirSync(join(cwd, 'build'));
    writeFileSync(join(cwd, 'build', 'x'), '1');
    script = [callSse('run_command', { command: 'rm -rf build' }), textSse('borrado')];
    const a = adapter();
    const evs = await collect(a, spec(), (e) => {
      if (e.type === 'permission_request') {
        expect(existsSync(join(cwd, 'build'))).toBe(true); // aún no se ejecutó
        a.answerPermission(e.id, true);
      }
    });
    const pr = ofType(evs, 'permission_request')[0]!;
    expect(pr).toMatchObject({ tool: 'run_command', input: { command: 'rm -rf build' }, risk: 'ask' });
    expect(existsSync(join(cwd, 'build'))).toBe(false);
  });

  it('rm -rf -> deny: no se ejecuta y el modelo recibe el motivo', async () => {
    mkdirSync(join(cwd, 'build'));
    script = [callSse('run_command', { command: 'rm -rf build' }), textSse('vale')];
    const a = adapter();
    const evs = await collect(a, spec(), (e) => e.type === 'permission_request' && a.answerPermission(e.id, false, 'no'));
    expect(existsSync(join(cwd, 'build'))).toBe(true);
    expect(ofType(evs, 'tool').find((t) => t.status === 'end')!.isError).toBe(true);
    expect(lastToolMsg()).toMatch(/denegó.*no/);
  });

  it('comando "never" -> deny sin preguntar', async () => {
    script = [callSse('run_command', { command: 'rm -rf /' }), textSse('vale')];
    const evs = await collect(adapter(), spec());
    expect(ofType(evs, 'permission_request')).toHaveLength(0);
    expect(lastToolMsg()).toMatch(/prohibida/);
  });

  it('comando "ok" se ejecuta en el cwd', async () => {
    script = [callSse('run_command', { command: 'pwd' }), textSse('vale')];
    await collect(adapter(), spec());
    expect(lastToolMsg().trim()).toBe(cwd);
  });

  it('escribir fuera de allowedPaths -> deny con la lista', async () => {
    script = [callSse('write_file', { path: 'otro.txt', content: 'x' }), textSse('vale')];
    const evs = await collect(adapter(), spec());
    expect(existsSync(join(cwd, 'otro.txt'))).toBe(false);
    expect(ofType(evs, 'tool').find((t) => t.status === 'end')!.isError).toBe(true);
    expect(lastToolMsg()).toMatch(/no está entre tus archivos asignados.*hola\.txt/);
  });

  it('edit_file: reemplaza una vez y avisa si es ambiguo o no existe', async () => {
    writeFileSync(join(cwd, 'hola.txt'), 'uno dos uno');
    script = [
      callSse('edit_file', { path: 'hola.txt', old_string: 'uno', new_string: 'X' }),
      callSse('edit_file', { path: 'hola.txt', old_string: 'dos', new_string: 'Y' }),
      callSse('edit_file', { path: 'hola.txt', old_string: 'nada', new_string: 'Z' }),
      textSse('fin'),
    ];
    await collect(adapter(), spec());
    expect(requests[1]!.body.messages.at(-1).content).toMatch(/2 veces/);
    expect(readFileSync(join(cwd, 'hola.txt'), 'utf8')).toBe('uno Y uno');
    expect(requests[3]!.body.messages.at(-1).content).toMatch(/no aparece/);
  });

  it('symlink que sale del cwd -> deny en lectura y escritura', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'kiji-out-')));
    try {
      writeFileSync(join(outside, 'secreto.txt'), 'FUERA');
      symlinkSync(outside, join(cwd, 'enlace'));
      symlinkSync(join(outside, 'secreto.txt'), join(cwd, 'hola.txt'));
      script = [
        callSse('read_file', { path: 'enlace/secreto.txt' }),
        callSse('write_file', { path: 'hola.txt', content: 'pisado' }),
        callSse('list_dir', { path: 'enlace' }),
        textSse('fin'),
      ];
      await collect(adapter(), spec());
      expect(readFileSync(join(outside, 'secreto.txt'), 'utf8')).toBe('FUERA');
      expect(requests[1]!.body.messages.at(-1).content).toMatch(/fuera del proyecto/);
      expect(requests[2]!.body.messages.at(-1).content).toMatch(/fuera del proyecto/);
      expect(requests[3]!.body.messages.at(-1).content).toMatch(/fuera del proyecto/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('rutas absolutas y con .. fuera del cwd -> deny', async () => {
    script = [callSse('read_file', { path: '/etc/hosts' }), callSse('read_file', { path: '../x' }), textSse('fin')];
    await collect(adapter(), spec());
    expect(requests[1]!.body.messages.at(-1).content).toMatch(/fuera del proyecto/);
    expect(requests[2]!.body.messages.at(-1).content).toMatch(/fuera del proyecto/);
  });

  it('read_file y grep nunca leen .env ni credenciales', async () => {
    writeFileSync(join(cwd, '.env'), 'TOKEN=abc123');
    writeFileSync(join(cwd, 'ok.txt'), 'TOKEN=visible');
    mkdirSync(join(cwd, '.ssh'));
    writeFileSync(join(cwd, '.ssh', 'id_rsa'), 'TOKEN=privada');
    script = [callSse('read_file', { path: '.env' }), callSse('grep', { pattern: 'TOKEN' }), callSse('read_file', { path: '.ssh/id_rsa' }), textSse('fin')];
    await collect(adapter(), spec());
    expect(requests[1]!.body.messages.at(-1).content).toMatch(/sensible/);
    const g = requests[2]!.body.messages.at(-1).content;
    expect(g).toContain('ok.txt:1:TOKEN=visible');
    expect(g).not.toContain('abc123');
    expect(g).not.toContain('privada');
    expect(requests[3]!.body.messages.at(-1).content).toMatch(/sensible/);
  });

  it('grep con un patrón catastrófico (a+)+$ termina rápido y sin bloquear', async () => {
    writeFileSync(join(cwd, 'bomba.txt'), `${'a'.repeat(5000)}b\n`);
    writeFileSync(join(cwd, 'hola.txt'), 'hola mundo\n');
    mkdirSync(join(cwd, '.git'));
    writeFileSync(join(cwd, '.git', 'x.txt'), 'hola secreto\n');
    script = [callSse('grep', { pattern: '(a+)+$' }), callSse('grep', { pattern: '-e hola' }), callSse('grep', { pattern: 'hola' }), callSse('grep', { pattern: '(' }), textSse('fin')];
    const t0 = Date.now();
    await collect(adapter(), spec());
    expect(Date.now() - t0).toBeLessThan(8000);
    expect(requests[1]!.body.messages.at(-1).content).toBe('Sin coincidencias.'); // termina, sin colgarse
    expect(requests[2]!.body.messages.at(-1).content).toBe('Sin coincidencias.'); // el patrón empieza por "-": no es una opción
    const g = requests[3]!.body.messages.at(-1).content;
    expect(g).toContain('hola.txt:1:hola mundo');
    expect(g).not.toContain('.git');
    expect(requests[4]!.body.messages.at(-1).content).toMatch(/no válida|error de grep/);
  });

  it('read_file rechaza archivos de más de 2 MB y binarios, con mensaje claro', async () => {
    writeFileSync(join(cwd, 'grande.txt'), 'x'.repeat(2 * 1024 * 1024 + 1));
    writeFileSync(join(cwd, 'img.bin'), Buffer.from([1, 2, 0, 3]));
    writeFileSync(join(cwd, 'ok.txt'), 'texto');
    script = [callSse('read_file', { path: 'grande.txt' }), callSse('read_file', { path: 'img.bin' }), callSse('read_file', { path: 'ok.txt' }), textSse('fin')];
    await collect(adapter(), spec());
    expect(requests[1]!.body.messages.at(-1).content).toMatch(/límite es 2048 KB/);
    expect(requests[2]!.body.messages.at(-1).content).toMatch(/binario/);
    expect(requests[3]!.body.messages.at(-1).content).toBe('texto');
  });

  it('readOnly: solo ofrece read_file, list_dir y grep, y rechaza el resto', async () => {
    script = [callSse('write_file', { path: 'hola.txt', content: 'x' }), callSse('run_command', { command: 'pwd' }), textSse('fin')];
    await collect(adapter(), spec({ readOnly: true }));
    expect(requests[0]!.body.tools.map((t: any) => t.function.name)).toEqual(['read_file', 'list_dir', 'grep']);
    expect(existsSync(join(cwd, 'hola.txt'))).toBe(false);
    expect(requests[1]!.body.messages.at(-1).content).toMatch(/solo lectura/);
    expect(requests[2]!.body.messages.at(-1).content).toMatch(/solo lectura/);
  });

  it('recorta la salida de herramientas a 4000 caracteres', async () => {
    writeFileSync(join(cwd, 'big.txt'), 'x'.repeat(20_000));
    script = [callSse('run_command', { command: 'cat big.txt' }), callSse('read_file', { path: 'big.txt' }), textSse('fin')];
    const evs = await collect(adapter(), spec());
    for (const t of ofType(evs, 'tool').filter((t) => t.status === 'end')) {
      expect(t.output!.length).toBeLessThan(4200);
      expect(t.output).toContain('recortada');
      expect(t.output!.startsWith('x'.repeat(4000))).toBe(true);
    }
  });
});

describe('ApiLoopAdapter: rescate weak', () => {
  const textCall = '{"name":"write_file","arguments":{"path":"hola.txt","content":"rescatado"}}';

  it('weak: un JSON {name, arguments} en el texto se ejecuta una vez, con log', async () => {
    script = [textSse(`Voy a escribir:\n\`\`\`json\n${textCall}\n${textCall}\n\`\`\``), textSse('listo')];
    const evs = await collect(adapter({ toolQuality: 'weak' }), spec());
    expect(readFileSync(join(cwd, 'hola.txt'), 'utf8')).toBe('rescatado');
    expect(ofType(evs, 'tool').filter((t) => t.status === 'end')).toHaveLength(1);
    expect(vi.mocked(console.error).mock.calls.flat().join(' ')).toMatch(/rescate weak/);
    expect(ofType(evs, 'done')[0]!.text).toBe('listo');
  });

  it('unknown también rescata; ok no', async () => {
    script = [textSse(textCall), textSse('listo')];
    await collect(adapter({ toolQuality: 'unknown' }), spec());
    expect(existsSync(join(cwd, 'hola.txt'))).toBe(true);
    rmSync(join(cwd, 'hola.txt'));
    script = [textSse(textCall)];
    const evs = await collect(adapter({ toolQuality: 'ok' }), spec());
    expect(existsSync(join(cwd, 'hola.txt'))).toBe(false);
    expect(ofType(evs, 'done')[0]!.text).toBe(textCall);
  });

  it('rescueToolCall: ignora nombres desconocidos y acepta arguments como string', () => {
    expect(rescueToolCall('{"name":"rm","arguments":{}}', false)).toBeNull();
    expect(rescueToolCall('texto sin json', false)).toBeNull();
    expect(rescueToolCall('{"name":"read_file","arguments":"{\\"path\\":\\"a\\"}"}', false)).toEqual({ name: 'read_file', arguments: { path: 'a' } });
    expect(rescueToolCall('{"name":"write_file","arguments":{}}', true)).toBeNull();
  });
});

describe('ApiLoopAdapter: hilo', () => {
  it('send() añade un mensaje de usuario durante el run', async () => {
    const a = adapter();
    script = [
      (q, res, b) => {
        void a.send('cambio de planes');
        callSse('list_dir', {})(q, res, b);
      },
      textSse('ok'),
    ];
    await collect(a, spec());
    const last = requests[1]!.body.messages.at(-1);
    expect(last).toEqual({ role: 'user', content: 'cambio de planes' });
    await expect(a.send('tarde')).rejects.toThrow();
  });

  it('prompt_tokens > 80 % del contexto: resume el hilo, avisa y sigue con el historial reducido', async () => {
    script = [
      callSse('list_dir', {}, 900, 5),
      textSse('RESUMEN: se listó la carpeta', 910, 20),
      textSse('terminado', 100, 3),
    ];
    const evs = await collect(adapter({ contextWindow: 1000 }), spec());
    expect(requests).toHaveLength(3);
    expect(requests[1]!.body.tool_choice).toBe('none');
    expect(requests[1]!.body.messages.at(-1).content).toMatch(/Resume/);
    const third = requests[2]!.body.messages;
    expect(third.map((m: any) => m.role)).toEqual(['system', 'user']);
    expect(third[1].content).toContain('RESUMEN: se listó la carpeta');
    expect(third[1].content).toContain('haz algo');
    const texts = ofType(evs, 'text').map((t) => t.delta).join('');
    expect(texts).toMatch(/se resumió el hilo/);
    expect(ofType(evs, 'done')[0]!.text).toBe('terminado');
    // el resumen no se emite como texto del agente
    expect(texts).not.toContain('RESUMEN');
  });

  it('stop() corta una petición colgada sin emitir evento terminal', async () => {
    let opened!: () => void;
    const hung = new Promise<void>((r) => (opened = r));
    script = [
      (_q, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(chunk({ content: 'empiezo' }));
        opened();
      },
    ];
    const a = adapter();
    const evs: AgentEvent[] = [];
    const run = (async () => {
      for await (const e of a.start(spec())) evs.push(e);
    })();
    await hung;
    await a.stop();
    await run;
    expect(terminal(evs)).toHaveLength(0);
    await expect(a.send('x')).rejects.toThrow();
  });

  it('stop() mientras espera permiso: deniega y termina', async () => {
    script = [callSse('run_command', { command: 'rm -rf algo' })];
    const a = adapter();
    const evs: AgentEvent[] = [];
    for await (const e of a.start(spec())) {
      evs.push(e);
      if (e.type === 'permission_request') await a.stop();
    }
    expect(terminal(evs)).toHaveLength(0);
  });

  it('un adaptador = un run', () => {
    script = [textSse('x')];
    const a = adapter();
    a.start(spec());
    expect(() => a.start(spec())).toThrow();
  });
});
