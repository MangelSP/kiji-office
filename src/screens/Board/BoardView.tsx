// Vista Pizarra: tablero kanban con las 10 columnas del plan 0.4a. Arrastrar y soltar (HTML5) o, con el foco en una
// tarjeta, flechas izquierda/derecha; ambos llaman a `board.move` con actualización optimista (store/board.ts).
import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import type { BoardColumn } from "../../../shared/protocol";
import { useStore } from "../../store";
import type { Agent } from "../../store/agents";
import { BOARD_COLUMNS, canMoveTo, columnLabel, columnOf, flagOf, type BoardTask } from "../../store/board";
import { useProjectId, useScoped } from "../../store/scoped";
import { useModelLabel } from "../Connections/useModelLabel";
import { fmtUsd, paletteHex } from "../Agents/format";
import "./Board.css";

type Props = {
  /** Abre el detalle de la tarea en el panel del agente. */
  onOpenTask: (agentId: string | null, task: BoardTask) => void;
  onClose: () => void;
};

const FLAG: Record<string, { icon: string; label: string }> = {
  blocked: { icon: "⛔", label: "Bloqueada" },
  failed: { icon: "✖", label: "Fallida" },
  paused_limit: { icon: "⏸", label: "En pausa por límite" },
};

export default function BoardView({ onOpenTask, onClose }: Props) {
  const projectId = useProjectId();
  const agents = useScoped((s) => s.agents);
  const tasks = useScoped((s) => s.tasks) as BoardTask[];
  const moveTask = useStore((s) => s.moveTask);
  const modelLabel = useModelLabel();
  const [robots, setRobots] = useState<string[]>([]);
  const [hideProd, setHideProd] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<BoardColumn | null>(null);
  const [live, setLive] = useState("");
  const refocus = useRef<string | null>(null);
  const root = useRef<HTMLElement>(null);

  const columns = BOARD_COLUMNS.filter((c) => !(hideProd && c.id === "done_prod"));
  const visible = robots.length ? tasks.filter((t) => robots.includes(String(t.agent_id))) : tasks;
  const byColumn = useMemo(() => {
    const m = new Map<BoardColumn, BoardTask[]>(BOARD_COLUMNS.map((c) => [c.id, []]));
    for (const t of visible) m.get(columnOf(t, agents))?.push(t);
    return m;
  }, [visible, agents]);
  const dragged = dragId ? tasks.find((t) => String(t.id) === dragId) : undefined;
  const dragFrom = dragged ? columnOf(dragged, agents) : null;

  // Tras mover con teclado la tarjeta cambia de columna (se remonta): se le devuelve el foco.
  useEffect(() => {
    if (!refocus.current) return;
    root.current?.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(refocus.current)}"]`)?.focus();
    refocus.current = null;
  });

  async function move(task: BoardTask, to: BoardColumn, viaKeyboard = false) {
    const from = columnOf(task, agents);
    if (from === to) return;
    if (!canMoveTo(from, to)) {
      setLive(`No se puede mover a ${columnLabel(to)}: solo desde Done`);
      return;
    }
    if (viaKeyboard) refocus.current = String(task.id);
    const ok = await moveTask(projectId, String(task.id), to);
    setLive(ok ? `Movida a ${columnLabel(to)}` : `No se pudo mover a ${columnLabel(to)}`);
  }

  function onKey(e: KeyboardEvent<HTMLElement>, t: BoardTask) {
    if (e.key === "Enter") return onOpenTask(t.agent_id == null ? null : String(t.agent_id), t);
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const i = columns.findIndex((c) => c.id === columnOf(t, agents));
    const next = columns[i + (e.key === "ArrowRight" ? 1 : -1)];
    if (next) void move(t, next.id, true);
  }

  function onDrop(e: DragEvent, to: BoardColumn) {
    e.preventDefault();
    const id = e.dataTransfer.getData("text/plain") || dragId;
    setOver(null);
    setDragId(null);
    const t = tasks.find((x) => String(x.id) === id);
    if (t) void move(t, to);
  }

  const toggle = (id: string) => setRobots((r) => (r.includes(id) ? r.filter((x) => x !== id) : [...r, id]));

  return (
    <section className="board" aria-label="Pizarra" ref={root}>
      <header className="board-head">
        <button type="button" className="btn" onClick={onClose}>
          ← Volver a la oficina
        </button>
        <h2>Pizarra</h2>
        <div className="board-chips" role="group" aria-label="Filtrar por robot">
          {agents.map((a) => (
            <button
              key={String(a.id)}
              type="button"
              className={`board-chip${robots.includes(String(a.id)) ? " is-on" : ""}`}
              aria-pressed={robots.includes(String(a.id))}
              onClick={() => toggle(String(a.id))}
            >
              <i className="board-dot" style={{ background: paletteHex(a.color) }} />
              {a.name}
            </button>
          ))}
        </div>
        <label className="board-check">
          <input type="checkbox" checked={hideProd} onChange={(e) => setHideProd(e.target.checked)} /> Ocultar Done producción
        </label>
      </header>
      <p className="sr-only" role="status" aria-live="polite">
        {live}
      </p>
      <div className="board-cols">
        {columns.map((c) => {
          const list = byColumn.get(c.id) ?? [];
          const invalid = dragFrom !== null && over === c.id && !canMoveTo(dragFrom, c.id) && dragFrom !== c.id;
          return (
            <section
              key={c.id}
              className={`board-col${over === c.id ? (invalid ? " is-invalid" : " is-over") : ""}`}
              style={{ ["--col" as string]: c.color }}
              aria-label={`${c.label}, ${list.length}`}
              data-column={c.id}
              onDragOver={(e) => {
                if (!dragId) return;
                if (dragFrom !== null && !canMoveTo(dragFrom, c.id) && dragFrom !== c.id) e.dataTransfer.dropEffect = "none";
                else e.preventDefault();
                setOver(c.id);
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver((o) => (o === c.id ? null : o));
              }}
              onDrop={(e) => onDrop(e, c.id)}
            >
              <h3>
                {c.label} <span className="board-count">{list.length}</span>
              </h3>
              <ul className="plain board-list">
                {list.map((t) => (
                  <Card
                    key={String(t.id)}
                    task={t}
                    agent={agents.find((a) => String(a.id) === String(t.agent_id))}
                    modelLabel={modelLabel}
                    dragging={dragId === String(t.id)}
                    onDragStart={(e) => {
                      e.dataTransfer.setData("text/plain", String(t.id));
                      e.dataTransfer.effectAllowed = "move";
                      setDragId(String(t.id));
                    }}
                    onDragEnd={() => {
                      setDragId(null);
                      setOver(null);
                    }}
                    onKeyDown={(e) => onKey(e, t)}
                    onOpen={() => onOpenTask(t.agent_id == null ? null : String(t.agent_id), t)}
                  />
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </section>
  );
}

type CardProps = {
  task: BoardTask;
  agent?: Agent;
  modelLabel: (m: string) => string;
  dragging: boolean;
  onDragStart: (e: DragEvent) => void;
  onDragEnd: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => void;
  onOpen: () => void;
};

function Card({ task: t, agent, modelLabel, dragging, onDragStart, onDragEnd, onKeyDown, onOpen }: CardProps) {
  const flag = flagOf(t);
  const model = t.model ?? agent?.current_model ?? agent?.model;
  const manual = t.board_manual === 1;
  return (
    <li
      className={`board-card${dragging ? " is-dragging" : ""}`}
      tabIndex={0}
      draggable
      data-task-id={String(t.id)}
      aria-label={`Tarea ${t.title}`}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onKeyDown={onKeyDown}
      onClick={onOpen}
    >
      <p className="board-title">
        {flag && (
          <span className="board-flag" title={FLAG[flag].label} role="img" aria-label={FLAG[flag].label}>
            {FLAG[flag].icon}
          </span>
        )}{" "}
        {t.title}
      </p>
      <p className="board-meta">
        <span className="board-robot">
          <i className="board-dot" style={{ background: paletteHex(agent?.color) }} />
          {agent?.name ?? "Sin robot"}
        </span>
        {model && <span className="board-pill">{modelLabel(model)}</span>}
        {t.cost_usd != null && t.cost_usd > 0 && <span className="board-pill">{fmtUsd(t.cost_usd)}</span>}
        <span className={`board-pill ${manual ? "is-manual" : ""}`}>{manual ? "manual" : "auto"}</span>
      </p>
    </li>
  );
}
