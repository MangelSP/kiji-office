// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import TaskList, { accessLabel } from "./TaskList";
import { useStore } from "../store";
import type { Task } from "../store/tasks";

afterEach(cleanup);

const AGENTS = [{ id: "a2", name: "Clau", provider: "claude" }];
const base: Task = { id: "t1", title: "Revisar", status: "review", agent_id: "a2" };
const show = (tasks: Task[]) =>
  render(<TaskList tasks={tasks} agents={AGENTS} onStart={vi.fn()} onDiff={vi.fn()} />);

describe("accessLabel", () => {
  it("solo lectura, singular y plural", () => {
    expect(accessLabel({ ...base, read_only: true, files: [] })).toBe("Solo lectura");
    expect(accessLabel({ ...base, files: [] })).toBe("Solo lectura");
    expect(accessLabel({ ...base, files: ["a"] })).toBe("Modifica 1 archivo");
    expect(accessLabel({ ...base, files: ["a", "b"] })).toBe("Modifica 2 archivos");
    expect(accessLabel(base)).toBeUndefined();
  });
});

describe("TaskList", () => {
  it("con la parada global activa, Iniciar está desactivado", () => {
    useStore.setState({ halted: true });
    show([{ ...base, status: "todo" }]);
    expect((screen.getByRole("button", { name: "Iniciar tarea Revisar" }) as HTMLButtonElement).disabled).toBe(true);
    useStore.setState({ halted: false });
  });

  it("muestra la respuesta corta con su autor y la etiqueta Solo lectura, sin botón de diff", () => {
    show([{ ...base, read_only: true, files: [], result: "Es una app.\nTiene tres módulos." }]);
    expect(screen.getByText("Solo lectura")).toBeTruthy();
    expect(screen.getByText("Respuesta de Clau:")).toBeTruthy();
    expect(screen.getByLabelText("Respuesta de Revisar").textContent).toBe("Es una app.\nTiene tres módulos.");
    expect(screen.queryByRole("button", { name: "Ver diff" })).toBeNull();
  });

  it("una respuesta larga va en un desplegable cerrado", () => {
    const { container } = show([{ ...base, files: ["a.ts", "b.ts"], result: "x".repeat(2000) }]);
    expect(screen.getByText("Modifica 2 archivos")).toBeTruthy();
    const details = container.querySelector("details")!;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain("Respuesta de Clau:");
    expect(screen.getByRole("button", { name: "Ver diff" })).toBeTruthy();
  });

  it("sin result no hay bloque de respuesta", () => {
    show([{ ...base, status: "assigned", files: ["a.ts"] }]);
    expect(screen.queryByText(/Respuesta/)).toBeNull();
  });
});
