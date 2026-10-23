import { describe, expect, it } from "vitest";
import {
  BOARD_COLUMNS, columnFromStatus, columnOfTask, countByColumn, MoveQueue, nextColumn, PAUSE_MS, TRIP_MS, tripPose,
  visibleNotes, WALK_MS,
} from "./boardLogic";

describe("columnas", () => {
  it("son 10, en el orden del plan", () => {
    expect(BOARD_COLUMNS).toHaveLength(10);
    expect(BOARD_COLUMNS[0]).toBe("refinement");
    expect(BOARD_COLUMNS[9]).toBe("done_prod");
  });
  it("deriva la columna del estado si no hay board_column", () => {
    expect(columnFromStatus("todo", false)).toBe("refinement");
    expect(columnFromStatus("todo", true)).toBe("refined");
    expect(columnFromStatus("running", true)).toBe("doing_dev");
    expect(columnFromStatus("review", true)).toBe("committed");
    expect(columnFromStatus("approved", true)).toBe("functional");
    expect(columnFromStatus("integrated", true)).toBe("done");
    expect(columnFromStatus("raro", true)).toBe("refinement");
  });
  it("board_column manda sobre el estado", () => {
    expect(columnOfTask({ id: 1, status: "running", board_column: "bug" })).toBe("bug");
    expect(columnOfTask({ id: 1, status: "running", agent_id: "a" })).toBe("doing_dev");
  });
  it("el mapeo de demo avanza una columna y da la vuelta", () => {
    expect(nextColumn("refinement")).toBe("refined");
    expect(nextColumn("done")).toBe("done_prod");
    expect(nextColumn("done_prod")).toBe("refinement");
  });
});

describe("conteo", () => {
  const tasks = [
    { id: "a", status: "running", agent_id: "x" },
    { id: "b", status: "running", agent_id: "x" },
    { id: "c", status: "review", agent_id: "x", board_column: "bug" as const },
  ];
  it("cuenta por columna", () => {
    const c = countByColumn(tasks);
    expect(c.doing_dev).toBe(2);
    expect(c.bug).toBe(1);
    expect(c.committed).toBe(0);
  });
  it("hold mantiene la tarea en su columna de origen", () => {
    const c = countByColumn(tasks, new Map([["a", "refined" as const]]));
    expect(c.doing_dev).toBe(1);
    expect(c.refined).toBe(1);
  });
  it("máx. 4 notas visibles y el resto como número", () => {
    expect(visibleNotes(0)).toEqual({ shown: 0, extra: 0 });
    expect(visibleNotes(4)).toEqual({ shown: 4, extra: 0 });
    expect(visibleNotes(7)).toEqual({ shown: 4, extra: 3 });
  });
});

describe("MoveQueue", () => {
  it("es FIFO y con tope", () => {
    const q = new MoveQueue<number>(2);
    q.push(1);
    q.push(2);
    q.push(3);
    expect(q.length).toBe(2);
    expect(q.next()).toBe(2);
    expect(q.next()).toBe(3);
    expect(q.next()).toBeUndefined();
  });
});

describe("tripPose", () => {
  const home = { x: 100, y: 110 };
  const board = { x: 200, y: 90 };
  it("sale de casa, llega a la pizarra, pausa y vuelve", () => {
    expect(tripPose(0, home, board)).toMatchObject({ phase: "out", x: 100, y: 110, dir: 1 });
    const mid = tripPose(WALK_MS / 2, home, board);
    expect(mid.x).toBeCloseTo(150);
    expect(mid.y).toBeCloseTo(100);
    expect(tripPose(WALK_MS, home, board)).toMatchObject({ phase: "pause", x: 200, y: 90 });
    expect(tripPose(WALK_MS + PAUSE_MS, home, board)).toMatchObject({ phase: "back", x: 200, y: 90, dir: -1 });
    expect(tripPose(TRIP_MS, home, board)).toMatchObject({ phase: "done", x: 100, y: 110 });
  });
  it("el easing es suave: más lento al principio que lineal", () => {
    expect(tripPose(WALK_MS * 0.25, home, board).x).toBeLessThan(125);
  });
  it("voltea hacia el lado al que camina", () => {
    expect(tripPose(10, { x: 300, y: 110 }, board).dir).toBe(-1);
    expect(tripPose(WALK_MS + PAUSE_MS + 10, { x: 300, y: 110 }, board).dir).toBe(1);
  });
  it("el balanceo es de 1 px como mucho al andar", () => {
    for (let t = 0; t < WALK_MS; t += 37) expect(Math.abs(tripPose(t, home, board).bob)).toBeLessThanOrEqual(1);
  });
});
