// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), handler: null as null | (() => void) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, isTauri: () => true }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_name: string, cb: () => void) => {
    mocks.handler = cb;
    return () => {};
  }),
}));
vi.mock("../core/client", () => ({
  core: { request: vi.fn(), start: vi.fn(), onEvent: vi.fn(() => () => {}) },
  CoreError: class CoreError extends Error {},
}));

import { resetStore, seed } from "../store/testing";
import CloseGuard from "./CloseGuard";

const calls = () => mocks.invoke.mock.calls.map((c) => c[0]);

async function requestClose() {
  await waitFor(() => expect(mocks.handler).not.toBeNull());
  act(() => mocks.handler!());
}

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.invoke.mockResolvedValue(undefined);
  mocks.handler = null;
  resetStore();
  seed({ agents: [{ id: "a2", name: "Clau", status: "idle" }] });
});
afterEach(cleanup);

describe("CloseGuard", () => {
  it("sin trabajo no muestra diálogo y sale", async () => {
    seed({ tasks: [{ id: "t1", title: "x", status: "review" }] });
    render(<CloseGuard />);
    await requestClose();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(calls()).toContain("app_close_ack");
    expect(calls()).toContain("app_quit");
  });

  it("con trabajo muestra los nombres y avisa a la bandeja", async () => {
    seed({ tasks: [{ id: "t1", title: "Arreglar login", status: "running", agent_id: "a2" }] });
    render(<CloseGuard />);
    await requestClose();
    expect(screen.getByRole("alertdialog").textContent).toContain("Hay 1 robot trabajando (Clau: «Arreglar login»)");
    expect(mocks.invoke).toHaveBeenCalledWith("tray_set_busy", { count: 1 });
    expect(calls()).not.toContain("app_quit");
  });

  it("una aprobación pendiente cuenta como trabajo", async () => {
    seed({ approvals: [{ id: "p1" }] });
    render(<CloseGuard />);
    await requestClose();
    expect(screen.getByRole("alertdialog")).toBeTruthy();
  });

  it("cuenta el trabajo de TODOS los workspaces, también los de segundo plano", async () => {
    seed({ tasks: [{ id: "t9", title: "Migrar", status: "running", agent_id: "b1" }], agents: [{ id: "b1", name: "Ana" }] }, "p2");
    seed({ approvals: [{ id: "q1" }] }, "p2");
    // La pestaña visible (p1) está ociosa: el aviso sale por el trabajo de p2.
    render(<CloseGuard />);
    await requestClose();
    const text = screen.getByRole("alertdialog").textContent;
    expect(text).toContain("Hay 1 robot trabajando");
    expect(text).toContain("Ana: «Migrar»");
    expect(text).toContain("1 aprobación pendiente");
    expect(mocks.invoke).toHaveBeenCalledWith("tray_set_busy", { count: 1 });
  });

  const working = { tasks: [{ id: "t1", title: "T", status: "needs_you", agent_id: "a2" }] };

  it.each([
    ["Seguir en segundo plano", "app_hide"],
    ["Detener todo y salir", "app_quit"],
  ])("«%s» llama a %s", async (label, cmd) => {
    seed(working as never);
    render(<CloseGuard />);
    await requestClose();
    fireEvent.click(screen.getByRole("button", { name: label }));
    expect(calls()).toContain(cmd);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("Cancelar cierra el diálogo sin ocultar ni salir", async () => {
    seed(working as never);
    render(<CloseGuard />);
    await requestClose();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(calls()).not.toContain("app_hide");
    expect(calls()).not.toContain("app_quit");
  });
});
