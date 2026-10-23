// Panel de agentes de la columna derecha: tarjetas-pestaña (AgentStrip vertical) y, debajo, el resumen "Todos"
// o el detalle del agente con Tareas, Métricas, Perfil y Registro. Controlado por `selectedId` (escena y caja de pedido).
import { useEffect, useId, useState, type KeyboardEvent } from "react";
import type { Agent } from "../../store/agents";
import AgentLog from "./AgentLog";
import AgentMetricsView, { ContextBar, useAgentMetrics } from "./AgentMetricsView";
import AgentProfile from "./AgentProfile";
import AgentTasks from "./AgentTasks";
import { fmtUsd, isBoss, paletteHex, ROLE_LABEL, statusInfo } from "./format";
import { useAgentsStore } from "./useAgentsStore";
import AgentStrip from "../../components/AgentStrip"; // también aporta .ag-chip y .ag-status-dot
import "./AgentTabs.css";

const SUBTABS = [
  { id: "tasks", label: "Tareas" },
  { id: "metrics", label: "Métricas" },
  { id: "profile", label: "Perfil" },
  { id: "log", label: "Registro" },
] as const;
type SubTab = (typeof SUBTABS)[number]["id"];

type Props = { selectedId: string | null; onSelect: (id: string | null) => void };

/** Flechas izquierda/derecha, Inicio y Fin mueven el foco entre pestañas (patrón WAI-ARIA). */
function arrowNav(e: KeyboardEvent<HTMLElement>) {
  const keys = ["ArrowRight", "ArrowLeft", "Home", "End"];
  if (!keys.includes(e.key)) return;
  const tabs = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'));
  const i = tabs.indexOf(document.activeElement as HTMLElement);
  if (i < 0) return;
  e.preventDefault();
  const next = e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : (i + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
  tabs[next].focus();
  tabs[next].click();
}

export default function AgentTabs({ selectedId, onSelect }: Props) {
  const uid = useId();
  const agents = useAgentsStore((s) => s.agents);
  const refreshMetrics = useAgentsStore((s) => s.refreshMetrics);
  const [sub, setSub] = useState<SubTab>("tasks");

  const agent = selectedId == null ? undefined : agents.find((a) => String(a.id) === selectedId);
  const agentKey = agent ? String(agent.id) : null;
  const agentIds = agents.map((a) => String(a.id)).join("|");

  // Totales al abrir un agente, o de todos en "Todos"; después se mantienen con `run.metrics`.
  useEffect(() => {
    if (agentKey) void refreshMetrics(agentKey);
    else for (const id of agentIds.split("|").filter(Boolean)) void refreshMetrics(id);
  }, [agentKey, agentIds, refreshMetrics]);

  const tabId = (k: string) => `${uid}-tab-${k}`;
  const panelId = `${uid}-panel`;

  return (
    <section className="panel ag-tabs" aria-label="Agentes">
      <AgentStrip layout="vertical" selectedId={selectedId} onSelect={onSelect} idPrefix={uid} panelId={panelId} />

      <div role="tabpanel" id={panelId} aria-labelledby={tabId(agent ? String(agent.id) : "all")} className="ag-panel">
        {!agent ? (
          <Overview agents={agents} onSelect={onSelect} />
        ) : (
          <AgentView agent={agent} sub={sub} onSub={setSub} />
        )}
      </div>
    </section>
  );
}

function Overview({ agents, onSelect }: { agents: Agent[]; onSelect: (id: string) => void }) {
  const tasks = useAgentsStore((s) => s.tasks);
  const metrics = useAgentsStore((s) => s.metricsByAgent);
  if (agents.length === 0) return <p className="muted">No hay agentes todavía.</p>;
  return (
    <ul className="plain ag-overview">
      {agents.map((a) => {
        const id = String(a.id);
        const mine = tasks.filter((t) => String(t.agent_id) === id);
        const open = mine.filter((t) => !["integrated", "approved", "failed"].includes(t.status)).length;
        const st = statusInfo(a.status);
        const m = metrics[id];
        return (
          <li key={id}>
            <button type="button" className="card ag-ov-card" onClick={() => onSelect(id)} aria-label={`Abrir ${a.name}`}>
              <span className="ag-dot" style={{ background: paletteHex(a.color) }} aria-hidden="true" />
              <span className="ag-ov-main">
                <strong>{a.name}</strong>
                <span className="muted small">
                  {ROLE_LABEL[a.role ?? ""] ?? a.role ?? ""} · <span className="ag-chip">{m?.model ?? a.current_model ?? a.model ?? "—"}</span>
                </span>
              </span>
              <span className="ag-ov-stats muted small">
                <span>
                  <span className="ag-status-dot" style={{ background: st.dot }} aria-hidden="true" /> {st.label}
                </span>
                <span>
                  {open} {open === 1 ? "tarea abierta" : "tareas abiertas"} de {mine.length}
                </span>
                <span>{m ? fmtUsd(m.costUsd) : "—"}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function AgentView({ agent, sub, onSub }: { agent: Agent; sub: SubTab; onSub: (s: SubTab) => void }) {
  const uid = useId();
  const id = String(agent.id);
  const { metrics, runs } = useAgentMetrics(id);
  const live = runs.find((r) => r.live);
  const st = statusInfo(agent.status);
  const model = live?.model ?? metrics?.model ?? agent.current_model ?? agent.model;
  const used = live?.contextTokens ?? metrics?.lastContextTokens ?? 0;
  const total = live?.contextWindow ?? metrics?.lastContextWindow ?? 0;

  return (
    <div className="ag-agent">
      <header className="ag-head">
        <span className="ag-dot ag-dot-lg" style={{ background: paletteHex(agent.color) }} aria-hidden="true" />
        <div className="ag-head-main">
          <h3>
            {agent.name}
            {isBoss(agent) && <span className="tag muted">Jefe</span>}
          </h3>
          <p className="muted small">
            {ROLE_LABEL[agent.role ?? ""] ?? agent.role ?? "sin rol"}
            {" · "}
            <span className="ag-chip">{model ?? "—"}</span>
            {" · "}
            <span className="ag-status-dot" style={{ background: st.dot }} aria-hidden="true" /> {st.label}
            {" · "}
            {metrics ? fmtUsd(metrics.costUsd) : "sin coste aún"}
          </p>
        </div>
        {total > 0 && <ContextBar used={used} total={total} />}
      </header>

      <div
        className="ag-subtabs"
        role="tablist"
        aria-label={`Secciones de ${agent.name}`}
        onKeyDown={arrowNav}
      >
        {SUBTABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`${uid}-${t.id}`}
            aria-selected={sub === t.id}
            aria-controls={`${uid}-panel`}
            tabIndex={sub === t.id ? 0 : -1}
            className="ag-subtab"
            onClick={() => onSub(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${uid}-panel`} aria-labelledby={`${uid}-${sub}`} className="ag-subpanel">
        {sub === "tasks" && <AgentTasks agent={agent} />}
        {sub === "metrics" && <AgentMetricsView agent={agent} />}
        {sub === "profile" && <AgentProfile key={id} agent={agent} />}
        {sub === "log" && <AgentLog agent={agent} />}
      </div>
    </div>
  );
}
