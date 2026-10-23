// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingSpec } from "../../../shared/protocol";

const mocks = vi.hoisted(() => ({ request: vi.fn(), invoke: vi.fn(), pick: vi.fn() }));
vi.mock("../../core/client", () => ({
  core: { request: mocks.request, start: vi.fn(), onEvent: vi.fn(() => () => {}) },
  CoreError: class CoreError extends Error {
    code: string;
    constructor(e: { code: string; message: string }) {
      super(e.message);
      this.code = e.code;
    }
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, isTauri: () => false }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.pick }));

import { CoreError } from "../../core/client";
import { useStore } from "../../store";
import { useSettings } from "../../store/settings";
import { resetStore } from "../../store/testing";
import SettingsScreen from "./SettingsScreen";

const spec = (key: SettingSpec["key"], def: string, section: SettingSpec["section"], value: string | null = null): SettingSpec => ({ key, default: def, section, value });
const SPECS: SettingSpec[] = [
  spec("user_name", "Alexis", "general", "Marta"),
  spec("start_view", "home", "general"),
  spec("max_concurrent_runs", "3", "trabajo"),
  spec("daily_budget_usd", "10", "trabajo"),
  spec("default_budget_usd", "2", "trabajo"),
  spec("default_model", "sonnet", "trabajo"),
  spec("auto_relay_default", "1", "trabajo"),
  spec("test_timeout_min", "10", "trabajo"),
  spec("extra_skill_roots", "[]", "skills", '["/Users/m/skills"]'),
  spec("notify_system", "1", "avisos"),
  spec("notify_levels", '["warn"]', "avisos"),
  spec("quiet_hours", "", "avisos"),
  spec("update_auto_check", "1", "actualizaciones"),
];

const EXT = {
  mcp: [
    { name: "pg", scope: "user", projectId: null, transport: "stdio", command: "npx", envNames: [], headerNames: [], source: "/h/.claude.json" },
    { name: "pm", scope: "plugin", projectId: null, transport: "http", url: "https://x", envNames: [], headerNames: [], source: "/h/p/.mcp.json", managedBy: "plugin:stripe" },
  ],
  skills: [{ name: "frontend-design", description: "Diseño", scope: "user", projectId: null, path: "/h/.claude/skills/frontend-design", isSymlink: false }],
  warnings: [],
};

function reply(overrides: Record<string, (p: unknown) => unknown> = {}) {
  mocks.request.mockImplementation(async (method: string, params: unknown) => {
    if (overrides[method]) return overrides[method]!(params);
    if (method === "settings.all") return SPECS;
    if (method === "extensions.list") return EXT;
    return null;
  });
}
const go = (name: string) => fireEvent.click(screen.getByRole("button", { name }));

beforeEach(() => {
  mocks.request.mockReset();
  mocks.invoke.mockReset();
  mocks.invoke.mockRejectedValue("no tauri");
  resetStore(null);
  useSettings.setState({ specs: {}, status: "idle", reason: null, demo: false });
});
afterEach(cleanup);

describe("SettingsScreen", () => {
  it("carga settings.all y guarda un campo con settings.set", async () => {
    reply({ "settings.set": (p) => p });
    render(<SettingsScreen onClose={() => {}} />);
    const input = (await screen.findByLabelText("Tu nombre")) as HTMLInputElement;
    expect(input.value).toBe("Marta");
    fireEvent.change(input, { target: { value: "Luz" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar Tu nombre" }));
    await waitFor(() => expect(mocks.request).toHaveBeenCalledWith("settings.set", { key: "user_name", value: "Luz" }));
    expect(await screen.findByRole("status")).toHaveProperty("textContent", "Guardado");
    expect(useSettings.getState().specs.user_name?.value).toBe("Luz");
  });

  it("muestra junto al campo el error de validación del core", async () => {
    reply({
      "settings.set": () => {
        throw new CoreError({ code: "invalid", message: "settings.set: max_concurrent_runs debe ser un entero entre 1 y 32" });
      },
    });
    render(<SettingsScreen onClose={() => {}} />);
    go("Trabajo");
    const input = await screen.findByLabelText("Robots a la vez");
    fireEvent.change(input, { target: { value: "99" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar Robots a la vez" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("max_concurrent_runs debe ser un entero entre 1 y 32");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(useSettings.getState().specs.max_concurrent_runs?.value).toBeNull();
  });

  it("Restablecer guarda el defecto", async () => {
    reply({ "settings.set": (p) => p });
    render(<SettingsScreen onClose={() => {}} />);
    await screen.findByLabelText("Tu nombre");
    fireEvent.click(screen.getByRole("button", { name: "Restablecer Tu nombre" }));
    await waitFor(() => expect(mocks.request).toHaveBeenCalledWith("settings.set", { key: "user_name", value: "Alexis" }));
    // Con el valor ya en el defecto, el botón se desactiva.
    await waitFor(() => expect((screen.getByRole("button", { name: "Restablecer Tu nombre" }) as HTMLButtonElement).disabled).toBe(true));
  });

  it("interruptor sí/no guarda '0' / '1'", async () => {
    reply({ "settings.set": (p) => p });
    render(<SettingsScreen onClose={() => {}} />);
    go("Actualizaciones");
    fireEvent.click(await screen.findByLabelText("Sí"));
    await waitFor(() => expect(mocks.request).toHaveBeenCalledWith("settings.set", { key: "update_auto_check", value: "0" }));
  });

  it("carpetas de confianza: quitar guarda el JSON sin ella; lista las skills", async () => {
    reply({ "settings.set": (p) => p });
    render(<SettingsScreen onClose={() => {}} />);
    go("Skills");
    expect(await screen.findByText("frontend-design")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Quitar /Users/m/skills" }));
    await waitFor(() => expect(mocks.request).toHaveBeenCalledWith("settings.set", { key: "extra_skill_roots", value: "[]" }));
  });

  it("MCP: desinstalar pide confirmación con el archivo y avisa de la copia; los de plugin no se pueden", async () => {
    reply({ "extensions.remove": () => ({ removed: true, file: "/h/.claude.json", backup: "/h/.claude.json.kiji-backup-X" }) });
    render(<SettingsScreen onClose={() => {}} />);
    go("Skills");
    await screen.findByText("frontend-design");
    fireEvent.click(screen.getByRole("tab", { name: "MCP" }));
    expect(((await screen.findByRole("button", { name: "Desinstalar pm" })) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Desinstalar pg" }));
    const dlg = await screen.findByRole("dialog");
    expect(dlg.textContent).toContain("/h/.claude.json");
    expect(dlg.textContent).toContain("copia de seguridad");
    expect(dlg.textContent).toContain("reiniciarse");
    expect(mocks.request).not.toHaveBeenCalledWith("extensions.remove", expect.anything());
    fireEvent.click(within(dlg).getByRole("button", { name: "Desinstalar" }));
    await waitFor(() => expect(mocks.request).toHaveBeenCalledWith("extensions.remove", { kind: "mcp", scope: "user", name: "pg", projectId: undefined }));
    expect((await screen.findByText(/kiji-backup-X/)).textContent).toContain("Copia de seguridad");
  });

  it("sin settings.all en el core: aviso «aún no disponible», sin romper", async () => {
    mocks.request.mockImplementation(async () => {
      throw new CoreError({ code: "unknown_method", message: "unknown" });
    });
    render(<SettingsScreen onClose={() => {}} />);
    expect((await screen.findByRole("status")).textContent).toContain("aún no están disponibles");
    expect(useStore.getState().unavailable["settings.all"]).toBe(true);
    go("Gerente");
    expect(screen.getByText(/pestaña del Jefe/)).toBeTruthy();
    expect(within(screen.getByRole("navigation", { name: "Secciones de ajustes" })).getAllByRole("button")).toHaveLength(10);
  });
});
