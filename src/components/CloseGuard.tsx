// Aviso al cerrar: Rust emite `app-close-requested` y aquí se decide según el trabajo en curso.
// Sin trabajo se sale directamente; con trabajo se pregunta (segundo plano / detener todo / cancelar).
import { useEffect, useId, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useShallow } from "zustand/react/shallow";
import { useStore } from "../store";
import "./CloseGuard.css";

const WORKING = ["running", "needs_you"];

type Work = { names: string[]; count: number; approvals: number };

/**
 * Resume el trabajo en curso de TODOS los workspaces abiertos (tareas en marcha o esperando, y aprobaciones sin
 * responder). Los selectores devuelven textos y números, así no repinta por cada token de un workspace.
 */
function useWork(): Work {
  const multi = useStore((s) => Object.keys(s.byProject).length > 1);
  const names = useStore(
    useShallow((s) => {
      const out: string[] = [];
      for (const [pid, p] of Object.entries(s.byProject)) {
        const project = multi ? s.projects.find((x) => x.projectId === pid)?.name : undefined;
        for (const t of p.tasks) {
          if (!WORKING.includes(t.status)) continue;
          const agent = p.agents.find((a) => String(a.id) === String(t.agent_id));
          out.push(`${project ? `${project} · ` : ""}${agent?.name ?? "Robot"}: «${t.title}»`);
        }
      }
      return out;
    }),
  );
  const approvals = useStore((s) => Object.values(s.byProject).reduce((n, p) => n + p.approvals.length, 0));
  return { names, count: names.length, approvals };
}

/** Llama a un comando de Rust; fuera de Tauri (navegador) no hace nada. */
async function call(cmd: string, args?: Record<string, unknown>) {
  try {
    await invoke(cmd, args);
  } catch {
    /* sin Tauri o comando no disponible */
  }
}

export default function CloseGuard() {
  const work = useWork();
  const [open, setOpen] = useState(false);
  const ids = useId();
  // El oyente se registra una sola vez: lee el trabajo actual desde una ref.
  const workRef = useRef(work);
  workRef.current = work;
  const openRef = useRef(false);
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Mantiene el texto de la bandeja al día.
  useEffect(() => {
    void call("tray_set_busy", { count: work.count });
  }, [work.count]);

  useEffect(() => {
    if (!isTauri()) return; // en el navegador (?demo=1) no hay ventana nativa que cerrar
    let off: (() => void) | undefined;
    let disposed = false;
    listen("app-close-requested", () => {
      void call("app_close_ack");
      const w = workRef.current;
      if (w.count === 0 && w.approvals === 0) void call("app_quit");
      else {
        openRef.current = true;
        setOpen(true);
      }
    })
      .then((un) => (disposed ? un() : (off = un)))
      .catch((e) => console.error("[CloseGuard] no se pudo escuchar el cierre:", e));
    return () => {
      disposed = true;
      off?.();
    };
  }, []);

  useEffect(() => {
    if (open) cancelRef.current?.focus();
  }, [open]);

  if (!open) return null;

  const close = () => {
    openRef.current = false;
    setOpen(false);
  };
  const hide = () => {
    close();
    void call("app_hide");
  };
  const quit = () => {
    close();
    void call("app_quit");
  };

  const { names, count, approvals } = work;
  const robots = count === 1 ? "1 robot trabajando" : `${count} robots trabajando`;
  const pending = approvals > 0 ? ` y ${approvals === 1 ? "1 aprobación pendiente" : `${approvals} aprobaciones pendientes`}` : "";
  const text =
    count > 0
      ? `Hay ${robots} (${names.join("; ")})${pending}. Si cierras, se detendrá todo.`
      : `Hay ${approvals === 1 ? "1 aprobación pendiente" : `${approvals} aprobaciones pendientes`}. Si cierras, se detendrá todo.`;

  return (
    <div className="cg-backdrop">
      <div
        className="cg-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`${ids}-title`}
        aria-describedby={`${ids}-desc`}
        onKeyDown={(e) => e.key === "Escape" && close()}
      >
        <h2 id={`${ids}-title`} className="cg-title">
          ¿Cerrar Kiji Office?
        </h2>
        <p id={`${ids}-desc`} className="cg-text">
          {text}
        </p>
        <div className="cg-actions">
          <button type="button" className="cg-btn" onClick={hide}>
            Seguir en segundo plano
          </button>
          <button type="button" className="cg-btn cg-danger" onClick={quit}>
            Detener todo y salir
          </button>
          <button type="button" className="cg-btn" ref={cancelRef} onClick={close}>
            Cancelar
          </button>
        </div>
      </div>
    </div>
  );
}
