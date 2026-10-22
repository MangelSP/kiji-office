import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, GIT_EDITOR: 'true' } }).trim();
}

/** Crea un repo temporal con rama `main`, identidad local y un primer commit (a.txt, b.txt). */
export function makeRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kiji-git-')));
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  writeFileSync(join(dir, 'b.txt'), 'b\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'inicial');
  return dir;
}

export function removeRepo(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}
