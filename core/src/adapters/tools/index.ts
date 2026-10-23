// Las seis herramientas del adaptador `api-loop` (PLAN-0.2b, D14). Se ejecutan dentro de `cwd`; cada
// escritura pasa por isPathAllowed y cada comando por classifyCommand (mismas reglas que el adaptador de Claude).

import { spawn } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { classifyCommand, classifyPath, isInsideCwd, isPathAllowed } from '../classify.js';

export const MAX_TOOL_OUTPUT = 4000;
export const COMMAND_TIMEOUT_MS = 60_000;

export type ToolName = 'read_file' | 'write_file' | 'edit_file' | 'list_dir' | 'grep' | 'run_command';
export const READ_ONLY_TOOL_NAMES: ToolName[] = ['read_file', 'list_dir', 'grep'];
export const ALL_TOOL_NAMES: ToolName[] = ['read_file', 'write_file', 'edit_file', 'list_dir', 'grep', 'run_command'];

export type ToolResult = { output: string; isError: boolean };

export type ToolContext = {
  cwd: string;
  allowedPaths: string[];
  signal: AbortSignal;
  /** Pide confirmación al usuario (permission_request). */
  ask: (tool: string, input: Record<string, unknown>) => Promise<{ allow: boolean; reason?: string }>;
  /** Tapa secretos en cualquier texto que salga de la herramienta. */
  redact: (s: string) => string;
};

const fn = (name: string, description: string, properties: Record<string, unknown>, required: string[]) => ({
  type: 'function' as const,
  function: { name, description, parameters: { type: 'object', properties, required } },
});

const DEFS: Record<ToolName, ReturnType<typeof fn>> = {
  read_file: fn('read_file', 'Lee un archivo de texto del proyecto.', { path: { type: 'string', description: 'Ruta relativa al proyecto' } }, ['path']),
  write_file: fn(
    'write_file',
    'Crea o sobrescribe un archivo (solo tus archivos asignados).',
    { path: { type: 'string' }, content: { type: 'string' } },
    ['path', 'content'],
  ),
  edit_file: fn(
    'edit_file',
    'Sustituye un fragmento exacto de un archivo (solo tus archivos asignados).',
    { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } },
    ['path', 'old_string', 'new_string'],
  ),
  list_dir: fn('list_dir', 'Lista el contenido de una carpeta.', { path: { type: 'string', description: 'Por defecto "."' } }, []),
  grep: fn(
    'grep',
    'Busca una expresión regular en los archivos de una carpeta.',
    { pattern: { type: 'string' }, path: { type: 'string', description: 'Por defecto "."' } },
    ['pattern'],
  ),
  run_command: fn('run_command', 'Ejecuta un comando de shell en el proyecto.', { command: { type: 'string' } }, ['command']),
};

export function toolDefinitions(readOnly: boolean) {
  return (readOnly ? READ_ONLY_TOOL_NAMES : ALL_TOOL_NAMES).map((n) => DEFS[n]);
}

export const isToolName = (n: unknown): n is ToolName => typeof n === 'string' && Object.hasOwn(DEFS, n);

export function truncate(s: string, max = MAX_TOOL_OUTPUT): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n…[salida recortada: ${s.length - max} caracteres más]`;
}

const ok = (output: string): ToolResult => ({ output, isError: false });
const fail = (msg: string): ToolResult => ({ output: msg, isError: true });
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

const OUTSIDE = (p: string) => `La ruta ${p} queda fuera del proyecto. Usa rutas relativas dentro del proyecto.`;
const SENSITIVE = (p: string) => `No se puede acceder a ${p}: es un archivo sensible (credenciales o secretos). Continúa sin él.`;

export async function runTool(
  name: string,
  rawArgs: unknown,
  readOnly: boolean,
  ctx: ToolContext,
): Promise<ToolResult> {
  if (!isToolName(name)) {
    return fail(`La herramienta "${name}" no existe. Herramientas disponibles: ${(readOnly ? READ_ONLY_TOOL_NAMES : ALL_TOOL_NAMES).join(', ')}.`);
  }
  if (readOnly && !READ_ONLY_TOOL_NAMES.includes(name)) {
    return fail(`Este agente es de solo lectura: solo puede usar ${READ_ONLY_TOOL_NAMES.join(', ')}.`);
  }
  if (typeof rawArgs !== 'object' || rawArgs === null || Array.isArray(rawArgs)) {
    return fail(`Los argumentos de ${name} deben ser un objeto JSON. Vuelve a llamar a la herramienta con argumentos válidos.`);
  }
  const a = rawArgs as Record<string, unknown>;
  try {
    const r = await run(name, a, ctx);
    // run_command ya recorta su salida (deja el aviso de timeout/código al final)
    return { output: ctx.redact(name === 'run_command' ? r.output : truncate(r.output)), isError: r.isError };
  } catch (e) {
    return fail(ctx.redact(`Error al ejecutar ${name}: ${e instanceof Error ? e.message : String(e)}. Revisa los argumentos e inténtalo de nuevo.`));
  }
}

async function run(name: ToolName, a: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const { cwd } = ctx;
  switch (name) {
    case 'read_file': {
      const p = str(a.path);
      if (!p) return fail('Falta el argumento "path" (string).');
      if (!isInsideCwd(p, cwd)) return fail(OUTSIDE(p));
      if (classifyPath(p) !== 'ok') return fail(SENSITIVE(p));
      const abs = path.resolve(cwd, p);
      if (!statSync(abs).isFile()) return fail(`${p} no es un archivo. Usa list_dir para carpetas.`);
      return ok(readFileSync(abs, 'utf8'));
    }
    case 'list_dir': {
      const p = str(a.path) || '.';
      if (!isInsideCwd(p, cwd)) return fail(OUTSIDE(p));
      if (classifyPath(p) !== 'ok') return fail(SENSITIVE(p));
      const abs = path.resolve(cwd, p);
      const lines = readdirSync(abs, { withFileTypes: true })
        .filter((d) => classifyPath(d.name) === 'ok')
        .map((d) => (d.isDirectory() ? `${d.name}/` : d.name))
        .sort();
      return ok(lines.join('\n') || '(carpeta vacía)');
    }
    case 'grep': {
      const pattern = str(a.pattern);
      if (!pattern) return fail('Falta el argumento "pattern" (string).');
      let re: RegExp;
      try {
        re = new RegExp(pattern);
      } catch (e) {
        return fail(`Expresión regular no válida: ${(e as Error).message}`);
      }
      const p = str(a.path) || '.';
      if (!isInsideCwd(p, cwd)) return fail(OUTSIDE(p));
      if (classifyPath(p) !== 'ok') return fail(SENSITIVE(p));
      return ok(grep(re, path.resolve(cwd, p), cwd));
    }
    case 'write_file': {
      const p = str(a.path);
      if (!p || typeof a.content !== 'string') return fail('Faltan los argumentos "path" y "content" (strings).');
      const deny = await writeGate(p, ctx);
      if (deny) return fail(deny);
      const abs = path.resolve(cwd, p);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, a.content);
      return ok(`Escrito ${p} (${a.content.length} caracteres).`);
    }
    case 'edit_file': {
      const p = str(a.path);
      const oldS = str(a.old_string);
      if (!p || !oldS || typeof a.new_string !== 'string') return fail('Faltan "path", "old_string" (no vacío) y "new_string".');
      const deny = await writeGate(p, ctx);
      if (deny) return fail(deny);
      const abs = path.resolve(cwd, p);
      const text = readFileSync(abs, 'utf8');
      const n = text.split(oldS).length - 1;
      if (n === 0) return fail(`old_string no aparece en ${p}. Lee el archivo con read_file y copia el fragmento exacto.`);
      if (n > 1) return fail(`old_string aparece ${n} veces en ${p}. Incluye más contexto para que sea único.`);
      writeFileSync(abs, text.replace(oldS, () => a.new_string as string));
      return ok(`Editado ${p}.`);
    }
    case 'run_command': {
      const cmd = str(a.command);
      if (!cmd) return fail('Falta el argumento "command" (string).');
      const risk = classifyCommand(cmd);
      if (risk === 'never') return fail('Acción prohibida: ese comando está en la lista de acciones que nunca se ejecutan. Busca otra forma.');
      if (risk === 'ask') {
        const r = await ctx.ask('run_command', { command: cmd });
        if (!r.allow) return fail(`El usuario denegó el comando${r.reason ? `: ${r.reason}` : ''}. No lo repitas; prueba otra cosa.`);
      }
      return execCommand(cmd, ctx);
    }
  }
}

/** null = se puede escribir; si no, el mensaje de denegación para el modelo. */
async function writeGate(p: string, ctx: ToolContext): Promise<string | null> {
  if (!isInsideCwd(p, ctx.cwd)) return OUTSIDE(p);
  if (!isPathAllowed(p, ctx.allowedPaths, ctx.cwd)) {
    const list = ctx.allowedPaths.join(', ') || '(ninguno)';
    return `No puedes modificar ${p}: no está entre tus archivos asignados. Archivos permitidos: ${list}.`;
  }
  const risk = classifyPath(p);
  if (risk === 'never') return `Acción prohibida: ${p} es un archivo sensible.`;
  if (risk === 'ask') {
    const r = await ctx.ask('write_file', { path: p });
    if (!r.allow) return `El usuario denegó modificar ${p}${r.reason ? `: ${r.reason}` : ''}.`;
  }
  return null;
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'target']);
const MAX_MATCHES = 100;

function grep(re: RegExp, start: string, cwd: string): string {
  const out: string[] = [];
  const visit = (abs: string): void => {
    if (out.length >= MAX_MATCHES) return;
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) {
      if (!isInsideCwd(abs, cwd)) return;
    }
    const rel = path.relative(cwd, abs) || '.';
    if (rel !== '.' && classifyPath(rel) !== 'ok') return;
    const real = statSync(abs);
    if (real.isDirectory()) {
      if (SKIP_DIRS.has(path.basename(abs)) && abs !== start) return;
      for (const e of readdirSync(abs).sort()) visit(path.join(abs, e));
      return;
    }
    if (!real.isFile() || real.size > 1_000_000) return;
    const text = readFileSync(abs, 'utf8');
    if (text.includes('\0')) return;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length && out.length < MAX_MATCHES; i++) {
      if (re.test(lines[i]!)) out.push(`${rel}:${i + 1}:${lines[i]!.slice(0, 300)}`);
    }
  };
  visit(start);
  return out.length ? out.join('\n') : 'Sin coincidencias.';
}

/** Elimina del entorno heredado lo que parece un secreto: el comando del agente no debe poder imprimirlo. */
export function safeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (!/KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL/i.test(k)) out[k] = v;
  return out;
}

// classifyCommand analiza sintaxis de shell (pipes, &&, redirecciones), así que se ejecuta con `sh -c`.
function execCommand(cmd: string, ctx: ToolContext, timeoutMs = COMMAND_TIMEOUT_MS): Promise<ToolResult> {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', cmd], { cwd: ctx.cwd, env: safeEnv(), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    let timedOut = false;
    const add = (d: Buffer) => {
      if (buf.length < MAX_TOOL_OUTPUT * 4) buf += d.toString('utf8'); // se corta al final; no acumula sin límite
    };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const killTree = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeoutMs);
    const onAbort = () => killTree();
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    const end = (r: ToolResult) => {
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onAbort);
      resolve(r);
    };
    child.on('error', (e) => end(fail(`No se pudo ejecutar el comando: ${e.message}`)));
    child.on('close', (code, sig) => {
      if (timedOut) return end(fail(truncate(`${buf}\nEl comando superó ${Math.round(timeoutMs / 1000)} s y se canceló.`)));
      if (code === 0) return end(ok(truncate(buf) || '(sin salida)'));
      end(fail(truncate(`${buf}\n[código de salida ${code ?? sig}]`)));
    });
  });
}
