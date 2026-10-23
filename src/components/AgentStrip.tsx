// Tarjetas de robots: avatar real (primer fotograma `idle`), nombre, estado, modelo, barra de contexto y coste.
// `layout="strip"` (por defecto) es una tira de botones; `layout="vertical"` son pestañas para la columna derecha:
// tarjetas compactas (con "Todos" al principio) que se pliegan a una fila de avatares; con un robot elegido
// siempre es esa fila, para cambiar de robot sin perder sitio.
import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import type { Agent } from "../store/agents";
import type { AgentMetrics, RunMetrics } from "../store/metrics";
import { contextSegments, fmtTokens, fmtUsd, isBoss, pct, SEGMENTS, statusInfo } from "../screens/Agents/format";
import { loadAccessories } from "./accessories";
import RobotAvatar from "./RobotAvatar";
import { sheetKey } from "../scenes/officeLayout";
import { useModelLabel } from "../screens/Connections/useModelLabel";
import { useStore } from "../store";
import { useProjectId } from "../store/scoped";
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
  const pid = useProjectId();
  const [folded, setFolded] = useState(false);
  const autonomous = useStore((s) => s.manager[pid]?.policy?.enabled === true);

  const missing = agents.map((a) => String(a.id)).filter((id) => !metrics[id]).join("|");
  useEffect(() => {
    for (const id of missing.split("|").filter(Boolean)) void refreshMetrics(id);
  }, [missing, refreshMetrics]);

  if (agents.length === 0) return null;
  if (layout === "vertical") {
    const selected = agents.find((a) => String(a.id) === selectedId);
    const working = agents.filter((a) => WORKING.includes(a.status ?? "")).length;
    const cost = agents.reduce((sum, a) => sum + (metrics[String(a.id)]?.costUsd ?? 0), 0);
    // Con un robot elegido, la lista es siempre una fila de avatares; en "Todos" se puede plegar a mano.
    const row = !!selected || folded;
    const allProps = {
      role: "tab",
      id: `${idPrefix}-tab-all`,
      "aria-selected": !selected,
      "aria-controls": panelId,
      tabIndex: !selected ? 0 : -1,
      onClick: () => onSelect(null),
    } as const;
    return (
      <div className="strip-wrap">
        <div
          className={`strip-v${row ? " is-row" : ""}`}
          role="tablist"
          aria-orientation={row ? "horizontal" : "vertical"}
          aria-label="Robots"
          onKeyDown={arrowNav}
        >
          {row ? (
            <button type="button" {...allProps} className={`strip-all-chip${!selected ? " is-selected" : ""}`}>
              Todos
            </button>
          ) : (
            <button type="button" {...allProps} className={`strip-card strip-all${!selected ? " is-selected" : ""}`}>
              <span className="strip-body">
                <strong className="strip-name">Todos</strong>
                <span className="strip-status muted">
                  {agents.length} {agents.length === 1 ? "robot" : "robots"} · {working} trabajando
                </span>
                <span className="strip-cost muted">{fmtUsd(cost)}</span>
              </span>
            </button>
          )}
          {agents.map((a) => {
            const id = String(a.id);
            return (
              <StripCard
                key={id}
                agent={a}
                selected={id === selectedId}
                avatarOnly={row}
                liveRun={Object.values(liveRuns).find((r) => String(r.agentId) === id && r.live)}
                autonomous={autonomous && isBoss(a)}
                totals={metrics[id]}
                onSelect={(v) => onSelect(v)}
                tab={{ id: `${idPrefix}-tab-${id}`, panelId }}
              />
            );
          })}
        </div>
        {!selected && agents.length > 1 && (
          <button type="button" className="strip-fold" aria-expanded={!folded} onClick={() => setFolded((v) => !v)}>
            {folded ? "Mostrar tarjetas" : "Plegar a avatares"}
          </button>
        )}
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
            autonomous={autonomous && isBoss(a)}
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
  autonomous,
  totals,
  onSelect,
  tab,
  avatarOnly,
}: {
  agent: Agent;
  selected: boolean;
  /** Solo el avatar (fila plegada); el nombre y el estado quedan en el `aria-label` y el tooltip. */
  avatarOnly?: boolean;
  autonomous?: boolean;
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
  const accessories = useMemo(() => loadAccessories(agent.id), [agent.id]);
  const avatar = <RobotAvatar sheet={sheetKey(agent)} zoom={1} accessories={accessories} className="strip-avatar" />;
  if (avatarOnly) {
    return (
      <button
        type="button"
        className={`strip-chip${selected ? " is-selected" : ""}${isBoss(agent) ? " is-boss" : ""}`}
        {...(tab
          ? { role: "tab", id: tab.id, "aria-selected": selected, "aria-controls": tab.panelId, tabIndex: selected ? 0 : -1 }
          : { "aria-pressed": selected })}
        aria-label={`${agent.name}, ${st.label}`}
        title={`${agent.name} · ${st.label}`}
        onClick={() => onSelect(String(agent.id))}
      >
        {avatar}
        <span className="ag-status-dot strip-chip-dot" style={{ background: st.dot }} aria-hidden="true" />
      </button>
    );
  }
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
      {avatar}
      <span className="strip-body">
        <span className="strip-top">
          <strong className="strip-name">{agent.name}</strong>
          <span className="ag-chip">{label(model)}</span>
          {autonomous && (
            <span className="strip-auto" title="El gerente autónomo está activo">
              autónomo
            </span>
          )}
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
