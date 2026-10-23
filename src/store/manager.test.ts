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
import { integrationFailureFromError, integrationFailureFromView } from "./manager";

const calls = (m: string) => mocks.request.mock.calls.filter((c) => c[0] === m);
const st = () => useStore.getState();
const fail = (code: string, message: string) => new CoreError({ code, message });

beforeEach(() => {
  mocks.request.mockReset();
  mocks.request.mockResolvedValue(null);
  resetStore();
});

describe("fallos de integración", () => {
  it("desde la vista: conflicto con archivos, tests con salida, merge", () => {
    expect(integrationFailureFromView({ detail: "d", reason: "conflict", files: ["a.ts", "b.ts"] })).toEqual({ kind: "conflict", files: ["a.ts", "b.ts"], message: "d" });
    expect(integrationFailureFromView({ detail: "d", reason: "tests_failed", output: "FAIL x" })).toEqual({ kind: "tests", output: "FAIL x", message: "d" });
    expect(integrationFailureFromView({ detail: "boom", reason: "merge" }).kind).toBe("merge");
    expect(integrationFailureFromView({ detail: "boom" })).toEqual({ kind: "other", message: "boom" });
  });
  it("error con code dirty: mensaje con la rama base", () => {
    expect(integrationFailureFromError("dirty", "x", "main")).toEqual({
      kind: "dirty",
      message: "Tu repo principal tiene cambios sin guardar o está en otra rama: haz commit o cambia a main y vuelve a intentarlo",
    });
    expect(integrationFailureFromError("x", "boom")).toEqual({ kind: "other", message: "boom" });
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

  it("integration.apply devuelve status failed (no lanza): conflicto, tests y merge", async () => {
    const view = (extra: object) => ({ id: "i2", projectId: P, taskId: "t1", status: "failed", detail: "d", ...extra });
    mocks.request.mockResolvedValueOnce(view({ reason: "tests_failed", output: "FAIL x" }));
    expect(await st().applyTask(P, "t1")).toBe(false);
    expect(st().integrationRuns.t1.failure).toMatchObject({ kind: "tests", output: "FAIL x" });
    mocks.request.mockResolvedValueOnce(view({ reason: "conflict", files: ["a.ts"] }));
    expect(await st().applyTask(P, "t1")).toBe(false);
    expect(st().integrationRuns.t1.failure).toMatchObject({ kind: "conflict", files: ["a.ts"] });
    mocks.request.mockResolvedValueOnce(view({ reason: "merge" }));
    await st().applyTask(P, "t1");
    expect(st().integrationRuns.t1.failure?.kind).toBe("merge");
  });

  it("error code dirty: usa la rama base del proyecto", async () => {
    useStore.setState({ projects: [{ projectId: P, baseBranch: "develop" } as never] });
    mocks.request.mockRejectedValue(fail("dirty", "sucio"));
    expect(await st().applyTask(P, "t1")).toBe(false);
    expect(st().integrationRuns.t1.failure).toEqual({
      kind: "dirty",
      message: "Tu repo principal tiene cambios sin guardar o está en otra rama: haz commit o cambia a develop y vuelve a intentarlo",
    });
  });

  it("integration.changed: fases rebase -> tests -> merge y done las cierra", () => {
    const ev = (phase: string) => applyEvent({ type: "event", name: "integration.changed", payload: { projectId: P, taskId: "t1", phase } });
    ev("rebase");
    expect(st().integrationRuns.t1.phase).toBe("rebase");
    ev("merge");
    expect(st().integrationRuns.t1.phase).toBe("merge");
    ev("done");
    expect(st().integrationRuns.t1.phase).toBeNull();
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

describe("answerApproval", () => {
  it("manda la opción elegida solo si se permite", async () => {
    seed({ approvals: [{ id: "a1", tool: "manager:ask" }, { id: "a2", tool: "manager:ask" }] });
    await st().answerApproval(P, "a1", true, "Sí, hoy");
    expect(calls("approval.answer")[0][1]).toEqual({ id: "a1", allow: true, projectId: P, option: "Sí, hoy" });
    await st().answerApproval(P, "a2", false);
    expect(calls("approval.answer")[1][1]).toEqual({ id: "a2", allow: false, projectId: P });
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

  it("manager.action reemitida al resolverse actualiza la fila por id", () => {
    const a = { id: 1, tickId: "k1", projectId: P, tool: "ask", input: "", result: "", level: "ask", decidedBy: null, createdAt: 5 };
    applyEvent({ type: "event", name: "manager.action", payload: a });
    applyEvent({ type: "event", name: "manager.action", payload: { ...a, result: "ok", decidedBy: "user" } });
    expect(st().diary[P][0].actions).toHaveLength(1);
    expect(st().diary[P][0].actions[0]).toMatchObject({ result: "ok", decidedBy: "user" });
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

  it("archiveMemory y markRead 'all' usan los params del contrato", async () => {
    useStore.setState({ memory: { [P]: [{ id: 3 } as never] } });
    await st().archiveMemory(P, 3);
    expect(calls("memory.archive")[0][1]).toEqual({ projectId: P, id: 3 });
    await st().markRead("all");
    expect(calls("notifications.markRead")[0][1]).toEqual({ ids: "all" });
  });

  it("task.start con parada global: aviso claro", async () => {
    mocks.request.mockRejectedValue(fail("error", "Parada global activa: no se arranca nada hasta que pulses «Reanudar»."));
    await st().startTask(P, "t1");
    expect(st().notice).toBe("Parada global activa: no se arranca nada hasta que pulses «Reanudar».");
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
