// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, isTauri: () => true }));
vi.mock("../core/client", () => ({
  core: { request: vi.fn(), start: vi.fn(), onEvent: vi.fn(() => () => {}) },
  CoreError: class CoreError extends Error {},
}));

import { resetStore, seed } from "../store/testing";
import { useStore } from "../store";
import UpdateDialog, { LAST_CHECK_KEY, UpdateAutoCheck, shouldAutoCheck } from "./UpdateDialog";

const update = { available: true, version: "0.4.0", notes: "Novedades", date: null };
const install = () => screen.getByRole("button", { name: /Instalar y reiniciar/ }) as HTMLButtonElement;

beforeEach(() => {
  mocks.invoke.mockReset();
  localStorage.clear();
  resetStore();
});
afterEach(cleanup);

describe("UpdateDialog", () => {
  it("muestra versión y notas e instala si no hay trabajo", async () => {
    mocks.invoke.mockResolvedValue(undefined);
    render(<UpdateDialog update={update} onClose={() => {}} />);
    expect(screen.getByRole("dialog").textContent).toContain("0.4.0");
    expect(screen.getByText("Novedades")).toBeTruthy();
    fireEvent.click(install());
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("install_update"));
  });

  it("con robots trabajando o aprobaciones pendientes desactiva instalar y lo explica", () => {
    seed({ agents: [{ id: "a1", name: "Clau", status: "idle" }], tasks: [{ id: "t1", title: "x", status: "running", agent_id: "a1" }] });
    render(<UpdateDialog update={update} onClose={() => {}} />);
    expect(install().disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toContain("1 robot trabajando");
    cleanup();
    resetStore();
    seed({ approvals: [{ id: "p1" }] });
    render(<UpdateDialog update={update} onClose={() => {}} />);
    expect(install().disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toContain("1 aprobación pendiente");
  });

  it("«Más tarde» cierra y un fallo de instalación se muestra", async () => {
    const onClose = vi.fn();
    mocks.invoke.mockRejectedValue("No se pudo instalar: x");
    render(<UpdateDialog update={update} onClose={onClose} />);
    fireEvent.click(install());
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("No se pudo instalar"));
    fireEvent.click(screen.getByRole("button", { name: "Más tarde" }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("comprobación automática", () => {
  it("una vez al día: avisa con la versión y no repite", async () => {
    mocks.invoke.mockResolvedValue(update);
    render(<UpdateAutoCheck />);
    await waitFor(() => expect(useStore.getState().notice).toContain("0.4.0"));
    expect(localStorage.getItem(LAST_CHECK_KEY)).not.toBeNull();
    expect(shouldAutoCheck()).toBe(false);
    cleanup();
    mocks.invoke.mockClear();
    render(<UpdateAutoCheck />);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("error de la comprobación: en silencio; localStorage roto no revienta", async () => {
    mocks.invoke.mockRejectedValue("sin publicar");
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denegado");
    });
    expect(shouldAutoCheck()).toBe(true);
    render(<UpdateAutoCheck />);
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("check_update"));
    expect(useStore.getState().notice).toBeNull();
    spy.mockRestore();
  });
});
