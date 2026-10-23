// Cerrar un workspace: si tiene runs vivos pide confirmación y ofrece «Detener y cerrar» (`project.close` con force).
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useStore } from "../../store";
import "./Workspaces.css";

export function useCloseWorkspace(): { requestClose: (projectId: string) => void; dialog: ReactNode } {
  const closeProject = useStore((s) => s.closeProject);
  const [pending, setPending] = useState<{ id: string; name: string; runs: number } | null>(null);

  const requestClose = (id: string) => {
    const p = useStore.getState().projects.find((x) => x.projectId === id);
    if (p && p.liveRuns > 0) setPending({ id, name: p.name, runs: p.liveRuns });
    else void closeProject(id);
  };

  const dialog = pending && (
    <ConfirmClose
      name={pending.name}
      runs={pending.runs}
      onCancel={() => setPending(null)}
      onForce={() => {
        const id = pending.id;
        setPending(null);
        void closeProject(id, true);
      }}
    />
  );
  return { requestClose, dialog };
}

function ConfirmClose({ name, runs, onCancel, onForce }: { name: string; runs: number; onCancel: () => void; onForce: () => void }) {
  const ids = useId();
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => cancel.current?.focus(), []);
  return (
    <div className="ws-backdrop">
      <div
        className="ws-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`${ids}-t`}
        aria-describedby={`${ids}-d`}
        onKeyDown={(e) => e.key === "Escape" && onCancel()}
      >
        <h2 id={`${ids}-t`}>¿Cerrar «{name}»?</h2>
        <p id={`${ids}-d`}>
          Tiene {runs === 1 ? "1 run en marcha" : `${runs} runs en marcha`}. Si lo cierras ahora, se detendrán.
        </p>
        <div className="ws-dialog-actions">
          <button type="button" className="ws-btn ws-danger" onClick={onForce}>
            Detener y cerrar
          </button>
          <button type="button" className="ws-btn" ref={cancel} onClick={onCancel}>
            Cancelar
          </button>
        </div>
      </div>
    </div>
  );
}
