// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectListItem, WorkspaceOverview, WorkspaceSummary } from "../../../shared/protocol";

const mocks = vi.hoisted(() => ({ request: vi.fn(), pick: vi.fn() }));
vi.mock("../../core/client", () => ({
  core: { request: mocks.request, start: vi.fn(), onEvent: vi.fn(() => () => {}) },
  CoreError: class CoreError extends Error {},
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.pick }));

import { useStore } from "../../store";
import { resetStore } from "../../store/testing";
import { queueInfo, timeAgo } from "../Agents/format";
import Home from "./Home";

const NOW = new Date(2026, 9, 23, 12, 0, 0).getTime();

const ws = (id: string, over: Partial<WorkspaceSummary> = {}): WorkspaceSummary => ({
  projectId: id, name: `proy-${id}`, path: `/r/${id}`, open: true, color: "#5aa9f0", scene: "oficina",
  agents: [{ id: `${id}1`, name: "Ana", model: "sonnet", status: "writing", color: "azul", isBoss: false }],
  liveRuns: 2, queued: 1, needsYou: 1, approvalsPending: 1, tasksByStatus: { running: 2, integrated: 3 },
  costTodayUsd: 3.42, costTotalUsd: 18.7, tokensToday: { input: 412_000, output: 58_000, cacheRead: 2_100_000, cacheWrite: 100_000 },
  lastActivityAt: NOW - 3 * 60_000, ...over,
});
const overview = (workspaces: WorkspaceSummary[]): WorkspaceOverview => ({
  workspaces,
  totals: { costTodayUsd: 4.5, liveRuns: 3, queued: 1, maxConcurrentRuns: 4, dailyBudgetUsd: 10 },
});
const listItem = (w: WorkspaceSummary): ProjectListItem => ({
  projectId: w.projectId, name: w.name, path: w.path, baseBranch: "main", testCommand: null, createdAt: 1, open: w.open,
  lastOpenedAt: 1, color: w.color, scene: w.scene, liveRuns: w.liveRuns, queued: w.queued, needsYou: w.needsYou,
  approvalsPending: w.approvalsPending, tasksByStatus: w.tasksByStatus,
});

function load(workspaces: WorkspaceSummary[]) {
  const ov = overview(workspaces);
  useStore.setState({ overview: ov, projects: workspaces.map(listItem), tabs: workspaces.filter((w) => w.open).map((w) => w.projectId) });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  mocks.request.mockReset();
  mocks.request.mockResolvedValue(null);
  resetStore(null);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Home", () => {
  it("cabecera con los totales globales del overview", () => {
    load([ws("A"), ws("B")]);
    render(<Home />);
    const totals = screen.getByLabelText("Totales globales");
    expect(totals.textContent).toContain("$4,50");
    expect(totals.textContent).toContain("/ $10,00");
    expect(totals.textContent).toContain("3 / 4");
    expect(totals.textContent).toContain("2"); // workspaces abiertos
    expect(screen.getByRole("progressbar", { name: "Gasto de hoy frente al tope diario" }).getAttribute("aria-valuenow")).toBe("45");
    expect(screen.getByRole("progressbar", { name: "Runs vivos frente al máximo" }).getAttribute("aria-valuenow")).toBe("75");
  });

  it("una tarjeta por workspace con sus cifras", () => {
    load([ws("A"), ws("B", { name: "otro", costTodayUsd: 0.5, liveRuns: 0 })]);
    render(<Home />);
    const card = screen.getByLabelText("Workspace proy-A");
    expect(within(card).getByText("/r/A")).toBeTruthy();
    expect(card.textContent).toContain("⚙ 2");
    expect(card.textContent).toContain("⏳ 1");
    expect(card.textContent).toContain("✋ 1");
    expect(card.textContent).toContain("$3,42");
    expect(card.textContent).toContain("$18,70");
    expect(card.textContent).toContain("412,0 k entrada");
    expect(card.textContent).toContain("58,0 k salida");
    expect(card.textContent).toContain("2,2 M caché");
    expect(card.textContent).toContain("Última actividad: hace 3 min");
    expect(within(card).getByRole("img", { name: "Tareas: 2 en curso, 3 integrada" })).toBeTruthy();
    expect(within(card).getByRole("list", { name: "Robots" }).textContent).toContain("Ana");
    expect(screen.getByLabelText("Workspace otro").textContent).toContain("$0,500");
  });

  it("muestra el último relevo", () => {
    load([
      ws("A", {
        lastRelay: { id: 1, projectId: "A", taskId: "t", fromAgentId: "A1", toAgentId: "A1", fromModel: "sonnet", toModel: "haiku", reason: "limit", detail: "", createdAt: NOW - 3_600_000 },
      }),
    ]);
    render(<Home />);
    expect(screen.getByLabelText("Workspace proy-A").textContent).toContain("Último relevo: sonnet → haiku · hace 1 h");
  });

  it("Entrar cambia a la pestaña del workspace", () => {
    load([ws("A"), ws("B")]);
    render(<Home />);
    fireEvent.click(screen.getByRole("button", { name: "Entrar en proy-B" }));
    expect(useStore.getState().activeProjectId).toBe("B");
  });

  it("Cerrar pide confirmación si hay runs vivos y ofrece detenerlos", async () => {
    load([ws("A")]);
    render(<Home />);
    fireEvent.click(screen.getByRole("button", { name: "Cerrar proy-A" }));
    fireEvent.click(screen.getByRole("button", { name: "Detener y cerrar" }));
    await waitFor(() => expect(mocks.request).toHaveBeenCalledWith("project.close", { projectId: "A", force: true }));
  });

  it("los cerrados salen en Recientes y Abrir los reabre", async () => {
    load([ws("A"), ws("Z", { open: false, name: "viejo", agents: [], liveRuns: 0 })]);
    mocks.request.mockImplementation(async (m: string) => (m === "project.open" ? { id: "Z" } : []));
    render(<Home />);
    expect(screen.queryByLabelText("Workspace viejo")).toBeNull();
    const recents = screen.getByRole("heading", { name: "Recientes" }).closest("section")!;
    expect(recents.textContent).toContain("viejo");
    fireEvent.click(within(recents).getByRole("button", { name: "Abrir viejo" }));
    await waitFor(() => expect(mocks.request).toHaveBeenCalledWith("project.open", { path: "/r/Z" }));
  });

  it("sin proyectos: estado vacío con «Abrir proyecto»", () => {
    load([]);
    render(<Home />);
    expect(screen.getByText("Aún no hay ningún proyecto abierto")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Abrir proyecto" }).length).toBeGreaterThan(0);
  });

  it("Editar topes guarda max_concurrent_runs y daily_budget_usd", async () => {
    load([ws("A")]);
    render(<Home />);
    fireEvent.click(screen.getByRole("button", { name: "Editar topes" }));
    fireEvent.change(screen.getByLabelText(/Máximo de runs/), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText(/Tope de gasto diario/), { target: { value: "25" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(mocks.request).toHaveBeenCalledWith("settings.set", { key: "daily_budget_usd", value: "25" }));
    expect(mocks.request).toHaveBeenCalledWith("settings.set", { key: "max_concurrent_runs", value: "5" });
  });
});

describe("formato", () => {
  it("timeAgo", () => {
    expect(timeAgo(NOW - 10_000, NOW)).toBe("hace unos segundos");
    expect(timeAgo(NOW - 3 * 60_000, NOW)).toBe("hace 3 min");
    expect(timeAgo(NOW - 5 * 3_600_000, NOW)).toBe("hace 5 h");
    expect(timeAgo(NOW - 2 * 86_400_000, NOW)).toBe("hace 2 d");
    expect(timeAgo(null, NOW)).toBe("—");
  });
  it("queueInfo usa queue.changed y, si no, la posición de la tarea", () => {
    expect(queueInfo({}, undefined)).toBeNull();
    expect(queueInfo({ queued: true, queue_position: 2 }, undefined)).toEqual({ position: 2, budget: false });
    expect(queueInfo({}, { position: 1, blockedBy: "budget" })).toEqual({ position: 1, budget: true });
  });
});
