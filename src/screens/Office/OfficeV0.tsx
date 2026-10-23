// Pantalla principal: la oficina (escena + caja de pedido), la tira de robots, las pestañas por agente
// y, a la derecha, las IAs en vivo, las aprobaciones, el proyecto y el registro.
import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import AgentStrip from "../../components/AgentStrip";
import ApprovalCard from "../../components/ApprovalCard";
import LogPanel from "../../components/LogPanel";
import OfficeComposer from "../../components/OfficeComposer";
import ProvidersPanel from "../../components/ProvidersPanel";
import AgentTabs from "../Agents/AgentTabs";
import CreateAgent from "../CreateAgent/CreateAgent";
import OfficeScene from "../../scenes/OfficeScene";
import type { ProviderStatus } from "../../../shared/protocol";
import { connectStore, useStore } from "../../store";
import "../../components/components.css";
import "./OfficeV0.css";

const NOMBRE = "Alexis";

// Solo en desarrollo: `?demo=1` mete agentes de ejemplo para ver los robots sin core.
const DEMO_AGENTS = [
  { id: "demo-1", name: "Jefe", provider: "claude", color: "terracota", is_boss: 1, status: "thinking" },
  { id: "demo-2", name: "Ana", provider: "openai", color: "azul", status: "needs_you" },
  { id: "demo-3", name: "Nico", provider: "gemini", color: "verde", status: "done" },
];

const DEMO_PROVIDERS: ProviderStatus[] = [
  {
    id: "claude",
    label: "Claude",
    configured: true,
    state: "warning",
    windows: [
      { type: "five_hour", status: "allowed", utilization: 0.42, resetsAt: Date.now() + 2.5 * 3_600_000, seenAt: Date.now() },
      { type: "seven_day", status: "allowed_warning", utilization: 0.78, resetsAt: Date.now() + 3 * 86_400_000, seenAt: Date.now() },
      { type: "seven_day_sonnet", status: "rejected", utilization: 1, resetsAt: Date.now() + 5 * 3_600_000, seenAt: Date.now() },
    ],
    models: [{ model: "sonnet", agents: ["demo-2"], liveRuns: 1, costTodayUsd: 0.42, limitedUntil: null }],
  },
  { id: "ollama", label: "Ollama", configured: false, state: "off", windows: [], models: [] },
];

// Mismo ancho que el CSS: por debajo, una sola columna.
const NARROW = "(max-width: 1099px)";

function useNarrow() {
  const [narrow, setNarrow] = useState(() => window.matchMedia?.(NARROW).matches ?? false);
  useEffect(() => {
    const mq = window.matchMedia?.(NARROW);
    if (!mq) return;
    const on = () => setNarrow(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return narrow;
}

function saludo(hora: number) {
  if (hora < 12) return "Buenos días";
  if (hora < 19) return "Buenas tardes";
  return "Buenas noches";
}

function coreLabel(status: string, detail?: string) {
  if (status === "ok") return "pong";
  if (status === "connecting") return "conectando…";
  return detail ?? "caído";
}

export default function OfficeV0() {
  const s = useStore();
  const narrow = useNarrow();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showCreateAgent, setShowCreateAgent] = useState(false);
  const [showLog, setShowLog] = useState(false);

  useEffect(() => connectStore(), []);

  useEffect(() => {
    if (import.meta.env.DEV && new URLSearchParams(window.location.search).has("demo")) {
      const st = useStore.getState();
      st.setAgents(DEMO_AGENTS);
      st.applyLimits(DEMO_PROVIDERS);
      st.noteActivity("demo-1", "tool", { name: "Read", input: { file_path: "src/store/index.ts" } });
      st.noteActivity("demo-2", "permission", { decision: "pending" });
      st.noteActivity("demo-3", "status", { type: "done" });
    }
  }, []);

  const abrirProyecto = async () => {
    try {
      const path = await open({ directory: true, multiple: false, title: "Elige la carpeta del proyecto" });
      if (typeof path === "string") await s.openProject(path);
    } catch {
      // Fuera de Tauri no existe el selector nativo.
      s.setNotice("El selector de carpetas solo está disponible en la app de escritorio.");
    }
  };

  const agentName = (id?: string | number) => s.agents.find((a) => String(a.id) === String(id))?.name;

  const approvals = s.approvals.length > 0 && (
    <section className="panel" aria-labelledby="appr-title">
      <h2 id="appr-title">Esperan tu respuesta ({s.approvals.length})</h2>
      {s.approvals.map((a) => (
        <ApprovalCard
          key={String(a.id)}
          approval={a}
          agentName={agentName(a.agent_id)}
          onAnswer={(allow) => s.answerApproval(a.id, allow)}
        />
      ))}
    </section>
  );

  return (
    <main className="office">
      <header className="office-head">
        <p className="marca">KIJI OFFICE</p>
        <h1>
          ¡{saludo(new Date().getHours())}, {NOMBRE}!
        </h1>
        <button type="button" className="btn" onClick={() => setShowCreateAgent(true)}>
          + Robot
        </button>
        <p className="core-status">core: {coreLabel(s.coreStatus, s.coreDetail)}</p>
      </header>

      {s.notice && (
        <div className="notice" role="status">
          <span>{s.notice}</span>
          <button type="button" className="btn btn-ghost" onClick={() => s.setNotice(null)}>
            Cerrar
          </button>
        </div>
      )}

      {narrow && approvals}

      <section className="panel scene-panel" aria-label="Oficina">
        <div className="scene-stage">
          <OfficeScene selectedId={selectedId} onSelect={setSelectedId} />
          <OfficeComposer selectedId={selectedId} onSelect={setSelectedId} />
        </div>
      </section>

      <AgentStrip selectedId={selectedId} onSelect={setSelectedId} />

      <div className="office-grid">
        <div className="col">
          {s.unavailable["agent.list"] && <p className="muted">Aún no disponible: el core no implementa agent.list.</p>}
          <AgentTabs selectedId={selectedId} onSelect={setSelectedId} />
        </div>

        <div className="col">
          <ProvidersPanel />
          {!narrow && approvals}

          <section className="panel project-compact" aria-labelledby="proj-title">
            <div className="panel-head">
              <h2 id="proj-title">Proyecto</h2>
              <button type="button" className="btn btn-primary" onClick={() => void abrirProyecto()}>
                Abrir proyecto
              </button>
            </div>
            <p className="muted small project-path">{s.project ? s.project.path : "Ningún proyecto abierto."}</p>
          </section>

          {showLog ? (
            <div>
              <LogPanel />
              <button type="button" className="btn btn-ghost" onClick={() => setShowLog(false)}>
                Ocultar el registro
              </button>
            </div>
          ) : (
            <button type="button" className="btn" aria-expanded={false} onClick={() => setShowLog(true)}>
              Registro en vivo ({s.events.length}) ▸
            </button>
          )}
        </div>
      </div>
      {showCreateAgent && <CreateAgent onClose={() => setShowCreateAgent(false)} />}
    </main>
  );
}
