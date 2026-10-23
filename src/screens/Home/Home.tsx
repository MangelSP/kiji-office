// Home / dashboard: totales globales (gasto de hoy, runs, workspaces), una tarjeta por workspace abierto y los
// proyectos recientes (cerrados). Los datos salen de `workspaces.overview` / `workspaces.changed`.
import { useState } from "react";
import type { ProjectListItem, WorkspaceSummary } from "../../../shared/protocol";
import { useStore } from "../../store";
import { fmtUsd, timeAgo } from "../Agents/format";
import { workspaceColor } from "../Workspaces/color";
import { useCloseWorkspace } from "../Workspaces/useCloseWorkspace";
import { useOpenFolder } from "../Workspaces/useOpenFolder";
import LimitsForm from "./LimitsForm";
import ModelsUsed from "./ModelsUsed";
import Panel from "./Panel";
import WorkspaceCard from "./WorkspaceCard";
import YourAIs from "./YourAIs";
import "./Home.css";

/** Tarjeta mínima cuando el core aún no ha mandado el resumen: solo con lo que trae `project.list`. */
function fromListItem(p: ProjectListItem): WorkspaceSummary {
  return {
    projectId: p.projectId,
    name: p.name,
    path: p.path,
    open: p.open,
    color: p.color,
    scene: p.scene,
    agents: [],
    liveRuns: p.liveRuns,
    queued: p.queued,
    needsYou: p.needsYou,
    approvalsPending: p.approvalsPending,
    tasksByStatus: p.tasksByStatus,
    costTodayUsd: 0,
    costTotalUsd: 0,
    tokensToday: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    lastActivityAt: p.lastOpenedAt,
  };
}

export default function Home() {
  const overview = useStore((s) => s.overview);
  const projects = useStore((s) => s.projects);
  const enterWorkspace = useStore((s) => s.enterWorkspace);
  const openFolder = useOpenFolder();
  const { requestClose, dialog } = useCloseWorkspace();
  const [editing, setEditing] = useState(false);

  const all = overview?.workspaces ?? projects.map(fromListItem);
  const open = all.filter((w) => w.open);
  const recents = all.filter((w) => !w.open);
  const totals = overview?.totals;

  return (
    <main className="home">
      <header className="hm-head">
        <p className="marca">KIJI OFFICE</p>
        <h1>Home</h1>
        <button type="button" className="hm-btn hm-btn-primary" onClick={() => void openFolder()}>
          Abrir proyecto
        </button>
      </header>

      <Panel totals={totals} open={open.length} editing={editing} onEditLimits={() => setEditing((v) => !v)} />

      {editing && totals && <LimitsForm totals={totals} onDone={() => setEditing(false)} />}

      <YourAIs />
      <ModelsUsed />

      {open.length === 0 && recents.length === 0 && (
        <section className="hm-empty" aria-label="Sin proyectos">
          <p className="hm-empty-title">Aún no hay ningún proyecto abierto</p>
          <p className="hm-muted">Abre una carpeta (un repositorio git) y tus robots empezarán a trabajar en ella.</p>
          <button type="button" className="hm-btn hm-btn-primary" onClick={() => void openFolder()}>
            Abrir proyecto
          </button>
        </section>
      )}

      {open.length > 0 && (
        <section aria-labelledby="hm-open-title">
          <h2 id="hm-open-title" className="hm-section">
            Workspaces abiertos ({open.length})
          </h2>
          <div className="hm-grid">
            {open.map((w) => (
              <WorkspaceCard key={w.projectId} w={w} onEnter={() => void enterWorkspace(w.projectId)} onClose={() => requestClose(w.projectId)} />
            ))}
          </div>
        </section>
      )}

      {recents.length > 0 && (
        <section aria-labelledby="hm-recent-title">
          <h2 id="hm-recent-title" className="hm-section">
            Recientes
          </h2>
          <ul className="hm-recents">
            {recents.map((w) => (
              <li key={w.projectId} className="hm-recent">
                <span className="hm-dot" style={{ background: workspaceColor(w.color, w.projectId) }} aria-hidden="true" />
                <span className="hm-recent-text">
                  <strong>{w.name}</strong>
                  <small title={w.path}>{w.path}</small>
                </span>
                <span className="hm-muted hm-recent-meta">
                  {fmtUsd(w.costTotalUsd)} en total · {timeAgo(w.lastActivityAt)}
                </span>
                <button type="button" className="hm-btn" aria-label={`Abrir ${w.name}`} onClick={() => void enterWorkspace(w.projectId)}>
                  Abrir
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {dialog}
    </main>
  );
}
