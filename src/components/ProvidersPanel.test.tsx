// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderStatus } from "../../shared/protocol";

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../core/client", () => ({
  core: { request: mocks.request, start: vi.fn(), onEvent: vi.fn(() => () => {}) },
  CoreError: class CoreError extends Error {
    code: string;
    constructor(e: { code: string; message: string }) {
      super(e.message);
      this.code = e.code;
    }
  },
}));

import { useStore } from "../store";
import ProvidersPanel, { COUNTDOWN_REFRESH_MS, formatCountdown, percent } from "./ProvidersPanel";

const NOW = new Date(2026, 9, 23, 12, 0).getTime();
const H = 3_600_000;

const claude: ProviderStatus = {
  id: "claude",
  label: "Claude",
  configured: true,
  state: "warning",
  windows: [
    { type: "seven_day_sonnet", status: "rejected", utilization: 1, resetsAt: NOW + 3 * 86_400_000, seenAt: NOW },
    { type: "five_hour", status: "allowed", utilization: 0.42, resetsAt: NOW + 2 * H + 15 * 60_000, seenAt: NOW },
    { type: "seven_day", status: "allowed_warning", utilization: 0.784, resetsAt: null, seenAt: NOW },
  ],
  models: [
    { model: "sonnet", agents: ["a2"], liveRuns: 1, costTodayUsd: 0.4, limitedUntil: null },
    { model: "haiku", agents: [], liveRuns: 0, costTodayUsd: 0.025, limitedUntil: null },
  ],
};
const ollama: ProviderStatus = { id: "ollama", label: "Ollama", configured: false, state: "off", windows: [], models: [] };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(NOW);
  mocks.request.mockReset();
  useStore.setState({
    providers: [],
    relays: [],
    tasks: [],
    unavailable: {},
    notice: null,
    agents: [
      { id: "a1", name: "Jefe", is_boss: 1, status: "idle" },
      { id: "a2", name: "Clau", status: "thinking" },
      { id: "a3", name: "Nico", status: "idle" },
    ],
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("formatCountdown y percent", () => {
  it("formatos de cuenta atrás", () => {
    expect(formatCountdown(NOW - 1, NOW)).toBe("ya se renovó");
    expect(formatCountdown(NOW + 20_000, NOW)).toBe("menos de 1 min");
    expect(formatCountdown(NOW + 45 * 60_000, NOW)).toBe("45 min");
    expect(formatCountdown(NOW + 2 * H + 15 * 60_000, NOW)).toBe("2 h 15 min");
    expect(formatCountdown(NOW + 3 * H, NOW)).toBe("3 h");
    expect(formatCountdown(NOW + 3 * 86_400_000 + 4 * H, NOW)).toBe("3 d 4 h");
  });
  it("porcentaje acotado", () => {
    expect(percent(0.784)).toBe(78);
    expect(percent(1.4)).toBe(100);
    expect(percent(null)).toBeNull();
  });
});

describe("ProvidersPanel", () => {
  it("sin proveedores y método no disponible, lo dice", () => {
    useStore.setState({ unavailable: { "providers.status": true } });
    render(<ProvidersPanel />);
    expect(screen.getByText(/Aún no disponible/)).toBeTruthy();
  });

  it("dibuja las barras en orden con su porcentaje y su cuenta atrás", () => {
    useStore.setState({ providers: [claude, ollama] });
    render(<ProvidersPanel />);
    const bars = screen.getAllByRole("progressbar");
    expect(bars.map((b) => b.getAttribute("aria-label"))).toEqual([
      "Uso de la ventana de 5 horas",
      "Uso de la ventana de 7 días",
      "Uso de la ventana de 7 días Sonnet",
    ]);
    expect(bars.map((b) => b.getAttribute("aria-valuenow"))).toEqual(["42", "78", "100"]);
    expect(screen.getByText("42 %")).toBeTruthy();
    expect(screen.getByText("se renueva en 2 h 15 min")).toBeTruthy();
    expect(screen.getByText("se renueva en 3 d")).toBeTruthy();
    expect(screen.getByText("100 % · agotado")).toBeTruthy();
  });

  it("la cuenta atrás se actualiza cada 30 s", () => {
    useStore.setState({ providers: [claude] });
    render(<ProvidersPanel />);
    expect(screen.getByText("se renueva en 2 h 15 min")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(COUNTDOWN_REFRESH_MS * 2 * 20); // 20 min
    });
    expect(screen.getByText("se renueva en 1 h 55 min")).toBeTruthy();
  });

  it("windows vacío -> sin datos de cupo, y el proveedor apagado se ve como no configurado", () => {
    useStore.setState({ providers: [ollama] });
    render(<ProvidersPanel />);
    expect(screen.getByText("sin datos de cupo")).toBeTruthy();
    expect(screen.getByText("No configurado")).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("muestra modelos con sus agentes, runs vivos y gasto de hoy", () => {
    useStore.setState({ providers: [claude] });
    const { container } = render(<ProvidersPanel />);
    const models = container.querySelector(".models")!.textContent!;
    expect(models).toContain("sonnet");
    expect(models).toContain("Clau");
    expect(models).toContain("1 run vivo");
    expect(models).toContain("hoy $0.40");
    expect(models).toContain("sin agentes");
    expect(container.querySelector(".prov-total")!.textContent).toContain("1 run vivo · hoy $0.43");
    expect(container.querySelector(".light-warning")).toBeTruthy();
  });

  it("lista el historial de relevos", () => {
    useStore.setState({
      providers: [claude],
      relays: [
        {
          id: 1, taskId: "t1", fromAgentId: "a2", toAgentId: "a2", fromModel: "sonnet", toModel: "haiku",
          reason: "limit", detail: "límite semanal de Sonnet", createdAt: new Date(2026, 9, 23, 1, 20).getTime(),
        },
      ],
    });
    render(<ProvidersPanel />);
    expect(screen.getByText("01:20 · Clau: sonnet → haiku · límite semanal de Sonnet")).toBeTruthy();
  });

  it("Cambiar IA ahora: confirma antes de llamar a task.switch", async () => {
    useStore.setState({
      providers: [claude],
      tasks: [
        { id: "t1", title: "Arreglar login", status: "running", agent_id: "a2" },
        { id: "t2", title: "Otra", status: "review", agent_id: "a3" },
      ],
    });
    mocks.request.mockResolvedValue({ id: "t1", title: "Arreglar login", status: "running" });
    render(<ProvidersPanel />);
    expect(screen.queryByText("Otra")).toBeNull(); // solo running / paused_limit
    const select = screen.getByLabelText("Cambiar la IA de «Arreglar login»");
    // Clau está ocupada, Nico libre: ofrece modelos y a Nico, pero no a Clau ni al jefe.
    expect(within(select).getByRole("option", { name: "Nico" })).toBeTruthy();
    expect(within(select).queryByRole("option", { name: "Jefe" })).toBeNull();
    fireEvent.change(select, { target: { value: "model:haiku" } });
    fireEvent.click(screen.getByRole("button", { name: "Cambiar" }));
    expect(mocks.request).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog").textContent).toContain("¿Pasar «Arreglar login» a haiku?");
    fireEvent.click(screen.getByRole("button", { name: "Sí, cambiar" }));
    await waitFor(() => expect(mocks.request).toHaveBeenCalledWith("task.switch", { taskId: "t1", model: "haiku" }));
    await waitFor(() => expect(useStore.getState().notice).toBe("«Arreglar login» ahora usa haiku."));
  });

  it("cambiar a otro agente manda agentId; cancelar no llama", async () => {
    useStore.setState({ tasks: [{ id: "t1", title: "Tarea", status: "paused_limit", agent_id: "a2" }] });
    mocks.request.mockResolvedValue(null);
    render(<ProvidersPanel />);
    const select = screen.getByLabelText("Cambiar la IA de «Tarea»");
    fireEvent.change(select, { target: { value: "agent:a3" } });
    fireEvent.click(screen.getByRole("button", { name: "Cambiar" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(mocks.request).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cambiar" }));
    fireEvent.click(screen.getByRole("button", { name: "Sí, cambiar" }));
    await waitFor(() => expect(mocks.request).toHaveBeenCalledWith("task.switch", { taskId: "t1", agentId: "a3" }));
  });
});
