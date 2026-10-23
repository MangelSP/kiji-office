// Diferencias Unix/Windows de run_command, grep y runTests (PLAN-0.3 D4). En Windows se usa el bash y el grep de
// Git for Windows, así que classifyCommand (sintaxis POSIX) sigue valiendo. Todo recibe `platform`/`env` inyectables.

import { execFile, execFileSync } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

export const NO_GIT_MESSAGE = 'Instala Git for Windows (git-scm.com) para que los robots puedan ejecutar comandos';

export type PlatformDeps = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exists?: (p: string) => boolean;
  /** Salida de `where git` (una ruta por línea); '' si no está. */
  whereGit?: () => string;
  /** execFile para taskkill. */
  execFile?: typeof execFile;
};

const defaultWhereGit = (): string => {
  try {
    return execFileSync('where', ['git'], { encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
};

const isWin = (d: PlatformDeps) => (d.platform ?? process.platform) === 'win32';

/** Carpetas raíz candidatas de Git for Windows (la que contiene `bin\` y `usr\`). */
function gitRoots(d: PlatformDeps): string[] {
  const env = d.env ?? process.env;
  const w = path.win32;
  const roots: string[] = [];
  if (env.ProgramFiles) roots.push(w.join(env.ProgramFiles, 'Git'));
  if (env['ProgramFiles(x86)']) roots.push(w.join(env['ProgramFiles(x86)'], 'Git'));
  if (env.LOCALAPPDATA) roots.push(w.join(env.LOCALAPPDATA, 'Programs', 'Git'));
  return roots;
}

/** Raíz de Git for Windows que contiene `rel` (p. ej. `bin\bash.exe`), o null. */
function findGitFile(rel: string, d: PlatformDeps): string | null {
  const exists = d.exists ?? existsSync;
  const w = path.win32;
  for (const root of gitRoots(d)) {
    const p = w.join(root, rel);
    if (exists(p)) return p;
  }
  // `where git` → <root>\cmd\git.exe (o <root>\bin\git.exe) → <root>\<rel>
  for (const line of (d.whereGit ?? defaultWhereGit)().split(/\r?\n/)) {
    const g = line.trim();
    if (!g) continue;
    const p = w.join(w.dirname(g), '..', rel);
    if (exists(p)) return p;
  }
  return null;
}

/** [programa, args] para ejecutar `cmd` con una shell POSIX. Lanza si en Windows no hay Git for Windows. */
export function shellCommand(cmd: string, d: PlatformDeps = {}): [string, string[]] {
  if (!isWin(d)) return ['/bin/sh', ['-c', cmd]];
  const bash = findGitFile(path.win32.join('bin', 'bash.exe'), d);
  if (!bash) throw new Error(NO_GIT_MESSAGE);
  return [bash, ['-c', cmd]];
}

/** Binario de grep: `grep` en Unix; el de Git for Windows (`usr\bin\grep.exe`) en Windows. */
export function grepBinary(d: PlatformDeps = {}): string {
  if (!isWin(d)) return 'grep';
  const g = findGitFile(path.win32.join('usr', 'bin', 'grep.exe'), d);
  if (!g) throw new Error(NO_GIT_MESSAGE);
  return g;
}

/** `detached` (grupo propio) solo en Unix; en Windows abriría una consola, así que se oculta. */
export function spawnOptions(d: PlatformDeps = {}): Pick<SpawnOptions, 'detached' | 'windowsHide'> {
  return isWin(d) ? { windowsHide: true } : { detached: true };
}

/** Mata el hijo y sus descendientes: grupo (Unix, requiere `detached`) o `taskkill /T /F` (Windows). */
export function killTree(child: Pick<ChildProcess, 'pid' | 'kill'>, d: PlatformDeps = {}): void {
  if (!child.pid) return;
  if (isWin(d)) {
    (d.execFile ?? execFile)('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => undefined);
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ESRCH') child.kill('SIGKILL');
  }
}

/**
 * Ruta del modelo → relativa al cwd con '/' para classifyPath/isPathAllowed. En Windows acepta `\` y rutas
 * absolutas (`C:\repo\src\a.ts` ≡ `src/a.ts`, sin distinguir mayúsculas). En Unix devuelve `p` intacta.
 */
export function normalizeModelPath(p: string, cwd: string, d: PlatformDeps = {}): string {
  if (!isWin(d)) return p;
  const w = path.win32;
  let q = p;
  if (w.isAbsolute(q)) {
    const rel = w.relative(cwd, q);
    // relative() ya ignora mayúsculas en win32; fuera del cwd se deja absoluta para que isInsideCwd la rechace
    if (rel === '' ) q = '.';
    else if (!rel.startsWith('..') && !w.isAbsolute(rel)) q = rel;
  }
  return q.replace(/\\/g, '/');
}

/** En Windows el sistema de archivos no distingue mayúsculas: se comparan en minúsculas. En Unix, intacto. */
export const foldCase = (s: string, d: PlatformDeps = {}): string => (isWin(d) ? s.toLowerCase() : s);
