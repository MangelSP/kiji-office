// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), handler: null as null | (() => void) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
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

import { useStore } from "../store";
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
  useStore.setState({
    agents: [{ id: "a2", name: "Clau", status: "idle" }],
    tasks: [],
    approvals: [],
  } as never);
});
afterEach(cleanup);

describe("CloseGuard", () => {
  it("sin trabajo no muestra diálogo y sale", async () => {
    useStore.setState({ tasks: [{ id: "t1", title: "x", status: "review" }] } as never);
    render(<CloseGuard />);
    await requestClose();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(calls()).toContain("app_close_ack");
    expect(calls()).toContain("app_quit");
  });

  it("con trabajo muestra los nombres y avisa a la bandeja", async () => {
    useStore.setState({
      tasks: [{ id: "t1", title: "Arreglar login", status: "running", agent_id: "a2" }],
    } as never);
    render(<CloseGuard />);
    await requestClose();
    expect(screen.getByRole("alertdialog").textContent).toContain("Hay 1 robot trabajando (Clau: «Arreglar login»)");
    expect(mocks.invoke).toHaveBeenCalledWith("tray_set_busy", { count: 1 });
    expect(calls()).not.toContain("app_quit");
  });

  it("una aprobación pendiente cuenta como trabajo", async () => {
    useStore.setState({ approvals: [{ id: "p1" }] } as never);
    render(<CloseGuard />);
    await requestClose();
    expect(screen.getByRole("alertdialog")).toBeTruthy();
  });

  const working = { tasks: [{ id: "t1", title: "T", status: "needs_you", agent_id: "a2" }] };

  it.each([
    ["Seguir en segundo plano", "app_hide"],
    ["Detener todo y salir", "app_quit"],
  ])("«%s» llama a %s", async (label, cmd) => {
    useStore.setState(working as never);
    render(<CloseGuard />);
    await requestClose();
    fireEvent.click(screen.getByRole("button", { name: label }));
    expect(calls()).toContain(cmd);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("Cancelar cierra el diálogo sin ocultar ni salir", async () => {
    useStore.setState(working as never);
    render(<CloseGuard />);
    await requestClose();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(calls()).not.toContain("app_hide");
    expect(calls()).not.toContain("app_quit");
  });
});
