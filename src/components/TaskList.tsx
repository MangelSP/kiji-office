import { useState } from "react";
import type { Agent, Id } from "../store/agents";
import { TASK_STATES, type Task } from "../store/tasks";
import "./components.css";

const STATE_LABEL: Record<string, string> = {
  todo: "Por hacer",
  assigned: "Asignada",
  running: "En curso",
  needs_you: "Te necesita",
  review: "En revisión",
  changes: "Con cambios pedidos",
  approved: "Aprobada",
  integrated: "Integrada",
  blocked: "Bloqueada",
  failed: "Fallida",
  paused_limit: "Pausada por límite",
};

/** Estados desde los que tiene sentido pulsar ▶. */
const STARTABLE = new Set(["todo", "assigned", "changes", "paused_limit"]);

// Lista de tareas agrupadas por estado, con ▶ (task.start) y "Ver diff" (task.diff).
export default function TaskList({
  tasks,
  agents,
  onStart,
  onDiff,
}: {
  tasks: Task[];
  agents: Agent[];
  onStart: (id: Id) => Promise<void>;
  onDiff: (id: Id) => Promise<string | undefined>;
}) {
  const [diffs, setDiffs] = useState<Record<string, string>>({});
  const [loadingDiff, setLoadingDiff] = useState<string | null>(null);

  if (tasks.length === 0) return <p className="muted">No hay tareas todavía.</p>;

  const agentName = (id?: Id | null) =>
    id == null ? "sin asignar" : (agents.find((a) => String(a.id) === String(id))?.name ?? String(id));

  // Estados conocidos en orden de flujo; los desconocidos van al final.
  const known = new Set<string>(TASK_STATES);
  const states = [...TASK_STATES, ...new Set(tasks.map((t) => t.status).filter((s) => !known.has(s)))];

  const showDiff = async (id: Id) => {
    const key = String(id);
    setLoadingDiff(key);
    const text = await onDiff(id);
    setLoadingDiff(null);
    if (text !== undefined) setDiffs((d) => ({ ...d, [key]: text === "" ? "(sin cambios)" : text }));
  };

  return (
    <div>
      {states.map((state) => {
        const group = tasks.filter((t) => t.status === state);
        if (group.length === 0) return null;
        return (
          <section key={state} aria-label={STATE_LABEL[state] ?? state}>
            <h3 className="group-title">
              {STATE_LABEL[state] ?? state} <span className="muted">({group.length})</span>
            </h3>
            <ul className="plain">
              {group.map((t) => {
                const key = String(t.id);
                return (
                  <li key={key} className="card">
                    <p className="card-title">{t.title}</p>
                    <p className="muted small">
                      {agentName(t.agent_id)}
                      {t.files && t.files.length > 0 ? ` · ${t.files.join(", ")}` : ""}
                    </p>
                    <div className="row">
                      {STARTABLE.has(t.status) && (
                        <button
                          type="button"
                          className="btn btn-primary"
                          aria-label={`Iniciar tarea ${t.title}`}
                          onClick={() => void onStart(t.id)}
                        >
                          ▶ Iniciar
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn"
                        disabled={loadingDiff === key}
                        onClick={() => void showDiff(t.id)}
                      >
                        {loadingDiff === key ? "Cargando…" : "Ver diff"}
                      </button>
                    </div>
                    {diffs[key] !== undefined && (
                      <pre className="pre" aria-label={`Diff de ${t.title}`}>
                        {diffs[key]}
                      </pre>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
