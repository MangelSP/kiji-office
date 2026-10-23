// Lógica pura de la pizarra de la escena (columnas, conteo, cola de viajes, interpolación). Sin PixiJS: se testea en vitest.
import type { BoardColumn } from "../../shared/protocol";
import type { Point } from "./officeLayout";

/** En orden de flujo (igual que PLAN-0.4-pizarra.md). */
export const BOARD_COLUMNS: readonly BoardColumn[] = [
  "refinement", "refined", "doing_dev", "committed", "doing_qa", "bug", "fix", "functional", "done", "done_prod",
];

/** Color de la cabecera de cada franja (mismo orden que `BOARD_COLUMNS`). */
export const COLUMN_COLORS: readonly number[] = [
  0x8a8f98, 0x5aa9f0, 0xf4c542, 0x9b7bf0, 0xff9f43, 0xe5484d, 0xd1459b, 0x2fb5a8, 0x4cc38a, 0x2c8f5f,
];

export const NOTE_COLORS: readonly number[] = [0xffe066, 0x8fd0ff, 0xa8e6a1, 0xff9fc4];
export const MAX_NOTES = 4;

type TaskLike = { id: string | number; status: string; agent_id?: string | number | null; board_column?: BoardColumn | null };

/** Columna aproximada a partir del estado (solo si el core aún no manda `board_column`). */
export function columnFromStatus(status: string, hasAgent: boolean): BoardColumn {
  switch (status) {
    case "todo": return hasAgent ? "refined" : "refinement";
    case "assigned": return "refined";
    case "running":
    case "needs_you":
    case "blocked":
    case "failed":
    case "paused_limit": return "doing_dev";
    case "review": return "committed";
    case "changes": return "bug";
    case "approved": return "functional";
    case "integrated": return "done";
    default: return "refinement";
  }
}

export function columnOfTask(t: TaskLike): BoardColumn {
  if (t.board_column && BOARD_COLUMNS.includes(t.board_column)) return t.board_column;
  return columnFromStatus(t.status, t.agent_id != null);
}

/** Ids de tarea por columna. `hold` fija una tarea en otra columna (la nota aún no ha sido pegada por el robot). */
export function tasksByColumn(tasks: readonly TaskLike[], hold?: ReadonlyMap<string, BoardColumn>): Record<BoardColumn, string[]> {
  const out = Object.fromEntries(BOARD_COLUMNS.map((c) => [c, [] as string[]])) as Record<BoardColumn, string[]>;
  for (const t of tasks) {
    const id = String(t.id);
    out[hold?.get(id) ?? columnOfTask(t)].push(id);
  }
  return out;
}

export function countByColumn(tasks: readonly TaskLike[], hold?: ReadonlyMap<string, BoardColumn>): Record<BoardColumn, number> {
  const by = tasksByColumn(tasks, hold);
  return Object.fromEntries(BOARD_COLUMNS.map((c) => [c, by[c].length])) as Record<BoardColumn, number>;
}

/** Cuántas notitas se dibujan y cuántas sobran (se muestran como número). */
export function visibleNotes(count: number, max = MAX_NOTES): { shown: number; extra: number } {
  const n = Math.max(0, Math.floor(count));
  return { shown: Math.min(n, max), extra: Math.max(0, n - max) };
}

/** Color estable de la nota de una tarea. */
export function noteColorOf(taskId: string): number {
  let h = 0;
  for (let i = 0; i < taskId.length; i++) h = (h * 31 + taskId.charCodeAt(i)) >>> 0;
  return NOTE_COLORS[h % NOTE_COLORS.length];
}

/** Demo: la siguiente columna del flujo (la última vuelve a la primera). */
export function nextColumn(c: BoardColumn): BoardColumn {
  return BOARD_COLUMNS[(BOARD_COLUMNS.indexOf(c) + 1) % BOARD_COLUMNS.length];
}

/** Cola FIFO con tope (un robot no acumula animaciones sin fin si llegan a ráfagas). */
export class MoveQueue<T> {
  private items: T[] = [];
  constructor(private cap = 20) {}
  push(item: T) {
    this.items.push(item);
    if (this.items.length > this.cap) this.items.shift();
  }
  next(): T | undefined {
    return this.items.shift();
  }
  get length() {
    return this.items.length;
  }
  clear() {
    this.items = [];
  }
}

export const WALK_MS = 1200;
export const PAUSE_MS = 600;
export const TRIP_MS = WALK_MS * 2 + PAUSE_MS;

export const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export type TripPhase = "out" | "pause" | "back" | "done";
export type TripPose = {
  phase: TripPhase;
  x: number;
  y: number;
  /** Desplazamiento vertical extra (px) del balanceo al andar o del salto en la pausa. */
  bob: number;
  /** +1 mira a la derecha, -1 a la izquierda. */
  dir: 1 | -1;
};

/** Pose del robot `elapsed` ms después de salir de `home` hacia `board`, y de vuelta. */
export function tripPose(elapsed: number, home: Point, board: Point): TripPose {
  const e = Math.max(0, elapsed);
  const dx = board.x - home.x;
  const outDir: 1 | -1 = dx < 0 ? -1 : 1;
  const sway = (p: number) => (Math.floor(p * 8) % 2 === 1 ? -1 : 0); // 1 px, a saltitos
  if (e < WALK_MS) {
    const p = e / WALK_MS;
    const k = easeInOut(p);
    return { phase: "out", x: lerp(home.x, board.x, k), y: lerp(home.y, board.y, k), bob: sway(p), dir: outDir };
  }
  if (e < WALK_MS + PAUSE_MS) {
    const p = (e - WALK_MS) / PAUSE_MS;
    return { phase: "pause", x: board.x, y: board.y, bob: Math.sin(p * Math.PI * 2) > 0.5 ? -2 : 0, dir: outDir };
  }
  if (e < TRIP_MS) {
    const p = (e - WALK_MS - PAUSE_MS) / WALK_MS;
    const k = easeInOut(p);
    return { phase: "back", x: lerp(board.x, home.x, k), y: lerp(board.y, home.y, k), bob: sway(p), dir: outDir === 1 ? -1 : 1 };
  }
  return { phase: "done", x: home.x, y: home.y, bob: 0, dir: 1 };
}
