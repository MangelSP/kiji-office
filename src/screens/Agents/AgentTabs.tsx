// Panel de agentes de la columna derecha: tarjetas compactas (o fila de avatares) con AgentStrip vertical y, debajo, el
// resumen breve de "Todos" o el robot elegido con Chat, Tareas, Métricas, Perfil y Registro. Controlado por `selectedId`;
// `focusSignal` sube cuando se elige un robot en la escena: se abre su Chat y se enfoca la caja de pedido.
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { Agent } from "../../store/agents";
import RobotAvatar from "../../components/RobotAvatar";
import { loadAccessories } from "../../components/accessories";
import { sheetKey } from "../../scenes/officeLayout";
import AgentChat from "./AgentChat";
import { useModelLabel } from "../Connections/useModelLabel";
import AgentLog from "./AgentLog";
import AgentMetricsView, { ContextBar, useAgentMetrics } from "./AgentMetricsView";
import AgentProfile from "./AgentProfile";
import AgentTasks from "./AgentTasks";
import { fmtUsd, isBoss, ROLE_LABEL, statusInfo } from "./format";
import { useAgentsStore } from "./useAgentsStore";
import ManagerDiary from "../Manager/ManagerDiary";
import ManagerSettings from "../Manager/ManagerSettings";
import MemoryPanel from "../Manager/MemoryPanel";
import ObjectivesList from "../Manager/ObjectivesList";
import { useProjectId } from "../../store/scoped";
import AgentStrip from "../../components/AgentStrip"; // también aporta .ag-chip y .ag-status-dot
import "./AgentTabs.css";

const SUBTABS = [
  { id: "chat", label: "Chat" },
  { id: "tasks", label: "Tareas" },
  { id: "metrics", label: "Métricas" },
  { id: "profile", label: "Perfil" },
  { id: "log", label: "Registro" },
] as const;
/** Subpestañas propias del jefe (0.2d): objetivos y Gerente autónomo con su diario y su memoria. */
const BOSS_SUBTABS = [
  { id: "chat", label: "Chat" },
  { id: "tasks", label: "Tareas" },
  { id: "objectives", label: "Objetivos" },
  { id: "manager", label: "Gerente" },
  { id: "diary", label: "Diario" },
  { id: "memory", label: "Memoria" },
  { id: "metrics", label: "Métricas" },
  { id: "profile", label: "Perfil" },
  { id: "log", label: "Registro" },
] as const;
type SubTab = (typeof BOSS_SUBTABS)[number]["id"];

type Props = { selectedId: string | null; onSelect: (id: string | null) => void; focusSignal?: number };

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

export default function AgentTabs({ selectedId, onSelect, focusSignal = 0 }: Props) {
  const uid = useId();
  const agents = useAgentsStore((s) => s.agents);
  const refreshMetrics = useAgentsStore((s) => s.refreshMetrics);
  const [sub, setSub] = useState<SubTab>("chat");
  const chatInput = useRef<HTMLTextAreaElement | null>(null);
  const wantFocus = useRef(false);

  const agent = selectedId == null ? undefined : agents.find((a) => String(a.id) === selectedId);
  const agentKey = agent ? String(agent.id) : null;
  const agentIds = agents.map((a) => String(a.id)).join("|");

  // Totales al abrir un agente, o de todos en "Todos"; después se mantienen con `run.metrics`.
  useEffect(() => {
    if (agentKey) void refreshMetrics(agentKey);
    else for (const id of agentIds.split("|").filter(Boolean)) void refreshMetrics(id);
  }, [agentKey, agentIds, refreshMetrics]);

  // Clic en un robot de la escena: su chat y el cursor en la caja de pedido.
  useEffect(() => {
    if (focusSignal === 0) return;
    wantFocus.current = true;
    setSub("chat");
  }, [focusSignal]);
  useEffect(() => {
    if (wantFocus.current && chatInput.current) {
      chatInput.current.focus();
      wantFocus.current = false;
    }
  });

  const tabId = (k: string) => `${uid}-tab-${k}`;
  const panelId = `${uid}-panel`;

  return (
    <section className="panel ag-tabs" aria-label="Agentes">
      <AgentStrip layout="vertical" selectedId={selectedId} onSelect={onSelect} idPrefix={uid} panelId={panelId} />

      <div role="tabpanel" id={panelId} aria-labelledby={tabId(agent ? String(agent.id) : "all")} className="ag-panel">
        {!agent ? (
          <Overview agents={agents} />
        ) : (
          <AgentView agent={agent} sub={sub} onSub={setSub} chatInput={chatInput} />
        )}
      </div>
    </section>
  );
}

/** "Todos": solo un resumen; cada robot ya está en las tarjetas de arriba. */
function Overview({ agents }: { agents: Agent[] }) {
  const tasks = useAgentsStore((s) => s.tasks);
  const metrics = useAgentsStore((s) => s.metricsByAgent);
  if (agents.length === 0) return <p className="muted">No hay agentes todavía.</p>;
  const open = tasks.filter((t) => !["integrated", "approved", "failed"].includes(t.status)).length;
  const waiting = tasks.filter((t) => ["needs_you", "review"].includes(t.status)).length;
  const cost = agents.reduce((sum, a) => sum + (metrics[String(a.id)]?.costUsd ?? 0), 0);
  return (
    <div className="ag-summary">
      <p>
        {open} {open === 1 ? "tarea abierta" : "tareas abiertas"} de {tasks.length}
        {waiting > 0 && <> · <strong>{waiting} {waiting === 1 ? "espera" : "esperan"} tu respuesta</strong></>}
        {" · "}
        {fmtUsd(cost)} gastados
      </p>
      <p className="muted small">Elige un robot arriba o en la oficina para hablar con él.</p>
    </div>
  );
}

function AgentView({ agent, sub: wanted, onSub, chatInput }: { agent: Agent; sub: SubTab; onSub: (s: SubTab) => void; chatInput: React.Ref<HTMLTextAreaElement> }) {
  const uid = useId();
  const projectId = useProjectId();
  const tabs: readonly { id: SubTab; label: string }[] = isBoss(agent) ? BOSS_SUBTABS : SUBTABS;
  const sub = tabs.some((t) => t.id === wanted) ? wanted : "chat";
  const id = String(agent.id);
  const { metrics, runs } = useAgentMetrics(id);
  const live = runs.find((r) => r.live);
  const label = useModelLabel();
  const st = statusInfo(agent.status);
  const model = live?.model ?? metrics?.model ?? agent.current_model ?? agent.model;
  const used = live?.contextTokens ?? metrics?.lastContextTokens ?? 0;
  const total = live?.contextWindow ?? metrics?.lastContextWindow ?? 0;

  return (
    <div className="ag-agent">
      <header className="ag-head">
        <AgentAvatar agent={agent} />
        <div className="ag-head-main">
          <h3>
            {agent.name}
            {isBoss(agent) && <span className="tag muted">Jefe</span>}
          </h3>
          <p className="muted small">
            {ROLE_LABEL[agent.role ?? ""] ?? agent.role ?? "sin rol"}
            {" · "}
            <span className="ag-chip">{model ? label(model) : "—"}</span>
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
        {tabs.map((t) => (
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
        {sub === "chat" && <AgentChat agent={agent} inputRef={chatInput} />}
        {sub === "tasks" && <AgentTasks agent={agent} />}
        {sub === "objectives" && <ObjectivesList projectId={projectId} />}
        {sub === "manager" && <ManagerSettings projectId={projectId} />}
        {sub === "diary" && <ManagerDiary projectId={projectId} />}
        {sub === "memory" && <MemoryPanel projectId={projectId} />}
        {sub === "metrics" && <AgentMetricsView agent={agent} />}
        {sub === "profile" && <AgentProfile key={id} agent={agent} />}
        {sub === "log" && <AgentLog agent={agent} />}
      </div>
    </div>
  );
}

/** Avatar grande de la cabecera: el robot animado (con «reducir movimiento» se queda quieto). */
function AgentAvatar({ agent }: { agent: Agent }) {
  const accessories = useMemo(() => loadAccessories(agent.id), [agent.id]);
  return (
    <span className="ag-head-avatar">
      <RobotAvatar sheet={sheetKey(agent)} zoom={2} animate accessories={accessories} />
    </span>
  );
}
