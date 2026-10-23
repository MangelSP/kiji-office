// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

import { useStore } from "../../store";
import { proj, resetStore, seed } from "../../store/testing";
import CreateAgent from "./CreateAgent";
import { validateName } from "./options";

const BOSS = { id: "a1", name: "Jefe", provider: "claude", color: "terracota", is_boss: 1 };
const CLAU = { id: "a2", name: "Clau", provider: "claude", color: "terracota" };

beforeEach(() => {
  mocks.request.mockReset();
  resetStore();
  useStore.setState({ connections: [] });
  seed({ agents: [BOSS, CLAU] });
});
afterEach(cleanup);

const nameInput = () => screen.getByLabelText("Nombre") as HTMLInputElement;
const created = () => mocks.request.mock.calls.filter((c) => c[0] === "agent.create");
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
    expect(created()).toHaveLength(0);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("nombre duplicado (case-insensitive) frente a los agentes del proyecto", () => {
    render(<CreateAgent onClose={() => {}} />);
    fireEvent.change(nameInput(), { target: { value: "clau" } });
    submit();
    expect(screen.getByRole("alert").textContent).toMatch(/Ya hay un robot llamado "clau"/);
    expect(created()).toHaveLength(0);
  });

  it("muestra el warning que devuelve agent.create", async () => {
    mocks.request.mockImplementation(async (m: string) => (m === "agent.create" ? { id: "a3", name: "Nuevo", warning: "el modelo no está en la lista" } : []));
    const onClose = vi.fn();
    render(<CreateAgent onClose={onClose} />);
    fireEvent.change(nameInput(), { target: { value: "Nuevo" } });
    submit();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(useStore.getState().notice).toBe("Nuevo: el modelo no está en la lista");
  });

  it("el campo limita a 24 caracteres", () => {
    render(<CreateAgent onClose={() => {}} />);
    expect(nameInput().maxLength).toBe(24);
  });

  it("sin conexiones solo hay Claude (y el aviso de Conexiones); el rol jefe no se ofrece", () => {
    render(<CreateAgent onClose={() => {}} />);
    expect(screen.getAllByRole("radio")).toHaveLength(1);
    expect((screen.getByRole("radio", { name: /Claude/ }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(/en Conexiones/)).toBeTruthy();
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

  describe("con conexiones", () => {
    const LM = { id: "c1", name: "LM Studio", preset: "lmstudio", baseUrl: "http://localhost:1234/v1", auth: "none", hasSecret: false, defaultModel: "qwen3-coder", contextWindow: 8192, toolQuality: "ok", lastTestAt: 1, lastTestOk: true, agents: [], prices: {} };
    const WEAK = { ...LM, id: "c2", name: "Solo charla", toolQuality: "none", defaultModel: null };

    beforeEach(() => {
      mocks.request.mockImplementation(async (method: string, params?: { id?: string }) => {
        if (method === "connection.list") return [LM, WEAK];
        if (method === "connection.models") return params?.id === "c1" ? ["qwen3-coder", "gemma-3"] : ["tiny"];
        if (method === "agent.create") return { id: "a9", name: "Loc" };
        if (method === "agent.list") return [BOSS, CLAU];
        throw new Error(`inesperado: ${method}`);
      });
    });

    it("lista Claude + cada conexión con LED; al elegir una carga sus modelos y envía connectionId", async () => {
      render(<CreateAgent onClose={() => {}} />);
      const radio = await screen.findByRole("radio", { name: /LM Studio/ });
      expect(screen.getAllByRole("radio")).toHaveLength(3);
      expect(within(radio.closest("label")!).getByRole("img").getAttribute("aria-label")).toBe("funciona");
      fireEvent.click(radio);
      await waitFor(() => expect(Array.from((screen.getByLabelText("Modelo") as HTMLSelectElement).options).map((o) => o.value)).toEqual(["qwen3-coder", "gemma-3"]));
      expect((screen.getByLabelText("Modelo") as HTMLSelectElement).value).toBe("qwen3-coder");
      expect(mocks.request).toHaveBeenCalledWith("connection.models", { id: "c1" });
      fireEvent.change(screen.getByLabelText("Modelo"), { target: { value: "gemma-3" } });
      fireEvent.change(nameInput(), { target: { value: "Loc" } });
      submit();
      await waitFor(() => expect(created()).toHaveLength(1));
      expect(created()[0]![1]).toEqual({ projectId: "p1", name: "Loc", provider: "api", model: "gemma-3", role: "programador", color: "terracota", connectionId: "c1" });
    });

    it("toolQuality 'none': avisa de que el robot solo podrá responder consultas", async () => {
      render(<CreateAgent onClose={() => {}} />);
      expect(screen.queryByText(/solo podrá responder consultas/)).toBeNull();
      fireEvent.click(await screen.findByRole("radio", { name: /Solo charla/ }));
      expect(screen.getByText(/solo podrá responder consultas/)).toBeTruthy();
    });
  });
});
