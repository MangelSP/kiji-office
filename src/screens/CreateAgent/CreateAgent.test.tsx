// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
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
// PixiJS necesita WebGL: en jsdom la vista previa se sustituye por un marcador con la paleta.
vi.mock("./RobotPreview", () => ({ default: ({ palette }: { palette: string }) => <div data-testid="preview" data-palette={palette} /> }));

import { proj, resetStore, seed } from "../../store/testing";
import CreateAgent from "./CreateAgent";
import { validateName } from "./options";

const BOSS = { id: "a1", name: "Jefe", provider: "claude", color: "terracota", is_boss: 1 };
const CLAU = { id: "a2", name: "Clau", provider: "claude", color: "terracota" };

beforeEach(() => {
  mocks.request.mockReset();
  resetStore();
  seed({ agents: [BOSS, CLAU] });
});
afterEach(cleanup);

const nameInput = () => screen.getByLabelText("Nombre") as HTMLInputElement;
const submit = () => fireEvent.click(screen.getByRole("button", { name: "Crear robot" }));

describe("validateName", () => {
  it("vacío, demasiado largo y duplicado (sin distinguir mayúsculas)", () => {
    expect(validateName("   ", [])).toMatch(/nombre/i);
    expect(validateName("a".repeat(25), [])).toMatch(/24/);
    expect(validateName("a".repeat(24), [])).toBeNull();
    expect(validateName(" clau ", ["Clau"])).toMatch(/Ya hay un robot/);
    expect(validateName("Pixel", ["Clau"])).toBeNull();
  });
});

describe("CreateAgent", () => {
  it("nombre vacío: muestra el error, no llama al core y no cierra", () => {
    const onClose = vi.fn();
    render(<CreateAgent onClose={onClose} />);
    submit();
    expect(screen.getByRole("alert").textContent).toMatch(/Ponle un nombre/);
    expect(nameInput().getAttribute("aria-invalid")).toBe("true");
    expect(mocks.request).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("nombre duplicado (case-insensitive) frente a los agentes del proyecto", () => {
    render(<CreateAgent onClose={() => {}} />);
    fireEvent.change(nameInput(), { target: { value: "clau" } });
    submit();
    expect(screen.getByRole("alert").textContent).toMatch(/Ya hay un robot llamado "clau"/);
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("el campo limita a 24 caracteres", () => {
    render(<CreateAgent onClose={() => {}} />);
    expect(nameInput().maxLength).toBe(24);
  });

  it("solo Claude está habilitado; las demás IA llevan el aviso del paso 15/16; el rol jefe no se ofrece", () => {
    render(<CreateAgent onClose={() => {}} />);
    expect((screen.getByRole("radio", { name: /Claude/ }) as HTMLInputElement).disabled).toBe(false);
    for (const n of [/OpenAI/, /Gemini/, /Ollama/]) {
      const r = screen.getByRole("radio", { name: n }) as HTMLInputElement;
      expect(r.disabled).toBe(true);
      expect(r.closest("label")!.textContent).toContain("llega en 0.1 paso 15/16");
    }
    const roles = Array.from((screen.getByLabelText("Rol") as HTMLSelectElement).options).map((o) => o.value);
    expect(roles).toEqual(["programador", "tester", "explorador", "modelador-2d", "documentador", "revisor-critico"]);
    const models = Array.from((screen.getByLabelText("Modelo") as HTMLSelectElement).options).map((o) => o.value);
    expect(models).toEqual(["sonnet", "opus", "haiku"]);
  });

  it("los colores son botones con aria-pressed y cambian la vista previa", () => {
    render(<CreateAgent onClose={() => {}} />);
    expect(screen.getByRole("button", { name: "Color Terracota" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Color Verde" }));
    expect(screen.getByRole("button", { name: "Color Verde" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Color Terracota" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByTestId("preview").getAttribute("data-palette")).toBe("verde");
  });

  it("agent.create recibe {name, provider:'claude', model, role, color}, refresca la lista y cierra", async () => {
    const onClose = vi.fn();
    const onCreated = vi.fn();
    const nuevo = { id: "a3", name: "Pixel", provider: "claude", model: "haiku", role: "tester", color: "azul" };
    mocks.request.mockImplementation(async (method: string) => {
      if (method === "agent.create") return nuevo;
      if (method === "agent.list") return [BOSS, CLAU, nuevo];
      throw new Error(`inesperado: ${method}`);
    });
    render(<CreateAgent onClose={onClose} onCreated={onCreated} />);
    fireEvent.change(screen.getByLabelText("Modelo"), { target: { value: "haiku" } });
    fireEvent.change(screen.getByLabelText("Rol"), { target: { value: "tester" } });
    fireEvent.change(nameInput(), { target: { value: "  Pixel " } });
    fireEvent.click(screen.getByRole("button", { name: "Color Azul" }));
    submit();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(mocks.request).toHaveBeenCalledWith("agent.create", { projectId: "p1", name: "Pixel", provider: "claude", model: "haiku", role: "tester", color: "azul" });
    expect(mocks.request).toHaveBeenCalledWith("agent.list", { projectId: "p1" });
    expect(proj().agents.map((a) => a.name)).toEqual(["Jefe", "Clau", "Pixel"]);
    expect(onCreated).toHaveBeenCalledWith("Pixel");
  });

  it("valores por defecto: sonnet, programador y terracota", async () => {
    mocks.request.mockResolvedValue([]);
    render(<CreateAgent onClose={() => {}} />);
    fireEvent.change(nameInput(), { target: { value: "Ana" } });
    submit();
    await waitFor(() => expect(mocks.request).toHaveBeenCalled());
    expect(mocks.request).toHaveBeenCalledWith("agent.create", { projectId: "p1", name: "Ana", provider: "claude", model: "sonnet", role: "programador", color: "terracota" });
  });

  it("si el core rechaza, muestra su mensaje y no cierra", async () => {
    const onClose = vi.fn();
    mocks.request.mockRejectedValue(new Error("agent.create: ya hay un agente llamado \"Zed\""));
    render(<CreateAgent onClose={onClose} />);
    fireEvent.change(nameInput(), { target: { value: "Zed" } });
    submit();
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/ya hay un agente llamado "Zed"/));
    expect(onClose).not.toHaveBeenCalled();
  });
});
