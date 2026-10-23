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
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

import { useStore } from "../../store";
import { createMetricsSlice } from "../../store/metrics";
import AgentTabs from "./AgentTabs";
import { describeEntry } from "./eventText";

const BOSS = { id: "a1", name: "Jefe", role: "jefe", color: "terracota", is_boss: 1, status: "thinking", model: "opus" };
const CLAU = {
  id: "a2", name: "Clau", role: "programador", color: "azul", status: "writing", model: "sonnet",
  persona: "Habla claro.", skills: ["frontend-design"], relay_order: ["opus", "haiku"], auto_relay: 1,
};
const TASK = {
  id: "t1", title: "Arreglar el login", description: "El botón no responde.\nRevisa el formulario.", status: "review",
  agent_id: "a2", files: ["src/login.ts"], result: "## Hecho\n\nSe arregló <script>alert(1)</script> el **botón**.\n\n| a | b |\n|---|---|\n| 1 | 2 |",
};

const calls = (method: string) => mocks.request.mock.calls.filter((c) => c[0] === method);

beforeEach(() => {
  mocks.request.mockReset();
  mocks.request.mockImplementation(async (method: string) => {
    if (method === "skills.list") return [{ name: "frontend-design", description: "Interfaces cuidadas" }, { name: "game-ui-ux", description: "Pantallas de juego" }];
    if (method === "agent.update") return { ...CLAU, name: "Clau 2" };
    throw Object.assign(new Error("no"), { code: "unknown_method" });
  });
  useStore.setState(createMetricsSlice(useStore.setState as never, useStore.getState as never, useStore as never));
  useStore.setState({
    agents: [BOSS, CLAU], tasks: [TASK], events: [], liveRuns: {}, metricsByAgent: {}, stepsByTask: {}, skills: [], notice: null, unavailable: {},
  } as never);
});
afterEach(cleanup);

describe("AgentTabs", () => {
  it("muestra Todos y una tarjeta-pestaña por agente, y selecciona al hacer clic", () => {
    const onSelect = vi.fn();
    render(<AgentTabs selectedId={null} onSelect={onSelect} />);
    const tabs = within(screen.getByRole("tablist", { name: "Robots" })).getAllByRole("tab");
    expect(tabs).toHaveLength(3);
    expect(tabs[0].textContent).toContain("Todos");
    expect(tabs[0].textContent).toContain("2 robots · 2 trabajando");
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: /^Jefe/ }).getAttribute("aria-selected")).toBe("false");
    fireEvent.click(screen.getByRole("tab", { name: /^Clau/ }));
    expect(onSelect).toHaveBeenCalledWith("a2");
    fireEvent.click(screen.getByRole("button", { name: "Abrir Jefe" }));
    expect(onSelect).toHaveBeenCalledWith("a1");
  });

  it("clic en la tarjeta seleccionada o en Todos vuelve a Todos; las flechas cambian de tarjeta", () => {
    const onSelect = vi.fn();
    render(<AgentTabs selectedId="a2" onSelect={onSelect} />);
    const clau = screen.getByRole("tab", { name: /^Clau/ });
    expect(clau.getAttribute("aria-selected")).toBe("true");
    fireEvent.click(clau);
    expect(onSelect).toHaveBeenLastCalledWith(null);
    fireEvent.click(screen.getByRole("tab", { name: /^Todos/ }));
    expect(onSelect).toHaveBeenLastCalledWith(null);
    clau.focus();
    fireEvent.keyDown(clau, { key: "ArrowUp" });
    expect(onSelect).toHaveBeenLastCalledWith("a1");
  });

  it("Todos resume modelo, estado, tareas y coste de cada agente", () => {
    useStore.setState({ metricsByAgent: { a2: { agentId: "a2", model: "haiku", runs: 1, costUsd: 0.25, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, lastContextTokens: 0, lastContextWindow: 0, recent: [] } } } as never);
    render(<AgentTabs selectedId={null} onSelect={vi.fn()} />);
    const card = screen.getByRole("button", { name: "Abrir Clau" });
    expect(card.textContent).toContain("haiku");
    expect(card.textContent).toContain("escribiendo");
    expect(card.textContent).toContain("1 tarea abierta de 1");
    expect(card.textContent).toContain("$0,250");
  });

  it("cambia de subpestaña y pide las métricas del agente", async () => {
    render(<AgentTabs selectedId="a2" onSelect={vi.fn()} />);
    await waitFor(() => expect(calls("agent.metrics").map((c) => c[1])).toContainEqual({ agentId: "a2" }));
    expect(screen.getByRole("tablist", { name: "Secciones de Clau" }).querySelector(".ag-subtab")).not.toBeNull();
    expect(screen.getByRole("tab", { name: "Tareas" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Arreglar el login")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Métricas" }));
    expect(screen.getByRole("tab", { name: "Métricas" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByText("Arreglar el login")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Perfil" }));
    expect(screen.getByLabelText("Nombre")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Registro" }));
    expect(screen.getByText(/Sin actividad de Clau/)).toBeTruthy();
  });

  it("las métricas se actualizan en vivo con liveRuns", () => {
    useStore.setState({
      metricsByAgent: { a2: { agentId: "a2", model: "sonnet", runs: 1, costUsd: 1.234, input: 12300, output: 900, cacheRead: 50000, cacheWrite: 800, lastContextTokens: 100000, lastContextWindow: 200000, recent: [] } },
    } as never);
    render(<AgentTabs selectedId="a2" onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Métricas" }));
    expect(screen.getByText("12,3 k")).toBeTruthy();
    expect(screen.getByText("50,0 k")).toBeTruthy();
    expect(screen.getAllByText(/50 %/).length).toBeGreaterThan(0);
    useStore.getState().applyRunMetrics({
      runId: "r1234567", taskId: "t1", agentId: "a2", model: "opus", input: 10, output: 5, cacheRead: 0, cacheWrite: 0,
      contextTokens: 190000, contextWindow: 200000, costUsd: 0.1, live: true,
    });
    return waitFor(() => {
      const bars = screen.getAllByRole("progressbar", { name: "Contexto" }); // cabecera y pestaña
      expect(bars.map((b) => b.getAttribute("aria-valuenow"))).toEqual(["95", "95"]);
      expect(screen.getAllByText("en vivo").length).toBeGreaterThan(0);
    });
  });

  it("la respuesta se muestra como Markdown sin HTML crudo", () => {
    const { container } = render(<AgentTabs selectedId="a2" onSelect={vi.fn()} />);
    const resp = screen.getByLabelText("Respuesta de Arreglar el login");
    expect(within(resp).getByRole("heading", { name: "Hecho" })).toBeTruthy();
    expect(resp.querySelector("strong")?.textContent).toBe("botón");
    expect(resp.querySelector("table")).not.toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(resp.innerHTML).not.toContain("<script");
    expect(resp.textContent).not.toContain("<script");
  });

  it("los enlaces no navegan y abren con el plugin opener", async () => {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    useStore.setState({ tasks: [{ ...TASK, result: "Mira [docs](https://example.com) y [mal](javascript:alert(1))" }] } as never);
    render(<AgentTabs selectedId="a2" onSelect={vi.fn()} />);
    const link = screen.getByRole("link", { name: "docs" });
    expect(fireEvent.click(link)).toBe(false); // preventDefault
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith("https://example.com"));
    expect(screen.queryByRole("link", { name: "mal" })).toBeNull();
  });

  it("Cambiar IA llama a task.switch con el modelo elegido", async () => {
    mocks.request.mockImplementation(async (m: string) => {
      if (m === "task.switch") return { ...TASK, status: "running" };
      throw Object.assign(new Error("no"), { code: "unknown_method" });
    });
    render(<AgentTabs selectedId="a2" onSelect={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Cambiar IA de Arreglar el login"), { target: { value: "model:opus" } });
    fireEvent.click(screen.getByRole("button", { name: "Cambiar" }));
    await waitFor(() => expect(calls("task.switch")[0]?.[1]).toEqual({ taskId: "t1", model: "opus" }));
  });

  it("los pasos se piden al desplegar y se muestran con ✓/✗", async () => {
    mocks.request.mockImplementation(async (m: string) => {
      if (m === "task.steps") return [
        { name: "Read", target: "src/a.ts", ok: true, startedAt: 1000, endedAt: 2200 },
        { name: "Bash", target: "npm test", ok: false, startedAt: 3000, endedAt: 3400 },
      ];
      throw Object.assign(new Error("no"), { code: "unknown_method" });
    });
    const { container } = render(<AgentTabs selectedId="a2" onSelect={vi.fn()} />);
    const details = container.querySelector("details.ag-steps") as HTMLDetailsElement;
    details.open = true;
    fireEvent(details, new Event("toggle"));
    await waitFor(() => expect(screen.getByText("npm test")).toBeTruthy());
    expect(screen.getByLabelText("correcto")).toBeTruthy();
    expect(screen.getByLabelText("falló")).toBeTruthy();
    expect(screen.getByText("1,2 s")).toBeTruthy();
  });

  it("guardar el perfil llama a agent.update solo con lo cambiado", async () => {
    render(<AgentTabs selectedId="a2" onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Perfil" }));
    const save = screen.getByRole("button", { name: "Guardar" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await screen.findByText("Pantallas de juego");
    fireEvent.change(screen.getByLabelText("Nombre"), { target: { value: "Clau 2" } });
    fireEvent.change(screen.getByLabelText("Personalidad"), { target: { value: "Sé breve." } });
    expect(screen.getByText("9 / 4000")).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/game-ui-ux/));
    fireEvent.click(screen.getByRole("button", { name: "Subir haiku" }));
    fireEvent.click(screen.getByRole("switch", { name: "Relevo automático" }));
    fireEvent.click(save);
    await waitFor(() => expect(calls("agent.update")).toHaveLength(1));
    expect(calls("agent.update")[0][1]).toEqual({
      agentId: "a2", name: "Clau 2", persona: "Sé breve.", skills: ["frontend-design", "game-ui-ux"],
      relayOrder: ["haiku", "opus"], autoRelay: false,
    });
    await waitFor(() => expect(useStore.getState().agents.find((a) => a.id === "a2")?.name).toBe("Clau 2"));
  });

  it("el buscador filtra las skills", async () => {
    render(<AgentTabs selectedId="a2" onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Perfil" }));
    await screen.findByText("Pantallas de juego");
    fireEvent.change(screen.getByLabelText("Buscar skills"), { target: { value: "juego" } });
    expect(screen.queryByText("Interfaces cuidadas")).toBeNull();
    expect(screen.getByText("Pantallas de juego")).toBeTruthy();
  });

  it("si el core rechaza el guardado muestra el error en el formulario", async () => {
    mocks.request.mockImplementation(async (m: string) => {
      if (m === "agent.update") throw new Error("agent.update: persona demasiado larga");
      return [];
    });
    render(<AgentTabs selectedId="a2" onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Perfil" }));
    fireEvent.change(screen.getByLabelText("Personalidad"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    expect((await screen.findByRole("alert")).textContent).toContain("persona demasiado larga");
  });

  it("el registro cuenta lo que hizo el agente en frases, con lo nuevo arriba y sin JSON", () => {
    const ev = (seq: number, payload: unknown) => ({ seq, at: 1_700_000_000_000 + seq, name: "event.appended", summary: JSON.stringify(payload) });
    useStore.setState({
      events: [
        ev(1, { agent_id: "a2", task_id: "t1", kind: "tool", payload: { name: "Read", status: "start" } }),
        ev(2, { agent_id: "a2", task_id: "t1", kind: "text", payload: { delta: "hola" } }),
        ev(3, { agent_id: "a1", task_id: "t1", kind: "tool", payload: { name: "Edit", status: "start" } }),
        ev(4, { agent_id: "a2", task_id: "t1", kind: "status", payload: { task_id: "t1", from: "running", to: "review" } }),
      ],
    } as never);
    render(<AgentTabs selectedId="a2" onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Registro" }));
    const items = within(screen.getByRole("list", { name: "Registro de Clau" })).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain("La tarea «Arreglar el login» pasó a «En revisión»");
    expect(items[1].textContent).toContain("Usa Read");
    expect(items.map((i) => i.textContent).join()).not.toContain("{");
  });

  it("describeEntry rescata los campos de un resumen recortado", () => {
    const cut = '{"id":9,"project_id":"p","task_id":"t1","agent_id":"a2","run_id":"r","kind":"tool","payload":{"name":"Grep","status":"start","input":{"pattern":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    expect(describeEntry({ seq: 1, at: 0, name: "event.appended", summary: cut })).toBe("Usa Grep");
  });
});
