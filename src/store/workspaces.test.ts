import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectListItem, WorkspaceOverview } from "../../shared/protocol";

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

import { applyEvent, useStore } from ".";
import { proj, resetStore, seed } from "./testing";

const item = (id: string, over: Partial<ProjectListItem> = {}): ProjectListItem => ({
  projectId: id, name: id, path: `/r/${id}`, baseBranch: "main", testCommand: null, createdAt: 1, open: true, lastOpenedAt: 1,
  color: null, scene: "oficina", liveRuns: 0, queued: 0, needsYou: 0, approvalsPending: 0, tasksByStatus: {}, ...over,
});
const ev = (name: string, payload: unknown) => applyEvent({ type: "event", name, payload });

beforeEach(() => {
  mocks.request.mockReset();
  resetStore("A");
});

describe("eventos enrutados por proyecto", () => {
  it("cada evento va a la partición de su payload.projectId y no se mezcla", () => {
    ev("agent.changed", { projectId: "A", id: "a1", name: "Ana" });
    ev("agent.changed", { projectId: "B", id: "b1", name: "Beto" });
    ev("task.changed", { projectId: "A", id: "t1", title: "de A", status: "running" });
    ev("task.changed", { projectId: "B", id: "t2", title: "de B", status: "todo" });
    ev("approval.requested", { projectId: "B", id: "ap1", agent_id: "b1" });
    ev("event.appended", { projectId: "B", agent_id: "b1", kind: "tool", payload: { name: "Read", input: { file_path: "x.ts" } } });
    ev("run.metrics", { projectId: "B", runId: "r1", taskId: "t2", agentId: "b1", model: "sonnet", costUsd: 0.5, live: true });
    ev("agent.status", { projectId: "A", agent_id: "a1", status: "writing" });

    expect(proj("A").agents).toMatchObject([{ id: "a1", name: "Ana", status: "writing" }]);
    expect(proj("A").tasks.map((t) => t.id)).toEqual(["t1"]);
    expect(proj("A").approvals).toEqual([]);
    expect(proj("A").activity).toEqual({});
    expect(proj("A").liveRuns).toEqual({});
    expect(proj("B").agents.map((a) => a.id)).toEqual(["b1"]);
    expect(proj("B").tasks.map((t) => t.id)).toEqual(["t2"]);
    expect(proj("B").approvals.map((a) => a.id)).toEqual(["ap1"]);
    expect(proj("B").activity.b1.kind).toBe("tool");
    expect(Object.keys(proj("B").liveRuns)).toEqual(["r1"]);
    expect(proj("B").metricsByAgent.b1.costUsd).toBeCloseTo(0.5);
    // Y el registro en vivo de cada uno solo trae lo suyo.
    expect(proj("A").events.map((e) => e.name)).toEqual(["agent.changed", "task.changed", "agent.status"]);
    expect(proj("B").events).toHaveLength(5);
  });

  it("un evento de un workspace en segundo plano no toca el que se ve", () => {
    seed({ tasks: [{ id: "t1", title: "visible", status: "running" }] }, "A");
    const before = proj("A");
    ev("task.changed", { projectId: "B", id: "t1", title: "mismo id en otro proyecto", status: "failed" });
    expect(proj("A")).toBe(before);
    expect(proj("B").tasks[0].title).toBe("mismo id en otro proyecto");
  });

  it("un evento de proyecto sin projectId se ignora (no se pega en la pestaña activa)", () => {
    ev("task.changed", { id: "t9", title: "huérfana", status: "todo" });
    expect(proj("A").tasks).toEqual([]);
  });

  it("agent.status con projectId null busca al agente en las particiones", () => {
    seed({ agents: [{ id: "b1", name: "Beto", status: "idle" }] }, "B");
    ev("agent.status", { projectId: null, agent_id: "b1", status: "thinking" });
    expect(proj("B").agents[0].status).toBe("thinking");
  });

  it("limits.changed (de la cuenta) no es de ningún proyecto", () => {
    ev("limits.changed", []);
    expect(useStore.getState().coreEvents.map((e) => e.name)).toContain("limits.changed");
    expect(Object.keys(useStore.getState().byProject)).toEqual([]);
  });

  it("el relevo de un workspace oculto avisa con el nombre del proyecto", () => {
    useStore.setState({ projects: [item("A"), item("B", { name: "web" })] });
    seed({ agents: [{ id: "b1", name: "Beto" }] }, "B");
    ev("relay.happened", {
      id: 1, projectId: "B", taskId: "t", fromAgentId: "b1", toAgentId: "b1", fromModel: "sonnet", toModel: "haiku",
      reason: "limit", detail: "", createdAt: 1,
    });
    expect(proj("B").relays).toHaveLength(1);
    expect(proj("A").relays).toEqual([]);
    expect(useStore.getState().notice).toBe("web: Beto pasó de sonnet a haiku");
  });
});

describe("cola, tope de gasto y resumen", () => {
  it("queue.changed guarda y quita la posición y el motivo en su proyecto", () => {
    ev("queue.changed", { projectId: "B", taskId: "t1", queued: true, position: 2, blockedBy: "budget" });
    expect(proj("B").queue.t1).toMatchObject({ position: 2, blockedBy: "budget" });
    expect(proj("A").queue).toEqual({});
    ev("queue.changed", { projectId: "B", taskId: "t1", queued: false, position: 0, blockedBy: null });
    expect(proj("B").queue).toEqual({});
  });

  it("budget.reached deja un aviso visible", () => {
    ev("budget.reached", { costTodayUsd: 10.2, dailyBudgetUsd: 10, message: "Tope diario alcanzado" });
    expect(useStore.getState().budgetNotice?.message).toBe("Tope diario alcanzado");
  });

  it("workspaces.changed guarda el resumen y actualiza los contadores de las pestañas", () => {
    useStore.setState({ projects: [item("A")], tabs: ["A"] });
    const overview: WorkspaceOverview = {
      totals: { costTodayUsd: 1, liveRuns: 2, queued: 1, maxConcurrentRuns: 3, dailyBudgetUsd: 10 },
      workspaces: [
        {
          projectId: "A", name: "A", path: "/r/A", open: true, color: "#112233", scene: "oficina", agents: [], liveRuns: 2, queued: 1,
          needsYou: 1, approvalsPending: 3, tasksByStatus: { running: 2 }, costTodayUsd: 1, costTotalUsd: 2,
          tokensToday: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, lastActivityAt: null,
        },
      ],
    };
    ev("workspaces.changed", overview);
    const a = useStore.getState().projects[0];
    expect(useStore.getState().overview).toEqual(overview);
    expect(a).toMatchObject({ liveRuns: 2, queued: 1, approvalsPending: 3, color: "#112233" });
  });
});

describe("arranque y ciclo de vida", () => {
  it("bootstrap: project.reopen primero y luego project.list + workspaces.overview; carga cada workspace abierto", async () => {
    const overview: WorkspaceOverview = {
      workspaces: [],
      totals: { costTodayUsd: 0, liveRuns: 0, queued: 0, maxConcurrentRuns: 3, dailyBudgetUsd: 10 },
    };
    mocks.request.mockImplementation(async (m: string) => {
      if (m === "project.reopen") return { opened: [item("A"), item("B")], failed: [] };
      if (m === "project.list") return [item("A"), item("B"), item("C", { open: false })];
      if (m === "workspaces.overview") return overview;
      return [];
    });
    await useStore.getState().bootstrap();
    const methods = mocks.request.mock.calls.map((c) => c[0]);
    expect(methods).toContain("project.reopen");
    expect(methods.indexOf("project.list")).toBeGreaterThan(methods.indexOf("project.reopen"));
    expect(methods.indexOf("workspaces.overview")).toBeGreaterThan(methods.indexOf("project.reopen"));
    expect(useStore.getState().tabs).toEqual(["A", "B"]);
    const agentCalls = mocks.request.mock.calls.filter((c) => c[0] === "agent.list").map((c) => c[1]);
    expect(agentCalls).toEqual(expect.arrayContaining([{ projectId: "A" }, { projectId: "B" }]));
    expect(useStore.getState().booted).toBe(true);
  });

  it("core.ready vuelve a reabrir los proyectos tras un reinicio del core", async () => {
    mocks.request.mockImplementation(async (m: string) => (m === "ping" ? "pong" : m === "project.reopen" ? { opened: [], failed: [] } : []));
    ev("core.ready", {});
    await vi.waitFor(() => expect(mocks.request.mock.calls.map((c) => c[0])).toContain("project.reopen"));
  });

  it("closeProject manda force, tira su partición y vuelve al Home si era el activo", async () => {
    useStore.setState({ projects: [item("A"), item("B")], tabs: ["A", "B"], activeProjectId: "A" });
    seed({ tasks: [{ id: "t", title: "x", status: "todo" }] }, "A");
    mocks.request.mockImplementation(async (m: string) => (m === "project.close" ? { projectId: "A", closed: true, stoppedRuns: 1 } : m === "project.list" ? [item("B")] : null));
    expect(await useStore.getState().closeProject("A", true)).toBe(true);
    expect(mocks.request).toHaveBeenCalledWith("project.close", { projectId: "A", force: true });
    expect(useStore.getState().byProject.A).toBeUndefined();
    expect(useStore.getState().activeProjectId).toBeNull();
    expect(useStore.getState().tabs).toEqual(["B"]);
  });

  it("si el core rechaza cerrar (runs vivos) deja la pestaña y avisa", async () => {
    useStore.setState({ projects: [item("A")], tabs: ["A"], activeProjectId: "A" });
    mocks.request.mockRejectedValue(new Error("project.close: «A» tiene 1 run(s) en marcha"));
    expect(await useStore.getState().closeProject("A")).toBe(false);
    expect(useStore.getState().tabs).toEqual(["A"]);
    expect(useStore.getState().notice).toContain("run(s) en marcha");
  });

  it("openProject abre, carga el workspace y lo activa; las peticiones llevan su projectId", async () => {
    mocks.request.mockImplementation(async (m: string) => {
      if (m === "project.open") return { id: "N", name: "nuevo" };
      if (m === "project.list") return [item("N", { name: "nuevo" })];
      return [];
    });
    expect(await useStore.getState().openProject("/r/nuevo")).toBe("N");
    expect(useStore.getState().activeProjectId).toBe("N");
    expect(useStore.getState().tabs).toEqual(["N"]);
    expect(mocks.request).toHaveBeenCalledWith("task.list", { projectId: "N" });
  });

  it("enterWorkspace de uno cerrado lo abre (reabre por su ruta)", async () => {
    useStore.setState({ projects: [item("C", { open: false })], tabs: [] });
    mocks.request.mockImplementation(async (m: string) => (m === "project.open" ? { id: "C" } : m === "project.list" ? [item("C")] : []));
    await useStore.getState().enterWorkspace("C");
    expect(mocks.request).toHaveBeenCalledWith("project.open", { path: "/r/C" });
    expect(useStore.getState().activeProjectId).toBe("C");
  });
});
