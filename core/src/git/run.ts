// Ejecución de git sin intérprete de comandos: solo `execFile` con argv en array,
// `cwd` explícito y `timeout` en cada llamada. Los errores incluyen el stderr de git.
import { execFile } from 'node:child_process';

/** Tiempo máximo por defecto de una llamada a git (ms). */
export const DEFAULT_GIT_TIMEOUT_MS = 60_000;

/** Máximo de salida que aceptamos de git (p. ej. un `diff` grande). */
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

export class GitError extends Error {
  constructor(
    message: string,
    readonly args: readonly string[],
    readonly cwd: string,
    readonly exitCode: number | null,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

export interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface GitOptions {
  timeoutMs?: number;
}

/** Entorno no interactivo: git nunca debe quedarse esperando un editor ni una credencial. */
function gitEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_EDITOR: 'true', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' };
}

/**
 * Ejecuta `git <args>` en `cwd` y devuelve stdout/stderr/exitCode **sin lanzar** si git sale con
 * código distinto de 0. Sí lanza GitError si git no se pudo ejecutar o superó el timeout.
 */
export function runGitRaw(cwd: string, args: readonly string[], opts: GitOptions = {}): Promise<GitResult> {
  const timeout = opts.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...args],
      { cwd, timeout, maxBuffer: GIT_MAX_BUFFER, env: gitEnv(), encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (!err) return resolve({ exitCode: 0, stdout, stderr });
        const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
        if (typeof e.code === 'number') return resolve({ exitCode: e.code, stdout, stderr });
        const why = e.killed ? `superó el tiempo máximo (${timeout} ms)` : e.message;
        reject(new GitError(`git ${args.join(' ')} no se pudo ejecutar: ${why}\n${stderr}`.trim(), args, cwd, null, stdout, stderr));
      },
    );
  });
}

/** Como `runGitRaw`, pero lanza GitError (con el stderr de git) si el código de salida no es 0. */
export async function runGit(cwd: string, args: readonly string[], opts: GitOptions = {}): Promise<string> {
  const r = await runGitRaw(cwd, args, opts);
  if (r.exitCode !== 0) {
    throw new GitError(
      `git ${args.join(' ')} falló (código ${r.exitCode}): ${r.stderr.trim() || r.stdout.trim()}`,
      args,
      cwd,
      r.exitCode,
      r.stdout,
      r.stderr,
    );
  }
  return r.stdout;
}

/** Rechaza refs que git podría interpretar como opción (`--upload-pack=...`) o con caracteres raros. */
export function assertSafeRef(ref: string, what = 'ref'): void {
  if (!/^[A-Za-z0-9_][A-Za-z0-9._/@^~{}-]{0,199}$/.test(ref)) {
    throw new Error(`${what} no válido: ${JSON.stringify(ref)}`);
  }
}

/** Opciones `-c` para que los commits automáticos nunca esperen una clave de firma interactiva. */
export const NO_SIGN = ['-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false'] as const;
