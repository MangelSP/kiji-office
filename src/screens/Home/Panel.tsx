// Home · Panel: monitor tipo popover de macOS. Chips de resumen arriba y rejilla de tarjetas oscuras
// (icono + etiqueta, número grande, mini gráfico o barra y una línea de detalle). Sustituye la cabecera de totales.
import { useEffect, useState } from "react";
import type { ModelUsage, StatsOverview, StatsTokens, WorkspaceTotals } from "../../../shared/protocol";
import pkg from "../../../package.json";
import { useStore } from "../../store";
import { modelLabel } from "../../store/modelLabel";
import { fetchModelUsage } from "../../store/settings";
import { fetchStatsOverview } from "../../store/stats";
import { fmtTokens, fmtUsd } from "../Agents/format";
import "./Panel.css";

const REFRESH_MS = 15_000;
const APP_START = Date.now();

/** 3 h 12 min · 45 min · 20 s. */
export function fmtSpan(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1000) return "0 s";
  const m = Math.floor(ms / 60_000);
  if (m < 1) return `${Math.floor(ms / 1000)} s`;
  const h = Math.floor(m / 60);
  return h < 1 ? `${m} min` : `${h} h ${String(m % 60).padStart(2, "0")} min`;
}

/** Sparkline SVG propio: línea + área de la serie (sin dependencias). */
export function Sparkline({ values, label }: { values: number[]; label: string }) {
  const W = 120;
  const H = 32;
  const max = Math.max(...values, 0);
  if (values.length < 2) return null;
  const pts = values.map((v, i): [number, number] => [(i / (values.length - 1)) * W, H - 2 - (max > 0 ? (v / max) * (H - 6) : 0)]);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1]!;
  return (
    <svg className="pn-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label}>
      <path d={`${line} L${W} ${H} L0 ${H} Z`} className="pn-spark-area" />
      <path d={line} className="pn-spark-line" vectorEffect="non-scaling-stroke" />
      <circle cx={last[0]} cy={last[1]} r="2.2" className="pn-spark-dot" />
    </svg>
  );
}

function Bar({ label, value, max, tone }: { label: string; value: number; max: number; tone?: "ok" | "warn" | "high" | "in" | "out" | "cache" }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  const level = tone ?? (pct >= 100 ? "high" : pct >= 80 ? "warn" : "ok");
  return (
    <div className={`pn-bar is-${level}`} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

function Card({ icon, title, value, of, children, detail }: { icon: string; title: string; value: string; of?: string; children?: React.ReactNode; detail?: React.ReactNode }) {
  return (
    <article className="pn-card" aria-label={title}>
      <p className="pn-label">
        <span aria-hidden="true">{icon}</span> {title}
      </p>
      <p className="pn-value">
        {value}
        {of && <span className="pn-of"> {of}</span>}
      </p>
      {children}
      {detail && <p className="pn-detail">{detail}</p>}
    </article>
  );
}

function TokenBars({ t, name }: { t: StatsTokens; name: string }) {
  const max = Math.max(t.in, t.out, t.cacheRead, 1);
  return (
    <div className="pn-tokens">
      <Bar label={`${name}: entrada`} value={t.in} max={max} tone="in" />
      <Bar label={`${name}: salida`} value={t.out} max={max} tone="out" />
      <Bar label={`${name}: caché`} value={t.cacheRead} max={max} tone="cache" />
    </div>
  );
}

const tokLine = (t: StatsTokens) => `${fmtTokens(t.in)} ent. · ${fmtTokens(t.out)} sal. · ${fmtTokens(t.cacheRead)} caché`;

function SessionTime() {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);
  return <>{fmtSpan(Date.now() - APP_START)}</>;
}

export default function Panel({ totals, open, onEditLimits, editing }: { totals?: WorkspaceTotals; open: number; onEditLimits: () => void; editing: boolean }) {
  const overview = useStore((s) => s.overview);
  const providers = useStore((s) => s.providers);
  const connections = useStore((s) => s.connections);
  const [stats, setStats] = useState<StatsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<ModelUsage[]>([]);

  useEffect(() => {
    let alive = true;
    const load = () => {
      void fetchStatsOverview().then((r) => {
        if (!alive) return;
        if (r.ok) { setStats(r.data); setError(null); } else setError(r.reason);
      });
      void fetchModelUsage("7d").then((r) => alive && r.ok && setModels(r.models));
    };
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const today = totals?.costTodayUsd ?? stats?.cost.today ?? 0;
  const budget = totals?.dailyBudgetUsd ?? 0;
  const live = totals?.liveRuns ?? 0;
  const maxRuns = totals?.maxConcurrentRuns ?? 0;
  const queued = totals?.queued ?? stats?.agents.queued ?? 0;
  const agentsNow = overview?.workspaces.reduce((n, w) => n + w.agents.length, 0) ?? 0;
  const aisConfigured = stats?.ais.configured ?? providers.filter((p) => (p.id === "claude" || p.id.startsWith("conn:")) && p.configured).length;
  const top = [...models].sort((a, b) => b.costUsd - a.costUsd || b.runs - a.runs).slice(0, 3);
  const topMax = Math.max(...top.map((m) => m.costUsd), 0);
  const dash = "—";

  return (
    <section className="pn" aria-label="Totales globales">
      <ul className="pn-chips" aria-label="Resumen">
        <li className="pn-chip">{open} {open === 1 ? "workspace abierto" : "workspaces abiertos"}</li>
        <li className="pn-chip">{stats?.agents.total ?? agentsNow} agentes</li>
        <li className="pn-chip">{aisConfigured} {aisConfigured === 1 ? "IA configurada" : "IAs configuradas"}</li>
        <li className="pn-chip">v{pkg.version}</li>
      </ul>
      {error && !stats && <p className="hm-muted pn-note">{error}</p>}
      <div className="pn-grid">
        <Card icon="▣" title="Proyectos" value={stats ? String(stats.projects.open) : String(open)} of={stats ? `/ ${stats.projects.total}` : undefined}
          detail={stats?.projects.mostActive ? `Más activo: ${stats.projects.mostActive}` : "abiertos / total"} />
        <Card icon="☻" title="Agentes" value={stats ? String(stats.agents.total) : dash}
          detail={`${stats ? stats.agents.working : dash} trabajando · ${queued} en cola`}>
          <p className="pn-sub">Runs vivos <strong>{live}</strong>{maxRuns > 0 && <span className="pn-of"> / {maxRuns}</span>}</p>
          {maxRuns > 0 && <Bar label="Runs vivos frente al máximo" value={live} max={maxRuns} />}
        </Card>
        <Card icon="✦" title="IAs" value={String(aisConfigured)} of="configuradas"
          detail={stats ? `${stats.ais.ok} ok · ${stats.ais.warning} aviso · ${stats.ais.limited} límite` : undefined}>
          {stats && (
            <div className="pn-dots" aria-hidden="true">
              {Array.from({ length: stats.ais.ok }, (_, i) => <i key={`o${i}`} className="is-ok" />)}
              {Array.from({ length: stats.ais.warning }, (_, i) => <i key={`w${i}`} className="is-warn" />)}
              {Array.from({ length: stats.ais.limited }, (_, i) => <i key={`l${i}`} className="is-high" />)}
            </div>
          )}
        </Card>
        <Card icon="$" title="Gasto" value={fmtUsd(today)} of={budget > 0 ? `/ ${fmtUsd(budget)}` : undefined}
          detail={stats ? `7 días ${fmtUsd(stats.cost.last7)} · total ${fmtUsd(stats.cost.total)}` : undefined}>
          {budget > 0 && <Bar label="Gasto de hoy frente al tope diario" value={today} max={budget} />}
          {stats && <Sparkline values={stats.cost.perDay7} label="Gasto por día, últimos 7 días" />}
          <button type="button" className="hm-link pn-link" aria-expanded={editing} onClick={onEditLimits}>Editar topes</button>
        </Card>
        <Card icon="≋" title="Tokens hoy" value={stats ? fmtTokens(stats.tokens.today.in + stats.tokens.today.out) : dash}
          detail={stats ? `7 días: ${tokLine(stats.tokens.last7)}` : undefined}>
          {stats && <TokenBars t={stats.tokens.today} name="Tokens de hoy" />}
          {stats && <p className="pn-sub">{tokLine(stats.tokens.today)}</p>}
        </Card>
        <Card icon="◷" title="Tiempo" value={stats ? fmtSpan(stats.workTimeMs.today) : dash}
          detail={stats ? `Robots 7 días: ${fmtSpan(stats.workTimeMs.last7)}` : undefined}>
          <p className="pn-sub">Trabajado hoy por los robots</p>
          <p className="pn-sub">Sesión de la app <strong><SessionTime /></strong></p>
        </Card>
        <Card icon="◆" title="Modelos" value={top[0] ? modelLabel(top[0].model, connections) : dash} detail="Top 3 por coste · 7 días">
          {top.map((m) => (
            <div key={m.model} className="pn-model">
              <span title={m.model}>{modelLabel(m.model, connections)}</span>
              <Bar label={`Coste de ${modelLabel(m.model, connections)}`} value={m.costUsd} max={topMax} tone="in" />
              <span className="pn-num">{fmtUsd(m.costUsd)}</span>
            </div>
          ))}
        </Card>
        <Card icon="♛" title="Gerente" value={stats ? String(stats.manager.ticksToday) : dash} of="ticks hoy"
          detail={stats ? (stats.manager.costToday > 0 ? `Gasto hoy ${fmtUsd(stats.manager.costToday)}` : "Sin gasto hoy") : undefined} />
      </div>
    </section>
  );
}
