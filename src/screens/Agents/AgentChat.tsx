// Subpestaña "Chat" (primera y por defecto): la conversación con el robot elegido, a la manera del mock Chat.
// Cada tarea del robot es un par de mensajes (tu pedido -> su respuesta en Markdown, con estado y botón de pasos) y
// abajo va la caja de pedido. Con el jefe, el historial son los objetivos que le has dado.
import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import Markdown from "../../components/Markdown";
import OfficeComposer from "../../components/OfficeComposer";
import type { Agent } from "../../store/agents";
import type { Task } from "../../store/tasks";
import { useStore } from "../../store";
import { NO_OBJECTIVES } from "../../store/manager";
import { useProjectId } from "../../store/scoped";
import { OBJECTIVE_STATUS, objectiveProgress } from "../Manager/ObjectivesList";
import { toolIcon } from "./AgentTasks";
import { fmtDuration, isBoss, paletteHex, STATE_LABEL } from "./format";
import { useAgentsStore } from "./useAgentsStore";

function Bubble({ who, color, mine, children }: { who: string; color: string; mine?: boolean; children: ReactNode }) {
  return (
    <li className={`chat-msg${mine ? " is-mine" : ""}`}>
      <span className="chat-sq" style={{ background: color }} aria-hidden="true" />
      <div className="chat-bubble">
        <b className="chat-who" style={{ color: mine ? "#f4c542" : undefined }}>
          {who}
        </b>
        {children}
      </div>
    </li>
  );
}

export default function AgentChat({ agent, inputRef }: { agent: Agent; inputRef?: Ref<HTMLTextAreaElement> }) {
  const boss = isBoss(agent);
  const tasks = useAgentsStore((s) => s.tasks);
  const mine = boss ? [] : tasks.filter((t) => String(t.agent_id) === String(agent.id));
  const pid = useProjectId();
  const objectives = useStore((s) => s.objectives[pid] ?? NO_OBJECTIVES);
  const list = useRef<HTMLUListElement>(null);
  const color = paletteHex(agent.color);
  const sorted = [...objectives].sort((a, b) => a.createdAt - b.createdAt);
  // El historial va siempre abajo del todo: al llegar un mensaje o cambiar una respuesta se baja.
  const signature = boss ? sorted.map((o) => `${o.id}${o.status}`).join() : mine.map((t) => `${t.id}${t.status}${t.result?.length ?? 0}`).join();
  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [signature, agent.id]);

  const empty = boss ? sorted.length === 0 : mine.length === 0;
  return (
    <div className="chat">
      <ul className="plain chat-list" ref={list} aria-label={`Conversación con ${agent.name}`}>
        {empty && (
          <li className="muted chat-empty">
            {boss ? "Aún no le has dado objetivos al jefe." : `Todavía no has hablado con ${agent.name}.`} Escribe abajo para empezar.
          </li>
        )}
        {boss
          ? sorted.map((o) => {
              const { done, total } = objectiveProgress(o);
              return (
                <ObjectiveMessages
                  key={o.id}
                  agent={agent}
                  text={o.text}
                  status={OBJECTIVE_STATUS[o.status] ?? o.status}
                  progress={total > 0 ? `${done} de ${total} tareas integradas` : "sin tareas todavía"}
                  color={color}
                />
              );
            })
          : mine.map((t) => <TaskMessages key={String(t.id)} task={t} agent={agent} color={color} />)}
      </ul>
      <OfficeComposer agent={agent} inputRef={inputRef} />
    </div>
  );
}

function ObjectiveMessages({ agent, text, status, progress, color }: { agent: Agent; text: string; status: string; progress: string; color: string }) {
  return (
    <>
      <Bubble who="TÚ" color="#f4c542" mine>
        <span className="chat-text">{text}</span>
      </Bubble>
      <Bubble who={agent.name.toUpperCase()} color={color}>
        <span className="chat-text">
          <span className="ag-badge">{status}</span> {progress}
        </span>
      </Bubble>
    </>
  );
}

function TaskMessages({ task: t, agent, color }: { task: Task; agent: Agent; color: string }) {
  const refreshSteps = useAgentsStore((s) => s.refreshSteps);
  const steps = useAgentsStore((s) => s.stepsByTask[String(t.id)]);
  const unavailable = useAgentsStore((s) => s.unavailable["task.steps"]);
  const [open, setOpen] = useState(false);
  const request = t.description && t.description !== t.title ? t.description : t.title;
  const working = t.status === "running" || t.status === "needs_you";
  return (
    <>
      <Bubble who="TÚ" color="#f4c542" mine>
        <span className="chat-text">{request}</span>
      </Bubble>
      <Bubble who={agent.name.toUpperCase()} color={color}>
        <span className="chat-state">
          <span className={`ag-badge ag-badge-${t.status}`}>{STATE_LABEL[t.status] ?? t.status}</span>
          {working && <span className="muted small">trabajando…</span>}
          <button
            type="button"
            className="chat-steps-btn"
            aria-expanded={open}
            onClick={() => {
              if (!open) void refreshSteps(t.id);
              setOpen((v) => !v);
            }}
          >
            Pasos{open ? " ▾" : " ▸"}
          </button>
        </span>
        {open &&
          (unavailable ? (
            <span className="muted small">Aún no disponible: el core no implementa task.steps.</span>
          ) : steps === undefined ? (
            <span className="muted small">Cargando…</span>
          ) : steps.length === 0 ? (
            <span className="muted small">Sin pasos registrados.</span>
          ) : (
            <ol className="ag-step-list chat-steps">
              {steps.map((st, i) => (
                <li key={i}>
                  <span className="ag-tool-icon" aria-hidden="true">{toolIcon(st.name)}</span>
                  <strong>{st.name}</strong>
                  <span className="ag-step-target muted">{st.target}</span>
                  <span className="muted small">{st.endedAt != null ? fmtDuration(st.endedAt - st.startedAt) : ""}</span>
                </li>
              ))}
            </ol>
          ))}
        {t.result && <Markdown text={t.result} label={`Respuesta de ${t.title}`} />}
      </Bubble>
    </>
  );
}
