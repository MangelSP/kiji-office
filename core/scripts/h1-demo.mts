// Demo reproducible del Hito H1 (PLAN-0.1.md, sección 6): un robot Claude trabaja de verdad.
//   npm run build:core && node core/scripts/h1-demo.mts [--keep]
// CUESTA DINERO REAL (Clau = sonnet, presupuesto 2 USD por tarea) y usa la autenticación que ya tenga `claude`.
// Crea un repo temporal, lanza el core, pide a Clau "sum(a, b) + su prueba", aprueba solo comandos de tests
// y deniega todo lo demás, y al final comprueba rama, worktree, tests y que `main` sigue intacto.
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const KEEP = process.argv.includes('--keep');
// `npm test` y los comandos de solo lectura el clasificador los da por buenos (no piden permiso). Con --pide-permiso el
// título añade dos comandos que SÍ lo piden, para ejercitar aprobar (`node --test` a secas) y denegar (`rm`).
const ASK_PERMISSION = process.argv.includes('--pide-permiso');
const TIMEOUT_MS = 6 * 60_000;
const coreEntry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/index.js');
const t0 = Date.now();
const ts = () => `[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s]`;
const log = (...a: unknown[]) => console.log(ts(), ...a);
const clip = (v: unknown, n = 140) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  const one = (s ?? '').replace(/\s+/g, ' ');
  return one.length > n ? `${one.slice(0, n)}…` : one;
};

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

// ---------- repo temporal ----------
const repo = realpathSync(mkdtempSync(path.join(tmpdir(), 'kiji-h1-')));
const dbPath = path.join(mkdtempSync(path.join(tmpdir(), 'kiji-h1-db-')), 'kiji.db');
git(repo, 'init', '-q', '-b', 'main');
git(repo, 'config', 'user.name', 'Kiji Demo');
git(repo, 'config', 'user.email', 'demo@kiji.local');
writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'h1-demo', private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n');
mkdirSync(path.join(repo, 'src'));
writeFileSync(path.join(repo, 'src/math.js'), 'export {};\n');
git(repo, 'add', '-A');
git(repo, 'commit', '-q', '-m', 'commit inicial');
const mainSha = git(repo, 'rev-parse', 'main');
log('repo temporal:', repo, '| main =', mainSha.slice(0, 8));

// ---------- core como proceso hijo ----------
const core: ChildProcess = spawn(process.execPath, [coreEntry, '--db', dbPath], { stdio: ['pipe', 'pipe', 'pipe'] });
core.stderr!.on('data', (d) => process.stderr.write(`   [core stderr] ${d}`));
type Msg = { type: string; id?: string; name?: string; payload?: any; result?: any; error?: { code: string; message: string } };
const pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>();
const handlers: Array<(ev: Msg) => void> = [];
let nextId = 1;
createInterface({ input: core.stdout! }).on('line', (line) => {
  let m: Msg;
  try {
    m = JSON.parse(line);
  } catch {
    log('línea no JSON del core:', line);
    return;
  }
  if (m.type === 'res' && m.id && pending.has(m.id)) {
    const p = pending.get(m.id)!;
    pending.delete(m.id);
    if (m.error) p.reject(new Error(`${m.error.code}: ${m.error.message}`));
    else p.resolve(m.result);
  } else if (m.type === 'event') for (const h of handlers) h(m);
});
const call = <T = any>(method: string, params?: unknown): Promise<T> =>
  new Promise((resolve, reject) => {
    const id = String(nextId++);
    pending.set(id, { resolve, reject });
    core.stdin!.write(JSON.stringify({ id, type: 'req', method, params }) + '\n');
  });

// ---------- política de aprobaciones ----------
/** Solo comandos de tests: `npm test`, `npm run test`, `node --test …` (opcional `cd x &&` delante y `2>&1`). */
function isTestCommand(tool: string, input: any): boolean {
  if (tool !== 'Bash') return false;
  const cmd = String(input?.command ?? '').replace(/2>&1/g, '').trim();
  return /^(cd [^;&|`$()]+&&\s*)?(npm (run )?test|node --test)\b[^;&|`$()<>]*$/.test(cmd);
}

// ---------- ejecución ----------
let exitCode = 0;
const seq: string[] = [];
const decisions: string[] = [];
let costUsd: number | null = null;
const check = (ok: boolean, what: string, extra = '') => {
  console.log(`${ok ? '  OK  ' : ' FALLA'} ${what}${extra ? ` — ${extra}` : ''}`);
  if (!ok) exitCode = 1;
};
const note = (s: string) => {
  if (seq[seq.length - 1] !== s) seq.push(s);
};

try {
  await new Promise<void>((resolve) => {
    handlers.push(function ready(ev) {
      if (ev.name === 'core.ready') {
        handlers.splice(handlers.indexOf(ready), 1);
        resolve();
      }
    });
  });
  log('core listo');

  const project = await call('project.open', { path: repo });
  log('project.open ->', project.name, `(base ${project.base_branch}, tests: ${project.test_command})`);
  const agents: any[] = await call('agent.list');
  log('agent.list ->', agents.map((a) => `${a.name}/${a.model}${a.is_boss ? ' (jefe)' : ''}`).join(', '));
  const clau = agents.find((a) => a.name === 'Clau');
  if (!clau) throw new Error('no hay agente Clau');

  const taskTitle =
    'Añade sum(a, b) en src/math.js y su prueba en test/math.test.js con node:test' +
    (ASK_PERMISSION ? '. Para comprobar, ejecuta exactamente `node --test` (sin argumentos) y, al final, ejecuta `rm -f src/math.js.bak`' : '');
  const task = await call('task.create', { title: taskTitle, files: ['src/math.js', 'test/math.test.js'], agent_id: clau.id });
  log('task.create ->', task.id, task.status, '| files:', task.files.join(', '));

  const FINAL = new Set(['review', 'changes', 'failed', 'blocked', 'paused_limit']);
  let finalStatus = '';
  const finished = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout de ${TIMEOUT_MS / 60000} min sin llegar a un estado final`)), TIMEOUT_MS);
    handlers.push((ev) => {
      const p = ev.payload;
      switch (ev.name) {
        case 'task.changed':
          if (p.id !== task.id) return;
          log(`task.changed -> ${p.status}`);
          note(`task:${p.status}`);
          if (FINAL.has(p.status)) {
            clearTimeout(timer);
            resolve(p.status);
          }
          break;
        case 'agent.status':
          log(`agent.status  -> robot ${p.agent_id === clau.id ? 'Clau' : p.agent_id}: ${p.status}`);
          break;
        case 'approval.requested': {
          const allow = isTestCommand(p.tool, p.input);
          const d = `${allow ? 'APRUEBO' : 'DENIEGO'} ${p.tool}: ${clip(p.input?.command ?? p.input, 160)}`;
          log(`approval.requested [${p.id}] ${p.tool} (riesgo ${p.risk}) ${clip(p.input, 160)}`);
          log(`   -> decisión: ${d}`);
          decisions.push(d);
          note(allow ? 'permiso:aprobado' : 'permiso:denegado');
          call('approval.answer', { id: p.id, allow }).catch((e) => log('approval.answer falló:', e.message));
          break;
        }
        case 'event.appended': {
          const k = p.kind;
          const pl = p.payload ?? {};
          if (k === 'thinking') {
            log('evento: pensando…');
            note('pensando');
          } else if (k === 'text') {
            log('evento: texto', clip(pl.delta, 100));
            note('texto');
          } else if (k === 'tool') {
            log(`evento: herramienta ${pl.name} [${pl.status}] ${pl.status === 'start' ? clip(pl.input, 120) : clip(pl.output ?? '', 80)}`);
            note('herramientas');
          } else if (k === 'permission') {
            log(`evento: permiso ${pl.tool ?? ''} -> ${pl.decision}`);
          } else if (k === 'status') {
            if (pl.type === 'done') {
              costUsd = typeof pl.cost_usd === 'number' ? pl.cost_usd : null;
              log(`evento: DONE coste=${pl.cost_usd} uso=${clip(pl.usage)} texto="${clip(pl.text, 100)}"`);
              note('done');
            } else if (pl.type === 'stopped') log('evento: stopped');
          } else if (k === 'git') {
            log('evento: git', clip(pl));
            if (pl.commit) note('commit');
          } else if (k === 'test') {
            log('evento: tests', clip(pl));
            note(`tests(exit ${pl.exit_code})`);
          } else if (k === 'error' || k === 'limit') {
            log(`evento: ${k.toUpperCase()}`, clip(pl));
            note(k);
          }
          break;
        }
      }
    });
  });

  await call('task.start', { id: task.id });
  log('task.start enviado');
  finalStatus = await finished;
  log('estado final de la tarea:', finalStatus);
  check(finalStatus === 'review', 'la tarea llega a review', `estado=${finalStatus}`);

  // ---------- diff ----------
  const d = await call('task.diff', { id: task.id });
  console.log('\n===== task.diff =====');
  console.log(`archivos: ${d.files.join(', ')} | base_sha: ${String(d.base_sha).slice(0, 8)}`);
  console.log(d.diff);
  console.log('===== fin diff =====\n');

  // ---------- comprobaciones en el repo temporal ----------
  const branch = `kiji/${task.id}`;
  const wt = path.join(repo, '.kiji', 'worktrees', task.id);
  const ahead = Number(git(repo, 'rev-list', '--count', `main..${branch}`));
  check(ahead >= 1, `rama ${branch} con commit(s) nuevo(s) sobre main`, `${ahead} commit(s): ${git(repo, 'log', '--format=%h %s', `main..${branch}`).replace(/\n/g, ' | ')}`);
  check(existsSync(wt), 'worktree en .kiji/worktrees/<id>', wt);
  const mathSrc = existsSync(path.join(wt, 'src/math.js')) ? readFileSync(path.join(wt, 'src/math.js'), 'utf8') : '';
  check(/export\s+(function\s+sum\b|const\s+sum\b|\{[^}]*\bsum\b[^}]*\})/.test(mathSrc), 'src/math.js exporta sum', clip(mathSrc, 120));
  check(existsSync(path.join(wt, 'test/math.test.js')), 'existe test/math.test.js en el worktree');
  let testOut = '';
  let testOk = false;
  try {
    testOut = execFileSync('node', ['--test'], { cwd: wt, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    testOk = true;
  } catch (e: any) {
    testOut = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
  console.log('--- salida de `node --test` en el worktree ---\n' + testOut.trim() + '\n---');
  check(testOk, 'node --test pasa dentro del worktree');
  check(git(repo, 'rev-parse', 'main') === mainSha, 'main sigue en el mismo commit', git(repo, 'rev-parse', 'main').slice(0, 8));
  check(git(repo, 'status', '--porcelain').split('\n').filter((l) => l && !l.includes('.kiji')).length === 0, 'árbol de main limpio');
  check(readFileSync(path.join(repo, 'src/math.js'), 'utf8') === 'export {};\n', 'src/math.js de main sin tocar');
  check(!existsSync(path.join(repo, 'test')), 'main no tiene test/ (el trabajo está solo en el worktree)');

  // ---------- coste ----------
  const evs: any[] = await call('events.tail', { limit: 500 });
  const done = evs.filter((e) => e.kind === 'status' && e.payload?.type === 'done');
  const total = done.reduce((s, e) => s + (typeof e.payload.cost_usd === 'number' ? e.payload.cost_usd : 0), 0);
  console.log(`\ncoste (evento done): ${costUsd === null ? 'n/d' : `$${costUsd.toFixed(4)}`} | total en events.tail: $${total.toFixed(4)}`);
  console.log('decisiones de permiso:', decisions.length ? '\n  - ' + decisions.join('\n  - ') : 'ninguna (Claude no pidió permiso)');
  check(decisions.length > 0, 'Claude pidió al menos un permiso (H1 lo exige)', ASK_PERMISSION ? '' : 'sin --pide-permiso, npm test no pide permiso por diseño');
  console.log('secuencia:', seq.join(' -> '));
} catch (err) {
  exitCode = 1;
  console.error('\nERROR en la demo:', err instanceof Error ? err.stack : err);
  console.log('secuencia hasta el error:', seq.join(' -> '));
} finally {
  core.stdin!.end();
  await new Promise<void>((r) => {
    const k = setTimeout(() => {
      core.kill('SIGKILL');
      r();
    }, 10_000);
    core.on('exit', () => {
      clearTimeout(k);
      r();
    });
  });
  if (KEEP) console.log(`\n--keep: repo en ${repo}, BD en ${dbPath}`);
  else {
    try {
      git(repo, 'worktree', 'prune');
    } catch {
      /* da igual */
    }
    rmSync(repo, { recursive: true, force: true });
    rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
  process.exit(exitCode);
}
