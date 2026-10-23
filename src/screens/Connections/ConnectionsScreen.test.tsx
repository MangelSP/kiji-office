// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionTest, ConnectionView, DiscoveredServer } from "../../../shared/protocol";

const mocks = vi.hoisted(() => ({ request: vi.fn(), invoke: vi.fn() }));
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
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import { useStore } from "../../store";
import { resetStore } from "../../store/testing";
import ConnectionForm from "./ConnectionForm";
import ConnectionsScreen from "./ConnectionsScreen";

const SECRET = "sk-or-SUPERSECRET-1234";

const conn = (o: Partial<ConnectionView> = {}): ConnectionView => ({
  id: "c1", name: "LM Studio", preset: "lmstudio", baseUrl: "http://localhost:1234/v1", auth: "none", hasSecret: false,
  defaultModel: "qwen3-coder", contextWindow: 8192, toolQuality: "ok", lastTestAt: 1, lastTestOk: true, agents: [], prices: {}, ...o,
});
const TEST_OK: ConnectionTest = {
  ok: true, detail: "ok", toolQuality: "ok", latencyMs: 120, models: ["qwen3-coder", "gemma-3"],
  steps: [
    { name: "models", ok: true, detail: "2 modelos" },
    { name: "chat", ok: true, detail: "respondió" },
    { name: "tools", ok: false, detail: "no llamó a la herramienta" },
  ],
};

let list: ConnectionView[];
let discovered: DiscoveredServer[];
const calls = (m: string) => mocks.request.mock.calls.filter((c) => c[0] === m);

beforeEach(() => {
  list = [];
  discovered = [];
  mocks.request.mockReset();
  mocks.invoke.mockReset();
  mocks.invoke.mockResolvedValue(undefined);
  mocks.request.mockImplementation(async (method: string, params?: any) => {
    switch (method) {
      case "connection.list":
        return list;
      case "connections.discover":
        return discovered;
      case "connection.create": {
        const c = conn({ id: "new-1", name: params.name, preset: params.preset, baseUrl: params.baseUrl, auth: params.auth, toolQuality: "unknown", lastTestOk: null, defaultModel: params.defaultModel ?? null });
        list = [...list, c];
        return c;
      }
      case "connection.update":
        return true;
      case "connection.test":
        return TEST_OK;
      case "connection.models":
        return ["qwen3-coder", "gemma-3", "llama-3.2"];
      case "connection.delete":
        list = list.filter((c) => c.id !== params.id);
        return true;
      default:
        throw new Error(`inesperado: ${method}`);
    }
  });
  resetStore();
  useStore.setState({ connections: [], discovered: [], connectionsOpen: true });
});
afterEach(cleanup);

describe("lista", () => {
  it("descubre al abrir y pinta tarjetas con LED, preset, modelo, calidad de herramientas y robots", async () => {
    list = [
      conn({ agents: ["Ana", "Nico"] }),
      conn({ id: "c2", name: "Groq", preset: "groq", toolQuality: "weak", defaultModel: null }),
      conn({ id: "c3", name: "Caída", preset: "custom", toolQuality: "none", lastTestOk: false }),
    ];
    render(<ConnectionsScreen />);
    await screen.findByLabelText("LM Studio");
    expect(calls("connections.discover")).toHaveLength(1);
    const lm = screen.getByLabelText("LM Studio");
    expect(within(lm).getByRole("img").getAttribute("aria-label")).toBe("funciona");
    expect(lm.textContent).toContain("qwen3-coder");
    expect(lm.textContent).toContain("usa herramientas bien");
    expect(lm.textContent).toContain("La usan: Ana, Nico");
    const groq = screen.getByLabelText("Groq");
    expect(within(groq).getByRole("img").getAttribute("aria-label")).toBe("sin probar o a medias");
    expect(groq.textContent).toContain("a medias: puede fallar al editar");
    expect(within(screen.getByLabelText("Caída")).getByRole("img").className).toContain("cx-led-off");
    expect(screen.getByLabelText("Caída").textContent).toContain("solo responde consultas");
  });

  it("borrar: con robots se explica y no se deja; sin robots pide confirmación y llama a connection.delete", async () => {
    list = [conn({ agents: ["Ana"] }), conn({ id: "c2", name: "Libre" })];
    render(<ConnectionsScreen />);
    await screen.findByLabelText("Libre");
    expect((screen.getByRole("button", { name: "Borrar LM Studio" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/reasígnalos a otra IA/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Borrar Libre" }));
    fireEvent.click(screen.getByRole("button", { name: "Sí, borrar" }));
    await waitFor(() => expect(calls("connection.delete")).toEqual([["connection.delete", { id: "c2" }]]));
    await waitFor(() => expect(screen.queryByLabelText("Libre")).toBeNull());
  });

  it("Probar muestra los tres pasos con ✓/✗", async () => {
    list = [conn()];
    render(<ConnectionsScreen />);
    fireEvent.click(await screen.findByRole("button", { name: "Probar LM Studio" }));
    const steps = await screen.findByLabelText("Prueba de LM Studio");
    expect(steps.textContent).toContain("✓ models");
    expect(steps.textContent).toContain("✗ tools");
  });
});

describe("En este equipo", () => {
  it("Encontrado + Conectar crea la conexión sin clave y la prueba; Ollama sin arrancar da la pista", async () => {
    discovered = [
      { preset: "lmstudio", baseUrl: "http://localhost:1234/v1", models: ["a", "b", "c"], alreadyConnected: false },
      { preset: "ollama", baseUrl: "http://localhost:11434/v1", models: [], alreadyConnected: false, installedNotRunning: true },
    ];
    render(<ConnectionsScreen />);
    const found = await screen.findByText(/Encontrado:/);
    expect(found.textContent).toContain("LM Studio · 3 modelos");
    expect(screen.getByText(/Ollama está instalado pero no en marcha/).textContent).toContain("ollama serve");
    fireEvent.click(screen.getByRole("button", { name: "Conectar LM Studio" }));
    await waitFor(() => expect(calls("connection.test")).toHaveLength(1));
    expect(calls("connection.create")[0]![1]).toEqual({
      name: "LM Studio", preset: "lmstudio", baseUrl: "http://localhost:1234/v1", auth: "none", defaultModel: "a",
    });
    expect(calls("connection.test")[0]![1]).toEqual({ id: "new-1" });
    expect(mocks.invoke).not.toHaveBeenCalledWith("secret_set", expect.anything());
    await screen.findByLabelText("LM Studio");
  });

  it("el botón Buscar vuelve a sondear", async () => {
    render(<ConnectionsScreen />);
    await screen.findByText(/No se encontró ninguna IA local/);
    fireEvent.click(screen.getByRole("button", { name: "Buscar en este equipo" }));
    await waitFor(() => expect(calls("connections.discover")).toHaveLength(2));
  });

  it("si el core no implementa discover: 'aún no disponible' sin romper", async () => {
    const base = mocks.request.getMockImplementation()!;
    mocks.request.mockImplementation(async (m: string, p?: unknown) => {
      if (m === "connections.discover") throw Object.assign(new Error("x"), { code: "unknown_method", name: "CoreError" });
      return base(m, p);
    });
    useStore.setState({ unavailable: { "connections.discover": true } });
    render(<ConnectionsScreen />);
    expect(await screen.findByText(/Aún no disponible: el core no implementa connections.discover/)).toBeTruthy();
  });
});

describe("formulario de 3 pasos", () => {
  it("preset → URL y clave → Probar → modelo/contexto; la clave va a secret_set conn:<id> y no queda en el store", async () => {
    const onClose = vi.fn();
    render(<ConnectionForm onClose={onClose} />);
    // 1. preset
    fireEvent.click(screen.getByRole("radio", { name: /OpenRouter/ }));
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    // 2. URL prellenada, clave solo porque auth != none
    expect((screen.getByLabelText("URL") as HTMLInputElement).value).toBe("https://openrouter.ai/api/v1");
    const key = screen.getByLabelText("Clave") as HTMLInputElement;
    expect(key.type).toBe("password");
    fireEvent.change(key, { target: { value: SECRET } });
    fireEvent.click(screen.getByRole("button", { name: "Probar" }));
    const result = await screen.findByLabelText("Resultado de la prueba");
    expect(result.textContent).toContain("✓");
    expect(result.textContent).toContain("✗");
    expect(result.textContent).toContain("no llamó a la herramienta");
    expect(calls("connection.create")[0]![1]).toEqual({ name: "OpenRouter", preset: "openrouter", baseUrl: "https://openrouter.ai/api/v1", auth: "bearer" });
    expect(mocks.invoke).toHaveBeenCalledWith("secret_set", { user: "conn:new-1", value: SECRET });
    expect(key.value).toBe(""); // vaciada al guardar
    // Ni el store, ni el DOM, ni las peticiones al core llevan la clave.
    expect(JSON.stringify(useStore.getState(), (_k, v) => (typeof v === "function" ? undefined : v))).not.toContain(SECRET);
    expect(document.body.innerHTML).not.toContain(SECRET);
    expect(JSON.stringify(mocks.request.mock.calls)).not.toContain(SECRET);
    // 3. modelo con buscador y contexto
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    await waitFor(() => expect(Array.from((screen.getByLabelText("Modelo por defecto") as HTMLSelectElement).options)).toHaveLength(3));
    fireEvent.change(screen.getByLabelText("Buscar modelo"), { target: { value: "gemma" } });
    expect(Array.from((screen.getByLabelText("Modelo por defecto") as HTMLSelectElement).options).map((o) => o.value)).toContain("gemma-3");
    expect(Array.from((screen.getByLabelText("Modelo por defecto") as HTMLSelectElement).options).map((o) => o.value)).not.toContain("llama-3.2");
    fireEvent.change(screen.getByLabelText("Modelo por defecto"), { target: { value: "gemma-3" } });
    fireEvent.change(screen.getByLabelText("Ventana de contexto (tokens)"), { target: { value: "16000" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar conexión" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls("connection.update").at(-1)![1]).toEqual({ id: "new-1", defaultModel: "gemma-3", contextWindow: 16000 });
  });

  it("un preset local no pide clave; Ollama avisa del contexto de 4096", async () => {
    render(<ConnectionForm onClose={() => {}} />);
    fireEvent.click(screen.getByRole("radio", { name: /Ollama/ }));
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    expect(screen.queryByLabelText("Clave")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    await screen.findByText(/Ollama usa 4096 por defecto; súbelo con OLLAMA_CONTEXT_LENGTH/);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("Cancelar borra la conexión creada a medias", async () => {
    const onClose = vi.fn();
    render(<ConnectionForm onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    fireEvent.click(screen.getByRole("button", { name: "Probar" }));
    await screen.findByLabelText("Resultado de la prueba");
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls("connection.delete")).toEqual([["connection.delete", { id: "new-1" }]]);
  });

  it("URL no válida: avisa y no llama al core", () => {
    render(<ConnectionForm onClose={() => {}} />);
    fireEvent.click(screen.getByRole("radio", { name: /Personalizada/ }));
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    fireEvent.click(screen.getByRole("button", { name: "Probar" }));
    expect(screen.getByRole("alert").textContent).toMatch(/http/);
    expect(calls("connection.create")).toHaveLength(0);
  });
});

describe("borrado sin huérfanos y cambio de host", () => {
  const order = () => [...mocks.invoke.mock.invocationCallOrder.map((n, i) => [n, mocks.invoke.mock.calls[i]![0] as string] as const), ...mocks.request.mock.invocationCallOrder.map((n, i) => [n, mocks.request.mock.calls[i]![0] as string] as const)]
    .sort((a, b) => a[0] - b[0])
    .map((x) => x[1])
    .filter((m) => m === "secret_delete" || m === "connection.delete");

  it("Cancelar: borra primero la clave y luego la conexión", async () => {
    const onClose = vi.fn();
    render(<ConnectionForm onClose={onClose} />);
    fireEvent.click(screen.getByRole("radio", { name: /OpenRouter/ }));
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    fireEvent.change(screen.getByLabelText("Clave"), { target: { value: SECRET } });
    fireEvent.click(screen.getByRole("button", { name: "Probar" }));
    await screen.findByLabelText("Resultado de la prueba");
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(order()).toEqual(["secret_delete", "connection.delete"]);
    expect(mocks.invoke).toHaveBeenCalledWith("secret_delete", { user: "conn:new-1" });
  });

  it("Cancelar: si falla el llavero igual borra la conexión y muestra el error sin cerrar", async () => {
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "secret_delete") throw "llavero bloqueado";
    });
    const onClose = vi.fn();
    render(<ConnectionForm onClose={onClose} />);
    fireEvent.click(screen.getByRole("radio", { name: /OpenRouter/ }));
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    fireEvent.change(screen.getByLabelText("Clave"), { target: { value: SECRET } });
    fireEvent.click(screen.getByRole("button", { name: "Probar" }));
    await screen.findByLabelText("Resultado de la prueba");
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/llavero bloqueado/));
    expect(calls("connection.delete")).toHaveLength(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Borrar una tarjeta con clave: primero el llavero y luego la conexión; si el core falla, la clave ya no queda", async () => {
    list = [conn({ id: "c9", name: "Remota", auth: "bearer", hasSecret: true })];
    render(<ConnectionsScreen />);
    await screen.findByLabelText("Remota");
    fireEvent.click(screen.getByRole("button", { name: "Borrar Remota" }));
    fireEvent.click(screen.getByRole("button", { name: "Sí, borrar" }));
    await waitFor(() => expect(calls("connection.delete")).toHaveLength(1));
    expect(order()).toEqual(["secret_delete", "connection.delete"]);
    expect(mocks.invoke).toHaveBeenCalledWith("secret_delete", { user: "conn:c9" });
  });

  it("removeConnection intenta ambas aunque la primera falle y devuelve los dos errores", async () => {
    mocks.invoke.mockRejectedValue("sin acceso");
    mocks.request.mockImplementation(async (m: string) => {
      if (m === "connection.delete") throw new Error("la conexión no existe");
      return [];
    });
    const err = await useStore.getState().removeConnection("c1", true);
    expect(err).toMatch(/sin acceso/);
    expect(err).toMatch(/no existe/);
    expect(calls("connection.delete")).toHaveLength(1);
  });

  it("al cambiar el host de una conexión con clave avisa y pide confirmación antes de guardar", async () => {
    const c = conn({ id: "c7", name: "Mi API", preset: "custom", baseUrl: "https://api.buena.com/v1", auth: "bearer", hasSecret: true });
    render(<ConnectionForm initial={c} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("URL"), { target: { value: "https://evil.example.org/v1" } });
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    const dlg = await screen.findByRole("alertdialog");
    expect(dlg.textContent).toMatch(/Tu clave se enviará a evil\.example\.org/);
    expect(calls("connection.update")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: /Sí, enviar la clave a evil\.example\.org/ }));
    await waitFor(() => expect(calls("connection.update")[0]![1]).toMatchObject({ id: "c7", baseUrl: "https://evil.example.org/v1" }));
  });

  it("mismo host (solo cambia la ruta) no pide confirmación", async () => {
    const c = conn({ id: "c7", preset: "custom", baseUrl: "https://api.buena.com/v1", auth: "bearer", hasSecret: true });
    render(<ConnectionForm initial={c} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("URL"), { target: { value: "https://api.buena.com/v2" } });
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    await waitFor(() => expect(calls("connection.update")).toHaveLength(1));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});
