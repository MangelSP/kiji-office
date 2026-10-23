// Caja de pedido del agente elegido, al pie de su chat en el panel derecho (estilo del mock Chat): campo que crece
// de 1 a 5 líneas, Enter envía, Shift+Enter salta de línea, botón Archivos y borrador por robot. Con el jefe elegido
// el pedido es un «Objetivo para el jefe» (lo planifica y lo reparte); con cualquier otro, una tarea para ese robot.
import { useCallback, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type Ref } from "react";
import { parseFiles, parseRequest } from "../screens/Office/request";
import { useStore } from "../store";
import { useProjectId, useScoped } from "../store/scoped";
import type { Agent } from "../store/agents";
import type { Task } from "../store/tasks";
import "./OfficeComposer.css";

const BUSY_ROBOT = new Set(["thinking", "writing", "needs_you"]);
const BUSY_TASK = new Set(["running", "needs_you"]);
/** Líneas máximas del campo antes de pasar a desplazarse. */
export const MAX_LINES = 5;

/** ¿El robot está ocupado? Por su estado de robot o porque tiene una tarea en curso. */
export function isBusy(agent: Pick<Agent, "id" | "status">, tasks: readonly Pick<Task, "agent_id" | "status">[]): boolean {
  if (agent.status && BUSY_ROBOT.has(agent.status)) return true;
  return tasks.some((t) => t.agent_id != null && String(t.agent_id) === String(agent.id) && BUSY_TASK.has(t.status));
}

export type OfficeComposerProps = {
  /** Robot al que va el pedido (el elegido en la oficina o en el panel). */
  agent: Agent;
  /** Para enfocar el campo desde fuera (clic en un robot de la escena). */
  inputRef?: Ref<HTMLTextAreaElement>;
};

export default function OfficeComposer({ agent, inputRef }: OfficeComposerProps) {
  const tasks = useScoped((s) => s.tasks);
  const drafts = useScoped((s) => s.drafts);
  const setDraft = useScoped((s) => s.setDraft);
  const createTask = useScoped((s) => s.createTask);
  const startTask = useScoped((s) => s.startTask);
  const setNotice = useScoped((s) => s.setNotice);

  const projectId = useProjectId();
  const createObjective = useStore((s) => s.createObjective);
  const halted = useStore((s) => s.halted);
  const objective = agent.is_boss === true || agent.is_boss === 1;
  const [sending, setSending] = useState(false);
  const [showFiles, setShowFiles] = useState(false);
  const area = useRef<HTMLTextAreaElement | null>(null);
  const uid = useId();
  const setArea = useCallback(
    (el: HTMLTextAreaElement | null) => {
      area.current = el;
      if (typeof inputRef === "function") inputRef(el);
      else if (inputRef) (inputRef as { current: HTMLTextAreaElement | null }).current = el;
    },
    [inputRef],
  );

  const target = agent;
  const targetId = String(agent.id);
  const busy = isBusy(agent, tasks);

  // El objetivo es para el jefe y tiene su propio borrador.
  const draftKey = objective ? "objective" : targetId;
  const draft = drafts[draftKey] ?? { request: "", files: "" };
  const { title, description } = parseRequest(draft.request);
  const canSend = !sending && !halted && title !== "";

  // El campo crece con el texto hasta MAX_LINES líneas; después se desplaza.
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    const line = parseFloat(getComputedStyle(el).lineHeight) || 20;
    const pad = el.offsetHeight - el.clientHeight;
    el.style.height = `${Math.min(el.scrollHeight, line * MAX_LINES + pad)}px`;
  }, [draft.request, draftKey]);

  const sendObjective = async () => {
    if (!canSend) return;
    setSending(true);
    try {
      const ok = await createObjective(projectId, draft.request.trim());
      if (!ok) return; // el aviso ya está puesto y el borrador se conserva
      setDraft("objective", { request: "", files: "" });
      setNotice("Objetivo enviado al jefe: lo planificará y lo verás en la pestaña del Jefe.");
    } finally {
      setSending(false);
    }
  };

  const send = async () => {
    if (objective) return sendObjective();
    if (!canSend) return;
    setSending(true);
    try {
      const created = await createTask({ title, description, files: parseFiles(draft.files), agentId: target.id });
      if (!created) return; // el aviso de error ya está puesto y el borrador se conserva
      setDraft(targetId, { request: "", files: "" });
      setShowFiles(false);
      if (busy) {
        setNotice(`${target.name} está trabajando: tu pedido quedó en cola. Empiézalo cuando termine.`);
      } else {
        await startTask(created.id);
      }
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    void send();
  };

  const placeholder = objective
    ? "Cuéntale al jefe qué quieres conseguir…"
    : busy
      ? `${target.name} está trabajando; tu pedido quedará en cola`
      : `Escríbele a ${target.name}…`;

  return (
    <section className="composer" aria-label="Caja de pedido">
      {objective && <p className="composer-mode">Objetivo para el jefe</p>}
      <div className="composer-row">
        <textarea
          ref={setArea}
          className="composer-input"
          rows={1}
          aria-label="Tu pedido"
          value={draft.request}
          placeholder={placeholder}
          onChange={(e) => setDraft(draftKey, { ...draft, request: e.target.value })}
          onKeyDown={onKeyDown}
        />
        <button
          type="button"
          className="composer-btn"
          aria-expanded={showFiles}
          aria-controls={`${uid}-files`}
          onClick={() => setShowFiles((v) => !v)}
          hidden={objective}
        >
          Archivos
        </button>
        <button
          type="button"
          className="composer-btn composer-send"
          disabled={!canSend}
          title={halted ? "Parada global activa: reanuda para enviar" : undefined} onClick={() => void send()}
        >
          {sending ? "Enviando…" : objective ? "Enviar objetivo" : busy ? "A la cola" : "Enviar"}
        </button>
      </div>
      <span className="composer-hint">Enter envía · Shift+Enter salto de línea</span>

      {showFiles && !objective && (
        <div className="composer-files" id={`${uid}-files`}>
          <input
            aria-label="Archivos que puede modificar (opcional)"
            value={draft.files}
            onChange={(e) => setDraft(targetId, { ...draft, files: e.target.value })}
            placeholder="src/a.ts, src/b.ts (vacío = solo lee y responde)"
          />
        </div>
      )}
    </section>
  );
}
