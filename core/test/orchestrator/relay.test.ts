// Relevo (D10), cambio manual (D11) y reanudación al reset.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recordRate } from '../../src/orchestrator/quota.js';
import { RESUME_GRACE_MS } from '../../src/orchestrator/relay.js';
import { removeRepo } from '../git/helpers.js';
import { makeHarness, makeNodeRepo, type Harness } from './helpers.js';

let repo: string;
let h: Harness;
const tmps: string[] = [];
beforeEach(() => {
  repo = makeNodeRepo();
  h = undefined as unknown as Harness;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await h?.orch.shutdown();
  removeRepo(repo);
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

const inFuture = (ms: number) => Date.now() + ms;
const task = (id: string) => h.orch.ctx.repos.tasks.get(id)!;
const relaysOf = () => h.orch.ctx.repos.relays.list(h.orch.ctx.activeProject!.id);

async function setup(opts: Parameters<typeof makeHarness>[0] = {}) {
  h = makeHarness(opts);
  await h.call('project.open', { path: repo });
  const worker = (await h.call('agent.list')).find((a: any) => a.is_boss === 0);
  const t = await h.call('task.create', { title: 'Haz algo', description: 'Haz algo con a.ts', files: ['src/a.ts'], agent_id: worker.id });
  await h.call('task.start', { id: t.id });
  return { worker, t };
}
const modelLimit = (type: string, over: object = {}) => [
  { type: 'rate', status: 'rejected', rateLimitType: type, resetsAt: inFuture(3600_000) },
  { type: 'limit', kind: 'rate', rateLimitType: type, resetsAt: inFuture(3600_000), message: `Límite ${type}`, sessionId: 'sess-1', ...over },
] as any[];

describe('relevo automático por límite de modelo', () => {
  it('seven_day_sonnet con auto_relay: cierra el run como paused_limit, relanza con el siguiente modelo libre y reanuda la sesión', async () => {
    const { worker, t } = await setup();
    const first = h.adapters[0]!;
    first.push(...modelLimit('seven_day_sonnet'));
    await h.waitFor(() => h.adapters.length === 2, 'segundo run');
    await h.waitFor(() => task(t.id).status === 'running', 'running otra vez');

    const runs = h.orch.ctx.repos.runs.listByTask(t.id);
    expect(runs.map((r) => [r.status, r.model])).toEqual([['paused_limit', 'sonnet'], ['running', 'opus']]);
    expect(runs[0]!.provider_session_id).toBe('sess-1');
    const second = h.adapters[1]!;
    expect(second.spec).toMatchObject({ model: 'opus', resumeSessionId: 'sess-1', cwd: first.spec!.cwd });
    expect(second.spec!.prompt).toMatch(/límite de uso de Sonnet y ahora trabajas con Opus/);
    expect(first.stopped).toBe(true);

    // el agente conserva su modelo preferido
    expect(h.orch.ctx.repos.agents.get(worker.id)!.model).toBe('sonnet');
    expect((await h.call('agent.list')).find((a: any) => a.id === worker.id)).toMatchObject({ model: 'sonnet', current_model: 'opus' });
    expect((await h.call('task.list')).find((x: any) => x.id === t.id)).toMatchObject({ model: 'opus' });

    // relays + notificación
    const rows = relaysOf();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ task_id: t.id, from_agent_id: worker.id, to_agent_id: worker.id, from_model: 'sonnet', to_model: 'opus', reason: 'limit' });
    expect(rows[0]!.detail).toMatch(/Límite de Sonnet \(7 días\) alcanzado: Clau sigue la tarea «Haz algo» con Opus en lugar de Sonnet/);
    const ev = h.emitted.filter((e) => e.name === 'relay.happened');
    expect(ev).toHaveLength(1);
    expect(ev[0]!.payload).toMatchObject({ id: rows[0]!.id, taskId: t.id, fromModel: 'sonnet', toModel: 'opus', reason: 'limit' });
    expect(await h.call('relays.list', {})).toEqual([expect.objectContaining({ id: rows[0]!.id, toModel: 'opus' })]);
    // sin temporizador de reanudación: ya está corriendo con otro modelo
    expect(h.orch.ctx.resumeTimers.size).toBe(0);
  });

  it('encadena: Opus también limitado -> Haiku; los límites ya vistos descartan candidatos', async () => {
    await setup();
    recordRate(h.orch.ctx, { status: 'rejected', rateLimitType: 'seven_day_opus', resetsAt: inFuture(3600_000) });
    h.adapters[0]!.push(...modelLimit('seven_day_sonnet'));
    await h.waitFor(() => h.adapters.length === 2, 'segundo run');
    expect(h.adapters[1]!.spec!.model).toBe('haiku'); // opus está limitado
  });

  it('si el run relevado topa con otro límite de modelo vuelve a relevar', async () => {
    const { t } = await setup();
    h.adapters[0]!.push(...modelLimit('seven_day_sonnet'));
    await h.waitFor(() => h.adapters.length === 2, 'segundo run');
    h.adapters[1]!.push(...modelLimit('seven_day_opus', { sessionId: 'sess-2' }));
    await h.waitFor(() => h.adapters.length === 3, 'tercer run');
    expect(h.adapters[2]!.spec).toMatchObject({ model: 'haiku', resumeSessionId: 'sess-2' });
    expect(relaysOf().map((r) => [r.from_model, r.to_model]).reverse()).toEqual([['sonnet', 'opus'], ['opus', 'haiku']]);
    expect(h.orch.ctx.repos.runs.listByTask(t.id).map((r) => r.model)).toEqual(['sonnet', 'opus', 'haiku']);
  });

  it('cuando ya no queda ningún modelo libre: paused_limit con reanudación programada al reset', async () => {
    const { t } = await setup();
    recordRate(h.orch.ctx, { status: 'rejected', rateLimitType: 'seven_day_opus', resetsAt: inFuture(3600_000) });
    h.adapters[0]!.push(...modelLimit('seven_day_sonnet'));
    // haiku sigue libre: se releva a él
    await h.waitFor(() => h.adapters.length === 2, 'relevo a haiku');
    expect(h.adapters[1]!.spec!.model).toBe('haiku');
    h.adapters[1]!.push(...modelLimit('seven_day_sonnet'));
    await h.waitFor(() => task(t.id).status === 'paused_limit' && h.orch.ctx.live.size === 0, 'pausa final');
    expect(h.adapters).toHaveLength(2); // nadie más a quien relevar (el propio modelo ya salió y opus sigue limitado)
    expect(h.orch.ctx.resumeTimers.has(t.id)).toBe(true);
  });

  it('auto_relay desactivado: no relevo; pausa y reanudación al reset', async () => {
    h = makeHarness();
    await h.call('project.open', { path: repo });
    const worker = (await h.call('agent.list')).find((a: any) => a.is_boss === 0);
    await h.call('agent.update', { agentId: worker.id, autoRelay: false });
    const t = await h.call('task.create', { title: 'x', files: ['src/a.ts'], agent_id: worker.id });
    await h.call('task.start', { id: t.id });
    h.adapters[0]!.push(...modelLimit('seven_day_sonnet'));
    await h.waitFor(() => task(t.id).status === 'paused_limit' && h.orch.ctx.live.size === 0, 'paused_limit');
    expect(h.adapters).toHaveLength(1);
    expect(relaysOf()).toHaveLength(0);
    expect(h.orch.ctx.resumeTimers.has(t.id)).toBe(true);
  });

  it('el relay_order del agente manda: solo los modelos de la lista', async () => {
    h = makeHarness();
    await h.call('project.open', { path: repo });
    const worker = (await h.call('agent.list')).find((a: any) => a.is_boss === 0);
    await h.call('agent.update', { agentId: worker.id, relayOrder: ['haiku'] });
    const t = await h.call('task.create', { title: 'x', files: ['src/a.ts'], agent_id: worker.id });
    await h.call('task.start', { id: t.id });
    h.adapters[0]!.push(...modelLimit('seven_day_sonnet'));
    await h.waitFor(() => h.adapters.length === 2, 'relevo');
    expect(h.adapters[1]!.spec!.model).toBe('haiku');
  });
});

describe('límites que no se relevan', () => {
  it('budget: paused_limit, sin relevo ni temporizador', async () => {
    const { t } = await setup();
    h.adapters[0]!.push({ type: 'limit', kind: 'budget', message: 'presupuesto', sessionId: 'sess-b', resetsAt: inFuture(3600_000) });
    await h.waitFor(() => task(t.id).status === 'paused_limit' && h.orch.ctx.live.size === 0, 'paused_limit');
    expect(h.adapters).toHaveLength(1);
    expect(relaysOf()).toHaveLength(0);
    expect(h.orch.ctx.resumeTimers.size).toBe(0);
  });

  it('five_hour (toda la cuenta): sin relevo aunque auto_relay esté activo; temporizador a resetsAt + 30 s', async () => {
    const spy = vi.spyOn(globalThis, 'setTimeout');
    const { t } = await setup();
    const resetsAt = inFuture(2 * 3600_000);
    h.adapters[0]!.push({ type: 'rate', status: 'rejected', rateLimitType: 'five_hour', resetsAt }, { type: 'limit', kind: 'rate', rateLimitType: 'five_hour', resetsAt, message: 'cinco horas', sessionId: 'sess-5' });
    await h.waitFor(() => task(t.id).status === 'paused_limit' && h.orch.ctx.live.size === 0, 'paused_limit');
    expect(h.adapters).toHaveLength(1);
    expect(relaysOf()).toHaveLength(0);
    expect(h.orch.ctx.resumeTimers.has(t.id)).toBe(true);
    const delays = spy.mock.calls.map((c) => c[1] as number).filter((d) => d > 3600_000);
    expect(delays).toHaveLength(1);
    expect(Math.abs(delays[0]! - (resetsAt + RESUME_GRACE_MS - Date.now()))).toBeLessThan(2000);
  });

  it('tipo desconocido o ausente cuenta como toda la cuenta (sin relevo)', async () => {
    const { t } = await setup();
    h.adapters[0]!.push({ type: 'limit', kind: 'rate', resetsAt: inFuture(3600_000), message: 'Rate limit', sessionId: 's' });
    await h.waitFor(() => task(t.id).status === 'paused_limit' && h.orch.ctx.live.size === 0, 'paused_limit');
    expect(h.adapters).toHaveLength(1);
    expect(h.orch.ctx.resumeTimers.has(t.id)).toBe(true);
  });

  it('un límite sin hora de reset no programa nada', async () => {
    const { t } = await setup();
    h.adapters[0]!.push({ type: 'limit', kind: 'rate', rateLimitType: 'five_hour', message: 'sin hora' });
    await h.waitFor(() => task(t.id).status === 'paused_limit' && h.orch.ctx.live.size === 0, 'paused_limit');
    expect(h.orch.ctx.resumeTimers.size).toBe(0);
  });
});

describe('reanudación automática al reset', () => {
  it('al disparar el temporizador reanuda con resume de la sesión y registra resume_after_reset', async () => {
    const { worker, t } = await setup();
    // resetsAt tal que resetsAt + 30 s caiga dentro de ~100 ms
    const resetsAt = Date.now() - RESUME_GRACE_MS + 100;
    h.adapters[0]!.push({ type: 'limit', kind: 'rate', rateLimitType: 'five_hour', resetsAt, message: 'cinco horas', sessionId: 'sess-5' });
    await h.waitFor(() => h.adapters.length === 2, 'reanudación automática', 3000);
    await h.waitFor(() => task(t.id).status === 'running', 'running');
    expect(h.adapters[1]!.spec).toMatchObject({ model: 'sonnet', resumeSessionId: 'sess-5' });
    expect(h.adapters[1]!.spec!.prompt).toMatch(/límite de uso ya se restableció/);
    const rows = relaysOf();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reason: 'resume_after_reset', task_id: t.id, from_agent_id: worker.id, from_model: 'sonnet', to_model: 'sonnet' });
    expect(rows[0]!.detail).toMatch(/restableció.*«Haz algo».*Sonnet/);
    expect(h.emitted.filter((e) => e.name === 'relay.happened')).toHaveLength(1);
    expect(h.orch.ctx.resumeTimers.size).toBe(0);
  });

  it('la reanudación usa el modelo del último run (el del relevo), no el preferido', async () => {
    const { t } = await setup();
    h.adapters[0]!.push(...modelLimit('seven_day_sonnet'));
    await h.waitFor(() => h.adapters.length === 2, 'relevo');
    h.adapters[1]!.push({ type: 'limit', kind: 'rate', rateLimitType: 'five_hour', resetsAt: Date.now() - RESUME_GRACE_MS + 100, message: 'cinco horas', sessionId: 'sess-7' });
    await h.waitFor(() => h.adapters.length === 3, 'reanudación', 3000);
    expect(h.adapters[2]!.spec).toMatchObject({ model: 'opus', resumeSessionId: 'sess-7' });
    expect(relaysOf().map((r) => r.reason).reverse()).toEqual(['limit', 'resume_after_reset']);
    expect(t.id).toBeTruthy();
  });

  it('si la tarea ya no está pausada al llegar la hora (la reanudó la persona), no hace nada', async () => {
    const { t } = await setup();
    h.adapters[0]!.push({ type: 'limit', kind: 'rate', rateLimitType: 'five_hour', resetsAt: Date.now() - RESUME_GRACE_MS + 300, message: 'x', sessionId: 's' });
    await h.waitFor(() => task(t.id).status === 'paused_limit' && h.orch.ctx.live.size === 0, 'paused_limit');
    await h.call('task.start', { id: t.id }); // a mano, antes de que salte el temporizador
    expect(h.adapters).toHaveLength(2);
    await new Promise((r) => setTimeout(r, 500));
    expect(h.adapters).toHaveLength(2);
    expect(relaysOf()).toHaveLength(0);
  });

  it('si el agente sigue ocupado con otra tarea, espera y reintenta (no arranca dos runs)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    try {
      const { worker, t } = await setup();
      h.adapters[0]!.push({ type: 'limit', kind: 'rate', rateLimitType: 'five_hour', resetsAt: Date.now() - RESUME_GRACE_MS + 1000, message: 'x', sessionId: 's' });
      await h.waitFor(() => task(t.id).status === 'paused_limit' && h.orch.ctx.live.size === 0, 'paused_limit');
      const t2 = await h.call('task.create', { title: 'otra', files: ['src/other.ts'], agent_id: worker.id });
      await h.call('task.start', { id: t2.id }); // el agente se ocupa con otra tarea
      await vi.advanceTimersByTimeAsync(1500);
      expect(h.adapters).toHaveLength(2); // sin run nuevo de la pausada
      expect(h.orch.ctx.resumeTimers.has(t.id)).toBe(true); // reprogramado
      expect(task(t.id).status).toBe('paused_limit');
    } finally {
      vi.useRealTimers();
    }
  });

  it('no reanuda una tarea de otro proyecto; project.open descarta su temporizador y reprograma los del proyecto abierto', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    const repo2 = makeNodeRepo();
    try {
      const { t } = await setup();
      h.adapters[0]!.push({ type: 'limit', kind: 'rate', rateLimitType: 'five_hour', resetsAt: inFuture(60_000), message: 'x', sessionId: 's' });
      await h.waitFor(() => task(t.id).status === 'paused_limit' && h.orch.ctx.live.size === 0, 'paused_limit');
      expect(h.orch.ctx.resumeTimers.has(t.id)).toBe(true);
      await h.call('project.open', { path: repo2 }); // otro proyecto activo
      expect(h.orch.ctx.resumeTimers.size).toBe(0);
      await vi.advanceTimersByTimeAsync(200_000);
      expect(h.adapters).toHaveLength(1); // no se reanudó
      expect(task(t.id).status).toBe('paused_limit');
      await h.call('project.open', { path: repo }); // se reabre: se reprograma
      expect(h.orch.ctx.resumeTimers.has(t.id)).toBe(true);
    } finally {
      vi.useRealTimers();
      removeRepo(repo2);
    }
  });

  it('resumeAfterReset ignora la tarea si su proyecto no es el activo', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    const repo2 = makeNodeRepo();
    try {
      const { t } = await setup();
      h.adapters[0]!.push({ type: 'limit', kind: 'rate', rateLimitType: 'five_hour', resetsAt: inFuture(60_000), message: 'x', sessionId: 's' });
      await h.waitFor(() => task(t.id).status === 'paused_limit' && h.orch.ctx.live.size === 0, 'paused_limit');
      const other = (await h.call('project.open', { path: repo2 }));
      expect(h.orch.ctx.activeProject!.id).toBe(other.id);
      // fuerza un temporizador de la tarea del otro proyecto (como si hubiera sobrevivido)
      const { scheduleResume } = await import('../../src/orchestrator/relay.js');
      scheduleResume(h.orch.ctx, t.id, Date.now(), 1000);
      await vi.advanceTimersByTimeAsync(5000);
      expect(h.adapters).toHaveLength(1);
      expect(task(t.id).status).toBe('paused_limit');
    } finally {
      vi.useRealTimers();
      removeRepo(repo2);
    }
  });

  it('los temporizadores se limpian al cerrar el core', async () => {
    const { t } = await setup();
    h.adapters[0]!.push({ type: 'limit', kind: 'rate', rateLimitType: 'five_hour', resetsAt: inFuture(3600_000), message: 'x', sessionId: 's' });
    await h.waitFor(() => task(t.id).status === 'paused_limit' && h.orch.ctx.live.size === 0, 'paused_limit');
    expect(h.orch.ctx.resumeTimers.size).toBe(1);
    await h.orch.shutdown();
    expect(h.orch.ctx.resumeTimers.size).toBe(0);
  });

  it('al abrir el proyecto se reprograman las tareas paused_limit con resetsAt en su resume_hint', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kiji-db-'));
    tmps.push(dir);
    const dbPath = join(dir, 'kiji.db');
    const { t } = await setup({ dbPath });
    h.adapters[0]!.push({ type: 'limit', kind: 'rate', rateLimitType: 'five_hour', resetsAt: inFuture(3600_000), message: 'x', sessionId: 'sess-r' });
    await h.waitFor(() => task(t.id).status === 'paused_limit' && h.orch.ctx.live.size === 0, 'paused_limit');
    await h.orch.shutdown();
    h.orch.ctx.db.close();

    h = makeHarness({ dbPath });
    expect(h.orch.ctx.resumeTimers.size).toBe(0);
    await h.call('project.open', { path: repo });
    expect(h.orch.ctx.resumeTimers.has(t.id)).toBe(true);
    await h.call('project.open', { path: repo }); // reabrir no duplica
    expect(h.orch.ctx.resumeTimers.size).toBe(1);
  });

  it('si el reset ya pasó al abrir, reanuda enseguida (pocos segundos) con la sesión guardada', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    const dir = mkdtempSync(join(tmpdir(), 'kiji-db-'));
    tmps.push(dir);
    const dbPath = join(dir, 'kiji.db');
    try {
      const { t } = await setup({ dbPath });
      h.adapters[0]!.push({ type: 'limit', kind: 'rate', rateLimitType: 'five_hour', resetsAt: inFuture(3600_000), message: 'x', sessionId: 'sess-r' });
      await h.waitFor(() => task(t.id).status === 'paused_limit' && h.orch.ctx.live.size === 0, 'paused_limit');
      const run = h.orch.ctx.repos.runs.latestByTask(t.id)!;
      h.orch.ctx.repos.runs.update(run.id, { resume_hint: JSON.stringify({ sessionId: 'sess-r', resetsAt: Date.now() - 3600_000 }) });
      await h.orch.shutdown();
      h.orch.ctx.db.close();

      h = makeHarness({ dbPath });
      await h.call('project.open', { path: repo });
      await vi.advanceTimersByTimeAsync(6000);
      await h.waitFor(() => h.adapters.length === 1, 'reanudación tras abrir');
      expect(h.adapters[0]!.spec).toMatchObject({ resumeSessionId: 'sess-r' });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('task.stop en la ventana de cierre', () => {
  it('si el run ya terminó (ended) espera a que se retire y no lo recierra ni para el adaptador', async () => {
    const { t } = await setup();
    const live = h.orch.ctx.live.get(t.id)!;
    const run = h.orch.ctx.repos.runs.latestByTask(t.id)!;
    live.ended = true;
    live.finished = new Promise<void>((r) => setTimeout(() => { h.orch.ctx.live.delete(t.id); r(); }, 50));
    await expect(h.call('task.stop', { id: t.id })).rejects.toThrow(/no tiene un run en curso/);
    expect(h.adapters[0]!.stopped).toBe(false);
    expect(h.orch.ctx.repos.runs.latestByTask(t.id)!.status).toBe(run.status); // no se volvió a cerrar
    expect(relaysOf()).toHaveLength(0);
    h.orch.ctx.live.set(t.id, live); // para que el cierre de la prueba lo pare
    live.ended = false;
  });
});

describe('task.switch', () => {
  it('mismo agente, otro modelo: para el run limpiamente y reanuda la sesión con el nuevo modelo (reason manual)', async () => {
    const { worker, t } = await setup();
    const first = h.adapters[0]!;
    first.push({ type: 'usage', model: 'claude-sonnet-4-5', input: 1, output: 1, cacheRead: 0, cacheWrite: 0, contextTokens: 10, contextWindow: 200_000, sessionId: 'sess-live' });
    await h.waitFor(() => h.orch.ctx.live.get(t.id)?.sessionId === 'sess-live', 'sesión conocida');

    const view = await h.call('task.switch', { taskId: t.id, model: 'opus' });
    expect(view).toMatchObject({ id: t.id, status: 'running', model: 'opus' });
    expect(first.stopped).toBe(true);
    expect(h.adapters).toHaveLength(2);
    expect(h.adapters[1]!.spec).toMatchObject({ model: 'opus', resumeSessionId: 'sess-live', cwd: first.spec!.cwd });
    expect(h.adapters[1]!.spec!.prompt).toMatch(/se cambió el modelo de Sonnet a Opus/);
    const runs = h.orch.ctx.repos.runs.listByTask(t.id);
    expect(runs.map((r) => [r.status, r.model])).toEqual([['cancelled', 'sonnet'], ['running', 'opus']]);
    expect(runs[0]!.provider_session_id).toBe('sess-live');
    expect(h.orch.ctx.repos.agents.get(worker.id)!.model).toBe('sonnet');
    expect(relaysOf()[0]).toMatchObject({ reason: 'manual', task_id: t.id, from_agent_id: worker.id, to_agent_id: worker.id, from_model: 'sonnet', to_model: 'opus' });
    expect(relaysOf()[0]!.detail).toMatch(/Cambio manual.*Clau pasa de Sonnet a Opus/);
    expect(h.emitted.filter((e) => e.name === 'relay.happened')).toHaveLength(1);
    // el nuevo run sigue vivo y manejable: el cambio no dejó la tarea colgada
    h.adapters[1]!.push({ type: 'done', text: 'listo', costUsd: 0.1 });
    await h.waitFor(() => task(t.id).status === 'review', 'review');
    await h.orch.whenIdle();
  });

  it('sin sesión conocida (aún no hubo respuesta) relanza sin resume', async () => {
    const { t } = await setup();
    await h.call('task.switch', { taskId: t.id, model: 'haiku' });
    expect(h.adapters[1]!.spec!.resumeSessionId).toBeUndefined();
    expect(h.adapters[1]!.spec!.model).toBe('haiku');
  });

  it('una tarea pausada por límite también se puede cambiar de modelo y se reanuda al instante', async () => {
    const { t } = await setup();
    h.adapters[0]!.push({ type: 'limit', kind: 'rate', rateLimitType: 'five_hour', resetsAt: inFuture(3600_000), message: 'x', sessionId: 'sess-p' });
    await h.waitFor(() => task(t.id).status === 'paused_limit' && h.orch.ctx.live.size === 0, 'paused_limit');
    expect(h.orch.ctx.resumeTimers.has(t.id)).toBe(true);
    await h.call('task.switch', { taskId: t.id, model: 'haiku' });
    expect(h.adapters[1]!.spec).toMatchObject({ model: 'haiku', resumeSessionId: 'sess-p' });
    expect(h.orch.ctx.resumeTimers.has(t.id)).toBe(false); // ya no hace falta esperar al reset
    expect(task(t.id).status).toBe('running');
  });

  it('otro agente: nuevo run en el mismo worktree con prompt de traspaso (pedido, última respuesta, archivos y git diff --stat)', async () => {
    const { worker, t } = await setup();
    const first = h.adapters[0]!;
    first.push({ type: 'text', delta: 'He cambiado ' }, { type: 'text', delta: 'el valor de a.' });
    await h.waitFor(() => h.orch.ctx.repos.events.listByRun(h.orch.ctx.repos.runs.latestByTask(t.id)!.id, 'text').length === 2, 'texto guardado');
    writeFileSync(join(task(t.id).worktree_path!, 'src', 'a.ts'), 'export const a = 2;\n');
    writeFileSync(join(task(t.id).worktree_path!, 'src', 'nuevo.ts'), 'export {};\n');
    const pixel = await h.call('agent.create', { name: 'Pixel', provider: 'claude', model: 'haiku', role: 'programador' });

    const view = await h.call('task.switch', { taskId: t.id, agentId: pixel.id });
    expect(view).toMatchObject({ status: 'running', agent_id: pixel.id, model: 'haiku' });
    expect(first.stopped).toBe(true);
    const spec = h.adapters[1]!.spec!;
    expect(spec.cwd).toBe(first.spec!.cwd); // mismo worktree
    expect(spec.resumeSessionId).toBeUndefined();
    expect(spec.model).toBe('haiku'); // el modelo del agente destino
    expect(spec.systemPrompt).toContain('Te llamas Pixel');
    expect(spec.allowedPaths).toEqual(['src/a.ts']);
    expect(spec.prompt).toContain('Retomas una tarea que empezó Clau y se te traspasa a ti (Pixel)');
    expect(spec.prompt).toContain('Pedido original:\nHaz algo con a.ts');
    expect(spec.prompt).toMatch(/no instrucciones/);
    expect(spec.prompt).toContain('Última respuesta de Clau:\n<datos-del-trabajo-anterior tipo="ultima-respuesta">\nHe cambiado el valor de a.\n</datos-del-trabajo-anterior>');
    expect(spec.prompt).toContain('Archivos de la tarea:\n<datos-del-trabajo-anterior tipo="archivos">\n- src/a.ts\n</datos-del-trabajo-anterior>');
    expect(spec.prompt).toMatch(/git diff --stat\):\n<datos-del-trabajo-anterior tipo="diff-stat">\n\s*src\/a\.ts \| 2 \+-/);
    expect(spec.prompt).toContain('Archivos nuevos aún sin guardar:\n<datos-del-trabajo-anterior tipo="archivos-nuevos">\nsrc/nuevo.ts\n</datos-del-trabajo-anterior>');
    const runs = h.orch.ctx.repos.runs.listByTask(t.id);
    expect(runs.map((r) => [r.agent_id, r.status])).toEqual([[worker.id, 'cancelled'], [pixel.id, 'running']]);
    expect(relaysOf()[0]).toMatchObject({ reason: 'manual', from_agent_id: worker.id, to_agent_id: pixel.id, to_model: 'haiku' });
    expect(relaysOf()[0]!.detail).toMatch(/pasa de Clau a Pixel/);
    expect(h.orch.ctx.live.get(t.id)!.agentId).toBe(pixel.id);
  });

  it('otro agente + modelo: el modelo se aplica solo a ese run', async () => {
    const { t } = await setup();
    const pixel = await h.call('agent.create', { name: 'Pixel', provider: 'claude', model: 'haiku', role: 'programador' });
    await h.call('task.switch', { taskId: t.id, agentId: pixel.id, model: 'opus' });
    expect(h.adapters[1]!.spec!.model).toBe('opus');
    expect(h.orch.ctx.repos.agents.get(pixel.id)!.model).toBe('haiku');
  });

  it('valida que el agente destino no esté ocupado y entonces NO para el run actual', async () => {
    const { t } = await setup();
    const pixel = await h.call('agent.create', { name: 'Pixel', provider: 'claude', model: 'haiku', role: 'programador' });
    const t2 = await h.call('task.create', { title: 'otra', files: ['src/other.ts'], agent_id: pixel.id });
    await h.call('task.start', { id: t2.id });
    await expect(h.call('task.switch', { taskId: t.id, agentId: pixel.id })).rejects.toThrow(/Pixel ya está ocupado/);
    expect(h.adapters[0]!.stopped).toBe(false);
    expect(h.orch.ctx.live.has(t.id)).toBe(true);
    expect(task(t.id).status).toBe('running');
    expect(relaysOf()).toHaveLength(0);
  });

  it('errores de validación', async () => {
    const { worker, t } = await setup();
    const boss = (await h.call('agent.list')).find((a: any) => a.is_boss === 1);
    await expect(h.call('task.switch', { taskId: t.id })).rejects.toThrow(/model.*agentId/);
    await expect(h.call('task.switch', { taskId: t.id, model: 'gpt-4' })).rejects.toThrow(/modelo/);
    await expect(h.call('task.switch', { taskId: t.id, model: 'sonnet' })).rejects.toThrow(/ya usa Sonnet/);
    await expect(h.call('task.switch', { taskId: t.id, agentId: boss.id })).rejects.toThrow(/jefe/);
    await expect(h.call('task.switch', { taskId: t.id, agentId: 'nope' })).rejects.toThrow(/inexistente/);
    await expect(h.call('task.switch', { taskId: 'nope', model: 'opus' })).rejects.toThrow(/inexistente/);
    await expect(h.call('task.switch', {})).rejects.toThrow(/taskId/);
    expect(h.adapters).toHaveLength(1);
    expect(h.orch.ctx.live.has(t.id)).toBe(true);

    // una tarea que no corre ni está pausada por límite no se cambia
    const t2 = await h.call('task.create', { title: 'quieta', files: ['src/other.ts'], agent_id: worker.id });
    await expect(h.call('task.switch', { taskId: t2.id, model: 'opus' })).rejects.toThrow(/no está en marcha/);
  });

  it('relays.list: el más nuevo primero, con límite; sin proyecto abierto devuelve []', async () => {
    const empty = makeHarness();
    expect(await empty.call('relays.list')).toEqual([]);
    await empty.orch.shutdown();

    const { t } = await setup();
    await h.call('task.switch', { taskId: t.id, model: 'opus' });
    await h.call('task.switch', { taskId: t.id, model: 'haiku' });
    const all = await h.call('relays.list');
    expect(all.map((r: any) => r.toModel)).toEqual(['haiku', 'opus']);
    expect(await h.call('relays.list', { limit: 1 })).toHaveLength(1);
    expect(all[0]).toEqual({
      id: expect.any(Number), taskId: t.id, fromAgentId: expect.any(String), toAgentId: expect.any(String),
      fromModel: 'opus', toModel: 'haiku', reason: 'manual', detail: expect.any(String), createdAt: expect.any(Number),
    });
  });
});
