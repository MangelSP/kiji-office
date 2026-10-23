// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { core } from "../../core/client";
import { useStore } from "../../store";
import { BOARD_COLUMNS, canMoveTo, columnOf } from "../../store/board";
import { P, proj, resetStore, seed } from "../../store/testing";
import BoardView from "./BoardView";

const AGENTS = [
  { id: "a1", name: "Ana", color: "azul", model: "sonnet" },
  { id: "a2", name: "Nico", color: "verde" },
];
const TASKS = [
  { id: "t1", title: "Login", status: "running", agent_id: "a1", board_column: "doing_dev", board_manual: 0, board_flag: null, cost_usd: 0.5 },
  { id: "t2", title: "Estilos", status: "integrated", agent_id: "a2", board_column: "done", board_manual: 0, board_flag: null },
  { id: "t3", title: "Rutas", status: "blocked", agent_id: "a2", board_column: "refined", board_manual: 1, board_flag: "blocked" },
];

const col = (id: string) => document.querySelector<HTMLElement>(`[data-column="${id}"]`)!;
const column = (id: string) => (proj().tasks as { id: string; board_column?: string }[]).find((t) => t.id === id)?.board_column;
let request: ReturnType<typeof vi.fn>;

function show() {
  return render(<BoardView onOpenTask={vi.fn()} onClose={vi.fn()} />);
}

beforeEach(() => {
  resetStore();
  seed({ agents: AGENTS, tasks: TASKS as never });
  request = vi.fn().mockResolvedValue({});
  vi.spyOn(core, "request").mockImplementation(request as never);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("BoardView", () => {
  it("dibuja las 10 columnas con su conteo y la marca de la tarjeta", () => {
    show();
    expect(document.querySelectorAll("[data-column]").length).toBe(10);
    expect(col("doing_dev").getAttribute("aria-label")).toBe("Doing (Dev), 1");
    expect(col("bug").getAttribute("aria-label")).toBe("Bug, 0");
    expect(within(col("refined")).getByRole("img", { name: "Bloqueada" })).toBeTruthy();
    expect(within(col("refined")).getByText("manual")).toBeTruthy();
    expect(within(col("doing_dev")).getByText("auto")).toBeTruthy();
    expect(within(col("doing_dev")).getByText("$0,500")).toBeTruthy();
  });

  it("deriva la columna desde el estado si el core aún no la manda", () => {
    expect(columnOf({ id: "x", title: "x", status: "review" })).toBe("committed");
    expect(columnOf({ id: "x", title: "x", status: "todo" })).toBe("refinement");
  });

  it("arrastrar a otra columna llama a board.move", async () => {
    show();
    const card = screen.getByLabelText("Tarea Login");
    const data: Record<string, string> = {};
    const dataTransfer = { setData: (k: string, v: string) => (data[k] = v), getData: (k: string) => data[k], effectAllowed: "", dropEffect: "" };
    fireEvent.dragStart(card, { dataTransfer });
    fireEvent.dragOver(col("committed"), { dataTransfer });
    fireEvent.drop(col("committed"), { dataTransfer });
    await waitFor(() => expect(request).toHaveBeenCalledWith("board.move", { taskId: "t1", projectId: P, column: "committed" }));
    expect(column("t1")).toBe("committed");
  });

  it("con el teclado, flecha derecha mueve y anuncia", async () => {
    show();
    fireEvent.keyDown(screen.getByLabelText("Tarea Login"), { key: "ArrowRight" });
    await waitFor(() => expect(request).toHaveBeenCalledWith("board.move", { taskId: "t1", projectId: P, column: "committed" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Movida a Committed"));
    fireEvent.keyDown(screen.getByLabelText("Tarea Login"), { key: "ArrowLeft" });
    await waitFor(() => expect(column("t1")).toBe("doing_dev"));
  });

  it("done_prod solo se acepta desde done", async () => {
    expect(canMoveTo("done", "done_prod")).toBe(true);
    expect(canMoveTo("fix", "done_prod")).toBe(false);
    show();
    const dataTransfer = { setData: vi.fn(), getData: () => "t1", effectAllowed: "", dropEffect: "" };
    fireEvent.dragStart(screen.getByLabelText("Tarea Login"), { dataTransfer });
    fireEvent.dragOver(col("done_prod"), { dataTransfer });
    expect(col("done_prod").className).toContain("is-invalid");
    fireEvent.drop(col("done_prod"), { dataTransfer });
    expect(request).not.toHaveBeenCalled();
    expect(column("t1")).toBe("doing_dev");
    // Desde Done sí.
    fireEvent.keyDown(screen.getByLabelText("Tarea Estilos"), { key: "ArrowRight" });
    await waitFor(() => expect(request).toHaveBeenCalledWith("board.move", { taskId: "t2", projectId: P, column: "done_prod" }));
  });

  it("si board.move falla, la tarjeta vuelve a su columna y se avisa", async () => {
    request.mockRejectedValue(new Error("no se pudo"));
    show();
    fireEvent.keyDown(screen.getByLabelText("Tarea Login"), { key: "ArrowRight" });
    await waitFor(() => expect(useStore.getState().notice).toContain("board.move"));
    expect(column("t1")).toBe("doing_dev");
    expect((proj().tasks[0] as { board_manual?: number }).board_manual).toBe(0);
  });

  it("filtra por robot y oculta Done producción", () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "Ana" }));
    expect(screen.queryByLabelText("Tarea Estilos")).toBeNull();
    expect(screen.getByLabelText("Tarea Login")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Ocultar Done producción"));
    expect(col("done_prod")).toBeNull();
    expect(BOARD_COLUMNS.length).toBe(10);
  });
});
