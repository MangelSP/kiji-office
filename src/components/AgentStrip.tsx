// Tira horizontal de tarjetas de robots: avatar, modelo, estado, medidor de contexto de 8 segmentos y coste.
import { useEffect } from "react";
import type { Agent } from "../store/agents";
import type { AgentMetrics, RunMetrics } from "../store/metrics";
import { contextSegments, fmtTokens, fmtUsd, isBoss, paletteHex, pct, SEGMENTS, statusInfo } from "../screens/Agents/format";
import { useAgentsStore } from "../screens/Agents/useAgentsStore";
import "./AgentStrip.css";

type Props = { selectedId: string | null; onSelect: (id: string | null) => void };

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

export default function AgentStrip({ selectedId, onSelect }: Props) {
  const agents = useAgentsStore((s) => s.agents);
  const metrics = useAgentsStore((s) => s.metricsByAgent);
  const liveRuns = useAgentsStore((s) => s.liveRuns);
  const refreshMetrics = useAgentsStore((s) => s.refreshMetrics);

  const missing = agents.map((a) => String(a.id)).filter((id) => !metrics[id]).join("|");
  useEffect(() => {
    for (const id of missing.split("|").filter(Boolean)) void refreshMetrics(id);
  }, [missing, refreshMetrics]);

  if (agents.length === 0) return null;
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
}: {
  agent: Agent;
  selected: boolean;
  liveRun: RunMetrics | undefined;
  totals: AgentMetrics | undefined;
  onSelect: (id: string | null) => void;
}) {
  const st = statusInfo(agent.status);
  const model = liveRun?.model ?? totals?.model ?? agent.current_model ?? agent.model ?? "—";
  const used = liveRun?.contextTokens ?? totals?.lastContextTokens ?? 0;
  const total = liveRun?.contextWindow ?? totals?.lastContextWindow ?? 0;
  return (
    <button
      type="button"
      className={`strip-card${selected ? " is-selected" : ""}${isBoss(agent) ? " is-boss" : ""}`}
      aria-pressed={selected}
      aria-label={`${agent.name}, ${st.label}`}
      onClick={() => onSelect(String(agent.id))}
    >
      <span className="strip-avatar" style={{ background: paletteHex(agent.color) }} aria-hidden="true" />
      <span className="strip-body">
        <span className="strip-top">
          <strong className="strip-name">{agent.name}</strong>
          <span className="ag-chip">{model}</span>
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
