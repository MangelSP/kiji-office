// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import pkg from "../../../package.json";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), tauri: false, getVersion: vi.fn(async () => "9.9.9") }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => mocks.tauri, invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: mocks.getVersion }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

import AboutScreen, { TELEMETRY_TEXT } from "./AboutScreen";

afterEach(() => {
  cleanup();
  mocks.tauri = false;
  mocks.getVersion.mockClear();
  mocks.invoke.mockReset();
});

describe("AboutScreen", () => {
  it("en el navegador enseña la versión de package.json, autor, licencia MIT y telemetría", () => {
    render(<AboutScreen />);
    expect(screen.getByTestId("ab-version").textContent).toBe(pkg.version);
    expect(screen.getByText("Creado por Miguel Ángel Sánchez Peralta.")).toBeTruthy();
    expect(screen.getByText("Código: licencia MIT.")).toBeTruthy();
    expect(screen.getByText(TELEMETRY_TEXT)).toBeTruthy();
    expect(mocks.getVersion).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Buscar actualizaciones" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("dentro de Tauri usa getVersion()", async () => {
    mocks.tauri = true;
    render(<AboutScreen />);
    await waitFor(() => expect(screen.getByTestId("ab-version").textContent).toBe("9.9.9"));
  });

  it("muestra el registro de cambios", () => {
    render(<AboutScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Ver registro de cambios" }));
    expect(screen.getByRole("region", { name: "Registro de cambios" }).textContent).toContain("0.2d");
  });

  it("Buscar actualizaciones: versión nueva abre el diálogo", async () => {
    mocks.tauri = true;
    mocks.invoke.mockResolvedValue({ available: true, version: "0.4.0", notes: "Mejoras", date: null });
    render(<AboutScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Buscar actualizaciones" }));
    await waitFor(() => expect(screen.getByRole("dialog").textContent).toContain("0.4.0"));
    expect(mocks.invoke).toHaveBeenCalledWith("check_update");
  });

  it("Buscar actualizaciones: sin novedades o con error muestra el motivo", async () => {
    mocks.tauri = true;
    mocks.invoke.mockResolvedValueOnce(null);
    render(<AboutScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Buscar actualizaciones" }));
    await waitFor(() => expect(screen.getByText("Ya tienes la última versión.")).toBeTruthy());
    mocks.invoke.mockRejectedValueOnce("Las actualizaciones se activarán cuando se publique la primera versión.");
    fireEvent.click(screen.getByRole("button", { name: "Buscar actualizaciones" }));
    await waitFor(() => expect(screen.getByText(/se activarán cuando se publique/)).toBeTruthy());
  });
});
