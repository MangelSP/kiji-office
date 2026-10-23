// Barra superior de pestañas de workspace (como un navegador): Home, una pestaña por proyecto abierto y «+».
import { useEffect, useRef, useState } from "react";
import NotificationBell from "../../components/NotificationBell";
import StopAllButton from "../../components/StopAllButton";
import { useStore } from "../../store";
import { workspaceColor } from "./color";
import { useCloseWorkspace } from "./useCloseWorkspace";
import { useOpenFolder } from "./useOpenFolder";
import "./Workspaces.css";

type Props = { onWizard?: () => void; onAbout?: () => void; aboutOpen?: boolean };

export default function WorkspaceTabs({ onWizard, onAbout, aboutOpen }: Props) {
  const tabs = useStore((s) => s.tabs);
  const projects = useStore((s) => s.projects);
  const active = useStore((s) => s.activeProjectId);
  const setActive = useStore((s) => s.setActiveProject);
  const reopenProject = useStore((s) => s.reopenProject);
  const connectionsOpen = useStore((s) => s.connectionsOpen);
  const setConnectionsOpen = useStore((s) => s.setConnectionsOpen);
  const openFolder = useOpenFolder();
  const { requestClose, dialog } = useCloseWorkspace();
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // El menú «+» se cierra con Escape o al pulsar fuera.
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenu(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const recents = projects.filter((p) => !p.open).slice(0, 8);

  return (
    <nav className="ws-bar" aria-label="Workspaces">
      <div className="ws-tabs" role="tablist" aria-label="Workspaces abiertos">
        <button
          type="button"
          role="tab"
          className={`ws-tab ws-home${active === null ? " is-active" : ""}`}
          aria-selected={active === null}
          title="Home (Cmd/Ctrl+0)"
          onClick={() => {
            setConnectionsOpen(false);
            setActive(null);
          }}
        >
          ⌂ Home
        </button>
        {tabs.map((id, i) => (
          <Tab key={id} id={id} index={i} active={id === active} onClose={() => requestClose(id)} />
        ))}
      </div>

      <div className="ws-plus" ref={menuRef}>
        <button
          type="button"
          className="ws-btn ws-add"
          aria-label="Abrir proyecto"
          aria-haspopup="menu"
          aria-expanded={menu}
          title="Abrir proyecto"
          onClick={() => setMenu((v) => !v)}
        >
          +
        </button>
        {menu && (
          <div className="ws-menu" role="menu" aria-label="Abrir proyecto">
            <button
              type="button"
              role="menuitem"
              className="ws-btn ws-btn-primary"
              onClick={() => {
                setMenu(false);
                void openFolder();
              }}
            >
              Abrir carpeta…
            </button>
            <p className="ws-menu-title">Recientes</p>
            {recents.length === 0 && <p className="ws-menu-empty">No hay proyectos cerrados.</p>}
            {recents.map((p) => (
              <div key={p.projectId} className="ws-recent" role="none">
                <span className="ws-dot" style={{ background: workspaceColor(p.color, p.projectId) }} aria-hidden="true" />
                <span className="ws-recent-text">
                  <strong>{p.name}</strong>
                  <small title={p.path}>{p.path}</small>
                </span>
                <button
                  type="button"
                  role="menuitem"
                  className="ws-btn"
                  aria-label={`Abrir ${p.name}`}
                  onClick={() => {
                    setMenu(false);
                    void reopenProject(p.projectId);
                  }}
                >
                  Abrir
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <button
        type="button"
        className={`ws-btn ws-conn${connectionsOpen ? " is-active" : ""}`}
        aria-pressed={connectionsOpen}
        title="Conexiones a otras IAs"
        onClick={() => setConnectionsOpen(!connectionsOpen)}
      >
        Conexiones
      </button>
      <NotificationBell />
      <StopAllButton />
      {onWizard && (
        <button type="button" className="ws-btn ws-wizard" onClick={onWizard}>
          Asistente
        </button>
      )}
      {onAbout && (
        <button type="button" className={`ws-btn ws-about${aboutOpen ? " is-active" : ""}`} aria-pressed={aboutOpen} onClick={onAbout}>
          Acerca de
        </button>
      )}
      {dialog}
    </nav>
  );
}

function Tab({ id, index, active, onClose }: { id: string; index: number; active: boolean; onClose: () => void }) {
  const item = useStore((s) => s.projects.find((p) => p.projectId === id));
  const setActive = useStore((s) => s.setActiveProject);
  const setConnectionsOpen = useStore((s) => s.setConnectionsOpen);
  // ⚡: alguna tarea pausada por límite del proveedor o en cola por el tope de gasto.
  const limited = useStore(
    (s) =>
      (item?.tasksByStatus.paused_limit ?? 0) > 0 || Object.values(s.byProject[id]?.queue ?? {}).some((q) => q.blockedBy === "budget"),
  );
  if (!item) return null;
  const needs = Math.max(item.approvalsPending, item.needsYou);
  const name = item.name;
  const shortcut = index < 9 ? ` (Cmd/Ctrl+${index + 1})` : "";
  const parts = [
    needs > 0 && `${needs} te necesitan`,
    item.liveRuns > 0 && `${item.liveRuns} en marcha`,
    item.queued > 0 && `${item.queued} en cola`,
    limited && "límite",
  ].filter(Boolean);

  return (
    <div className={`ws-tab-wrap${active ? " is-active" : ""}`}>
      <button
        type="button"
        role="tab"
        className={`ws-tab${active ? " is-active" : ""}`}
        aria-selected={active}
        aria-label={parts.length > 0 ? `${name}, ${parts.join(", ")}` : name}
        title={`${item.path}${shortcut}`}
        onClick={() => {
          setConnectionsOpen(false);
          setActive(id);
        }}
      >
        <span className="ws-dot" style={{ background: workspaceColor(item.color, id) }} aria-hidden="true" />
        <span className="ws-name">{name}</span>
        {needs > 0 && (
          <span className="ws-badge ws-badge-needs" data-badge="needs" title={`${needs} te necesitan`}>
            ✋ {needs}
          </span>
        )}
        {item.liveRuns > 0 && (
          <span className="ws-badge ws-badge-runs" data-badge="runs" title={`${item.liveRuns} runs en marcha`}>
            ⚙ {item.liveRuns}
          </span>
        )}
        {item.queued > 0 && (
          <span className="ws-badge ws-badge-queue" data-badge="queued" title={`${item.queued} en cola`}>
            ⏳ {item.queued}
          </span>
        )}
        {limited && (
          <span className="ws-badge ws-badge-limit" data-badge="limit" title="Hay un límite activo">
            ⚡
          </span>
        )}
      </button>
      <button type="button" className="ws-close" aria-label={`Cerrar ${name}`} title="Cerrar workspace" onClick={onClose}>
        ×
      </button>
    </div>
  );
}
