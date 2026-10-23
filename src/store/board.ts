// Slice `board`: mover una tarea de columna (`board.move`) con actualización optimista y reversión si falla.
import type { StateCreator } from "zustand";
import type { BoardColumn, BoardFlag, BoardTaskFields } from "../../shared/protocol";
import type { Agent } from "./agents";
import { errorMessage, stripMethodPrefix } from "./core";
import type { AppState } from "./index";
import type { Task } from "./tasks";

/** Las 10 columnas en orden de flujo (PLAN-0.4-pizarra.md). */
export const BOARD_COLUMNS: { id: BoardColumn; label: string; color: string }[] = [
  { id: "refinement", label: "Refinamiento", color: "#8d93b8" },
  { id: "refined", label: "Refinado", color: "#5aa9f0" },
  { id: "doing_dev", label: "Doing (Dev)", color: "#f4c542" },
  { id: "committed", label: "Committed", color: "#e08a3c" },
  { id: "doing_qa", label: "Doing (QA)", color: "#b07be0" },
  { id: "bug", label: "Bug", color: "#e5534b" },
  { id: "fix", label: "Fix", color: "#ff7a45" },
  { id: "functional", label: "Prueba funcional", color: "#3fb8c9" },
  { id: "done", label: "Done", color: "#4cc38a" },
  { id: "done_prod", label: "Done producción", color: "#2f9e6b" },
];

export const columnLabel = (c: BoardColumn) => BOARD_COLUMNS.find((x) => x.id === c)?.label ?? c;

/** Tarea con los campos de pizarra que añade el core y los de 0.2a que usa la tarjeta. */
export type BoardTask = Task & Partial<BoardTaskFields> & { model?: string | null; cost_usd?: number | null };

/** `done_prod` solo se acepta desde `done` (misma regla que el core). */
export function canMoveTo(from: BoardColumn, to: BoardColumn): boolean {
  return from !== to && (to !== "done_prod" || from === "done");
}

/** Columna aproximada desde el estado, por si el core aún no manda `board_column` (tabla del plan). */
export function columnOf(t: BoardTask, agents: Agent[] = []): BoardColumn {
  if (t.board_column) return t.board_column;
  const hasAgent = t.agent_id != null && t.agent_id !== "";
  const agent = agents.find((a) => String(a.id) === String(t.agent_id));
  switch (t.status) {
    case "todo":
      return hasAgent ? "refined" : "refinement";
    case "assigned":
    case "blocked":
    case "paused_limit":
      return "refined";
    case "running":
    case "needs_you":
    case "failed":
      return /test|qa/i.test(agent?.role ?? "") ? "doing_qa" : "doing_dev";
    case "review":
      return "committed";
    case "changes":
      return "bug";
    case "approved":
      return "functional";
    case "integrated":
      return "done";
    default:
      return "refinement";
  }
}

export function flagOf(t: BoardTask): BoardFlag {
  if (t.board_flag !== undefined) return t.board_flag;
  return t.status === "blocked" || t.status === "failed" || t.status === "paused_limit" ? t.status : null;
}

export type BoardSlice = {
  /** Devuelve `true` si el core aceptó el movimiento; si falla, deja la tarea como estaba y avisa en `notice`. */
  moveTask: (projectId: string, taskId: string, column: BoardColumn) => Promise<boolean>;
};

export const createBoardSlice: StateCreator<AppState, [], [], BoardSlice> = (set, get) => ({
  moveTask: async (pid, taskId, column) => {
    const before = get().byProject[pid]?.tasks.find((t) => String(t.id) === taskId) as BoardTask | undefined;
    if (!before) return false;
    const prev = { board_column: before.board_column, board_manual: before.board_manual };
    get().upsertTask(pid, { ...before, board_column: column, board_manual: 1 } as Task);
    try {
      await get().call("board.move", { taskId, projectId: pid, column });
      return true;
    } catch (err) {
      // Solo se revierte si nadie la tocó mientras tanto (p. ej. un `task.changed` del core).
      const now = get().byProject[pid]?.tasks.find((t) => String(t.id) === taskId) as BoardTask | undefined;
      if (now?.board_column === column) get().upsertTask(pid, { ...now, ...prev } as Task);
      set({ notice: `board.move: ${stripMethodPrefix("board.move", errorMessage(err))}` });
      return false;
    }
  },
});
