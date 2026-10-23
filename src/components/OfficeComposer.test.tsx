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
const [BOSS, CLAU, NICO] = AGENTS;

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
  it("escribe al robot que se le pasa y lo dice en el placeholder", () => {
    render(<OfficeComposer agent={CLAU} />);
    expect(box().placeholder).toBe("Escríbele a Clau…");
    expect(screen.queryByRole("button", { name: "Pedido a un robot" })).toBeNull();
    expect(screen.queryByText("Objetivo para el jefe")).toBeNull();
  });

  it("Enter crea la tarea para el destinatario y la empieza", async () => {
    render(<OfficeComposer agent={NICO} />);
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

  it("con la parada global activa Enviar está desactivado y Enter no crea nada", () => {
    useStore.setState({ halted: true });
    render(<OfficeComposer agent={NICO} />);
    type("Revisa el login");
    expect((screen.getByRole("button", { name: "Enviar" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(calls("task.create")).toHaveLength(0);
    useStore.setState({ halted: false });
  });

  it("Shift+Enter no envía", () => {
    render(<OfficeComposer agent={CLAU} />);
    type("hola");
    fireEvent.keyDown(box(), { key: "Enter", shiftKey: true });
    expect(mocks.request).not.toHaveBeenCalled();
    expect(box().value).toBe("hola");
  });

  it("un pedido vacío no se envía", () => {
    render(<OfficeComposer agent={CLAU} />);
    type("   ");
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("con el robot ocupado crea la tarea sin empezarla y avisa", async () => {
    seed({ tasks: [{ id: "t0", title: "otra", status: "running", agent_id: "a2" }] });
    render(<OfficeComposer agent={CLAU} />);
    expect(box().placeholder).toBe("Clau está trabajando; tu pedido quedará en cola");
    type("Siguiente cosa");
    fireEvent.keyDown(box(), { key: "Enter" });
    await waitFor(() => expect(calls("task.create")).toHaveLength(1));
    await waitFor(() => expect(useStore.getState().notice).toContain("Clau está trabajando"));
    expect(calls("task.start")).toHaveLength(0);
  });

  it("el botón Archivos despliega el campo y los archivos viajan en la tarea", async () => {
    render(<OfficeComposer agent={CLAU} />);
    expect(screen.queryByLabelText(/Archivos que puede modificar/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Archivos" }));
    fireEvent.change(screen.getByLabelText(/Archivos que puede modificar/), { target: { value: "src/a.ts, src/b.ts" } });
    type("Cambia A");
    fireEvent.keyDown(box(), { key: "Enter" });
    await waitFor(() => expect(calls("task.create")).toHaveLength(1));
    expect(calls("task.create")[0][1]).toMatchObject({ projectId: "p1", files: ["src/a.ts", "src/b.ts"] });
  });

  it("guarda un borrador por robot", () => {
    const { rerender } = render(<OfficeComposer agent={CLAU} />);
    type("para Clau");
    rerender(<OfficeComposer agent={NICO} />);
    expect(box().value).toBe("");
    type("para Nico");
    rerender(<OfficeComposer agent={CLAU} />);
    expect(box().value).toBe("para Clau");
    expect(proj().drafts.a3.request).toBe("para Nico");
  });

  it("si la tarea no se pudo crear conserva el borrador", async () => {
    mocks.request.mockRejectedValue(new Error("no hay un proyecto abierto"));
    render(<OfficeComposer agent={CLAU} />);
    type("algo");
    fireEvent.keyDown(box(), { key: "Enter" });
    await waitFor(() => expect(useStore.getState().notice).toContain("no hay un proyecto abierto"));
    expect(box().value).toBe("algo");
  });

  it("inputRef da acceso al campo para enfocarlo desde fuera", () => {
    const ref = { current: null as HTMLTextAreaElement | null };
    render(<OfficeComposer agent={CLAU} inputRef={ref} />);
    expect(ref.current).toBe(box());
  });
});

describe("Objetivo para el jefe", () => {
  it("con el jefe el pedido es un objetivo: Enter llama a objective.create sin crear tarea", async () => {
    render(<OfficeComposer agent={BOSS} />);
    expect(screen.getByText("Objetivo para el jefe")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Archivos" })).toBeNull();
    expect(box().placeholder).toMatch(/qué quieres conseguir/);
    type("Renovar el flujo de pago");
    fireEvent.keyDown(box(), { key: "Enter" });
    await waitFor(() => expect(calls("objective.create")).toHaveLength(1));
    expect(calls("objective.create")[0][1]).toEqual({ projectId: "p1", text: "Renovar el flujo de pago" });
    expect(calls("task.create")).toHaveLength(0);
    await waitFor(() => expect(box().value).toBe(""));
  });

  it("el borrador del objetivo es independiente del de los robots", () => {
    const { rerender } = render(<OfficeComposer agent={CLAU} />);
    type("para Clau");
    rerender(<OfficeComposer agent={BOSS} />);
    expect(box().value).toBe("");
    type("meta");
    rerender(<OfficeComposer agent={CLAU} />);
    expect(box().value).toBe("para Clau");
  });

  it("si el core aún no tiene objective.create deja el borrador y avisa", async () => {
    mocks.request.mockRejectedValue(Object.assign(new Error("x"), { code: "unknown_method" }));
    render(<OfficeComposer agent={BOSS} />);
    type("meta");
    fireEvent.keyDown(box(), { key: "Enter" });
    await waitFor(() => expect(useStore.getState().notice).toContain("objective.create"));
    expect(box().value).toBe("meta");
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
