import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  changedFiles,
  createWorktree,
  diff,
  listWorktrees,
  pruneWorktrees,
  removeWorktree,
} from '../../src/git/worktree.js';
import { git, makeRepo, removeRepo } from './helpers.js';

let repo: string;
beforeEach(() => {
  repo = makeRepo();
});
afterEach(() => removeRepo(repo));

describe('createWorktree / removeWorktree', () => {
  it('crea el worktree y la rama kiji/<id>, y los retira (rama incluida)', async () => {
    const path = await createWorktree(repo, 't1', 'main');
    expect(path).toBe(join(repo, '.kiji', 'worktrees', 't1'));
    expect(existsSync(join(path, 'a.txt'))).toBe(true);
    expect(git(repo, 'branch', '--list', 'kiji/t1')).toContain('kiji/t1');

    const list = await listWorktrees(repo);
    expect(list).toHaveLength(2);
    const wt = list.find((w) => w.path === path)!;
    expect(wt.branch).toBe('kiji/t1');
    expect(wt.detached).toBe(false);
    expect(list.find((w) => w.path === repo)!.branch).toBe('main');

    await removeWorktree(repo, 't1', { deleteBranch: true });
    expect(existsSync(path)).toBe(false);
    expect(git(repo, 'branch', '--list', 'kiji/t1')).toBe('');
    expect(await listWorktrees(repo)).toHaveLength(1);
  });

  it('si worktree add falla tras crear la rama, borra la rama kiji/<id>', async () => {
    writeFileSync(join(repo, '.kiji'), 'estorba\n'); // un archivo donde debería ir el directorio .kiji
    await expect(createWorktree(repo, 't1', 'main')).rejects.toThrow(/worktree add/);
    expect(git(repo, 'branch', '--list', 'kiji/t1')).toBe('');
  });

  it('si la rama kiji/<id> ya existía y la creación falla, no la borra', async () => {
    git(repo, 'branch', 'kiji/t1');
    await expect(createWorktree(repo, 't1', 'main')).rejects.toThrow(/worktree add/);
    expect(git(repo, 'branch', '--list', 'kiji/t1')).toContain('kiji/t1');
  });

  it('removeWorktree sin deleteBranch conserva la rama', async () => {
    await createWorktree(repo, 't1', 'main');
    await removeWorktree(repo, 't1', { deleteBranch: false });
    expect(git(repo, 'branch', '--list', 'kiji/t1')).toContain('kiji/t1');
  });

  it('retira un worktree aunque tenga cambios sin guardar', async () => {
    const path = await createWorktree(repo, 't1', 'main');
    writeFileSync(join(path, 'a.txt'), 'sucio\n');
    writeFileSync(join(path, 'nuevo.txt'), 'x\n');
    await removeWorktree(repo, 't1', { deleteBranch: true });
    expect(existsSync(path)).toBe(false);
  });

  it('deja .kiji/ en .git/info/exclude una sola vez y el repo principal limpio', async () => {
    await createWorktree(repo, 't1', 'main');
    await createWorktree(repo, 't2', 'main');
    const exclude = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude.split('\n').filter((l) => l.trim() === '.kiji/')).toHaveLength(1);
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('respeta un exclude existente sin salto de línea final', async () => {
    writeFileSync(join(repo, '.git', 'info', 'exclude'), '*.log');
    await createWorktree(repo, 't1', 'main');
    const lines = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8').split('\n');
    expect(lines).toContain('*.log');
    expect(lines).toContain('.kiji/');
  });

  it('rechaza taskId no válidos sin tocar nada', async () => {
    for (const bad of ['', '..', '../x', 'a/b', 'a b', 'a;rm', 'x'.repeat(65), 'a\nb', 'ñ']) {
      await expect(createWorktree(repo, bad, 'main')).rejects.toThrow(/taskId no válido/);
      await expect(removeWorktree(repo, bad)).rejects.toThrow(/taskId no válido/);
    }
    expect(existsSync(join(repo, '.kiji'))).toBe(false);
    expect(await listWorktrees(repo)).toHaveLength(1);
  });

  it('rechaza una base que parezca una opción', async () => {
    await expect(createWorktree(repo, 't1', '--detach')).rejects.toThrow(/base no válido/);
  });

  it('el error incluye el stderr de git', async () => {
    await expect(createWorktree(repo, 't1', 'no-existe')).rejects.toThrow(/invalid reference|not a valid|fatal/i);
  });

  it('prune elimina el registro de un worktree borrado a mano', async () => {
    const path = await createWorktree(repo, 't1', 'main');
    rmSync(path, { recursive: true, force: true });
    await pruneWorktrees(repo);
    expect(await listWorktrees(repo)).toHaveLength(1);
  });
});

describe('changedFiles / diff', () => {
  it('une modificados, borrados, preparados y no rastreados sin duplicados', async () => {
    const path = await createWorktree(repo, 't1', 'main');
    writeFileSync(join(path, 'a.txt'), 'cambiado\n');
    git(path, 'add', 'a.txt');
    writeFileSync(join(path, 'a.txt'), 'cambiado otra vez\n'); // en el índice y de nuevo modificado
    rmSync(join(path, 'b.txt'));
    mkdirSync(join(path, 'src', 'deep'), { recursive: true });
    writeFileSync(join(path, 'src', 'deep', 'nuevo.ts'), 'x\n');
    writeFileSync(join(path, 'otro.txt'), 'y\n');
    expect(await changedFiles(path, 'main')).toEqual(['a.txt', 'b.txt', 'otro.txt', 'src/deep/nuevo.ts']);
  });

  it('incluye lo ya commiteado en el worktree', async () => {
    const path = await createWorktree(repo, 't1', 'main');
    writeFileSync(join(path, 'c.txt'), 'c\n');
    git(path, 'add', '-A');
    git(path, 'commit', '-m', 'c');
    writeFileSync(join(path, 'a.txt'), 'm\n');
    expect(await changedFiles(path, 'main')).toEqual(['a.txt', 'c.txt']);
  });

  it('sin cambios devuelve lista vacía', async () => {
    const path = await createWorktree(repo, 't1', 'main');
    expect(await changedFiles(path, 'main')).toEqual([]);
  });

  it('diff incluye el contenido de los archivos nuevos sin rastrear', async () => {
    const path = await createWorktree(repo, 't1', 'main');
    writeFileSync(join(path, 'a.txt'), 'a\nlinea nueva\n');
    writeFileSync(join(path, 'nuevo.txt'), 'contenido nuevo\n');
    const d = await diff(path, 'main');
    expect(d).toContain('+linea nueva');
    expect(d).toContain('+++ b/nuevo.txt');
    expect(d).toContain('+contenido nuevo');
  });
});
