import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  commitAll,
  mergeFfOnly,
  rebaseOnto,
  revertRange,
  runTests,
  splitCommand,
  TEST_OUTPUT_LIMIT,
} from '../../src/git/integrate.js';
import { createWorktree } from '../../src/git/worktree.js';
import { git, makeRepo, removeRepo } from './helpers.js';

let repo: string;
beforeEach(() => {
  repo = makeRepo();
});
afterEach(() => removeRepo(repo));

function commitOnMain(file: string, content: string, msg: string): void {
  writeFileSync(join(repo, file), content);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', msg);
}

describe('commitAll', () => {
  it('devuelve null si no hay cambios y el sha si los hay (incluye no rastreados)', async () => {
    const wt = await createWorktree(repo, 't1', 'main');
    expect(await commitAll(wt, 'nada')).toBeNull();
    writeFileSync(join(wt, 'nuevo.txt'), 'x\n');
    const sha = await commitAll(wt, 'agrega nuevo');
    expect(sha).toBe(git(wt, 'rev-parse', 'HEAD'));
    expect(git(wt, 'log', '-1', '--format=%s')).toBe('agrega nuevo');
    expect(git(wt, 'status', '--porcelain')).toBe('');
  });

  it('un mensaje que empieza por guion no se toma como opción', async () => {
    const wt = await createWorktree(repo, 't1', 'main');
    writeFileSync(join(wt, 'x.txt'), 'x\n');
    await commitAll(wt, '--amend');
    expect(git(wt, 'log', '-1', '--format=%s')).toBe('--amend');
  });
});

describe('commitAll: mensaje vacío', () => {
  it('lanza un error claro y no toca el índice', async () => {
    const wt = await createWorktree(repo, 't1', 'main');
    writeFileSync(join(wt, 'x.txt'), 'x\n');
    await expect(commitAll(wt, '')).rejects.toThrow(/mensaje de commit no puede estar vacío/);
    await expect(commitAll(wt, '   ')).rejects.toThrow(/vacío/);
    expect(git(wt, 'status', '--porcelain')).toBe('?? x.txt'); // sin `add -A`
  });
});

describe('rebaseOnto', () => {
  it('rebase sin conflicto', async () => {
    const wt = await createWorktree(repo, 't1', 'main');
    writeFileSync(join(wt, 'tarea.txt'), 't\n');
    await commitAll(wt, 'tarea');
    commitOnMain('b.txt', 'b2\n', 'main avanza');
    expect(await rebaseOnto(wt, 'main')).toEqual({ ok: true });
    expect(git(wt, 'log', '--format=%s')).toBe('tarea\nmain avanza\ninicial');
  });

  it('con conflicto: informa los archivos, aborta y deja el worktree limpio', async () => {
    const wt = await createWorktree(repo, 't1', 'main');
    writeFileSync(join(wt, 'a.txt'), 'version tarea\n');
    await commitAll(wt, 'tarea toca a');
    const headAntes = git(wt, 'rev-parse', 'HEAD');
    commitOnMain('a.txt', 'version main\n', 'main toca a');

    const r = await rebaseOnto(wt, 'main');
    expect(r).toEqual({ ok: false, conflicts: ['a.txt'] });
    expect(git(wt, 'status', '--porcelain')).toBe('');
    expect(git(wt, 'rev-parse', 'HEAD')).toBe(headAntes);
    expect(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('kiji/t1'); // no queda desacoplado
    expect(readFileSync(join(wt, 'a.txt'), 'utf8')).toBe('version tarea\n');
  });

  it('un fallo que no es conflicto (cambios sin commit) lanza el error de git', async () => {
    const wt = await createWorktree(repo, 't1', 'main');
    commitOnMain('c.txt', 'c\n', 'main avanza');
    writeFileSync(join(wt, 'a.txt'), 'sucio\n');
    await expect(rebaseOnto(wt, 'main')).rejects.toThrow(/rebase/);
  });
});

describe('mergeFfOnly / revertRange', () => {
  async function taskWithCommit(id: string, file: string): Promise<string> {
    const wt = await createWorktree(repo, id, 'main');
    writeFileSync(join(wt, file), `${id}\n`);
    await commitAll(wt, `tarea ${id}`);
    return wt;
  }

  it('ff-merge devuelve before/after y avanza main', async () => {
    await taskWithCommit('t1', 'uno.txt');
    const before = git(repo, 'rev-parse', 'main');
    const r = await mergeFfOnly(repo, 'kiji/t1', { expectedBase: 'main' });
    expect(r.beforeSha).toBe(before);
    expect(r.afterSha).toBe(git(repo, 'rev-parse', 'kiji/t1'));
    expect(r.afterSha).not.toBe(r.beforeSha);
    expect(readFileSync(join(repo, 'uno.txt'), 'utf8')).toBe('t1\n');
  });

  it('falla si no es fast-forward y no toca main', async () => {
    await taskWithCommit('t1', 'uno.txt');
    commitOnMain('b.txt', 'b2\n', 'main avanza');
    const before = git(repo, 'rev-parse', 'main');
    await expect(mergeFfOnly(repo, 'kiji/t1')).rejects.toThrow(/fast-forward/i);
    expect(git(repo, 'rev-parse', 'main')).toBe(before);
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('falla con el repo sucio, fuera de la rama base o desacoplado', async () => {
    await taskWithCommit('t1', 'uno.txt');
    writeFileSync(join(repo, 'a.txt'), 'sucio\n');
    await expect(mergeFfOnly(repo, 'kiji/t1')).rejects.toThrow(/cambios sin guardar/);
    git(repo, 'checkout', '--', 'a.txt');

    await expect(mergeFfOnly(repo, 'kiji/t1', { expectedBase: 'develop' })).rejects.toThrow(/rama base "develop"/);

    git(repo, 'checkout', '--detach');
    await expect(mergeFfOnly(repo, 'kiji/t1')).rejects.toThrow(/desacoplado/);
  });

  it('rechaza una rama que parezca una opción', async () => {
    await expect(mergeFfOnly(repo, '--abort')).rejects.toThrow(/rama no válido/);
  });

  it('revertRange deja el árbol de main como antes de integrar', async () => {
    const wt = await taskWithCommit('t1', 'uno.txt');
    writeFileSync(join(wt, 'a.txt'), 'a cambiado\n');
    await commitAll(wt, 'segundo commit');
    const treeAntes = git(repo, 'rev-parse', 'main^{tree}');
    const { beforeSha, afterSha } = await mergeFfOnly(repo, 'kiji/t1');
    expect(git(repo, 'rev-parse', 'main^{tree}')).not.toBe(treeAntes);

    await revertRange(repo, beforeSha, afterSha);
    expect(git(repo, 'rev-parse', 'main^{tree}')).toBe(treeAntes);
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(git(repo, 'rev-list', '--count', `${afterSha}..main`)).toBe('2'); // un revert por commit
  });

  it('revertRange con before == after no hace nada; con sha inválido lanza', async () => {
    const head = git(repo, 'rev-parse', 'HEAD');
    expect(await revertRange(repo, head, head)).toBe(head);
    await expect(revertRange(repo, '--abort', head)).rejects.toThrow(/sha no válido/);
  });
});

describe('revertRange: comprobaciones previas', () => {
  async function integrated(): Promise<{ beforeSha: string; afterSha: string }> {
    const wt = await createWorktree(repo, 't1', 'main');
    writeFileSync(join(wt, 'uno.txt'), 'uno\n');
    await commitAll(wt, 'tarea');
    return mergeFfOnly(repo, 'kiji/t1');
  }

  it('árbol sucio: error y no toca nada', async () => {
    const { beforeSha, afterSha } = await integrated();
    writeFileSync(join(repo, 'a.txt'), 'sucio\n');
    await expect(revertRange(repo, beforeSha, afterSha)).rejects.toThrow(/cambios sin guardar/);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(afterSha);
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('sucio\n');
  });

  it('HEAD desacoplado: error y no toca nada', async () => {
    const { beforeSha, afterSha } = await integrated();
    git(repo, 'checkout', '--detach');
    await expect(revertRange(repo, beforeSha, afterSha)).rejects.toThrow(/desacoplado/);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(afterSha);
  });

  it('expectedBase distinta de la rama actual: error', async () => {
    const { beforeSha, afterSha } = await integrated();
    await expect(revertRange(repo, beforeSha, afterSha, { expectedBase: 'develop' })).rejects.toThrow(/rama base "develop"/);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(afterSha);
  });

  it('afterSha que no es ancestro de HEAD: error y no toca nada', async () => {
    const { beforeSha, afterSha } = await integrated();
    const wt2 = await createWorktree(repo, 't2', 'main');
    writeFileSync(join(wt2, 'dos.txt'), 'dos\n');
    const otro = (await commitAll(wt2, 'tarea 2'))!; // en kiji/t2, no integrada en main
    await expect(revertRange(repo, beforeSha, otro)).rejects.toThrow(/no es ancestro de HEAD/);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(afterSha);
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });
});

describe('splitCommand', () => {
  it('parte por espacios y respeta comillas', () => {
    expect(splitCommand('npm test')).toEqual(['npm', 'test']);
    expect(splitCommand('  npm   run  test -- --run ')).toEqual(['npm', 'run', 'test', '--', '--run']);
    expect(splitCommand(`node -e "console.log('a b')" 'x y' ""`)).toEqual(['node', '-e', "console.log('a b')", 'x y', '']);
  });
  it('rechaza vacío, comillas sin cerrar y operadores de shell', () => {
    expect(() => splitCommand('   ')).toThrow(/vacío/);
    expect(() => splitCommand('echo "abc')).toThrow(/comillas/);
    expect(() => splitCommand('npm test && rm -rf x')).toThrow(/operadores de shell/);
    expect(() => splitCommand('npm test | tee out')).toThrow(/operadores de shell/);
  });
  it('no expande variables ni sustituciones (se pasan literales)', () => {
    expect(splitCommand('echo $HOME $(whoami)')).toEqual(['echo', '$HOME', '$(whoami)']);
  });
});

describe('runTests en Windows (plataforma simulada)', () => {
  const bash = 'C:\\Program Files\\Git\\bin\\bash.exe';
  const fakeSpawn = () => {
    const calls: any[] = [];
    const fn: any = (file: string, args: string[], opts: any) => {
      calls.push({ file, args, opts });
      return spawn(process.execPath, ['-e', "console.log('hecho')"], { stdio: ['ignore', 'pipe', 'pipe'] });
    };
    return { calls, fn };
  };

  it('lanza por el bash de Git con los argumentos entre comillas, sin detached', async () => {
    const s = fakeSpawn();
    const r = await runTests(repo, `npm test -- "a b"`, 20_000, { platform: 'win32', env: { ProgramFiles: 'C:\\Program Files' }, exists: (p) => p === bash, whereGit: () => '', spawn: s.fn });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain('hecho');
    expect(s.calls[0].file).toBe(bash);
    expect(s.calls[0].args).toEqual(['-c', "'npm' 'test' '--' 'a b'"]);
    expect(s.calls[0].opts).toMatchObject({ windowsHide: true });
    expect(s.calls[0].opts.detached).toBeUndefined();
  });

  it('sin Git for Windows: 127 con el mensaje', async () => {
    const r = await runTests(repo, 'npm test', 1000, { platform: 'win32', env: {}, exists: () => false, whereGit: () => '' });
    expect(r.exitCode).toBe(127);
    expect(r.output).toContain('Git for Windows');
  });

  it('Unix: sin shell, el programa va directo', async () => {
    const s = fakeSpawn();
    await runTests(repo, 'npm test', 20_000, { platform: 'linux', spawn: s.fn });
    expect(s.calls[0]).toMatchObject({ file: 'npm', args: ['test'] });
  });
});

describe('runTests', () => {
  it('comando que pasa', async () => {
    const r = await runTests(repo, `node -e "console.log('todo bien')"`, 20_000);
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
    expect(r.output).toContain('todo bien');
  });

  it('comando que falla conserva el código y el stderr', async () => {
    const r = await runTests(repo, `node -e "console.error('boom'); process.exit(3)"`, 20_000);
    expect(r.exitCode).toBe(3);
    expect(r.output).toContain('boom');
  });

  it('se ejecuta en el cwd indicado', async () => {
    const r = await runTests(repo, `node -p "process.cwd()"`, 20_000);
    expect(r.output.trim()).toBe(repo);
  });

  it('no interpreta metacaracteres de shell', async () => {
    const r = await runTests(repo, 'node -p "1" $(echo hola)', 20_000);
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain('1');
  });

  it('comando inexistente: 127 con mensaje', async () => {
    const r = await runTests(repo, 'comando-que-no-existe-kiji', 20_000);
    expect(r.exitCode).toBe(127);
    expect(r.output).toContain('comando-que-no-existe-kiji');
  });

  it('mata el comando al vencer el tiempo', async () => {
    const t0 = Date.now();
    const r = await runTests(repo, `node -e "setTimeout(() => {}, 30000)"`, 400);
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBe(124);
    expect(Date.now() - t0).toBeLessThan(10_000);
  });

  // Nietos en segundo plano: el comando de tests puede dejar procesos (npm -> sh -> vitest -> workers).
  // El primer `echo $$` imprime el pid del `sh`, que al lanzarse `detached` es también el id de su grupo.
  describe.skipIf(process.platform === 'win32')('procesos hijos', () => {
    let pgid: number | undefined;
    afterEach(() => {
      // Limpieza aunque el test falle: no se deben dejar `sleep` vivos.
      if (pgid) {
        try {
          process.kill(-pgid, 'SIGKILL');
        } catch {
          /* ESRCH: ya no queda nadie */
        }
      }
      pgid = undefined;
    });

    async function groupGone(id: number): Promise<boolean> {
      // Hasta 5 s: con la máquina cargada, launchd/init tarda en recoger a los procesos ya muertos.
      for (let i = 0; i < 100; i++) {
        try {
          process.kill(-id, 0);
        } catch (e) {
          return (e as NodeJS.ErrnoException).code === 'ESRCH';
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      return false;
    }

    it('al vencer el tiempo resuelve y no deja ningún proceso del grupo', async () => {
      const t0 = Date.now();
      const r = await runTests(repo, 'sh -c "echo $$; sleep 30 & sleep 30 & wait"', 1000);
      pgid = Number(r.output.split('\n')[0]);
      expect(Date.now() - t0).toBeLessThan(5000);
      expect(r.timedOut).toBe(true);
      expect(r.exitCode).toBe(124);
      expect(Number.isInteger(pgid) && pgid > 1).toBe(true);
      expect(await groupGone(pgid)).toBe(true);
    });

    it('tras una salida normal mata los nietos que quedaron en segundo plano', async () => {
      const t0 = Date.now();
      const r = await runTests(repo, 'sh -c "echo $$; sleep 30 & echo fin"', 20_000);
      pgid = Number(r.output.split('\n')[0]);
      expect(Date.now() - t0).toBeLessThan(5000);
      expect(r.timedOut).toBe(false);
      expect(r.exitCode).toBe(0);
      expect(r.output).toContain('fin');
      expect(await groupGone(pgid)).toBe(true);
    });
  });

  it('recorta la salida a 64 KB conservando el final', async () => {
    const r = await runTests(
      repo,
      `node -e "for (let i = 0; i < 20000; i++) console.log('linea ' + i); console.log('FINAL')"`,
      20_000,
    );
    expect(r.exitCode).toBe(0);
    expect(Buffer.byteLength(r.output)).toBeLessThan(TEST_OUTPUT_LIMIT + 200);
    expect(r.output).toContain('salida recortada');
    expect(r.output.trimEnd().endsWith('FINAL')).toBe(true);
    expect(r.output).not.toContain('linea 0\n');
  });
});

describe('seguridad: sin shell', () => {
  it('ningún fuente de core/src/git usa shell: true, exec( ni execSync', () => {
    const dir = join(import.meta.dirname, '..', '..', 'src', 'git');
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && statSync(join(dir, f)).isFile());
    expect(files.length).toBeGreaterThanOrEqual(3);
    for (const f of files) {
      const src = readFileSync(join(dir, f), 'utf8');
      expect(src, f).not.toMatch(/shell\s*:\s*true/);
      expect(src, f).not.toMatch(/(?<![\w.])exec\s*\(/);
      expect(src, f).not.toMatch(/\b(execSync|spawnSync|execFileSync)\b/);
      expect(src, f).not.toMatch(/\bimport\s*\{[^}]*\bexec\b[^}]*\}\s*from/);
      expect(src, f).not.toMatch(/\bshell\s*:/);
    }
  });
});
