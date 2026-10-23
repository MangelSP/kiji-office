// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ request: vi.fn(), handler: null as null | ((e: { payload: unknown }) => void), tauri: true, off: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: () => mocks.tauri }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, cb: (e: { payload: unknown }) => void) => {
    if (name === "notification-clicked") mocks.handler = cb;
    return mocks.off;
  }),
}));
vi.mock("../core/client", () => ({
  core: { request: mocks.request, start: vi.fn(), onEvent: vi.fn(() => () => {}) },
  CoreError: class CoreError extends Error {},
}));

import { useStore, applyEvent } from "../store";
import { resetStore } from "../store/testing";
import NotificationBell from "./NotificationBell";

const row = (id: number, over = {}) => ({
  id, projectId: "A", level: "info" as const, title: `Aviso ${id}`, body: "texto", approvalId: null, readAt: null, createdAt: Date.now() - 120_000, ...over,
});
const proj = (id: string, name: string) => ({
  projectId: id, name, path: "/r", baseBranch: "main", testCommand: null, createdAt: 1, open: true, lastOpenedAt: 1, color: null,
  scene: "oficina" as const, liveRuns: 0, queued: 0, needsYou: 0, approvalsPending: 0, tasksByStatus: {},
});

beforeEach(() => {
  mocks.request.mockReset();
  mocks.request.mockResolvedValue(null);
  mocks.handler = null;
  mocks.tauri = true;
  resetStore(null);
  useStore.setState({ projects: [proj("A", "mi-web"), proj("B", "app-movil")], tabs: ["A", "B"] });
});
afterEach(cleanup);

describe("NotificationBell", () => {
  it("cuenta los no leídos de todos los workspaces", () => {
    useStore.setState({ notifications: [row(1), row(2, { projectId: "B" }), row(3, { readAt: 5 })] });
    render(<NotificationBell />);
    expect(screen.getByRole("button", { name: "Avisos, 2 sin leer" })).toBeTruthy();
    expect(screen.getByTestId("bell-count").textContent).toBe("2");
  });

  it("un aviso del evento notify sube el contador", () => {
    render(<NotificationBell />);
    expect(screen.queryByTestId("bell-count")).toBeNull();
    act(() => applyEvent({ type: "event", name: "notify", payload: { projectId: "B", id: 9, level: "warn", title: "Ojo", body: "x" } }));
    expect(screen.getByTestId("bell-count").textContent).toBe("1");
  });

  it("el panel enseña workspace, nivel, título, texto y antigüedad", () => {
    useStore.setState({ notifications: [row(1, { level: "ask", projectId: "B", title: "El gerente pregunta", body: "¿Sigo?" })] });
    render(<NotificationBell />);
    fireEvent.click(screen.getByRole("button", { name: /Avisos/ }));
    const item = screen.getByRole("button", { name: "El gerente pregunta, app-movil" });
    expect(item.textContent).toContain("app-movil");
    expect(item.textContent).toContain("Pregunta");
    expect(item.textContent).toContain("¿Sigo?");
    expect(item.textContent).toContain("hace 2 min");
  });

  it("clic: cambia a la pestaña del proyecto, resalta la aprobación y marca leído", async () => {
    useStore.setState({ activeProjectId: "A", notifications: [row(1, { projectId: "B", approvalId: "ap1" })] });
    render(<NotificationBell />);
    fireEvent.click(screen.getByRole("button", { name: /Avisos/ }));
    fireEvent.click(screen.getByRole("button", { name: "Aviso 1, app-movil" }));
    await waitFor(() => expect(useStore.getState().activeProjectId).toBe("B"));
    expect(useStore.getState().focusApproval).toEqual({ projectId: "B", approvalId: "ap1" });
    expect(useStore.getState().notifications[0].readAt).not.toBeNull();
  });

  it("Marcar todo como leído", async () => {
    useStore.setState({ notifications: [row(1), row(2)] });
    render(<NotificationBell />);
    fireEvent.click(screen.getByRole("button", { name: /Avisos/ }));
    fireEvent.click(screen.getByRole("button", { name: "Marcar todo como leído" }));
    await waitFor(() => expect(useStore.getState().notifications.every((n) => n.readAt != null)).toBe(true));
    expect(mocks.request.mock.calls.find((c) => c[0] === "notifications.markRead")?.[1]).toEqual({ ids: [1, 2] });
  });

  it("notification-clicked del sistema abre el proyecto (solo en Tauri)", async () => {
    useStore.setState({ activeProjectId: "A", notifications: [row(4, { projectId: "B", approvalId: "ap9" })] });
    render(<NotificationBell />);
    await waitFor(() => expect(mocks.handler).not.toBeNull());
    act(() => mocks.handler!({ payload: { projectId: "B", id: 4 } }));
    await waitFor(() => expect(useStore.getState().activeProjectId).toBe("B"));
    expect(useStore.getState().focusApproval?.approvalId).toBe("ap9");
  });

  it("fuera de Tauri no escucha nada", () => {
    mocks.tauri = false;
    render(<NotificationBell />);
    expect(mocks.handler).toBeNull();
  });
});
