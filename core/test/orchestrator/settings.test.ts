// 0.4b: ajustes completos (validación, defectos, settings.all/changed), su aplicación y stats.models.
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../../src/db/db.js';
import { createOrchestrator } from '../../src/orchestrator/index.js';
import { inQuietHours, notify } from '../../src/orchestrator/notifications.js';
import { makeAdapterFactory } from '../../src/orchestrator/connections.js';
import { pruneEvents, testTimeoutMsOf } from '../../src/orchestrator/settings.js';
import { statsSince } from '../../src/orchestrator/metrics.js';
import { removeRepo } from '../git/helpers.js';
import { makeHarness, makeNodeRepo, type Harness } from './helpers.js';

let h: Harness;
let home: string;
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'kiji-home-')));
  vi.stubEnv('HOME', home);
  h = makeHarness();
});
afterEach(async () => {
  await h.orch.shutdown();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});
const set = (key: string, value: string) => h.call('settings.set', { key, value });
const mkdir = (...p: string[]) => { const d = join(home, ...p); mkdirSync(d, { recursive: true }); return d; };

describe('settings.all / settings.set', () => {
  it('lista todas las claves con defecto y sección, y emite settings.changed', async () => {
    const all = await h.call('settings.all');
    const by = Object.fromEntries(all.map((s: any) => [s.key, s]));
    expect(all).toHaveLength(16);
    expect(by.user_name).toEqual({ key: 'user_name', value: null, default: '', section: 'general' });
    expect(by.default_model.default).toBe('sonnet');
    expect(by.test_timeout_min.default).toBe('5');
    expect(by.notify_levels.default).toBe('["warn","ask"]');
    expect(by.update_auto_check.section).toBe('actualizaciones');
    await set('start_view', 'last');
    expect(h.emitted.filter((e) => e.name === 'settings.changed').at(-1)!.payload).toEqual({ key: 'start_view', value: 'last' });
    expect((await h.call('settings.all')).find((s: any) => s.key === 'start_view').value).toBe('last');
  });

  it('valida cada clave', async () => {
    await expect(set('user_name', 'x'.repeat(41))).rejects.toThrow(/40/);
    await expect(set('user_name', 'a\nb')).rejects.toThrow(/control/);
    await expect(set('user_name', ' Alexis ')).resolves.toEqual({ key: 'user_name', value: 'Alexis' });
    await expect(set('user_name', '')).resolves.toEqual({ key: 'user_name', value: '' });
    await expect(set('start_view', 'otra')).rejects.toThrow(/home/);
    await expect(set('auto_relay_default', '2')).rejects.toThrow();
    await expect(set('test_timeout_min', '0')).rejects.toThrow();
    await expect(set('test_timeout_min', '121')).rejects.toThrow();
    await expect(set('test_timeout_min', '120')).resolves.toBeTruthy();
    await expect(set('events_retention_days', '3651')).rejects.toThrow();
    await expect(set('events_retention_days', '-1')).rejects.toThrow();
    await expect(set('notify_levels', '["info","x"]')).rejects.toThrow();
    await expect(set('notify_levels', '["ask","info","ask"]')).resolves.toEqual({ key: 'notify_levels', value: '["info","ask"]' });
    await expect(set('quiet_hours', '{"from":"25:00","to":"08:00"}')).rejects.toThrow(/HH:MM/);
    await expect(set('quiet_hours', '{"from":"22:00","to":"08:00"}')).resolves.toBeTruthy();
    await expect(set('quiet_hours', '')).resolves.toEqual({ key: 'quiet_hours', value: '' });
    await expect(set('max_concurrent_runs', '33')).rejects.toThrow();
    expect(h.emitted.filter((e) => e.name === 'settings.changed' && e.payload.key === 'start_view')).toHaveLength(0); // los rechazos no emiten
  });

  it('default_model: alias o conn:<id>/<modelo> de una conexión existente', async () => {
    await expect(set('default_model', 'gpt')).rejects.toThrow(/default_model/);
    await expect(set('default_model', 'conn:00000000-0000-4000-8000-000000000000/qwen')).rejects.toThrow(/no existe/);
    const c = h.orch.ctx.repos.connections.create({ name: 'L', preset: 'custom', baseUrl: 'http://127.0.0.1:1/v1', auth: 'none', defaultModel: 'qwen' });
    await expect(set('default_model', `conn:${c.id}/qwen`)).resolves.toBeTruthy();
    await expect(set('default_model', 'opus')).resolves.toBeTruthy();
  });

  it('claude_path: vacío o archivo ejecutable existente', async () => {
    await expect(set('claude_path', 'claude')).rejects.toThrow(/absoluta/);
    await expect(set('claude_path', join(home, 'nope'))).rejects.toThrow(/no existe/);
    const f = join(home, 'claude');
    writeFileSync(f, '#!/bin/sh\nexit 1\n');
    chmodSync(f, 0o644);
    await expect(set('claude_path', f)).rejects.toThrow(/ejecutable/);
    chmodSync(f, 0o755);
    await expect(set('claude_path', f)).resolves.toEqual({ key: 'claude_path', value: f });
    await expect(set('claude_path', '')).resolves.toEqual({ key: 'claude_path', value: '' });
    await expect(set('claude_path', home)).rejects.toThrow(/archivo/);
  });

  it('extra_skill_roots: máx 5 carpetas reales dentro del HOME, sin credenciales', async () => {
    const ok = mkdir('agents', 'skills');
    await expect(set('extra_skill_roots', JSON.stringify([ok]))).resolves.toEqual({ key: 'extra_skill_roots', value: JSON.stringify([ok]) });
    await expect(set('extra_skill_roots', 'no json')).rejects.toThrow(/JSON/);
    await expect(set('extra_skill_roots', '["relativa"]')).rejects.toThrow(/absolutas/);
    await expect(set('extra_skill_roots', '["/"]')).rejects.toThrow(/dentro de tu carpeta/);
    await expect(set('extra_skill_roots', JSON.stringify([tmpdir()]))).rejects.toThrow(/dentro de tu carpeta/);
    await expect(set('extra_skill_roots', JSON.stringify([home]))).rejects.toThrow(/dentro de tu carpeta/);
    await expect(set('extra_skill_roots', JSON.stringify([join(home, 'no-existe')]))).rejects.toThrow(/no existe/);
    await expect(set('extra_skill_roots', JSON.stringify([mkdir('.ssh')]))).rejects.toThrow();
    await expect(set('extra_skill_roots', JSON.stringify([mkdir('.ssh', 'sub')]))).rejects.toThrow();
    await expect(set('extra_skill_roots', JSON.stringify([mkdir('.claude', 'projects')]))).rejects.toThrow();
    await expect(set('extra_skill_roots', JSON.stringify([join(home, '.claude')]))).rejects.toThrow(); // contiene projects
    await expect(set('extra_skill_roots', JSON.stringify([mkdir('.aws')]))).rejects.toThrow();
    // un enlace que apunta a ~/.ssh se resuelve y se rechaza
    symlinkSync(join(home, '.ssh'), join(home, 'enlace'));
    await expect(set('extra_skill_roots', JSON.stringify([join(home, 'enlace')]))).rejects.toThrow();
    const many = Array.from({ length: 6 }, (_, i) => mkdir(`r${i}`));
    await expect(set('extra_skill_roots', JSON.stringify(many))).rejects.toThrow(/5/);
  });
});

describe('aplicación de los ajustes', () => {
  let repo: string;
  beforeEach(async () => {
    repo = makeNodeRepo();
    await h.call('project.open', { path: repo });
  });
  afterEach(() => removeRepo(repo));

  it('agent.create usa default_model y auto_relay_default solo si no se piden explícitos', async () => {
    expect(await h.call('agent.create', { name: 'A', provider: 'claude' })).toMatchObject({ model: 'sonnet', auto_relay: 1 });
    await set('default_model', 'opus');
    await set('auto_relay_default', '0');
    expect(await h.call('agent.create', { name: 'B', provider: 'claude' })).toMatchObject({ model: 'opus', auto_relay: 0 });
    expect(await h.call('agent.create', { name: 'C', provider: 'claude', model: 'haiku', autoRelay: true })).toMatchObject({ model: 'haiku', auto_relay: 1 });
    const c = h.orch.ctx.repos.connections.create({ name: 'L', preset: 'custom', baseUrl: 'http://127.0.0.1:1/v1', auth: 'none', defaultModel: 'otro' });
    await set('default_model', `conn:${c.id}/qwen`);
    expect(await h.call('agent.create', { name: 'D', provider: 'api', connectionId: c.id })).toMatchObject({ model: 'qwen', connection_id: c.id });
    expect(await h.call('agent.create', { name: 'E', provider: 'claude' })).toMatchObject({ model: 'sonnet', connection_id: null });
  });

  it('test_timeout_min manda sobre el tiempo de arranque', async () => {
    const ctx = h.orch.ctx;
    expect(testTimeoutMsOf(ctx)).toBe(ctx.testTimeoutMs);
    await set('test_timeout_min', '7');
    expect(testTimeoutMsOf(ctx)).toBe(7 * 60_000);
  });

  it('claude_path gana a KIJI_CLAUDE_PATH en providers.test y en el adaptador', async () => {
    const f = join(home, 'claude');
    writeFileSync(f, '#!/bin/sh\n');
    chmodSync(f, 0o755);
    const calls: any[] = [];
    const query = ((p: any) => {
      calls.push(p);
      const g: any = (async function* () { yield { type: 'result', subtype: 'success', is_error: false, result: 'ok' }; })();
      g.close = () => {};
      return g;
    }) as any;
    const execFile: any = (_f: string, _a: string[], _o: unknown, cb: any) => cb(null, '9.9.9 (Claude Code)\n', '');
    const o = createOrchestrator({ db: openDb(':memory:'), emit: () => {}, providerDeps: { env: { KIJI_CLAUDE_PATH: '/env/claude' }, query, execFile } });
    await o.handlers['providers.test']!({ provider: 'claude' });
    expect(calls[0].options.pathToClaudeCodeExecutable).toBe('/env/claude');
    await o.handlers['settings.set']!({ key: 'claude_path', value: f });
    await o.handlers['providers.test']!({ provider: 'claude' });
    expect(calls[1].options.pathToClaudeCodeExecutable).toBe(f);
    const adapter: any = makeAdapterFactory(o.ctx)({ provider: 'claude', connection_id: null, model: 'sonnet' } as any);
    expect(adapter.opts.pathToClaudeCodeExecutable).toBe(f);
    await o.shutdown();
  });

  it('extra_skill_roots amplía las raíces de skills.list, pero no sigue enlaces fuera de ellas', async () => {
    const skills = mkdir('.claude', 'skills');
    const extra = mkdir('agents', 'skills');
    const outside = mkdir('otro');
    const mk = (root: string, name: string) => {
      const d = join(root, name);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, 'SKILL.md'), `---\nname: ${name}\ndescription: Skill ${name}\n---\n`);
      return d;
    };
    symlinkSync(mk(extra, 'dentro'), join(skills, 'dentro'));
    symlinkSync(mk(outside, 'fuera'), join(skills, 'fuera'));
    mk(skills, 'propia');
    const h2 = makeHarness({ skillsDir: skills });
    const names = async () => (await h2.call('skills.list')).map((s: any) => s.name);
    expect(await names()).toEqual(['propia']);
    await h2.call('settings.set', { key: 'extra_skill_roots', value: JSON.stringify([extra]) });
    expect(await names()).toEqual(['dentro', 'propia']); // la cache se invalida al cambiar las raíces
    await h2.orch.shutdown();
  });
});

describe('avisos del sistema', () => {
  const emitNotify = (level: 'info' | 'warn' | 'ask') => {
    h.emitted.length = 0;
    const row = notify(h.orch.ctx, { projectId: 'p', level, title: 't', body: 'b' });
    return { row, ev: h.emitted.find((e) => e.name === 'notify')!.payload };
  };

  it('system según notify_system, notify_levels y quiet_hours; la fila se guarda siempre', async () => {
    expect(emitNotify('warn').ev.system).toBe(true); // defecto: warn y ask
    expect(emitNotify('ask').ev.system).toBe(true);
    expect(emitNotify('info').ev.system).toBe(false);
    await set('notify_levels', '["info"]');
    expect(emitNotify('info').ev.system).toBe(true);
    expect(emitNotify('warn').ev.system).toBe(false);
    await set('notify_system', '0');
    const r = emitNotify('info');
    expect(r.ev.system).toBe(false);
    expect(h.orch.ctx.repos.notifications.list({ limit: 50 }).some((n) => n.id === r.row.id)).toBe(true);
    await set('notify_system', '1');
    const now = new Date();
    const hm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const from = hm(new Date(now.getTime() - 60_000 * 5));
    const to = hm(new Date(now.getTime() + 60_000 * 5));
    if (from < to) { // evita el cruce de medianoche del propio test
      await set('quiet_hours', JSON.stringify({ from, to }));
      expect(emitNotify('info').ev.system).toBe(false);
    }
  });

  it('inQuietHours: tramo normal y que cruza la medianoche', () => {
    const at = (hh: number, mm = 0) => new Date(2026, 0, 5, hh, mm);
    expect(inQuietHours('', at(3))).toBe(false);
    expect(inQuietHours('{"from":"22:00","to":"08:00"}', at(23))).toBe(true);
    expect(inQuietHours('{"from":"22:00","to":"08:00"}', at(7, 59))).toBe(true);
    expect(inQuietHours('{"from":"22:00","to":"08:00"}', at(8))).toBe(false);
    expect(inQuietHours('{"from":"22:00","to":"08:00"}', at(12))).toBe(false);
    expect(inQuietHours('{"from":"13:00","to":"15:00"}', at(14))).toBe(true);
    expect(inQuietHours('{"from":"13:00","to":"15:00"}', at(15))).toBe(false);
  });
});

describe('events_retention_days', () => {
  it('borra eventos de registro antiguos y respeta runs, tareas, hallazgos y notificaciones', async () => {
    const repo = makeNodeRepo();
    try {
      const p = await h.call('project.open', { path: repo });
      const ctx = h.orch.ctx;
      const old = Date.now() - 40 * 86_400_000;
      const e1 = ctx.repos.events.append({ projectId: p.id, kind: 'text', payload: { text: 'viejo' } });
      const e2 = ctx.repos.events.append({ projectId: p.id, kind: 'git', payload: { finding: 'tests_failed' } });
      const e3 = ctx.repos.events.append({ projectId: p.id, kind: 'text', payload: { text: 'nuevo' } });
      ctx.db.prepare('UPDATE events SET created_at = ? WHERE id IN (?, ?)').run(old, e1.id, e2.id);
      notify(ctx, { projectId: p.id, level: 'info', title: 'x', body: 'y' });
      ctx.db.prepare('UPDATE notifications SET created_at = ?').run(old);
      expect(pruneEvents(ctx)).toBe(0); // 0 = sin límite
      await set('events_retention_days', '30'); // al guardar ya limpia
      const ids = ctx.db.prepare('SELECT id FROM events').all().map((r: any) => r.id);
      expect(ids).not.toContain(e1.id);
      expect(ids).toContain(e2.id);
      expect(ids).toContain(e3.id);
      expect(ctx.repos.notifications.list({ limit: 10 })).toHaveLength(1);
    } finally {
      removeRepo(repo);
    }
  });
});

describe('stats.models', () => {
  it('agrega runs de todos los proyectos por modelo, ordenado por runs y coste', async () => {
    const repo1 = makeNodeRepo();
    const repo2 = makeNodeRepo();
    try {
      const p1 = await h.call('project.open', { path: repo1 });
      const p2 = await h.call('project.open', { path: repo2 });
      const ctx = h.orch.ctx;
      const c = ctx.repos.connections.create({ name: 'L', preset: 'custom', baseUrl: 'http://127.0.0.1:1/v1', auth: 'none', defaultModel: 'qwen' });
      const a1 = await h.call('agent.create', { projectId: p1.id, name: 'Ana', provider: 'claude' });
      const a2 = await h.call('agent.create', { projectId: p2.id, name: 'Bea', provider: 'claude' });
      const a3 = await h.call('agent.create', { projectId: p2.id, name: 'Cai', provider: 'api', connectionId: c.id, model: 'qwen' });
      const obj = (pid: string) => ctx.repos.objectives.create({ projectId: pid, text: 'o' });
      const task = (pid: string, agentId: string) => ctx.repos.tasks.create({ objectiveId: obj(pid).id, title: 't', description: 'd', agentId });
      const run = (pid: string, agentId: string, model: string | null, cost: number, startedAt?: number) => {
        const r = ctx.repos.runs.create({ taskId: task(pid, agentId).id, agentId, model });
        ctx.repos.runs.update(r.id, { cost_usd: cost, input_tokens: 10, output_tokens: 5, cache_read_tokens: 2 });
        if (startedAt !== undefined) ctx.db.prepare('UPDATE runs SET started_at = ? WHERE id = ?').run(startedAt, r.id);
      };
      run(p1.id, a1.id, 'sonnet', 0.5);
      run(p2.id, a2.id, 'sonnet', 0.25);
      run(p2.id, a2.id, 'opus', 3);
      run(p2.id, a3.id, `conn:${c.id}/qwen`, 0);
      run(p1.id, a1.id, 'opus', 1, Date.now() - 10 * 86_400_000); // fuera de 7d
      const today = await h.call('stats.models', { range: 'today' });
      expect(today.map((m: any) => m.model)).toEqual(['sonnet', 'opus', `conn:${c.id}/qwen`]);
      expect(today[0]).toMatchObject({ provider: 'claude', runs: 2, input: 20, output: 10, cacheRead: 4, costUsd: 0.75, agents: ['Ana', 'Bea'] });
      expect(today[2]).toMatchObject({ provider: c.id, runs: 1, agents: ['Cai'] });
      expect(typeof today[0].lastUsedAt).toBe('number');
      expect((await h.call('stats.models', { range: '7d' })).find((m: any) => m.model === 'opus').runs).toBe(1);
      const all = await h.call('stats.models', { range: 'all', limit: 2 });
      expect(all.map((m: any) => [m.model, m.runs])).toEqual([['opus', 2], ['sonnet', 2]]); // empate de runs: más coste primero
      await expect(h.call('stats.models', { range: 'x' })).rejects.toThrow(/range/);
      await expect(h.call('stats.models', { range: 'all', limit: 0 })).rejects.toThrow(/limit/);
    } finally {
      removeRepo(repo1);
      removeRepo(repo2);
    }
  });

  it('statsSince cuenta días locales', () => {
    const now = new Date(2026, 2, 10, 15, 30).getTime();
    expect(statsSince('today', now)).toBe(new Date(2026, 2, 10).getTime());
    expect(statsSince('7d', now)).toBe(new Date(2026, 2, 4).getTime());
    expect(statsSince('30d', now)).toBe(new Date(2026, 1, 9).getTime());
    expect(statsSince('all', now)).toBe(0);
  });
});
