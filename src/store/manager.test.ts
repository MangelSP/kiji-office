// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { CoreError } from "../core/client";
import { applyEvent, useStore } from ".";
import { P, resetStore, seed } from "./testing";
import { parseIntegrationFailure } from "./manager";

const calls = (m: string) => mocks.request.mock.calls.filter((c) => c[0] === m);
const st = () => useStore.getState();
const fail = (code: string, message: string) => new CoreError({ code, message });

beforeEach(() => {
  mocks.request.mockReset();
  mocks.request.mockResolvedValue(null);
  resetStore();
});

describe("parseIntegrationFailure", () => {
  it("conflicto: saca la lista de archivos", () => {
    const f = parseIntegrationFailure("integration_conflict", "conflicto al hacer rebase: src/a.ts, src/b.ts");
    expect(f).toMatchObject({ kind: "conflict", files: ["src/a.ts", "src/b.ts"] });
    const g = parseIntegrationFailure("", "rebase conflict\n- src/x.ts\n- src/y.ts");
    expect(g).toMatchObject({ kind: "conflict", files: ["src/x.ts", "src/y.ts"] });
  });
  it("tests fallidos: separa la salida", () => {
    expect(parseIntegrationFailure("tests_failed", "Tests fallaron\nFAIL a.test.ts\n1 failed")).toEqual({
      kind: "tests", message: "Tests fallaron", output: "FAIL a.test.ts\n1 failed",
    });
  });
  it("repo sucio y desconocido", () => {
    expect(parseIntegrationFailure("main_dirty", "el repo principal tiene cambios").kind).toBe("dirty");
    expect(parseIntegrationFailure("x", "boom")).toEqual({ kind: "other", message: "boom" });
  });
});

describe("applyTask / revertTask", () => {
  it("integrar con éxito llama a integration.apply y limpia el estado", async () => {
    mocks.request.mockImplementation(async (m: string) => (m === "integration.apply" ? { id: "i1", taskId: "t1", status: "applied", projectId: P } : []));
    expect(await st().applyTask(P, "t1")).toBe(true);
    expect(calls("integration.apply")[0][1]).toEqual({ id: "t1", projectId: P });
    expect(st().integrationRuns.t1).toMatchObject({ busy: false, failure: null });
    expect(st().integrations[P]?.[0].id).toBe("i1");
  });

  it("un fallo del core queda como mensaje legible", async () => {
    mocks.request.mockRejectedValue(fail("tests_failed", "Tests fallaron\nFAIL x"));
    expect(await st().applyTask(P, "t1")).toBe(false);
    expect(st().integrationRuns.t1.failure).toMatchObject({ kind: "tests", output: "FAIL x" });
  });

  it("método ausente: mensaje 'aún no disponible' sin lanzar", async () => {
    mocks.request.mockRejectedValue(fail("unknown_method", "unknown method"));
    expect(await st().applyTask(P, "t1")).toBe(false);
    expect(st().integrationRuns.t1.failure?.message).toMatch(/aún no está disponible/);
    expect(st().unavailable["integration.apply"]).toBe(true);
  });

  it("deshacer busca la integración aplicada de la tarea", async () => {
    useStore.setState({
      integrations: { [P]: [{ id: "i1", projectId: P, taskId: "t1", beforeSha: "a", afterSha: "b", status: "applied", detail: "", createdAt: 1 }] },
    });
    expect(await st().revertTask(P, "t1")).toBe(true);
    expect(calls("integration.revert")[0][1]).toEqual({ integrationId: "i1", projectId: P });
  });

  it("deshacer sin integración conocida avisa y no llama a revert", async () => {
    expect(await st().revertTask(P, "t9")).toBe(false);
    expect(calls("integration.revert")).toHaveLength(0);
    expect(st().notice).toMatch(/No encuentro la integración/);
  });
});

describe("reviewTask", () => {
  it("envía veredicto y hallazgos", async () => {
    await st().reviewTask(P, "t1", "changes", ["falta test"]);
    expect(calls("task.review")[0][1]).toEqual({ id: "t1", projectId: P, verdict: "changes", findings: ["falta test"] });
    await st().reviewTask(P, "t1", "approve");
    expect(calls("task.review")[1][1]).toEqual({ id: "t1", projectId: P, verdict: "approve" });
  });
});

describe("eventos 0.2d", () => {
  it("notify añade a la campana sin duplicar", () => {
    const payload = { projectId: P, id: 7, level: "ask", title: "Pregunta", body: "¿Sigo?", approvalId: "a1" };
    applyEvent({ type: "event", name: "notify", payload });
    applyEvent({ type: "event", name: "notify", payload });
    expect(st().notifications).toHaveLength(1);
    expect(st().notifications[0]).toMatchObject({ id: 7, approvalId: "a1", readAt: null });
  });

  it("manager.halted pone y quita la parada global", () => {
    applyEvent({ type: "event", name: "manager.halted", payload: { halted: true } });
    expect(st().halted).toBe(true);
    applyEvent({ type: "event", name: "manager.halted", payload: { halted: false } });
    expect(st().halted).toBe(false);
  });

  it("manager.action cuelga la acción de su turno; objective.changed actualiza el objetivo", () => {
    applyEvent({
      type: "event", name: "manager.action",
      payload: { id: 1, tickId: "k1", projectId: P, tool: "start_task", input: "", result: "ok", level: "auto", decidedBy: "policy", createdAt: 5 },
    });
    expect(st().diary[P][0]).toMatchObject({ id: "k1", actions: [{ id: 1 }] });
    const o = { id: "o1", projectId: P, text: "x", status: "active", createdAt: 1, tasksByStatus: { integrated: 1 } };
    applyEvent({ type: "event", name: "objective.changed", payload: o });
    applyEvent({ type: "event", name: "objective.changed", payload: { ...o, status: "done" } });
    expect(st().objectives[P]).toHaveLength(1);
    expect(st().objectives[P][0].status).toBe("done");
  });

  it("manager.tick started marca 'pensando' y ended refresca", async () => {
    mocks.request.mockImplementation(async (m: string) =>
      m === "manager.get" ? { policy: null, halted: false, lastTick: null, todayCostUsd: 1 } : [],
    );
    await st().refreshManager(P);
    const tick = { id: "k1", projectId: P, trigger: "t", summary: "", costUsd: 0, startedAt: 1, endedAt: null };
    applyEvent({ type: "event", name: "manager.tick", payload: { projectId: P, phase: "started", tick } });
    expect(st().manager[P].running).toBe(true);
    applyEvent({ type: "event", name: "manager.tick", payload: { projectId: P, phase: "ended", tick: { ...tick, endedAt: 2 } } });
    expect(st().manager[P].running).toBe(false);
    await vi.waitFor(() => expect(calls("manager.diary").length).toBeGreaterThan(0));
  });
});

describe("parada global y avisos", () => {
  it("stopAll / resume guardan halted", async () => {
    mocks.request.mockResolvedValue({ halted: true });
    await st().stopAll();
    expect(st().halted).toBe(true);
    mocks.request.mockResolvedValue({ halted: false });
    await st().resume();
    expect(st().halted).toBe(false);
  });

  it("markRead marca en local y avisa al core", async () => {
    useStore.setState({ notifications: [{ id: 1, projectId: P, level: "info", title: "t", body: "", approvalId: null, readAt: null, createdAt: 1 }] });
    await st().markRead([1]);
    expect(st().notifications[0].readAt).not.toBeNull();
    expect(calls("notifications.markRead")[0][1]).toEqual({ ids: [1] });
  });

  it("sin métodos en el core no se rompe nada", async () => {
    mocks.request.mockRejectedValue(fail("unknown_method", "x"));
    seed({});
    await st().refreshManager(P);
    await st().refreshNotifications();
    expect(st().notifications).toEqual([]);
    expect(st().unavailable["manager.get"]).toBe(true);
  });
});
