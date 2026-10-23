import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunMetrics } from "../../shared/protocol";

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

import { useStore } from ".";
import { createMetricsSlice, type MetricsSlice } from "./metrics";

type Full = ReturnType<typeof useStore.getState> & MetricsSlice;
const st = () => useStore.getState() as Full;

const run = (over: Partial<RunMetrics> = {}): RunMetrics => ({
  runId: "r1", taskId: "t1", agentId: "a2", model: "sonnet",
  input: 100, output: 50, cacheRead: 1000, cacheWrite: 200,
  contextTokens: 1300, contextWindow: 200000, costUsd: 0.01, live: true, ...over,
});

beforeEach(() => {
  mocks.request.mockReset();
  // Instala la slice aunque `index.ts` aún no la componga (con el cableado de C es idempotente).
  useStore.setState(createMetricsSlice(useStore.setState as never, useStore.getState as never, useStore as never));
  useStore.setState({ metricsByAgent: {}, liveRuns: {}, stepsByTask: {}, skills: [], notice: null, unavailable: {} } as never);
});

describe("applyRunMetrics", () => {
  it("guarda el run en vivo y crea los totales del agente", () => {
    st().applyRunMetrics(run());
    expect(st().liveRuns.r1.costUsd).toBe(0.01);
    const m = st().metricsByAgent.a2;
    expect(m.runs).toBe(1);
    expect(m.costUsd).toBeCloseTo(0.01);
    expect(m.lastContextTokens).toBe(1300);
    expect(m.recent).toHaveLength(1);
  });

  it("las actualizaciones del mismo run suman solo la diferencia", () => {
    st().applyRunMetrics(run());
    st().applyRunMetrics(run({ input: 300, output: 80, costUsd: 0.025, contextTokens: 2000 }));
    const m = st().metricsByAgent.a2;
    expect(m.runs).toBe(1);
    expect(m.input).toBe(300);
    expect(m.output).toBe(80);
    expect(m.costUsd).toBeCloseTo(0.025);
    expect(m.lastContextTokens).toBe(2000);
    expect(m.recent).toHaveLength(1);
  });

  it("un run nuevo suma al total y el más nuevo va primero", () => {
    st().applyRunMetrics(run());
    st().applyRunMetrics(run({ runId: "r2", costUsd: 0.5, input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }));
    const m = st().metricsByAgent.a2;
    expect(m.runs).toBe(2);
    expect(m.costUsd).toBeCloseTo(0.51);
    expect(m.recent.map((r) => r.runId)).toEqual(["r2", "r1"]);
  });

  it("al terminar (live:false) sale de liveRuns pero conserva el total", () => {
    st().applyRunMetrics(run());
    st().applyRunMetrics(run({ live: false, costUsd: 0.02 }));
    expect(st().liveRuns.r1).toBeUndefined();
    expect(st().metricsByAgent.a2.costUsd).toBeCloseTo(0.02);
  });

  it("parte de los totales que dio agent.metrics sin contarlos dos veces", () => {
    useStore.setState({
      metricsByAgent: {
        a2: { agentId: "a2", model: "sonnet", runs: 3, costUsd: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
          lastContextTokens: 0, lastContextWindow: 200000, recent: [run({ costUsd: 0.4, input: 100, output: 50, cacheRead: 1000, cacheWrite: 200 })] },
      },
    } as never);
    st().applyRunMetrics(run({ costUsd: 0.5 }));
    expect(st().metricsByAgent.a2.costUsd).toBeCloseTo(1.1);
    expect(st().metricsByAgent.a2.runs).toBe(3);
  });
});

describe("llamadas al core", () => {
  it("refreshMetrics guarda el resultado y, si el método no existe, no deja aviso", async () => {
    mocks.request.mockResolvedValueOnce({ agentId: "a2", model: "opus", runs: 1, costUsd: 2, input: 1, output: 1, cacheRead: 0, cacheWrite: 0, lastContextTokens: 5, lastContextWindow: 10, recent: [] });
    await st().refreshMetrics("a2");
    expect(mocks.request).toHaveBeenCalledWith("agent.metrics", { agentId: "a2" });
    expect(st().metricsByAgent.a2.model).toBe("opus");
    mocks.request.mockRejectedValueOnce(Object.assign(new Error("x"), { code: "unknown_method" }));
    await st().refreshMetrics("a3");
    expect(st().notice).toBeNull();
  });

  it("refreshSteps y refreshSkills guardan las listas", async () => {
    mocks.request.mockResolvedValueOnce([{ name: "Read", target: "a.ts", ok: true, startedAt: 1, endedAt: 2 }]);
    await st().refreshSteps("t1");
    expect(st().stepsByTask.t1).toHaveLength(1);
    mocks.request.mockResolvedValueOnce([{ name: "frontend-design", description: "UI" }]);
    await st().refreshSkills();
    expect(st().skills[0].name).toBe("frontend-design");
  });

  it("switchTask manda los parámetros y fusiona la tarea devuelta", async () => {
    useStore.setState({ tasks: [{ id: "t1", title: "x", status: "running" }] });
    mocks.request.mockResolvedValueOnce({ id: "t1", title: "x", status: "running", agent_id: "a3" });
    expect(await st().switchTask({ taskId: "t1", agentId: "a3" })).toBe(true);
    expect(mocks.request).toHaveBeenCalledWith("task.switch", { taskId: "t1", agentId: "a3" });
    expect(st().tasks[0].agent_id).toBe("a3");
  });

  it("switchTask devuelve false y deja aviso si el core falla", async () => {
    mocks.request.mockRejectedValueOnce(new Error("task.switch: sin límite"));
    expect(await st().switchTask({ taskId: "t1", model: "opus" })).toBe(false);
    expect(st().notice).toBe("task.switch: sin límite");
  });
});
