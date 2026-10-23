// Vista de un workspace (proyecto abierto): la oficina (solo la escena) y, a su derecha, el panel de robots con su chat,
// la caja de pedido y el detalle; debajo, las IAs en vivo, las aprobaciones y el registro. Todo sale de la partición del proyecto.
import { useEffect, useState } from "react";
import ApprovalCard from "../../components/ApprovalCard";
import LogPanel from "../../components/LogPanel";
import ProvidersPanel from "../../components/ProvidersPanel";
import BoardView from "../Board/BoardView";
import AgentTabs from "../Agents/AgentTabs";
import CreateAgent from "../CreateAgent/CreateAgent";
import OfficeScene from "../../scenes/OfficeScene";
import { useStore } from "../../store";
import { ProjectContext, useScoped } from "../../store/scoped";
import { useGreeting } from "./greeting";
import "../../components/components.css";
import "./OfficeV0.css";

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
  const greeting = useGreeting();
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
  // Sube con cada clic en un robot de la escena: el panel abre su chat y enfoca la caja de pedido.
  const [focusSignal, setFocusSignal] = useState(0);
  const pickInScene = (id: string | null) => {
    setSelectedId(id);
    if (id) setFocusSignal((n) => n + 1);
  };
  const [showCreateAgent, setShowCreateAgent] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [showBoard, setShowBoard] = useState(false);
  const [focusTask, setFocusTask] = useState<string | null>(null);

  // Al cambiar de workspace se parte limpio: sin robot elegido ni diálogos del anterior.
  const [shownProject, setShownProject] = useState(projectId);
  if (shownProject !== projectId) {
    setShownProject(projectId);
    setSelectedId(null);
    setShowCreateAgent(false);
    setShowBoard(false);
  }

  // Desde la pizarra: se vuelve a la oficina, se elige el robot (el jefe si la tarea no tiene) y se enseña la tarjeta.
  const openTask = (agentId: string | null, task: { id: string | number; title: string }) => {
    const boss = agents.find((a) => a.is_boss === true || a.is_boss === 1);
    setSelectedId(agentId ?? (boss ? String(boss.id) : null));
    setFocusTask(task.title);
    setShowBoard(false);
  };
  useEffect(() => {
    if (focusTask === null || showBoard) return;
    const el = Array.from(document.querySelectorAll<HTMLElement>(".office-agent [aria-label]")).find(
      (e) => e.getAttribute("aria-label") === `Tarea ${focusTask}`,
    );
    el?.scrollIntoView?.({ block: "center" });
    setFocusTask(null);
  }, [focusTask, showBoard, selectedId, tasks]);
  // La escena (otro paso) expondrá `onBoardClick`; se pasa por spread para compilar antes de que exista.
  const sceneBoard = { onBoardClick: () => setShowBoard(true) };

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
          onAnswer={(allow, option) => answerApproval(a.id, allow, option)}
        />
      ))}
    </section>
  );

  return (
    <main className="office">
      <header className="office-head">
        <p className="marca">KIJI OFFICE <span className="beta">BETA</span></p>
        <h1>
          {greeting}
        </h1>
        {project && <p className="office-project" title={project.path}>{project.name}</p>}
        <button type="button" className="btn" onClick={() => setShowCreateAgent(true)}>
          + Robot
        </button>
        <button type="button" className="btn" aria-pressed={showBoard} onClick={() => setShowBoard((v) => !v)}>
          Pizarra
        </button>
        <p className="core-status">core: {coreLabel(coreStatus, coreDetail)}</p>
      </header>

      {showBoard && <BoardView onOpenTask={openTask} onClose={() => setShowBoard(false)} />}
      <div hidden={showBoard}>
      {narrow && approvals}

      {/* Arriba: la oficina y, a su derecha, el panel del robot elegido (chat con su caja de pedido, tareas, métricas...). */}
      <div className="office-top">
        <div className="office-left">
          <section className="panel scene-panel" aria-label="Oficina">
            <div className="scene-stage">
              <OfficeScene projectId={projectId} selectedId={selectedId} onSelect={pickInScene} {...sceneBoard} />
            </div>
          </section>
        </div>
        <aside className="office-agent" aria-label="Panel del robot">
          {unavailableAgentList && <p className="muted">Aún no disponible: el core no implementa agent.list.</p>}
          <AgentTabs selectedId={selectedId} onSelect={setSelectedId} focusSignal={focusSignal} />
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
      </div>
      {showCreateAgent && <CreateAgent onClose={() => setShowCreateAgent(false)} />}
    </main>
  );
}
