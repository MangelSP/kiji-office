// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

import { useStore } from "../store";
import { proj, resetStore, seed } from "../store/testing";
import OfficeComposer, { isBusy } from "./OfficeComposer";

const AGENTS = [
  { id: "a1", name: "Jefe", is_boss: 1, status: "idle" },
  { id: "a2", name: "Clau", status: "idle" },
  { id: "a3", name: "Nico", status: "idle" },
];

beforeEach(() => {
  mocks.request.mockReset();
  mocks.request.mockImplementation(async (method: string) =>
    method === "task.create" ? { id: "t1", title: "x", status: "assigned" } : null,
  );
  resetStore();
  seed({ agents: AGENTS });
});
afterEach(cleanup);

const box = () => screen.getByLabelText("Tu pedido") as HTMLTextAreaElement;
const type = (text: string) => fireEvent.change(box(), { target: { value: text } });
const calls = (method: string) => mocks.request.mock.calls.filter((c) => c[0] === method);

describe("OfficeComposer", () => {
  it("solo ofrece chips de los robots trabajadores y elige el primero por defecto", () => {
    render(<OfficeComposer selectedId={null} onSelect={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Jefe" })).toBeNull();
    expect(screen.getByRole("button", { name: "Clau" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Nico" }).getAttribute("aria-pressed")).toBe("false");
    expect(box().placeholder).toBe("Pídele algo a Clau…");
  });

  it("sigue al robot seleccionado en la escena y el clic en un chip avisa", () => {
    const onSelect = vi.fn();
    render(<OfficeComposer selectedId="a3" onSelect={onSelect} />);
    expect(screen.getByRole("button", { name: "Nico" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Clau" }));
    expect(onSelect).toHaveBeenCalledWith("a2");
  });

  it("Enter crea la tarea para el destinatario y la empieza", async () => {
    render(<OfficeComposer selectedId="a3" onSelect={vi.fn()} />);
    type("Revisa el login\nsin tocar nada");
    fireEvent.keyDown(box(), { key: "Enter" });
    await waitFor(() => expect(calls("task.start")).toHaveLength(1));
    expect(calls("task.create")[0][1]).toEqual({
      projectId: "p1",
      title: "Revisa el login",
      description: "Revisa el login\nsin tocar nada",
      files: [],
      agent_id: "a3",
    });
    expect(calls("task.start")[0][1]).toEqual({ id: "t1", projectId: "p1" });
    expect(box().value).toBe("");
  });

  it("Shift+Enter no envía", () => {
    render(<OfficeComposer selectedId={null} onSelect={vi.fn()} />);
    type("hola");
    fireEvent.keyDown(box(), { key: "Enter", shiftKey: true });
    expect(mocks.request).not.toHaveBeenCalled();
    expect(box().value).toBe("hola");
  });

  it("un pedido vacío no se envía", () => {
    render(<OfficeComposer selectedId={null} onSelect={vi.fn()} />);
    type("   ");
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("con el robot ocupado crea la tarea sin empezarla y avisa", async () => {
    seed({ tasks: [{ id: "t0", title: "otra", status: "running", agent_id: "a2" }] });
    render(<OfficeComposer selectedId="a2" onSelect={vi.fn()} />);
    expect(box().placeholder).toBe("Clau está trabajando; tu pedido quedará en cola");
    type("Siguiente cosa");
    fireEvent.keyDown(box(), { key: "Enter" });
    await waitFor(() => expect(calls("task.create")).toHaveLength(1));
    await waitFor(() => expect(useStore.getState().notice).toContain("Clau está trabajando"));
    expect(calls("task.start")).toHaveLength(0);
  });

  it("el botón Archivos despliega el campo y los archivos viajan en la tarea", async () => {
    render(<OfficeComposer selectedId="a2" onSelect={vi.fn()} />);
    expect(screen.queryByLabelText(/Archivos que puede modificar/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Archivos" }));
    fireEvent.change(screen.getByLabelText(/Archivos que puede modificar/), { target: { value: "src/a.ts, src/b.ts" } });
    type("Cambia A");
    fireEvent.keyDown(box(), { key: "Enter" });
    await waitFor(() => expect(calls("task.create")).toHaveLength(1));
    expect(calls("task.create")[0][1]).toMatchObject({ projectId: "p1", files: ["src/a.ts", "src/b.ts"] });
  });

  it("guarda un borrador por robot", () => {
    const { rerender } = render(<OfficeComposer selectedId="a2" onSelect={vi.fn()} />);
    type("para Clau");
    rerender(<OfficeComposer selectedId="a3" onSelect={vi.fn()} />);
    expect(box().value).toBe("");
    type("para Nico");
    rerender(<OfficeComposer selectedId="a2" onSelect={vi.fn()} />);
    expect(box().value).toBe("para Clau");
    expect(proj().drafts.a3.request).toBe("para Nico");
  });

  it("si la tarea no se pudo crear conserva el borrador", async () => {
    mocks.request.mockRejectedValue(new Error("no hay un proyecto abierto"));
    render(<OfficeComposer selectedId="a2" onSelect={vi.fn()} />);
    type("algo");
    fireEvent.keyDown(box(), { key: "Enter" });
    await waitFor(() => expect(useStore.getState().notice).toContain("no hay un proyecto abierto"));
    expect(box().value).toBe("algo");
  });

  it("sin robots trabajadores el campo está desactivado", () => {
    seed({ agents: [AGENTS[0]] });
    render(<OfficeComposer selectedId={null} onSelect={vi.fn()} />);
    expect(box().disabled).toBe(true);
  });
});

describe("isBusy", () => {
  it("ocupado por estado del robot o por tarea en curso", () => {
    expect(isBusy({ id: "a", status: "thinking" }, [])).toBe(true);
    expect(isBusy({ id: "a", status: "idle" }, [{ agent_id: "a", status: "needs_you" }])).toBe(true);
    expect(isBusy({ id: "a", status: "done" }, [{ agent_id: "a", status: "review" }])).toBe(false);
    expect(isBusy({ id: "a" }, [{ agent_id: "b", status: "running" }])).toBe(false);
  });
});
