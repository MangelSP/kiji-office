// Vista de un workspace (proyecto abierto): la oficina (escena + caja de pedido) y, a su derecha, las tarjetas de
// robots con su detalle; debajo, las IAs en vivo, las aprobaciones y el registro. Todo sale de la partición del proyecto.
import { useEffect, useState } from "react";
import ApprovalCard from "../../components/ApprovalCard";
import LogPanel from "../../components/LogPanel";
import OfficeComposer from "../../components/OfficeComposer";
import ProvidersPanel from "../../components/ProvidersPanel";
import AgentTabs from "../Agents/AgentTabs";
import CreateAgent from "../CreateAgent/CreateAgent";
import OfficeScene from "../../scenes/OfficeScene";
import { useStore } from "../../store";
import { ProjectContext, useScoped } from "../../store/scoped";
import "../../components/components.css";
import "./OfficeV0.css";

const NOMBRE = "Alexis";

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

export default function OfficeV0({ projectId }: { projectId: string }) {
  // Todo lo de dentro (composer, pestañas de robot, IAs en vivo...) lee la partición de este proyecto.
  return (
    <ProjectContext.Provider value={projectId}>
      <Office projectId={projectId} />
    </ProjectContext.Provider>
  );
}

function Office({ projectId }: { projectId: string }) {
  const agents = useScoped((st) => st.agents);
  const approvalsList = useScoped((st) => st.approvals);
  const coreStatus = useStore((st) => st.coreStatus);
  const coreDetail = useStore((st) => st.coreDetail);
  const unavailableAgentList = useStore((st) => st.unavailable["agent.list"]);
  const project = useStore((st) => st.projects.find((p) => p.projectId === projectId));
  const eventCount = useScoped((st) => st.events.length);
  const answerApproval = useScoped((st) => st.answerApproval);
  const tasks = useScoped((st) => st.tasks);
  const focus = useStore((st) => st.focusApproval);
  const askTimeout = useStore((st) => st.manager[projectId]?.policy?.askTimeoutMinutes);
  const refreshManager = useStore((st) => st.refreshManager);
  const refreshObjectives = useStore((st) => st.refreshObjectives);
  const refreshIntegrations = useStore((st) => st.refreshIntegrations);

  // Estado del gerente, objetivos e integraciones del workspace (la insignia "autónomo" y las tarjetas lo necesitan).
  useEffect(() => {
    void refreshManager(projectId);
    void refreshObjectives(projectId);
    void refreshIntegrations(projectId);
  }, [projectId, refreshManager, refreshObjectives, refreshIntegrations]);
  const narrow = useNarrow();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showCreateAgent, setShowCreateAgent] = useState(false);
  const [showLog, setShowLog] = useState(false);

  // Al cambiar de workspace se parte limpio: sin robot elegido ni diálogos del anterior.
  const [shownProject, setShownProject] = useState(projectId);
  if (shownProject !== projectId) {
    setShownProject(projectId);
    setSelectedId(null);
    setShowCreateAgent(false);
  }

  const agentName = (id?: string | number) => agents.find((a) => String(a.id) === String(id))?.name;

  const approvals = approvalsList.length > 0 && (
    <section className="panel" aria-labelledby="appr-title">
      <h2 id="appr-title">Esperan tu respuesta ({approvalsList.length})</h2>
      {approvalsList.map((a) => (
        <ApprovalCard
          key={String(a.id)}
          approval={a}
          agentName={agentName(a.agent_id)}
          taskTitle={tasks.find((t) => String(t.id) === String(a.task_id))?.title}
          timeoutMinutes={askTimeout}
          highlighted={focus?.projectId === projectId && focus.approvalId === String(a.id)}
          onAnswer={(allow) => answerApproval(a.id, allow)}
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
        {project && <p className="office-project" title={project.path}>{project.name}</p>}
        <button type="button" className="btn" onClick={() => setShowCreateAgent(true)}>
          + Robot
        </button>
        <p className="core-status">core: {coreLabel(coreStatus, coreDetail)}</p>
      </header>

      {narrow && approvals}

      {/* Arriba: la oficina (con su caja de pedido) y, a su derecha, las tarjetas de robots con el detalle del elegido. */}
      <div className="office-top">
        <div className="office-left">
          <section className="panel scene-panel" aria-label="Oficina">
            <div className="scene-stage">
              <OfficeScene projectId={projectId} selectedId={selectedId} onSelect={setSelectedId} />
              <OfficeComposer selectedId={selectedId} onSelect={setSelectedId} />
            </div>
          </section>
        </div>
        <aside className="office-agent" aria-label="Panel del robot">
          {unavailableAgentList && <p className="muted">Aún no disponible: el core no implementa agent.list.</p>}
          <AgentTabs selectedId={selectedId} onSelect={setSelectedId} />
        </aside>
      </div>

      <div className="office-grid">
        <div className="col">
          <ProvidersPanel />
        </div>
        <div className="col">
          {!narrow && approvals}

          {showLog ? (
            <div>
              <LogPanel />
              <button type="button" className="btn btn-ghost" onClick={() => setShowLog(false)}>
                Ocultar el registro
              </button>
            </div>
          ) : (
            <button type="button" className="btn" aria-expanded={false} onClick={() => setShowLog(true)}>
              Registro en vivo ({eventCount}) ▸
            </button>
          )}
        </div>
      </div>
      {showCreateAgent && <CreateAgent onClose={() => setShowCreateAgent(false)} />}
    </main>
  );
}
