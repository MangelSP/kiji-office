// Worktrees de git: uno por tarea, en `<repo>/.kiji/worktrees/<taskId>`, en la rama `kiji/<taskId>`.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { assertSafeRef, runGit } from './run.js';

const TASK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Valida el id de tarea: evita inyectar `..`, `/` u opciones en rutas y refs. */
export function assertValidTaskId(taskId: string): void {
  if (typeof taskId !== 'string' || !TASK_ID_RE.test(taskId)) {
    throw new Error(`taskId no válido: ${JSON.stringify(taskId)} (solo A-Z a-z 0-9 _ -, 1 a 64 caracteres)`);
  }
}

export function branchName(taskId: string): string {
  assertValidTaskId(taskId);
  return `kiji/${taskId}`;
}

export function worktreePath(repo: string, taskId: string): string {
  assertValidTaskId(taskId);
  return join(resolve(repo), '.kiji', 'worktrees', taskId);
}

/** Añade `.kiji/` a `.git/info/exclude` (compartido por todos los worktrees) si falta. */
async function ensureKijiExcluded(repo: string): Promise<void> {
  const common = (await runGit(repo, ['rev-parse', '--git-common-dir'])).trim();
  const excludeFile = join(resolve(repo, common), 'info', 'exclude');
  let current = '';
  try {
    current = await readFile(excludeFile, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    await mkdir(join(resolve(repo, common), 'info'), { recursive: true });
  }
  const already = current.split(/\r?\n/).some((l) => l.trim() === '.kiji/' || l.trim() === '.kiji');
  if (already) return;
  const sep = current === '' || current.endsWith('\n') ? '' : '\n';
  await writeFile(excludeFile, `${current}${sep}.kiji/\n`);
}

/** Crea el worktree de la tarea sobre `base` y devuelve su ruta absoluta. */
export async function createWorktree(repo: string, taskId: string, base: string): Promise<string> {
  assertValidTaskId(taskId);
  assertSafeRef(base, 'base');
  const root = resolve(repo);
  await ensureKijiExcluded(root);
  const path = worktreePath(root, taskId);
  await runGit(root, ['-C', root, 'worktree', 'add', '-b', branchName(taskId), path, base]);
  return path;
}

export interface RemoveWorktreeOptions {
  /** Borra también la rama `kiji/<taskId>` (`branch -D`). */
  deleteBranch?: boolean;
}

export async function removeWorktree(repo: string, taskId: string, opts: RemoveWorktreeOptions = {}): Promise<void> {
  assertValidTaskId(taskId);
  const root = resolve(repo);
  await runGit(root, ['worktree', 'remove', '--force', worktreePath(root, taskId)]);
  if (opts.deleteBranch) await runGit(root, ['branch', '-D', branchName(taskId)]);
}

/** Limpia los registros de worktrees cuyo directorio ya no existe. */
export async function pruneWorktrees(repo: string): Promise<void> {
  await runGit(resolve(repo), ['worktree', 'prune']);
}

export interface WorktreeInfo {
  path: string;
  head: string | null;
  /** Nombre corto de la rama (`kiji/t1`), o null si está en HEAD desacoplado. */
  branch: string | null;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
}

/** Parsea `git worktree list --porcelain` (bloques separados por línea en blanco). */
export async function listWorktrees(repo: string): Promise<WorktreeInfo[]> {
  const out = await runGit(resolve(repo), ['worktree', 'list', '--porcelain']);
  const result: WorktreeInfo[] = [];
  for (const block of out.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/).filter((l) => l !== '');
    if (lines.length === 0) continue;
    const info: WorktreeInfo = { path: '', head: null, branch: null, bare: false, detached: false, locked: false, prunable: false };
    for (const line of lines) {
      const space = line.indexOf(' ');
      const key = space === -1 ? line : line.slice(0, space);
      const value = space === -1 ? '' : line.slice(space + 1);
      if (key === 'worktree') info.path = value;
      else if (key === 'HEAD') info.head = value;
      else if (key === 'branch') info.branch = value.replace(/^refs\/heads\//, '');
      else if (key === 'bare') info.bare = true;
      else if (key === 'detached') info.detached = true;
      else if (key === 'locked') info.locked = true;
      else if (key === 'prunable') info.prunable = true;
    }
    if (info.path) result.push(info);
  }
  return result;
}

/**
 * Archivos tocados en el worktree respecto a `base`: unión (sin duplicados, ordenada) de
 * `git diff --name-only <base>` y `git status --porcelain` (incluye no rastreados, uno por archivo).
 * Rutas relativas a la raíz del repo (= raíz del worktree), con `/` como separador.
 * `--no-renames` lista tanto la ruta vieja como la nueva, útil para comprobar propiedad de archivos.
 */
export async function changedFiles(worktree: string, base: string): Promise<string[]> {
  assertSafeRef(base, 'base');
  const cwd = resolve(worktree);
  const diffOut = await runGit(cwd, ['diff', '--name-only', '--no-renames', '-z', base, '--']);
  const statusOut = await runGit(cwd, ['status', '--porcelain', '-z', '--no-renames', '--untracked-files=all']);
  const files = new Set<string>();
  for (const p of diffOut.split('\0')) if (p) files.add(p);
  // Formato -z: "XY <ruta>\0" por entrada (sin renombrados gracias a --no-renames).
  for (const entry of statusOut.split('\0')) if (entry.length > 3) files.add(entry.slice(3));
  return [...files].sort();
}

/**
 * Texto de `git diff <base>` del worktree. Los archivos nuevos sin rastrear se incluyen marcándolos antes
 * con `git add --intent-to-add --all` (solo registra la ruta en el índice, no el contenido); es lo más simple
 * y no cambia el árbol de trabajo. Efecto secundario aceptado: esos archivos pasan a verse como "añadidos
 * (intent-to-add)" en el índice del worktree, y `commitAll` los añade igualmente con `add -A`.
 */
export async function diff(worktree: string, base: string): Promise<string> {
  assertSafeRef(base, 'base');
  const cwd = resolve(worktree);
  await runGit(cwd, ['add', '--intent-to-add', '--all']);
  return runGit(cwd, ['diff', base, '--']);
}
