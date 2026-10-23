// Campana de la barra superior: avisos de todos los workspaces con contador de no leídos. Clic en un aviso lleva a la
// pestaña del proyecto y, si pide una respuesta, resalta su tarjeta de aprobación. Escucha también el clic en la
// notificación del sistema (`notification-clicked`, solo dentro de Tauri).
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import type { NotificationLevel, NotificationRow } from "../../shared/protocol";
import { timeAgo } from "../screens/Agents/format";
import { useStore } from "../store";
import "./NotificationBell.css";

const LEVEL: Record<NotificationLevel, { icon: string; label: string }> = {
  info: { icon: "ℹ", label: "Info" },
  warn: { icon: "⚠", label: "Aviso" },
  ask: { icon: "❓", label: "Pregunta" },
};

/** Lleva a la pestaña del proyecto y resalta la aprobación del aviso. */
function useOpenNotification() {
  return useCallback(async (projectId: string, id: number, approvalId?: string | null) => {
    const s = useStore.getState();
    s.setConnectionsOpen(false);
    if (s.tabs.includes(projectId)) s.setActiveProject(projectId);
    else await s.enterWorkspace(projectId);
    const row = useStore.getState().notifications.find((n) => n.id === id);
    const approval = approvalId ?? row?.approvalId;
    if (approval) useStore.getState().setFocusApproval(projectId, String(approval));
    void useStore.getState().markRead([id]);
  }, []);
}

export default function NotificationBell() {
  const notifications = useStore((s) => s.notifications);
  const projects = useStore((s) => s.projects);
  const markRead = useStore((s) => s.markRead);
  const open = useOpenNotification();
  const [shown, setShown] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  // Clic en la notificación del sistema: Rust trae la ventana al frente y avisa con {projectId, id}.
  useEffect(() => {
    if (!isTauri()) return;
    let off: (() => void) | undefined;
    let gone = false;
    void listen<{ projectId: string; id: number }>("notification-clicked", (e) => {
      const { projectId, id } = e.payload;
      void open(projectId, id);
    }).then((fn) => {
      if (gone) fn();
      else off = fn;
    });
    return () => {
      gone = true;
      off?.();
    };
  }, [open]);

  useEffect(() => {
    if (!shown) return;
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setShown(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setShown(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [shown]);

  const unread = notifications.filter((n) => n.readAt == null);
  const projectName = (id: string) => projects.find((p) => p.projectId === id)?.name ?? "Workspace";

  return (
    <div className="bell" ref={wrap}>
      <button
        type="button"
        className="ws-btn bell-btn"
        aria-label={unread.length > 0 ? `Avisos, ${unread.length} sin leer` : "Avisos"}
        aria-haspopup="dialog"
        aria-expanded={shown}
        title="Avisos"
        onClick={() => setShown((v) => !v)}
      >
        <span aria-hidden="true">🔔</span>
        {unread.length > 0 && (
          <span className="bell-count" data-testid="bell-count" aria-hidden="true">
            {unread.length > 99 ? "99+" : unread.length}
          </span>
        )}
      </button>
      {shown && (
        <div className="bell-panel" role="dialog" aria-label="Avisos">
          <div className="bell-head">
            <strong>Avisos</strong>
            <button type="button" className="ws-btn" disabled={unread.length === 0} onClick={() => void markRead(unread.map((n) => n.id))}>
              Marcar todo como leído
            </button>
          </div>
          {notifications.length === 0 ? (
            <p className="bell-empty">No hay avisos.</p>
          ) : (
            <ul className="bell-list">
              {notifications.map((n: NotificationRow) => (
                <li key={n.id}>
                  <button
                    type="button"
                    className={`bell-item${n.readAt == null ? " is-unread" : ""}`}
                    aria-label={`${n.title}, ${projectName(n.projectId)}`}
                    onClick={() => {
                      setShown(false);
                      void open(n.projectId, n.id, n.approvalId);
                    }}
                  >
                    <span className={`bell-level bell-level-${n.level}`} title={LEVEL[n.level]?.label}>
                      <span aria-hidden="true">{LEVEL[n.level]?.icon}</span> {LEVEL[n.level]?.label}
                    </span>
                    <span className="bell-ws">{projectName(n.projectId)}</span>
                    <strong className="bell-title">{n.title}</strong>
                    {n.body && <span className="bell-body">{n.body}</span>}
                    <span className="bell-time">{timeAgo(n.createdAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
