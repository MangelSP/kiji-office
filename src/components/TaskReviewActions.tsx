// Flujo del hito 3 sobre una tarea: en revisión -> Aprobar / Pedir cambios; aprobada -> Integrar (con progreso y
// errores legibles); integrada -> Deshacer (con confirmación). Se usa en AgentTasks y en TaskList.
import { useState } from "react";
import { useStore } from "../store";
import { EMPTY_RUN, INTEGRATION_PHASES, type IntegrationFailure, type IntegrationPhase } from "../store/manager";
import { useProjectId } from "../store/scoped";
import type { Task } from "../store/tasks";
import "../screens/Manager/Manager.css";

const PHASE_LABEL: Record<IntegrationPhase, string> = { rebase: "Rebase", tests: "Tests", merge: "Merge" };

export const REVIEW_STATES = new Set(["review", "approved", "integrated"]);

export default function TaskReviewActions({ task }: { task: Pick<Task, "id" | "title" | "status"> }) {
  const pid = useProjectId();
  const key = String(task.id);
  const run = useStore((s) => s.integrationRuns[key] ?? EMPTY_RUN);
  const review = useStore((s) => s.reviewTask);
  const apply = useStore((s) => s.applyTask);
  const revert = useStore((s) => s.revertTask);
  const clear = useStore((s) => s.clearIntegrationFailure);
  const [asking, setAsking] = useState(false);
  const [findings, setFindings] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!REVIEW_STATES.has(task.status)) return null;

  const guard = async (fn: () => Promise<boolean>) => {
    setBusy(true);
    try {
      return await fn();
    } finally {
      setBusy(false);
    }
  };
  const lines = findings.split("\n").map((l) => l.trim()).filter(Boolean);

  return (
    <div className="tr">
      {task.status === "review" && (
        <>
          <div className="row tr-row">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              aria-label={`Aprobar ${task.title}`}
              onClick={() => void guard(() => review(pid, task.id, "approve"))}
            >
              Aprobar
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy}
              aria-expanded={asking}
              aria-label={`Pedir cambios en ${task.title}`}
              onClick={() => setAsking((v) => !v)}
            >
              Pedir cambios
            </button>
          </div>
          {asking && (
            <div>
              <textarea
                className="tr-findings"
                aria-label={`Hallazgos para ${task.title}`}
                placeholder="Qué hay que cambiar (uno por línea)"
                value={findings}
                onChange={(e) => setFindings(e.target.value)}
              />
              <div className="row">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy || lines.length === 0}
                  onClick={() =>
                    void guard(async () => {
                      const ok = await review(pid, task.id, "changes", lines);
                      if (ok) {
                        setFindings("");
                        setAsking(false);
                      }
                      return ok;
                    })
                  }
                >
                  Enviar cambios
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {task.status === "approved" && (
        <div className="row tr-row">
          <button
            type="button"
            className="btn btn-primary"
            disabled={run.busy}
            aria-label={`Integrar ${task.title}`}
            onClick={() => void apply(pid, task.id)}
          >
            {run.busy ? "Integrando…" : "Integrar"}
          </button>
        </div>
      )}

      {run.busy && task.status === "approved" && <Phases current={run.phase} />}
      {run.failure && <Failure failure={run.failure} onClose={() => clear(task.id)} />}

      {task.status === "integrated" && (
        <>
          {!confirming ? (
            <div className="row tr-row">
              <button type="button" className="btn" disabled={run.busy} aria-label={`Deshacer ${task.title}`} onClick={() => setConfirming(true)}>
                {run.busy ? "Deshaciendo…" : "Deshacer"}
              </button>
            </div>
          ) : (
            <div className="tr-error" role="alertdialog" aria-label="Confirmar deshacer">
              <p>¿Deshacer la integración de «{task.title}»? La rama principal vuelve a como estaba antes de integrarla.</p>
              <div className="row">
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => {
                    setConfirming(false);
                    void revert(pid, task.id);
                  }}
                >
                  Sí, deshacer
                </button>
                <button type="button" className="btn" onClick={() => setConfirming(false)}>
                  Cancelar
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Phases({ current }: { current: IntegrationPhase | null }) {
  const at = current ? INTEGRATION_PHASES.indexOf(current) : -1;
  return (
    <ol className="tr-phases" aria-label="Progreso de la integración" role="status">
      {INTEGRATION_PHASES.map((p, i) => (
        <li key={p} className={i < at ? "is-past" : i === at ? "is-now" : ""} aria-current={i === at ? "step" : undefined}>
          {i < at ? "✓ " : ""}
          {PHASE_LABEL[p]}
        </li>
      ))}
    </ol>
  );
}

function Failure({ failure, onClose }: { failure: IntegrationFailure; onClose: () => void }) {
  return (
    <div className="tr-error" role="alert">
      {failure.kind === "conflict" && (
        <>
          <p>
            <strong>Conflicto al integrar.</strong> Estos archivos chocan con la rama principal:
          </p>
          {failure.files.length > 0 ? (
            <ul aria-label="Archivos en conflicto">
              {failure.files.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          ) : (
            <p className="muted small">{failure.message}</p>
          )}
          <p className="muted small">Pide cambios para que el robot lo resuelva y vuelve a aprobar.</p>
        </>
      )}
      {failure.kind === "tests" && (
        <>
          <p>
            <strong>Los tests fallaron:</strong> no se ha integrado nada.
          </p>
          {failure.output && (
            <details>
              <summary>Ver la salida de los tests</summary>
              <pre className="pre">{failure.output}</pre>
            </details>
          )}
        </>
      )}
      {failure.kind === "dirty" && (
        <p>
          <strong>El repositorio principal tiene cambios sin guardar.</strong> Guárdalos (commit) o descártalos y vuelve a integrar.
        </p>
      )}
      {failure.kind === "other" && <p>{failure.message}</p>}
      <button type="button" className="btn btn-ghost" onClick={onClose}>
        Cerrar aviso
      </button>
    </div>
  );
}
