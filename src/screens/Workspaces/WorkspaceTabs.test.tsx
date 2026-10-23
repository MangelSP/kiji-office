// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectListItem } from "../../../shared/protocol";

const mocks = vi.hoisted(() => ({ request: vi.fn(), pick: vi.fn() }));
vi.mock("../../core/client", () => ({
  core: { request: mocks.request, start: vi.fn(), onEvent: vi.fn(() => () => {}) },
  CoreError: class CoreError extends Error {},
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.pick }));

import { useStore } from "../../store";
import { resetStore } from "../../store/testing";
import WorkspaceTabs from "./WorkspaceTabs";

const item = (id: string, over: Partial<ProjectListItem> = {}): ProjectListItem => ({
  projectId: id, name: `proy-${id}`, path: `/r/${id}`, baseBranch: "main", testCommand: null, createdAt: 1, open: true, lastOpenedAt: 1,
  color: "#5aa9f0", scene: "oficina", liveRuns: 0, queued: 0, needsYou: 0, approvalsPending: 0, tasksByStatus: {}, ...over,
});

function setup(projects: ProjectListItem[], active: string | null = null) {
  useStore.setState({ projects, tabs: projects.filter((p) => p.open).map((p) => p.projectId), activeProjectId: active });
}

beforeEach(() => {
  mocks.request.mockReset();
  mocks.request.mockResolvedValue(null);
  mocks.pick.mockReset();
  resetStore(null);
});
afterEach(cleanup);

const tab = (name: RegExp | string) => screen.getByRole("tab", { name });

describe("WorkspaceTabs", () => {
  it("muestra Home y una pestaña por workspace abierto (los cerrados no)", () => {
    setup([item("A"), item("B"), item("C", { open: false })]);
    render(<WorkspaceTabs />);
    const tabs = within(screen.getByRole("tablist")).getAllByRole("tab");
    expect(tabs.map((t) => t.textContent?.trim())).toEqual(["⌂ Home", "proy-A", "proy-B"]);
    expect(tab(/Home/).getAttribute("aria-selected")).toBe("true");
  });

  it("clic en una pestaña cambia el workspace activo y Home vuelve al dashboard", () => {
    setup([item("A"), item("B")]);
    render(<WorkspaceTabs />);
    fireEvent.click(tab("proy-B"));
    expect(useStore.getState().activeProjectId).toBe("B");
    expect(tab("proy-B").getAttribute("aria-selected")).toBe("true");
    fireEvent.click(tab(/Home/));
    expect(useStore.getState().activeProjectId).toBeNull();
  });

  it("insignias: te necesitan, runs vivos, en cola y límite", () => {
    setup([item("A", { approvalsPending: 2, liveRuns: 3, queued: 1, tasksByStatus: { paused_limit: 1 } }), item("B")]);
    const { container } = render(<WorkspaceTabs />);
    const a = tab(/^proy-A/);
    expect(a.getAttribute("aria-label")).toBe("proy-A, 2 te necesitan, 3 en marcha, 1 en cola, límite");
    expect(a.querySelector('[data-badge="needs"]')?.textContent).toBe("✋ 2");
    expect(a.querySelector('[data-badge="runs"]')?.textContent).toBe("⚙ 3");
    expect(a.querySelector('[data-badge="queued"]')?.textContent).toBe("⏳ 1");
    expect(a.querySelector('[data-badge="limit"]')?.textContent).toBe("⚡");
    // La otra pestaña no lleva ninguna.
    expect(tab("proy-B").querySelector("[data-badge]")).toBeNull();
    expect(container.querySelectorAll("[data-badge]")).toHaveLength(4);
  });

  it("⚡ también aparece si una tarea espera por el tope de gasto", () => {
    setup([item("A")]);
    useStore.getState().applyQueue({ projectId: "A", taskId: "t1", queued: true, position: 1, blockedBy: "budget" });
    render(<WorkspaceTabs />);
    expect(tab(/^proy-A/).querySelector('[data-badge="limit"]')).not.toBeNull();
  });

  it("× cierra directamente un workspace sin runs vivos", async () => {
    setup([item("A"), item("B")], "A");
    render(<WorkspaceTabs />);
    fireEvent.click(screen.getByRole("button", { name: "Cerrar proy-A" }));
    await waitFor(() => expect(mocks.request).toHaveBeenCalledWith("project.close", { projectId: "A" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("× con runs vivos pide confirmación: Cancelar no cierra, «Detener y cerrar» usa force", async () => {
    setup([item("A", { liveRuns: 2 })], "A");
    render(<WorkspaceTabs />);
    fireEvent.click(screen.getByRole("button", { name: "Cerrar proy-A" }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("2 runs en marcha");
    expect(mocks.request).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(mocks.request).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Cerrar proy-A" }));
    fireEvent.click(screen.getByRole("button", { name: "Detener y cerrar" }));
    await waitFor(() => expect(mocks.request).toHaveBeenCalledWith("project.close", { projectId: "A", force: true }));
  });

  it("«+» abre el selector de carpeta y manda project.open", async () => {
    setup([item("A")]);
    mocks.pick.mockResolvedValue("/r/nuevo");
    mocks.request.mockImplementation(async (m: string) => (m === "project.open" ? { id: "N" } : m === "project.list" ? [item("A"), item("N")] : []));
    render(<WorkspaceTabs />);
    fireEvent.click(screen.getByRole("button", { name: "Abrir proyecto" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Abrir carpeta…" }));
    await waitFor(() => expect(mocks.request).toHaveBeenCalledWith("project.open", { path: "/r/nuevo" }));
    await waitFor(() => expect(useStore.getState().activeProjectId).toBe("N"));
  });

  it("«+» lista los Recientes (cerrados) y «Abrir» reabre por su ruta", async () => {
    setup([item("A"), item("Z", { open: false, name: "viejo" })]);
    mocks.request.mockImplementation(async (m: string) => (m === "project.open" ? { id: "Z" } : m === "project.list" ? [item("A"), item("Z")] : []));
    render(<WorkspaceTabs />);
    fireEvent.click(screen.getByRole("button", { name: "Abrir proyecto" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Abrir viejo" }));
    await waitFor(() => expect(mocks.request).toHaveBeenCalledWith("project.open", { path: "/r/Z" }));
    await waitFor(() => expect(useStore.getState().activeProjectId).toBe("Z"));
  });
});
