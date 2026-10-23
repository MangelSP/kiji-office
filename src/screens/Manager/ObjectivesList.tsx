// Lista compacta de objetivos del proyecto con su progreso (tareas integradas sobre el total).
import { useEffect } from "react";
import type { ObjectiveView } from "../../../shared/protocol";
import { useStore } from "../../store";
import { NO_OBJECTIVES } from "../../store/manager";
import "./Manager.css";

export const OBJECTIVE_STATUS: Record<ObjectiveView["status"], string> = { planning: "Planificando", active: "En marcha", done: "Hecho" };

/** Tareas hechas (integradas) y total de un objetivo. */
export function objectiveProgress(o: Pick<ObjectiveView, "tasksByStatus">): { done: number; total: number } {
  const entries = Object.values(o.tasksByStatus ?? {});
  const total = entries.reduce((n, v) => n + v, 0);
  return { done: o.tasksByStatus?.integrated ?? 0, total };
}

export default function ObjectivesList({ projectId }: { projectId: string }) {
  const objectives = useStore((s) => s.objectives[projectId] ?? NO_OBJECTIVES);
  const unavailable = useStore((s) => s.unavailable["objective.list"]);
  const refresh = useStore((s) => s.refreshObjectives);

  useEffect(() => {
    void refresh(projectId);
  }, [projectId, refresh]);

  if (unavailable) return <p className="muted">Aún no disponible: el core no implementa objective.list.</p>;
  if (objectives.length === 0) {
    return <p className="muted">No hay objetivos. Usa «Objetivo para el jefe» en la caja de pedido.</p>;
  }
  return (
    <ul className="plain mg-objectives" aria-label="Objetivos">
      {[...objectives]
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((o) => {
          const { done, total } = objectiveProgress(o);
          const pct = total > 0 ? Math.round((done / total) * 100) : 0;
          return (
            <li key={o.id} className="card mg-objective" aria-label={`Objetivo ${o.text}`}>
              <p className="card-title">{o.text}</p>
              <p className="small muted mg-obj-meta">
                <span className={`ag-badge mg-obj-${o.status}`}>{OBJECTIVE_STATUS[o.status] ?? o.status}</span>
                {total > 0 ? `${done} de ${total} ${total === 1 ? "tarea integrada" : "tareas integradas"}` : "sin tareas todavía"}
              </p>
              <div
                className="mg-bar"
                role="progressbar"
                aria-label={`Progreso de ${o.text}`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={pct}
              >
                <span style={{ width: `${pct}%` }} />
              </div>
            </li>
          );
        })}
    </ul>
  );
}
