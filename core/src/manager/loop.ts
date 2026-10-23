// Bucle del gerente (PLAN-0.2b, D23): sin `while(true)`. Se despierta (tick) por disparadores; un tick es un run de solo lectura
// del agente cerebro con las herramientas Kiji. Un tick a la vez por proyecto, mínimo `minTickGapMs` entre inicios (los
// disparadores se agrupan), `maxTicksPerHour`, horas de silencio y tope del día (solo avisan), `maxTickMinutes` aborta.
// Los disparadores pendientes viven solo en memoria: al reiniciar el core no se relanza ningún tick.
import type { MemoryRow } from '../../../shared/protocol.js';
import type { AgentAdapter, RunSpec } from '../adapters/types.js';
import { parseConnTarget, runModelOf } from '../orchestrator/connections.js';
import type { Ctx } from '../orchestrator/context.js';
import { recallMemory } from '../orchestrator/memory.js';
import { notify } from '../orchestrator/notifications.js';
import { type TickTrigger, GERENTE_ROLE, buildTickPrompt } from './prompt.js';
import {
  type ManagerOptions, clearAskTimers, inQuietHours, managerCostToday, msUntil, readPolicy, resolveAction, tickView,
} from './policy.js';
import { buildState, newToolEnv, toExtraTools, toSdkServer } from './tools.js';

export type { ManagerOptions } from './policy.js';

/** Estados de tarea que despiertan al gerente. */
const WAKE_STATUSES = new Set(['review', 'changes', 'failed', 'blocked', 'paused_limit']);
const MAX_PENDING = 20;
const HOUR = 3_600_000;
/** Aviso repetido de «horas de silencio» / «tope del día»: como mucho uno por este tiempo. */
const NOTICE_EVERY_MS = 30 * 60_000;

export interface ManagerRuntime {
  /** Pide un tick por este motivo (se agrupa con los demás y respeta los límites). No hace nada si el gerente está apagado o parado. */
  trigger(projectId: string, kind: string, detail?: string): void;
  /** «Habla con el gerente»: tick ya (salta pausa y límite por hora); devuelve su id. Lanza con un mensaje claro si no puede. */
  manualTick(projectId: string, message?: string): string;
  onTaskChanged(projectId: string, taskId: string, status: string): void;
  onRunEnded(projectId: string, taskId: string): void;
  /** Marca que el gerente está ejecutando una herramienta (sus propios cambios no lo despiertan). */
  acting(projectId: string, delta: 1 | -1): void;
  /** Arma o desarma el temporizador del proyecto según su política. */
  syncProject(projectId: string): void;
  stopProject(projectId: string): void;
  /** Parada global: cancela temporizadores y disparadores y aborta los ticks en curso. */
  halt(): Promise<void>;
  /** Quita la parada: vuelve a armar los temporizadores. */
  resume(): void;
  isRunning(projectId: string): boolean;
  /** Espera a que terminen los ticks en curso (pruebas). */
  whenIdle(): Promise<void>;
  dispose(): void;
}

interface PState {
  running: Promise<void> | null;
  adapter: AgentAdapter | null;
  abort: string | null;
  pending: TickTrigger[];
  timer: NodeJS.Timeout | null;
  periodic: NodeJS.Timeout | null;
  quietEnd: NodeJS.Timeout | null;
  lastStart: number;
  acting: number;
  lastStatus: Map<string, string>;
  lastNotice: Map<string, number>;
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function createManagerRuntime(ctx: Ctx): ManagerRuntime {
  const states = new Map<string, PState>();
  const opts = ctx.managerOptions;
  const nowMs = (): number => opts.now();

  // --- Arranque: lo que dejó un corte no se relanza ni se duplica ---
  ctx.db.prepare("UPDATE manager_ticks SET ended_at = ?, summary = CASE WHEN summary = '' THEN 'Interrumpido por un reinicio del core.' ELSE summary END WHERE ended_at IS NULL").run(Date.now());
  for (const a of ctx.repos.approvals.listPending()) {
    if (a.tool.startsWith('manager:')) ctx.repos.approvals.decide(a.id, 'denied');
  }
  // Preguntas que quedaron sin respuesta (su aprobación ya pudo denegarla `recoverAllProjects`): se dan por NO.
  for (const a of ctx.db.prepare("SELECT id FROM manager_actions WHERE level = 'ask' AND decided_by IS NULL").all() as Array<{ id: number }>) {
    resolveAction(ctx, a.id, { result: { ok: false, denied: true, message: 'El core se reinició sin respuesta: se da por NO.' }, decidedBy: 'timeout' });
  }

  const st = (pid: string): PState => {
    let s = states.get(pid);
    if (!s) {
      s = {
        running: null, adapter: null, abort: null, pending: [], timer: null, periodic: null, quietEnd: null,
        lastStart: ctx.repos.managerTicks.latest(pid)?.started_at ?? 0, acting: 0, lastStatus: new Map(), lastNotice: new Map(),
      };
      states.set(pid, s);
    }
    return s;
  };

  const active = (pid: string): boolean => !ctx.closed && !ctx.halted && ctx.projects.has(pid) && readPolicy(ctx, pid)?.enabled === true;

  const clearTimers = (s: PState): void => {
    for (const k of ['timer', 'periodic', 'quietEnd'] as const) {
      if (s[k]) clearTimeout(s[k]!);
      s[k] = null;
    }
  };

  /** Ticks que cuentan para maxTicksPerHour: los que de verdad despiertan al modelo. */
  const hourStats = (pid: string, since: number): { n: number; oldest: number } => {
    const r = ctx.db.prepare(
      "SELECT COUNT(*) AS n, COALESCE(MIN(started_at), 0) AS oldest FROM manager_ticks WHERE project_id = ? AND started_at >= ? AND trigger NOT LIKE 'skipped:%' AND trigger NOT IN ('halt', 'resume')",
    ).get(pid, since) as { n: number; oldest: number };
    return r;
  };

  // --- Planificación ---
  function schedule(pid: string): void {
    const s = st(pid);
    if (s.timer || s.running || s.pending.length === 0 || !active(pid)) return;
    const wait = Math.max(opts.settleMs, s.lastStart + opts.minTickGapMs - nowMs());
    s.timer = setTimeout(() => { s.timer = null; fire(pid); }, wait);
    s.timer.unref();
  }

  function trigger(pid: string, kind: string, detail?: string): void {
    if (!active(pid)) return;
    const s = st(pid);
    if (!s.pending.some((t) => t.kind === kind && t.detail === detail) && s.pending.length < MAX_PENDING) s.pending.push({ kind, ...(detail ? { detail } : {}) });
    schedule(pid);
  }

  const noticeDue = (s: PState, key: string): boolean => {
    const last = s.lastNotice.get(key) ?? 0;
    if (nowMs() - last < NOTICE_EVERY_MS) return false;
    s.lastNotice.set(key, nowMs());
    return true;
  };

  /** Tick que no despierta al modelo (silencio / tope del día): deja una línea en el diario y avisa. */
  function skipTick(pid: string, reason: 'quiet-hours' | 'day-budget', text: string): void {
    const s = st(pid);
    s.pending = [];
    if (!noticeDue(s, reason)) return;
    const tick = ctx.repos.managerTicks.create({ projectId: pid, trigger: `skipped:${reason}` });
    ctx.emit('manager.tick', { projectId: pid, phase: 'started', tick: tickView(tick) });
    const ended = ctx.repos.managerTicks.end(tick.id, { summary: text, costUsd: 0 })!;
    ctx.emit('manager.tick', { projectId: pid, phase: 'ended', tick: tickView(ended) });
    notify(ctx, { projectId: pid, level: reason === 'day-budget' ? 'warn' : 'info', title: reason === 'day-budget' ? 'El gerente llegó al tope del día' : 'El gerente en horas de silencio', body: text });
  }

  const waitingSummary = (pid: string): string => {
    const by: Record<string, number> = {};
    for (const t of ctx.repos.tasks.listByProject(pid)) if (WAKE_STATUSES.has(t.status)) by[t.status] = (by[t.status] ?? 0) + 1;
    const parts = Object.entries(by).map(([k, v]) => `${v} en ${k}`);
    return parts.length ? `Hay ${parts.join(', ')}.` : 'Nada urgente.';
  };

  function fire(pid: string): void {
    const s = st(pid);
    if (s.running || s.pending.length === 0) return;
    if (!active(pid)) { s.pending = []; return; }
    const policy = readPolicy(ctx, pid)!;
    if (inQuietHours(policy.quietHours, nowMs())) {
      skipTick(pid, 'quiet-hours', `Horas de silencio (${policy.quietHours!.from}–${policy.quietHours!.to}): no arranco nada. ${waitingSummary(pid)}`);
      if (!s.quietEnd) {
        s.quietEnd = setTimeout(() => { s.quietEnd = null; trigger(pid, 'quiet-end', 'Terminaron las horas de silencio'); }, Math.min(msUntil(policy.quietHours!.to, nowMs()) + 1000, 2_000_000_000));
        s.quietEnd.unref();
      }
      return;
    }
    if (managerCostToday(ctx, pid) >= policy.dayBudgetUsd) {
      skipTick(pid, 'day-budget', `Tope del día alcanzado (${policy.dayBudgetUsd} USD): no arranco nada más hoy. ${waitingSummary(pid)}`);
      return;
    }
    const hour = hourStats(pid, nowMs() - HOUR);
    if (hour.n >= policy.maxTicksPerHour) {
      if (noticeDue(s, 'hour-limit')) notify(ctx, { projectId: pid, level: 'info', title: 'El gerente descansa', body: `Llegó a ${policy.maxTicksPerHour} despertares en una hora; seguirá en cuanto pase.` });
      s.timer = setTimeout(() => { s.timer = null; fire(pid); }, Math.max(1000, hour.oldest + HOUR - nowMs() + 50));
      s.timer.unref();
      return;
    }
    const triggers = s.pending;
    s.pending = [];
    startTick(pid, [...new Set(triggers.map((t) => t.kind))].join('+'), triggers);
  }

  // --- Un tick ---
  function startTick(pid: string, label: string, triggers: TickTrigger[], message?: string): string {
    const s = st(pid);
    const tick = ctx.repos.managerTicks.create({ projectId: pid, trigger: label });
    s.lastStart = nowMs();
    s.abort = null;
    ctx.emit('manager.tick', { projectId: pid, phase: 'started', tick: tickView(tick) });
    s.running = runTick(pid, tick.id, triggers, message)
      .catch((e: unknown) => endTick(pid, tick.id, `Error del gerente: ${msg(e)}`, 0))
      .finally(() => {
        s.running = null;
        s.adapter = null;
        schedule(pid);
      });
    return tick.id;
  }

  function endTick(pid: string, tickId: string, summary: string, cost: number): void {
    const row = ctx.repos.managerTicks.end(tickId, { summary: clip(summary, 2000), costUsd: cost });
    if (row) ctx.emit('manager.tick', { projectId: pid, phase: 'ended', tick: tickView(row) });
  }

  function relevantMemory(pid: string, recent: MemoryRow[], triggers: TickTrigger[], message?: string): MemoryRow[] {
    const text = [message ?? '', ...triggers.map((t) => t.detail ?? ''), ...ctx.repos.objectives.list(pid).filter((o) => o.status !== 'done').map((o) => o.text)].join(' ');
    const words = [...new Set(text.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? [])].slice(0, 6);
    const seen = new Set(recent.map((m) => m.id));
    const out: MemoryRow[] = [];
    for (const w of words) {
      for (const m of recallMemory(ctx, pid, w, 3)) {
        if (!seen.has(m.id) && out.length < 10) { seen.add(m.id); out.push(m); }
      }
    }
    return out;
  }

  async function runTick(pid: string, tickId: string, triggers: TickTrigger[], message?: string): Promise<void> {
    const s = st(pid);
    const policy = readPolicy(ctx, pid);
    const project = ctx.projects.get(pid);
    if (!policy || !project) return endTick(pid, tickId, 'El gerente está apagado o el proyecto está cerrado.', 0);
    const agent = ctx.repos.agents.get(policy.brain.agentId);
    if (!agent || agent.project_id !== pid) {
      notify(ctx, { projectId: pid, level: 'warn', title: 'El gerente no tiene cerebro', body: 'El agente elegido ya no existe: elige otro en su política.' });
      return endTick(pid, tickId, 'El agente cerebro ya no existe.', 0);
    }
    const env = newToolEnv(ctx, pid, tickId);
    const recent = recallMemory(ctx, pid, undefined, 30);
    const prompt = buildTickPrompt({ policy, state: buildState(ctx, pid), recent, relevant: relevantMemory(pid, recent, triggers, message), triggers, message });

    // Mismo reparto que startTask: agente propio -> su modelo; con conexión -> api-loop con el modelo libre.
    const model = runModelOf(agent);
    const target = parseConnTarget(model);
    const adapter = ctx.adapterFactory(target ? { ...agent, provider: 'api', connection_id: target.connectionId, model: target.model } : agent);
    s.adapter = adapter;
    const remaining = Math.max(0.01, policy.dayBudgetUsd - managerCostToday(ctx, pid));
    const spec: RunSpec = {
      runId: tickId,
      cwd: project.path,
      model: target ? target.model : model,
      systemPrompt: GERENTE_ROLE,
      prompt,
      allowedPaths: [],
      readOnly: true,
      budgetUsd: Math.min(opts.tickBudgetUsd, remaining),
      mcpServers: { kiji: toSdkServer(env) },
      extraTools: toExtraTools(env),
    };

    let cost = 0;
    let text = '';
    let failure: string | null = null;
    const limitMs = opts.maxTickMs ?? policy.maxTickMinutes * 60_000;
    const killer = setTimeout(() => { s.abort = `Abortado: superó el tiempo máximo del despertar (${policy.maxTickMinutes} min).`; void adapter.stop(); }, limitMs);
    killer.unref();
    try {
      for await (const ev of adapter.start(spec)) {
        if (s.abort) break;
        switch (ev.type) {
          case 'permission_request':
            adapter.answerPermission(ev.id, false, 'El gerente no puede conceder permisos: solo la persona.'); // candado
            break;
          case 'usage':
            if (ev.costUsd !== undefined) cost = ev.costUsd;
            break;
          case 'done':
            cost = ev.costUsd ?? cost;
            text = ev.text;
            break;
          case 'error':
            failure = `Error del cerebro: ${ev.message}`;
            break;
          case 'limit':
            failure = `Límite del cerebro: ${ev.message}`;
            break;
          default:
            break;
        }
      }
    } finally {
      clearTimeout(killer);
      env.closed = true;
      await adapter.stop().catch(() => undefined);
    }
    if (failure) notify(ctx, { projectId: pid, level: 'warn', title: 'El gerente no pudo pensar', body: failure });
    endTick(pid, tickId, env.summary ?? s.abort ?? failure ?? (text.trim() !== '' ? text.trim() : 'Sin cambios.'), cost);
  }

  const timerArm = (pid: string): void => {
    const s = st(pid);
    if (s.periodic) clearTimeout(s.periodic);
    s.periodic = null;
    if (!active(pid)) return;
    s.periodic = setTimeout(() => {
      s.periodic = null;
      if (ctx.repos.objectives.list(pid).some((o) => o.status !== 'done')) trigger(pid, 'timer', 'Revisión periódica con objetivos abiertos');
      timerArm(pid);
    }, opts.timerMs);
    s.periodic.unref();
  };

  const runtime: ManagerRuntime = {
    trigger,
    manualTick(pid, message) {
      if (ctx.halted) throw new Error('Parada global activa: pulsa «Reanudar» para hablar con el gerente.');
      if (!ctx.projects.has(pid)) throw new Error('el proyecto no está abierto');
      const policy = readPolicy(ctx, pid);
      if (!policy?.enabled) throw new Error('El gerente está apagado en este proyecto: actívalo en su política.');
      const s = st(pid);
      if (s.running) throw new Error('El gerente ya está pensando: espera a que termine.');
      if (managerCostToday(ctx, pid) >= policy.dayBudgetUsd) throw new Error(`Tope del día del gerente alcanzado (${policy.dayBudgetUsd} USD).`);
      const triggers: TickTrigger[] = [...s.pending, { kind: 'manual' }];
      s.pending = [];
      if (s.timer) clearTimeout(s.timer);
      s.timer = null;
      return startTick(pid, 'manual', triggers, message?.trim() || undefined);
    },
    onTaskChanged(pid, taskId, status) {
      if (pid === '') return;
      const s = st(pid);
      const prev = s.lastStatus.get(taskId);
      s.lastStatus.set(taskId, status);
      if (prev === status || !WAKE_STATUSES.has(status)) return;
      if (s.acting > 0) return; // lo provocó una herramienta del propio gerente
      trigger(pid, 'task.changed', `${clip(ctx.repos.tasks.get(taskId)?.title ?? taskId, 80)} -> ${status}`);
    },
    onRunEnded(pid, taskId) {
      const s = st(pid);
      const task = ctx.repos.tasks.get(taskId);
      if (!task || s.acting > 0 || !WAKE_STATUSES.has(task.status)) return;
      trigger(pid, 'run.ended', `${clip(task.title, 80)} (${task.status})`);
    },
    acting(pid, delta) {
      const s = st(pid);
      s.acting = Math.max(0, s.acting + delta);
    },
    syncProject: timerArm,
    stopProject(pid) {
      const s = st(pid);
      clearTimers(s);
      s.pending = [];
      void s.adapter?.stop();
    },
    async halt() {
      s_all((s) => { clearTimers(s); s.pending = []; s.abort = 'Interrumpido por la parada global.'; });
      await Promise.allSettled([...states.values()].map(async (s) => { await s.adapter?.stop(); await s.running; }));
    },
    resume() {
      for (const pid of ctx.projects.keys()) timerArm(pid);
    },
    isRunning: (pid) => st(pid).running !== null,
    async whenIdle() {
      for (;;) {
        const running = [...states.values()].map((s) => s.running).filter((r): r is Promise<void> => r !== null);
        if (running.length === 0) return;
        await Promise.allSettled(running);
      }
    },
    dispose() {
      s_all((s) => { clearTimers(s); s.pending = []; });
      for (const s of states.values()) void s.adapter?.stop();
      clearAskTimers(ctx);
    },
  };
  function s_all(fn: (s: PState) => void): void {
    for (const s of states.values()) fn(s);
  }
  return runtime;
}
