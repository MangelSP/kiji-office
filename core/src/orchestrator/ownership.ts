// Red de seguridad de propiedad de archivos (PLAN D4, capa 3): detecta y revierte lo que el agente tocó fuera de su lista.
import { rm } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { isPathAllowed } from '../adapters/classify.js';
import { assertSafeRef, runGit, runGitRaw } from '../git/run.js';
import { changedFiles } from '../git/worktree.js';

/**
 * Commit desde el que nació la rama de la tarea: `merge-base HEAD <base>`. Se usa en lugar del tip de la rama
 * base porque `main` puede haber avanzado desde entonces y sus cambios no son del agente.
 */
export async function forkPoint(worktree: string, base: string): Promise<string> {
  assertSafeRef(base, 'base');
  return (await runGit(resolve(worktree), ['merge-base', 'HEAD', base])).trim();
}

/** Archivos tocados en el worktree desde el punto de partida que no entran en `allowed` (archivos, carpetas o globs). */
export async function foreignFiles(worktree: string, baseSha: string, allowed: string[]): Promise<string[]> {
  const root = resolve(worktree);
  const changed = await changedFiles(root, baseSha);
  return changed.filter((f) => !isPathAllowed(join(root, f), allowed, root));
}

/**
 * Deja cada archivo ajeno como estaba en `baseSha`: si existía lo restaura (índice y disco, también si lo borró);
 * si lo creó el agente lo borra del disco y del índice. No toca ningún otro archivo.
 */
export async function revertFiles(worktree: string, baseSha: string, files: string[]): Promise<void> {
  const root = resolve(worktree);
  for (const f of files) {
    const abs = resolve(root, f);
    if (relative(root, abs).startsWith('..') || abs === root || !abs.startsWith(root + sep)) {
      throw new Error(`ruta fuera del worktree, no se revierte: ${f}`);
    }
    const existed = (await runGitRaw(root, ['cat-file', '-e', `${baseSha}:${f}`])).exitCode === 0;
    if (existed) {
      await runGit(root, ['checkout', baseSha, '--', f]);
    } else {
      await runGit(root, ['rm', '-f', '--cached', '--ignore-unmatch', '--', f]);
      await rm(abs, { recursive: true, force: true });
    }
  }
}
