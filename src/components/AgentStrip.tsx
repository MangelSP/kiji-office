// Tarjetas de robots: avatar, modelo, estado, medidor de contexto de 8 segmentos y coste.
// `layout="strip"` (por defecto) es una tira de botones; `layout="vertical"` es una lista de pestañas
// (con "Todos" al principio) para la columna derecha; por debajo de 1100 px el CSS la vuelve fila con scroll.
import { useEffect, type KeyboardEvent } from "react";
import type { Agent } from "../store/agents";
import type { AgentMetrics, RunMetrics } from "../store/metrics";
import { contextSegments, fmtTokens, fmtUsd, isBoss, paletteHex, pct, SEGMENTS, statusInfo } from "../screens/Agents/format";
import { useModelLabel } from "../screens/Connections/useModelLabel";
import { useAgentsStore } from "../screens/Agents/useAgentsStore";
import "./AgentStrip.css";

type Props = {
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  layout?: "strip" | "vertical";
  /** Solo en vertical: prefijo de los ids de pestaña y id del panel que controlan. */
  idPrefix?: string;
  panelId?: string;
};

const WORKING = ["thinking", "writing"];

/** Flechas (arriba/abajo e izquierda/derecha), Inicio y Fin mueven el foco entre pestañas y las activan. */
function arrowNav(e: KeyboardEvent<HTMLElement>) {
  const back = ["ArrowUp", "ArrowLeft"].includes(e.key);
  if (!back && !["ArrowDown", "ArrowRight", "Home", "End"].includes(e.key)) return;
  const tabs = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'));
  const i = tabs.indexOf(document.activeElement as HTMLElement);
  if (i < 0) return;
  e.preventDefault();
  const next = e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : (i + (back ? -1 : 1) + tabs.length) % tabs.length;
  tabs[next].focus();
  tabs[next].click();
}

/** Medidor de 8 segmentos: acento normal, amarillo desde 6/8 y coral desde 7/8. */
export function ContextMeter({ used, total }: { used: number; total: number }) {
  const { filled, level } = contextSegments(used, total);
  const tip =
    total > 0 ? `Contexto: ${fmtTokens(used)} de ${fmtTokens(total)} (${pct(used, total)} %)` : "Contexto: sin datos todavía";
  return (
    <span className={`strip-meter is-${level}`} role="img" aria-label={tip} title={tip} data-filled={filled}>
      {Array.from({ length: SEGMENTS }, (_, i) => (
        <span key={i} className={`strip-seg${i < filled ? " is-on" : ""}`} />
      ))}
    </span>
  );
}

export default function AgentStrip({ selectedId, onSelect, layout = "strip", idPrefix = "strip", panelId }: Props) {
  const agents = useAgentsStore((s) => s.agents);
  const metrics = useAgentsStore((s) => s.metricsByAgent);
  const liveRuns = useAgentsStore((s) => s.liveRuns);
  const refreshMetrics = useAgentsStore((s) => s.refreshMetrics);

  const missing = agents.map((a) => String(a.id)).filter((id) => !metrics[id]).join("|");
  useEffect(() => {
    for (const id of missing.split("|").filter(Boolean)) void refreshMetrics(id);
  }, [missing, refreshMetrics]);

  if (agents.length === 0) return null;
  if (layout === "vertical") {
    const selected = agents.find((a) => String(a.id) === selectedId);
    const working = agents.filter((a) => WORKING.includes(a.status ?? "")).length;
    const cost = agents.reduce((sum, a) => sum + (metrics[String(a.id)]?.costUsd ?? 0), 0);
    return (
      <div className="strip-v" role="tablist" aria-orientation="vertical" aria-label="Robots" onKeyDown={arrowNav}>
        <button
          type="button"
          role="tab"
          id={`${idPrefix}-tab-all`}
          aria-selected={!selected}
          aria-controls={panelId}
          tabIndex={!selected ? 0 : -1}
          className={`strip-card strip-all${!selected ? " is-selected" : ""}`}
          onClick={() => onSelect(null)}
        >
          <span className="strip-body">
            <strong className="strip-name">Todos</strong>
            <span className="strip-status muted">
              {agents.length} {agents.length === 1 ? "robot" : "robots"} · {working} trabajando
            </span>
            <span className="strip-cost muted">{fmtUsd(cost)}</span>
          </span>
        </button>
        {agents.map((a) => {
          const id = String(a.id);
          return (
            <StripCard
              key={id}
              agent={a}
              selected={id === selectedId}
              liveRun={Object.values(liveRuns).find((r) => String(r.agentId) === id && r.live)}
              totals={metrics[id]}
              onSelect={(v) => onSelect(v === selectedId ? null : v)}
              tab={{ id: `${idPrefix}-tab-${id}`, panelId }}
            />
          );
        })}
      </div>
    );
  }
  return (
    <ul className="plain strip" aria-label="Robots">
      {agents.map((a) => (
        <li key={String(a.id)}>
          <StripCard
            agent={a}
            selected={selectedId !== null && String(a.id) === selectedId}
            liveRun={Object.values(liveRuns).find((r) => String(r.agentId) === String(a.id) && r.live)}
            totals={metrics[String(a.id)]}
            onSelect={onSelect}
          />
        </li>
      ))}
    </ul>
  );
}

function StripCard({
  agent,
  selected,
  liveRun,
  totals,
  onSelect,
  tab,
}: {
  agent: Agent;
  selected: boolean;
  liveRun: RunMetrics | undefined;
  totals: AgentMetrics | undefined;
  onSelect: (id: string | null) => void;
  tab?: { id: string; panelId?: string };
}) {
  const label = useModelLabel();
  const st = statusInfo(agent.status);
  const model = liveRun?.model ?? totals?.model ?? agent.current_model ?? agent.model ?? "—";
  const used = liveRun?.contextTokens ?? totals?.lastContextTokens ?? 0;
  const total = liveRun?.contextWindow ?? totals?.lastContextWindow ?? 0;
  return (
    <button
      type="button"
      className={`strip-card${selected ? " is-selected" : ""}${isBoss(agent) ? " is-boss" : ""}`}
      {...(tab
        ? { role: "tab", id: tab.id, "aria-selected": selected, "aria-controls": tab.panelId, tabIndex: selected ? 0 : -1 }
        : { "aria-pressed": selected })}
      aria-label={`${agent.name}, ${st.label}`}
      onClick={() => onSelect(String(agent.id))}
    >
      <span className="strip-avatar" style={{ background: paletteHex(agent.color) }} aria-hidden="true" />
      <span className="strip-body">
        <span className="strip-top">
          <strong className="strip-name">{agent.name}</strong>
          <span className="ag-chip">{label(model)}</span>
        </span>
        <span className="strip-status muted">
          <span className="ag-status-dot" style={{ background: st.dot }} aria-hidden="true" /> {st.label}
        </span>
        <ContextMeter used={used} total={total} />
        <span className="strip-cost muted">{totals ? fmtUsd(totals.costUsd) : "—"}</span>
      </span>
    </button>
  );
}
