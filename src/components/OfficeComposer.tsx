// Caja de pedido dentro de la oficina, superpuesta abajo en la escena (estilo chat de videojuego).
// Chips con los robots trabajadores para elegir destinatario (sincronizados con el robot seleccionado),
// campo que crece de 1 a 5 líneas, Enter envía, Shift+Enter salta de línea y borrador por robot.
import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
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
  selectedId: string | null;
  onSelect: (id: string | null) => void;
};

export default function OfficeComposer({ selectedId, onSelect }: OfficeComposerProps) {
  const agents = useScoped((s) => s.agents);
  const tasks = useScoped((s) => s.tasks);
  const drafts = useScoped((s) => s.drafts);
  const setDraft = useScoped((s) => s.setDraft);
  const createTask = useScoped((s) => s.createTask);
  const startTask = useScoped((s) => s.startTask);
  const setNotice = useScoped((s) => s.setNotice);

  const projectId = useProjectId();
  const createObjective = useStore((s) => s.createObjective);
  const [mode, setMode] = useState<"robot" | "objective">("robot");
  const objective = mode === "objective";
  const [sending, setSending] = useState(false);
  const [showFiles, setShowFiles] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const uid = useId();

  // El jefe planea y revisa: los pedidos van a los demás robots (el primero, por defecto).
  const workers = agents.filter((a) => !a.is_boss);
  const target = workers.find((a) => String(a.id) === selectedId) ?? workers[0];
  const targetId = target ? String(target.id) : "";
  const busy = target ? isBusy(target, tasks) : false;

  // El objetivo es para el jefe y tiene su propio borrador.
  const draftKey = objective ? "objective" : targetId;
  const draft = drafts[draftKey] ?? { request: "", files: "" };
  const { title, description } = parseRequest(draft.request);
  const canSend = (objective || !!target) && !sending && title !== "";

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
    if (!target) {
      setNotice("Crea un robot con «+ Robot» para poder enviarle el pedido.");
      return;
    }
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
    : !target
    ? "Crea un robot para poder pedirle cosas"
    : busy
      ? `${target.name} está trabajando; tu pedido quedará en cola`
      : `Pídele algo a ${target.name}…`;

  return (
    <section className="composer" aria-label="Caja de pedido">
      <div className="composer-chips">
        <div className="composer-mode" role="group" aria-label="Tipo de pedido">
          {(
            [
              ["robot", "Pedido a un robot"],
              ["objective", "Objetivo para el jefe"],
            ] as const
          ).map(([m, label]) => (
            <button key={m} type="button" className={`composer-chip${mode === m ? " is-on" : ""}`} aria-pressed={mode === m} onClick={() => setMode(m)}>
              {label}
            </button>
          ))}
        </div>
        {!objective && (
          <div className="composer-for" role="group" aria-label="Para quién es el pedido">
            <span className="composer-to">Para:</span>
            {workers.length === 0 && <span className="composer-empty">aún no hay robots trabajadores</span>}
            {workers.map((a) => {
              const on = String(a.id) === targetId;
              return (
                <button
                  key={String(a.id)}
                  type="button"
                  className={`composer-chip${on ? " is-on" : ""}${isBusy(a, tasks) ? " is-busy" : ""}`}
                  aria-pressed={on}
                  onClick={() => onSelect(String(a.id))}
                >
                  {a.name}
                </button>
              );
            })}
          </div>
        )}
        <span className="composer-hint">Enter envía · Shift+Enter salto de línea</span>
      </div>

      <div className="composer-row">
        <textarea
          ref={area}
          className="composer-input"
          rows={1}
          aria-label="Tu pedido"
          value={draft.request}
          disabled={!objective && !target}
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
          disabled={!target}
        >
          Archivos
        </button>
        <button type="button" className="composer-btn composer-send" disabled={!canSend} onClick={() => void send()}>
          {sending ? "Enviando…" : objective ? "Enviar objetivo" : busy ? "A la cola" : "Enviar"}
        </button>
      </div>

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
