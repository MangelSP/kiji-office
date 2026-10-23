// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import pkg from "../../../package.json";

const mocks = vi.hoisted(() => ({ tauri: false, getVersion: vi.fn(async () => "9.9.9") }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => mocks.tauri }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: mocks.getVersion }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

import AboutScreen, { TELEMETRY_TEXT } from "./AboutScreen";

afterEach(() => {
  cleanup();
  mocks.tauri = false;
  mocks.getVersion.mockClear();
});

describe("AboutScreen", () => {
  it("en el navegador enseña la versión de package.json, licencia pendiente y telemetría", () => {
    render(<AboutScreen />);
    expect(screen.getByTestId("ab-version").textContent).toBe(pkg.version);
    expect(screen.getByText("Licencia: pendiente")).toBeTruthy();
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
});
