// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionView, ModelUsage, ProviderStatus } from "../../../shared/protocol";

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
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import { CoreError } from "../../core/client";
import { useStore } from "../../store";
import { useSettings } from "../../store/settings";
import { resetStore } from "../../store/testing";
import ModelsUsed from "./ModelsUsed";
import YourAIs from "./YourAIs";

const providers: ProviderStatus[] = [
  {
    id: "claude", label: "Claude", configured: true, state: "warning",
    windows: [
      { type: "five_hour", status: "allowed", utilization: 0.42, resetsAt: null, seenAt: 1 },
      { type: "seven_day", status: "allowed_warning", utilization: 0.78, resetsAt: null, seenAt: 1 },
    ],
    models: [{ model: "sonnet", agents: ["a1", "a2"], liveRuns: 1, costTodayUsd: 1.5, limitedUntil: null }],
  },
  { id: "ollama", label: "Ollama", configured: false, state: "off", windows: [], models: [] },
  { id: "conn:c1", label: "LM Studio", configured: true, state: "ok", windows: [], models: [{ model: "qwen", agents: ["a1"], liveRuns: 0, costTodayUsd: 0, limitedUntil: null }] },
];
const conn = { id: "c1", name: "LM Studio" } as ConnectionView;
const usage = (model: string, provider: string, runs: number, o: Partial<ModelUsage> = {}): ModelUsage => ({
  model, provider, runs, input: 12_000, output: 3_000, cacheRead: 0, costUsd: 0.5, lastUsedAt: 1, agents: ["Ana"], ...o,
});

beforeEach(() => {
  mocks.request.mockReset();
  resetStore(null);
  useSettings.setState({ demo: false });
  useStore.setState({ providers, connections: [conn] });
});
afterEach(cleanup);

describe("Tus IAs", () => {
  it("una tarjeta por Claude y por conexión, con cupo, robots y gasto; Gestionar abre Conexiones", () => {
    render(<YourAIs />);
    expect(screen.queryByText("Ollama")).toBeNull(); // solo Claude y conn:
    const claude = within(screen.getByRole("listitem", { name: "Claude" }));
    expect(claude.getByRole("progressbar", { name: "Cupo 5 horas" }).getAttribute("aria-valuenow")).toBe("42");
    expect(claude.getByRole("progressbar", { name: "Cupo 7 días" }).getAttribute("aria-valuenow")).toBe("78");
    expect(claude.getByText("2 robots")).toBeTruthy();
    expect(claude.getByText(/Hoy \$1,50/)).toBeTruthy();
    const lm = within(screen.getByRole("listitem", { name: "LM Studio" }));
    expect(lm.getByText("1 robot")).toBeTruthy();
    expect(lm.queryByRole("progressbar")).toBeNull();
    fireEvent.click(lm.getByRole("button", { name: "Gestionar LM Studio" }));
    expect(useStore.getState().connectionsOpen).toBe(true);
  });
});

describe("Modelos más usados", () => {
  it("pide stats.models, nombra legible conn:<id>/<modelo> y cambia de rango", async () => {
    mocks.request.mockImplementation(async (_m: string, p: { range: string }) =>
      p.range === "today" ? [usage("haiku", "claude", 2)] : [usage("sonnet", "claude", 10), usage("conn:c1/qwen3", "c1", 5)],
    );
    render(<ModelsUsed />);
    await waitFor(() => expect(mocks.request).toHaveBeenCalledWith("stats.models", { range: "7d", limit: 10 }));
    expect(await screen.findByText("LM Studio · qwen3")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Tareas de sonnet" }).querySelector("span")?.getAttribute("style")).toContain("100%");
    expect(screen.getByRole("progressbar", { name: "Tareas de LM Studio · qwen3" }).querySelector("span")?.getAttribute("style")).toContain("50%");
    expect(screen.getByRole("button", { name: "7 días" }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Hoy" }));
    await waitFor(() => expect(mocks.request).toHaveBeenCalledWith("stats.models", { range: "today", limit: 10 }));
    expect(await screen.findByText("haiku")).toBeTruthy();
    expect(screen.queryByText("LM Studio · qwen3")).toBeNull();
  });

  it("sin datos: estado vacío amable; sin el método: aún no disponible", async () => {
    mocks.request.mockResolvedValue([]);
    render(<ModelsUsed />);
    expect(await screen.findByText(/Aún no hay uso de modelos/)).toBeTruthy();
    cleanup();
    mocks.request.mockRejectedValue(new CoreError({ code: "unknown_method", message: "x" }));
    render(<ModelsUsed />);
    expect(await screen.findByText(/aún no están disponibles/)).toBeTruthy();
  });
});
