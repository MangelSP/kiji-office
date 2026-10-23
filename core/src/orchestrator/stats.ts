// `stats.overview` (panel del Home): proyectos, agentes, IAs, gasto, tokens, tiempo trabajado y gerente en una llamada.
// Días locales; "7 días" = hoy y los 6 anteriores. Un run cuenta en el día en que empezó.
import type { StatsOverview, StatsTokens } from '../../../shared/protocol.js';
import type { Ctx, Handler } from './context.js';
import { startOfLocalDay, usageByProject } from './queue.js';

const DAYS = 7;
type RunRow = { id: string; started_at: number; ended_at: number | null; cost: number; i: number; o: number; c: number };

const sumUsage = (m: Map<string, { cost: number; input: number; output: number; cacheRead: number }>) => {
  const t = { cost: 0, input: 0, output: 0, cacheRead: 0 };
  for (const u of m.values()) { t.cost += u.cost; t.input += u.input; t.output += u.output; t.cacheRead += u.cacheRead; }
  return t;
};

export async function buildStatsOverview(ctx: Ctx, now = Date.now()): Promise<StatsOverview> {
  const day0 = startOfLocalDay(now);
  const first = new Date(day0);
  first.setDate(first.getDate() - (DAYS - 1));
  const since7 = first.getTime();
  // Límites de cada día local (robusto al cambio de hora).
  const bounds = Array.from({ length: DAYS }, (_, k) => {
    const d = new Date(since7);
    d.setDate(d.getDate() + k);
    return d.getTime();
  });
  const dayOf = (t: number) => {
    let k = DAYS - 1;
    while (k > 0 && t < bounds[k]!) k--;
    return k;
  };

  const rows = ctx.db.prepare(
    `SELECT id, started_at, ended_at, cost_usd AS cost, input_tokens AS i, output_tokens AS o, cache_read_tokens AS c
     FROM runs WHERE started_at >= ?`,
  ).all(since7) as RunRow[];
  const liveIds = new Set([...ctx.live.values()].filter((l) => l.runId && !l.ended).map((l) => l.runId));

  const perDay7 = new Array<number>(DAYS).fill(0);
  const tok = (): StatsTokens => ({ in: 0, out: 0, cacheRead: 0 });
  const t7 = tok();
  const tToday = tok();
  let work7 = 0;
  let workToday = 0;
  for (const r of rows) {
    const k = dayOf(r.started_at);
    perDay7[k]! += r.cost;
    for (const t of k === DAYS - 1 ? [t7, tToday] : [t7]) { t.in += r.i; t.out += r.o; t.cacheRead += r.c; }
    const end = r.ended_at ?? (liveIds.has(r.id) ? now : r.started_at);
    const ms = Math.max(0, end - r.started_at);
    work7 += ms;
    if (k === DAYS - 1) workToday += ms;
  }

  // Consumo vivo aún sin escribir: se suma a "hoy" (igual que workspaces.overview).
  const usage = usageByProject(ctx, day0);
  const today = sumUsage(usage.today);
  const extra = { cost: Math.max(0, today.cost - perDay7[DAYS - 1]!), i: Math.max(0, today.input - tToday.in), o: Math.max(0, today.output - tToday.out), c: Math.max(0, today.cacheRead - tToday.cacheRead) };
  perDay7[DAYS - 1]! += extra.cost;
  for (const t of [t7, tToday]) { t.in += extra.i; t.out += extra.o; t.cacheRead += extra.c; }
  let total = 0;
  for (const v of usage.total.values()) total += v;

  // Agentes (de todos los proyectos conocidos).
  const projects = ctx.repos.projects.list();
  let agents = 0;
  let working = 0;
  for (const p of projects) {
    for (const a of ctx.repos.agents.list(p.id)) {
      agents++;
      const st = ctx.agentStatus.get(a.id);
      if (st === 'thinking' || st === 'writing') working++;
    }
  }
  const activity = ctx.repos.events.lastActivityByProject();
  const latest = [...activity].sort((a, b) => b.at - a.at)[0];
  const mostActive = latest ? (projects.find((p) => p.id === latest.project_id)?.name ?? null) : null;

  // IAs: las mismas tarjetas que «Tus IAs» (Claude y conexiones).
  const ais = { configured: 0, ok: 0, warning: 0, limited: 0 };
  try {
    for (const p of (await ctx.providerStatus?.()) ?? []) {
      if (!(p.id === 'claude' || p.id.startsWith('conn:')) || !p.configured) continue;
      ais.configured++;
      if (p.state === 'ok') ais.ok++;
      else if (p.state === 'warning') ais.warning++;
      else if (p.state === 'limited') ais.limited++;
    }
  } catch { /* sin estado de IAs: se queda en cero */ }

  const tick = ctx.db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(cost_usd), 0) AS cost FROM manager_ticks WHERE started_at >= ?').get(day0) as { n: number; cost: number };

  return {
    projects: { open: ctx.projects.size, total: projects.length, mostActive },
    agents: { total: agents, working, queued: ctx.queue.length },
    ais,
    cost: { today: perDay7[DAYS - 1]!, last7: perDay7.reduce((n, v) => n + v, 0), total, perDay7 },
    tokens: { today: tToday, last7: t7 },
    workTimeMs: { today: workToday, last7: work7 },
    manager: { ticksToday: tick.n, costToday: tick.cost },
  };
}

export function statsHandlers(ctx: Ctx): Record<string, Handler> {
  return {
    /** Sin parámetros -> StatsOverview. */
    'stats.overview': () => buildStatsOverview(ctx),
  };
}
