// Pantalla principal v0 (sin pixel art): proyecto, agentes, tareas, aprobaciones y registro en vivo.
import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import ApprovalCard from "../../components/ApprovalCard";
import LogPanel from "../../components/LogPanel";
import TaskList from "../../components/TaskList";
import CreateAgent from "../CreateAgent/CreateAgent";
import { parseFiles, parseRequest } from "./request";
import OfficeScene from "../../scenes/OfficeScene";
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
  const [request, setRequest] = useState("");
  const [files, setFiles] = useState("");
  const [agentId, setAgentId] = useState("");
  const [creating, setCreating] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showCreateAgent, setShowCreateAgent] = useState(false);

  useEffect(() => connectStore(), []);

  useEffect(() => {
    if (import.meta.env.DEV && new URLSearchParams(window.location.search).has("demo")) {
      useStore.getState().setAgents(DEMO_AGENTS);
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

  // El jefe planea y revisa: las tareas se asignan a los demás robots (el primero, por defecto).
  const workers = s.agents.filter((a) => !a.is_boss);
  const selectedAgent = workers.some((a) => String(a.id) === agentId) ? agentId : String(workers[0]?.id ?? "");
  const { title, description } = parseRequest(request);
  const canSend = !creating && title !== "";

  const enviar = async (start: boolean) => {
    if (!canSend) return;
    if (start && !selectedAgent) {
      s.setNotice("Crea un robot con «+ Robot» para poder enviarle el pedido.");
      return;
    }
    setCreating(true);
    const created = await s.createTask({
      title,
      description,
      files: parseFiles(files),
      agentId: selectedAgent || undefined,
    });
    if (created) {
      setRequest("");
      setFiles("");
      if (start) await s.startTask(created.id);
    }
    setCreating(false);
  };

  const agentName = (id?: string | number) => s.agents.find((a) => String(a.id) === String(id))?.name;

  return (
    <main className="office">
      <header className="office-head">
        <p className="marca">KIJI OFFICE</p>
        <h1>
          ¡{saludo(new Date().getHours())}, {NOMBRE}!
        </h1>
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

      <section className="panel scene-panel" aria-label="Oficina">
        <OfficeScene selectedId={selectedId} onSelect={setSelectedId} />
        {selectedId && (
          <p className="muted scene-selected">
            Seleccionado: <strong>{agentName(selectedId) ?? selectedId}</strong>
          </p>
        )}
      </section>

      <div className="office-grid">
        <div className="col">
          <section className="panel" aria-labelledby="proj-title">
            <h2 id="proj-title">Proyecto</h2>
            <p className="muted">{s.project ? s.project.path : "Ningún proyecto abierto."}</p>
            <button type="button" className="btn btn-primary" onClick={() => void abrirProyecto()}>
              Abrir proyecto
            </button>
          </section>

          <section className="panel" aria-labelledby="agents-title">
            <div className="panel-head">
              <h2 id="agents-title">Agentes</h2>
              <button type="button" className="btn" onClick={() => setShowCreateAgent(true)}>
                + Robot
              </button>
            </div>
            {s.unavailable["agent.list"] ? (
              <p className="muted">Aún no disponible: el core no implementa agent.list.</p>
            ) : s.agents.length === 0 ? (
              <p className="muted">No hay agentes todavía.</p>
            ) : (
              <ul className="plain">
                {s.agents.map((a) => (
                  <li key={String(a.id)}>
                    <strong>{a.name}</strong>{" "}
                    <span className="muted">
                      {[a.provider, a.model, a.role].filter(Boolean).join(" · ")}
                      {a.status ? ` · ${a.status}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="panel" aria-labelledby="new-task-title">
            <h2 id="new-task-title">¿Qué quieres que haga?</h2>
            <p className="muted small">
              Escribe tu pedido, elige el robot y pulsa Enviar. Si toca archivos, te pedirá permiso antes de hacer algo
              riesgoso.
            </p>
            <form
              className="form"
              onSubmit={(e) => {
                e.preventDefault();
                void enviar(true);
              }}
            >
              <div className="field">
                <label htmlFor="task-request">Tu pedido</label>
                <textarea
                  id="task-request"
                  rows={5}
                  value={request}
                  onChange={(e) => setRequest(e.target.value)}
                  placeholder="Ej.: Revisa este proyecto y explícame qué hace, cómo está organizado y qué falta."
                />
              </div>
              <div className="field">
                <label htmlFor="task-files">Archivos que puede modificar (opcional)</label>
                <input
                  id="task-files"
                  value={files}
                  onChange={(e) => setFiles(e.target.value)}
                  placeholder="src/a.ts, src/b.ts"
                  aria-describedby="task-files-help"
                />
                <p id="task-files-help" className="muted small field-help">
                  Déjalo vacío para que solo lea y te responda. Pon archivos (separados por comas) si debe cambiarlos.
                </p>
              </div>
              <div className="field">
                <label htmlFor="task-agent">Agente</label>
                <select id="task-agent" value={selectedAgent} onChange={(e) => setAgentId(e.target.value)}>
                  {workers.map((a) => (
                    <option key={String(a.id)} value={String(a.id)}>
                      {a.name}
                    </option>
                  ))}
                  <option value="">Sin asignar</option>
                </select>
              </div>
              <div className="row">
                <button type="submit" className="btn btn-primary" disabled={!canSend || !selectedAgent}>
                  {creating ? "Enviando…" : "Enviar y empezar"}
                </button>
                <button type="button" className="btn" disabled={!canSend} onClick={() => void enviar(false)}>
                  Solo crear
                </button>
              </div>
            </form>
          </section>
        </div>

        <div className="col">
          {s.approvals.length > 0 && (
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
          )}

          <section className="panel" aria-labelledby="tasks-title">
            <h2 id="tasks-title">Tareas</h2>
            {s.unavailable["task.list"] && s.tasks.length === 0 ? (
              <p className="muted">Aún no disponible: el core no implementa task.list.</p>
            ) : (
              <TaskList tasks={s.tasks} agents={s.agents} onStart={s.startTask} onDiff={s.loadDiff} />
            )}
          </section>

          <LogPanel />
        </div>
      </div>
      {showCreateAgent && <CreateAgent onClose={() => setShowCreateAgent(false)} />}
    </main>
  );
}
