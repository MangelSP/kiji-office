// Integración: commit, rebase, tests, fast-forward merge y revert. Solo la hace el core a nombre del jefe.
import { execFile, type ExecFileOptions } from 'node:child_process';
import { resolve } from 'node:path';
import { assertSafeRef, GitError, NO_SIGN, runGit, runGitRaw } from './run.js';

/** Hace `add -A` y commit en el worktree. Devuelve el sha del commit, o `null` si no había cambios. */
export async function commitAll(worktree: string, message: string): Promise<string | null> {
  const cwd = resolve(worktree);
  await runGit(cwd, ['add', '-A']);
  const status = await runGit(cwd, ['status', '--porcelain', '--untracked-files=no']);
  if (status.trim() === '') return null;
  await runGit(cwd, [...NO_SIGN, 'commit', '-m', message]);
  return (await runGit(cwd, ['rev-parse', 'HEAD'])).trim();
}

export type RebaseResult = { ok: true } | { ok: false; conflicts: string[] };

/**
 * `git rebase <base>` en el worktree. Si hay conflicto, lista los archivos en conflicto, hace
 * `rebase --abort` (el worktree queda como antes) y devuelve `{ ok: false, conflicts }`.
 * Si falla por otra causa (p. ej. cambios sin commit), lanza el error de git.
 */
export async function rebaseOnto(worktree: string, base: string): Promise<RebaseResult> {
  assertSafeRef(base, 'base');
  const cwd = resolve(worktree);
  const r = await runGitRaw(cwd, [...NO_SIGN, 'rebase', base]);
  if (r.exitCode === 0) return { ok: true };
  const unmerged = await runGitRaw(cwd, ['diff', '--name-only', '--diff-filter=U', '-z']);
  const conflicts = unmerged.stdout.split('\0').filter(Boolean).sort();
  // Se intenta abortar siempre: si no había rebase en curso, el error se ignora y se lanza el original.
  const abort = await runGitRaw(cwd, ['rebase', '--abort']);
  if (conflicts.length > 0) {
    if (abort.exitCode !== 0) {
      throw new GitError(`git rebase --abort falló: ${abort.stderr.trim()}`, ['rebase', '--abort'], cwd, abort.exitCode, abort.stdout, abort.stderr);
    }
    return { ok: false, conflicts };
  }
  throw new GitError(`git rebase ${base} falló (código ${r.exitCode}): ${r.stderr.trim() || r.stdout.trim()}`, ['rebase', base], cwd, r.exitCode, r.stdout, r.stderr);
}

export interface TestRunResult {
  /** Código de salida del comando (124 si superó el tiempo, 127 si no se pudo lanzar). */
  exitCode: number;
  /** stdout y stderr intercalados, recortados a los últimos 64 KB. */
  output: string;
  timedOut: boolean;
}

export const TEST_OUTPUT_LIMIT = 64 * 1024;

const SHELL_OPERATORS = new Set(['&&', '||', '|', ';', '&', '>', '>>', '<', '2>&1']);

/**
 * Parte un comando en argv SIN intérprete de comandos: separa por espacios en blanco y respeta
 * comillas simples y dobles (el contenido entre comillas es un solo argumento, sin escapes ni
 * expansión de variables, globs, `~` ni sustitución). `npm test -- --run` -> ['npm','test','--','--run'].
 * Los operadores de shell (`&&`, `|`, `;`, `>`...) como argumento independiente se rechazan con un error claro.
 */
export function splitCommand(command: string): string[] {
  const argv: string[] = [];
  let cur = '';
  let inToken = false;
  let quote: '"' | "'" | null = null;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
    } else if (/\s/.test(ch)) {
      if (inToken) argv.push(cur);
      cur = '';
      inToken = false;
    } else {
      cur += ch;
      inToken = true;
    }
  }
  if (quote) throw new Error(`comando con comillas sin cerrar: ${command}`);
  if (inToken) argv.push(cur);
  if (argv.length === 0) throw new Error('el comando de tests está vacío');
  const op = argv.find((a) => SHELL_OPERATORS.has(a));
  if (op) throw new Error(`el comando de tests no admite operadores de shell (${op}); usa un script de package.json`);
  return argv;
}

/** Cola de salida con tope: conserva el final y recorta por el principio sin partir caracteres UTF-8. */
class TailBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  private dropped = false;
  constructor(private readonly limit: number) {}
  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    if (this.size > this.limit * 2) this.trim();
  }
  private trim(): void {
    const all = Buffer.concat(this.chunks);
    let start = Math.max(0, all.length - this.limit);
    if (start > 0) {
      this.dropped = true;
      while (start < all.length && (all[start]! & 0xc0) === 0x80) start++; // salta bytes de continuación
    }
    this.chunks = [all.subarray(start)];
    this.size = this.chunks[0]!.length;
  }
  toString(): string {
    this.trim();
    const text = this.chunks[0]?.toString('utf8') ?? '';
    return this.dropped ? `[... salida recortada, se conservan los últimos ${this.limit} bytes ...]\n${text}` : text;
  }
}

/**
 * Corre el comando de tests del proyecto en el worktree, sin shell (ver `splitCommand`), con tiempo máximo.
 * Nunca lanza por un fallo del comando: devuelve su `exitCode` y la salida. Al vencer el tiempo mata todo el
 * grupo de procesos (en POSIX) para no dejar hijos huérfanos.
 */
export function runTests(worktree: string, command: string, timeoutMs: number): Promise<TestRunResult> {
  const [file, ...args] = splitCommand(command);
  const tail = new TailBuffer(TEST_OUTPUT_LIMIT);
  const posix = process.platform !== 'win32';
  return new Promise((resolvePromise) => {
    let timedOut = false;
    const child = execFile(
      file!,
      args,
      // `detached` lo acepta execFile en ejecución (lo pasa a spawn) pero no está en sus tipos.
      { cwd: resolve(worktree), maxBuffer: 16 * 1024 * 1024, env: process.env, detached: posix, windowsHide: true } as ExecFileOptions,
      (err) => {
        clearTimeout(timer);
        let exitCode = 0;
        if (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (typeof code === 'number') exitCode = code;
          else if (timedOut) exitCode = 124;
          else if (code === 'ENOENT' || code === 'EACCES') {
            exitCode = 127;
            tail.push(Buffer.from(`no se pudo ejecutar "${file}": ${err.message}\n`));
          } else exitCode = 1;
        }
        resolvePromise({ exitCode, output: tail.toString(), timedOut });
      },
    );
    child.stdout?.on('data', (d: Buffer | string) => tail.push(Buffer.from(d)));
    child.stderr?.on('data', (d: Buffer | string) => tail.push(Buffer.from(d)));
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (posix && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, timeoutMs);
  });
}

export interface MergeResult {
  beforeSha: string;
  afterSha: string;
}

export interface MergeOptions {
  /** Si se indica, el repo principal debe estar en esta rama (la rama base del proyecto). */
  expectedBase?: string;
}

/**
 * `git merge --ff-only <branch>` en el repo principal. Exige: HEAD en una rama (no desacoplado), que sea
 * `expectedBase` si se da, y que no haya cambios en archivos rastreados. Falla (sin tocar nada) si no es fast-forward.
 */
export async function mergeFfOnly(repo: string, branch: string, opts: MergeOptions = {}): Promise<MergeResult> {
  assertSafeRef(branch, 'rama');
  const cwd = resolve(repo);
  const head = await runGitRaw(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']);
  const current = head.stdout.trim();
  if (head.exitCode !== 0 || current === '') {
    throw new Error('el repo principal está en HEAD desacoplado: debe estar en la rama base para integrar');
  }
  if (opts.expectedBase && current !== opts.expectedBase) {
    throw new Error(`el repo principal está en "${current}" y debería estar en la rama base "${opts.expectedBase}"`);
  }
  const dirty = (await runGit(cwd, ['status', '--porcelain', '--untracked-files=no'])).trim();
  if (dirty !== '') {
    throw new Error(`el repo principal tiene cambios sin guardar; límpialo antes de integrar:\n${dirty}`);
  }
  const beforeSha = (await runGit(cwd, ['rev-parse', 'HEAD'])).trim();
  const r = await runGitRaw(cwd, [...NO_SIGN, 'merge', '--ff-only', branch]);
  if (r.exitCode !== 0) {
    throw new GitError(
      `no se pudo integrar "${branch}" en "${current}" (¿no es fast-forward? haz rebase primero): ${r.stderr.trim() || r.stdout.trim()}`,
      ['merge', '--ff-only', branch],
      cwd,
      r.exitCode,
      r.stdout,
      r.stderr,
    );
  }
  const afterSha = (await runGit(cwd, ['rev-parse', 'HEAD'])).trim();
  return { beforeSha, afterSha };
}

const SHA_RE = /^[0-9a-f]{7,64}$/;

/**
 * Deshace una integración: `git revert --no-edit before..after` (crea un commit de revert por cada commit
 * del rango, el más nuevo primero). Si el revert entra en conflicto lo aborta y lanza el error.
 * Devuelve el sha de HEAD resultante.
 */
export async function revertRange(repo: string, beforeSha: string, afterSha: string): Promise<string> {
  if (!SHA_RE.test(beforeSha) || !SHA_RE.test(afterSha)) throw new Error('sha no válido para revertRange');
  const cwd = resolve(repo);
  if (beforeSha !== afterSha) {
    const r = await runGitRaw(cwd, [...NO_SIGN, 'revert', '--no-edit', `${beforeSha}..${afterSha}`]);
    if (r.exitCode !== 0) {
      await runGitRaw(cwd, ['revert', '--abort']);
      throw new GitError(
        `git revert ${beforeSha}..${afterSha} falló (código ${r.exitCode}): ${r.stderr.trim() || r.stdout.trim()}`,
        ['revert', `${beforeSha}..${afterSha}`],
        cwd,
        r.exitCode,
        r.stdout,
        r.stderr,
      );
    }
  }
  return (await runGit(cwd, ['rev-parse', 'HEAD'])).trim();
}
