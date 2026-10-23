// Subpestaña "Tareas": una tarjeta por tarea con Pedido, Estado, Pasos y Respuesta.
import { useState } from "react";
import Markdown from "../../components/Markdown";
import TaskReviewActions from "../../components/TaskReviewActions";
import { accessLabel } from "../../components/TaskList";
import type { Agent } from "../../store/agents";
import type { Task } from "../../store/tasks";
import { useModelLabel } from "../Connections/useModelLabel";
import { CLAUDE_MODELS } from "../CreateAgent/options";
import { fmtDuration, fmtUsd, isBoss, queueInfo, STATE_LABEL } from "./format";
import { useAgentsStore } from "./useAgentsStore";

/** Campos que añade `task.list` en 0.2a (aún no están en el tipo `Task` del store). */
type TaskView = Task & { model?: string | null; cost_usd?: number | null; context_pct?: number | null; steps_count?: number | null };

const LONG_RESULT_CHARS = 600;
const LONG_RESULT_LINES = 12;
const STARTABLE = new Set(["todo", "assigned", "changes", "paused_limit"]);
const NOT_SWITCHABLE = new Set(["approved", "integrated"]);

const TOOL_ICON: [RegExp, string][] = [
  [/^(read|notebookread)$/i, "▤"],
  [/^(edit|write|multiedit|notebookedit)$/i, "✎"],
  [/^bash/i, "▶"],
  [/^(grep|glob|ls)$/i, "⌕"],
  [/^(web|mcp)/i, "◎"],
  [/^(task|agent)/i, "◈"],
];
export const toolIcon = (name: string) => TOOL_ICON.find(([re]) => re.test(name))?.[1] ?? "⚙";

const isFree = (a: Agent) => !a.status || a.status === "idle" || a.status === "done";

export default function AgentTasks({ agent }: { agent: Agent }) {
  const tasks = useAgentsStore((s) => s.tasks) as TaskView[];
  const agents = useAgentsStore((s) => s.agents);
  // El jefe revisa e integra el trabajo de todos: su lista es la del proyecto entero.
  const boss = isBoss(agent);
  const mine = boss ? tasks : tasks.filter((t) => String(t.agent_id) === String(agent.id));
  if (mine.length === 0) return <p className="muted">{boss ? "No hay tareas todavía." : `${agent.name} no tiene tareas todavía.`}</p>;
  return (
    <ul className="plain ag-tasks">
      {mine.map((t) => (
        <TaskCard key={String(t.id)} task={t} agent={agent} owner={boss ? agents.find((a) => String(a.id) === String(t.agent_id))?.name : undefined} others={agents.filter((a) => String(a.id) !== String(agent.id) && !isBoss(a) && isFree(a))} />
      ))}
    </ul>
  );
}

function TaskCard({ task: t, agent, others, owner }: { task: TaskView; agent: Agent; others: Agent[]; owner?: string }) {
  const startTask = useAgentsStore((s) => s.startTask);
  const halted = useAgentsStore((s) => s.halted);
  const loadDiff = useAgentsStore((s) => s.loadDiff);
  const switchTask = useAgentsStore((s) => s.switchTask);
  const refreshSteps = useAgentsStore((s) => s.refreshSteps);
  const steps = useAgentsStore((s) => s.stepsByTask[String(t.id)]);
  const unavailable = useAgentsStore((s) => s.unavailable);
  const queueChange = useAgentsStore((s) => s.queue[String(t.id)]);
  const live = useAgentsStore((s) => Object.values(s.liveRuns).find((r) => String(r.taskId) === String(t.id)));
  const [diff, setDiff] = useState<string>();
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [target, setTarget] = useState("");
  const [switching, setSwitching] = useState(false);

  const label = useModelLabel();
  const model = live?.model ?? t.model ?? undefined;
  const cost = live?.costUsd ?? t.cost_usd ?? undefined;
  const queue = queueInfo(t, queueChange);
  const access = accessLabel(t);
  const readOnly = t.read_only === true || t.files?.length === 0;
  const result = t.result ?? "";
  const long = result.length > LONG_RESULT_CHARS || result.split("\n").length > LONG_RESULT_LINES;
  const count = steps?.length ?? t.steps_count ?? undefined;
  const currentModel = model ?? agent.current_model ?? agent.model;

  const showDiff = async () => {
    setLoadingDiff(true);
    const text = await loadDiff(t.id);
    setLoadingDiff(false);
    if (text !== undefined) setDiff(text === "" ? "(sin cambios)" : text);
  };

  const doSwitch = async () => {
    if (!target) return;
    setSwitching(true);
    const [kind, value] = [target.slice(0, target.indexOf(":")), target.slice(target.indexOf(":") + 1)];
    await switchTask({ taskId: String(t.id), ...(kind === "agent" ? { agentId: value } : { model: value }) });
    setSwitching(false);
    setTarget("");
  };

  return (
    <li className="card ag-task" aria-label={`Tarea ${t.title}`}>
      <section aria-label="Pedido">
        <h4 className="ag-sec">Pedido</h4>
        <p className="card-title">{t.title}</p>
        {t.description && t.description !== t.title && <p className="ag-desc">{t.description}</p>}
      </section>

      <section aria-label="Estado">
        <h4 className="ag-sec">Estado</h4>
        <p className="ag-state">
          <span className={`ag-badge ag-badge-${t.status}`}>{STATE_LABEL[t.status] ?? t.status}</span>
          {queue && (
            <span className="ag-badge ag-badge-queued">{queue.position > 0 ? `En cola #${queue.position}` : "En cola"}</span>
          )}
          {queue?.budget && <span className="ag-badge ag-badge-budget">bloqueada por tope de gasto</span>}
          {owner && <span className="tag muted">{owner}</span>}
          {access && <span className="tag muted">{access}</span>}
          {model && <span className="ag-chip">{label(model)}</span>}
          {cost !== undefined && <span className="muted small">{fmtUsd(cost)}</span>}
          {live && <span className="muted small">en vivo</span>}
        </p>
      </section>

      <details
        className="ag-steps"
        onToggle={(e) => {
          if ((e.currentTarget as HTMLDetailsElement).open) void refreshSteps(t.id);
        }}
      >
        <summary>Pasos{count !== undefined ? ` (${count})` : ""}</summary>
        {unavailable["task.steps"] ? (
          <p className="muted small">Aún no disponible: el core no implementa task.steps.</p>
        ) : steps === undefined ? (
          <p className="muted small">Cargando…</p>
        ) : steps.length === 0 ? (
          <p className="muted small">Sin pasos registrados.</p>
        ) : (
          <ol className="ag-step-list">
            {steps.map((st, i) => (
              <li key={i}>
                <span className="ag-tool-icon" aria-hidden="true">
                  {toolIcon(st.name)}
                </span>
                <strong>{st.name}</strong>
                <span className="ag-step-target muted">{st.target}</span>
                <span
                  className={`ag-step-ok ${st.ok === true ? "is-ok" : st.ok === false ? "is-bad" : ""}`}
                  aria-label={st.ok === true ? "correcto" : st.ok === false ? "falló" : "en curso"}
                >
                  {st.ok === true ? "✓" : st.ok === false ? "✗" : "…"}
                </span>
                <span className="muted small">{st.endedAt != null ? fmtDuration(st.endedAt - st.startedAt) : ""}</span>
              </li>
            ))}
          </ol>
        )}
      </details>

      {result && (
        <section aria-label="Respuesta">
          <h4 className="ag-sec">Respuesta</h4>
          {long ? (
            <details className="result-box">
              <summary>Ver respuesta completa</summary>
              <Markdown text={result} label={`Respuesta de ${t.title}`} />
            </details>
          ) : (
            <Markdown text={result} label={`Respuesta de ${t.title}`} />
          )}
        </section>
      )}

      <TaskReviewActions task={t} />

      <div className="row ag-actions">
        {STARTABLE.has(t.status) && (
          <button
            type="button"
            className="btn btn-primary"
            disabled={halted}
            title={halted ? "Parada global activa: reanuda para empezar" : undefined}
            onClick={() => void startTask(t.id)}
          >
            Empezar
          </button>
        )}
        {!readOnly && (
          <button type="button" className="btn" disabled={loadingDiff} onClick={() => void showDiff()}>
            {loadingDiff ? "Cargando…" : "Ver cambios"}
          </button>
        )}
        {!NOT_SWITCHABLE.has(t.status) && (
          <span className="ag-switch">
            <select aria-label={`Cambiar IA de ${t.title}`} value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">Cambiar IA…</option>
              <optgroup label="Modelo">
                {CLAUDE_MODELS.filter((m) => m.id !== currentModel).map((m) => (
                  <option key={m.id} value={`model:${m.id}`}>
                    {m.label}
                  </option>
                ))}
              </optgroup>
              {others.length > 0 && (
                <optgroup label="Otro agente libre">
                  {others.map((a) => (
                    <option key={String(a.id)} value={`agent:${a.id}`}>
                      {a.name}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
            <button type="button" className="btn" disabled={!target || switching} onClick={() => void doSwitch()}>
              {switching ? "Cambiando…" : "Cambiar"}
            </button>
          </span>
        )}
      </div>
      {unavailable["task.switch"] && <p className="muted small">Cambiar IA aún no está disponible en el core.</p>}
      {diff !== undefined && (
        <pre className="pre" aria-label={`Cambios de ${t.title}`}>
          {diff}
        </pre>
      )}
    </li>
  );
}
