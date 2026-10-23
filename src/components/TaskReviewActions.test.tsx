// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../core/client", () => ({
  core: { request: mocks.request, start: vi.fn(), onEvent: vi.fn(() => () => {}) },
  CoreError: class CoreError extends Error {
    code: string;
    constructor(e: { code: string; message: string }) {
      super(e.message);
      this.code = e.code;
    }
  },
}));

import { CoreError } from "../core/client";
import { useStore } from "../store";
import { P, resetStore } from "../store/testing";
import { STATE_LABEL } from "../screens/Agents/format";
import TaskList from "./TaskList";
import TaskReviewActions from "./TaskReviewActions";

const calls = (m: string) => mocks.request.mock.calls.filter((c) => c[0] === m);
const task = (status: string) => ({ id: "t1", title: "Login", status });

beforeEach(() => {
  mocks.request.mockReset();
  mocks.request.mockResolvedValue(null);
  resetStore();
});
afterEach(cleanup);

describe("estados en español", () => {
  it("approved, integrated, changes y blocked", () => {
    expect([STATE_LABEL.approved, STATE_LABEL.integrated, STATE_LABEL.changes, STATE_LABEL.blocked]).toEqual([
      "Aprobada", "Integrada", "Con cambios pedidos", "Bloqueada",
    ]);
  });
});

describe("TaskReviewActions", () => {
  it("no pinta nada en otros estados", () => {
    const { container } = render(<TaskReviewActions task={task("running")} />);
    expect(container.firstChild).toBeNull();
  });

  it("review: Aprobar llama a task.review approve", async () => {
    render(<TaskReviewActions task={task("review")} />);
    fireEvent.click(screen.getByRole("button", { name: "Aprobar Login" }));
    await waitFor(() => expect(calls("task.review")).toHaveLength(1));
    expect(calls("task.review")[0][1]).toEqual({ id: "t1", projectId: P, verdict: "approve" });
  });

  it("review: Pedir cambios exige hallazgos y los manda uno por línea", async () => {
    render(<TaskReviewActions task={task("review")} />);
    fireEvent.click(screen.getByRole("button", { name: "Pedir cambios en Login" }));
    const send = screen.getByRole("button", { name: "Enviar cambios" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Hallazgos para Login"), { target: { value: "falta test\n\n  revisar el estado " } });
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    await waitFor(() => expect(calls("task.review")).toHaveLength(1));
    expect(calls("task.review")[0][1]).toEqual({ id: "t1", projectId: P, verdict: "changes", findings: ["falta test", "revisar el estado"] });
  });

  it("approved: Integrar muestra el progreso mientras dura y luego se limpia", async () => {
    let done: (v: unknown) => void = () => {};
    mocks.request.mockImplementation((m: string) => (m === "integration.apply" ? new Promise((r) => (done = r)) : Promise.resolve([])));
    render(<TaskReviewActions task={task("approved")} />);
    fireEvent.click(screen.getByRole("button", { name: "Integrar Login" }));
    const progress = await screen.findByRole("status", { name: "Progreso de la integración" });
    expect(within(progress).getAllByRole("listitem").map((l) => l.textContent)).toEqual(["Rebase", "Tests", "Merge"]);
    act(() => useStore.getState().applyIntegration({ projectId: P, taskId: "t1", phase: "tests" }));
    expect(within(progress).getByText("Tests").getAttribute("aria-current")).toBe("step");
    expect(within(progress).getByText("✓ Rebase")).toBeTruthy();
    await act(async () => done({ id: "i1", projectId: P, taskId: "t1", status: "applied" }));
    await waitFor(() => expect(screen.queryByRole("status", { name: "Progreso de la integración" })).toBeNull());
  });

  it("conflicto: lista los archivos", async () => {
    mocks.request.mockRejectedValue(new CoreError({ code: "integration_conflict", message: "conflicto: src/a.ts, src/b.ts" }));
    render(<TaskReviewActions task={task("approved")} />);
    fireEvent.click(screen.getByRole("button", { name: "Integrar Login" }));
    const files = await screen.findByRole("list", { name: "Archivos en conflicto" });
    expect(within(files).getAllByRole("listitem").map((l) => l.textContent)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("tests fallidos: la salida va plegada", async () => {
    mocks.request.mockRejectedValue(new CoreError({ code: "tests_failed", message: "Tests fallaron\nFAIL login.test.ts" }));
    const { container } = render(<TaskReviewActions task={task("approved")} />);
    fireEvent.click(screen.getByRole("button", { name: "Integrar Login" }));
    await screen.findByText(/Los tests fallaron/);
    const details = container.querySelector("details")!;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain("FAIL login.test.ts");
  });

  it("repo principal sucio", async () => {
    mocks.request.mockRejectedValue(new CoreError({ code: "main_dirty", message: "el repo principal está sucio" }));
    render(<TaskReviewActions task={task("approved")} />);
    fireEvent.click(screen.getByRole("button", { name: "Integrar Login" }));
    await screen.findByText(/cambios sin guardar/);
  });

  it("integrated: Deshacer pide confirmación antes de llamar a integration.revert", async () => {
    useStore.setState({
      integrations: { [P]: [{ id: "i1", projectId: P, taskId: "t1", beforeSha: "a", afterSha: "b", status: "applied", detail: "", createdAt: 1 }] },
    });
    render(<TaskReviewActions task={task("integrated")} />);
    fireEvent.click(screen.getByRole("button", { name: "Deshacer Login" }));
    expect(calls("integration.revert")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(calls("integration.revert")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Deshacer Login" }));
    fireEvent.click(screen.getByRole("button", { name: "Sí, deshacer" }));
    await waitFor(() => expect(calls("integration.revert")).toHaveLength(1));
    expect(calls("integration.revert")[0][1]).toEqual({ integrationId: "i1", projectId: P });
  });

  it("TaskList también muestra los botones", () => {
    render(<TaskList tasks={[task("review")]} agents={[]} onStart={vi.fn()} onDiff={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Aprobar Login" })).toBeTruthy();
  });
});
