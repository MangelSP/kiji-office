// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../core/client", () => ({
  core: { request: mocks.request, start: vi.fn(), onEvent: vi.fn(() => () => {}) },
  CoreError: class CoreError extends Error {},
}));

import { useStore } from "../store";
import { createMetricsSlice } from "../store/metrics";
import { contextSegments } from "../screens/Agents/format";
import AgentStrip from "./AgentStrip";

const BOSS = { id: "a1", name: "Jefe", color: "terracota", is_boss: 1, status: "thinking", model: "opus" };
const CLAU = { id: "a2", name: "Clau", color: "azul", status: "idle", model: "sonnet" };

const metrics = (id: string, used: number, cost = 1.5) => ({
  agentId: id, model: "sonnet", runs: 1, costUsd: cost, input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
  lastContextTokens: used, lastContextWindow: 200000, recent: [],
});

beforeEach(() => {
  mocks.request.mockReset();
  mocks.request.mockRejectedValue(new Error("sin core"));
  useStore.setState(createMetricsSlice(useStore.setState as never, useStore.getState as never, useStore as never));
  useStore.setState({ agents: [BOSS, CLAU], liveRuns: {}, metricsByAgent: {} } as never);
});
afterEach(cleanup);

describe("contextSegments", () => {
  it("llena 8 segmentos y cambia de color en 6/8 y 7/8", () => {
    expect(contextSegments(0, 200000)).toEqual({ filled: 0, level: "ok" });
    expect(contextSegments(1, 200000)).toEqual({ filled: 1, level: "ok" });
    expect(contextSegments(100000, 200000)).toEqual({ filled: 4, level: "ok" });
    expect(contextSegments(125000, 200000)).toEqual({ filled: 5, level: "ok" });
    expect(contextSegments(130000, 200000)).toEqual({ filled: 6, level: "warn" });
    expect(contextSegments(160000, 200000)).toEqual({ filled: 7, level: "high" });
    expect(contextSegments(999999, 200000)).toEqual({ filled: 8, level: "high" });
    expect(contextSegments(10, 0)).toEqual({ filled: 0, level: "ok" });
  });
});

describe("AgentStrip", () => {
  it("pinta el medidor con color según el uso y el tooltip con números", () => {
    useStore.setState({ metricsByAgent: { a1: metrics("a1", 100000), a2: metrics("a2", 150000, 0.004) } } as never);
    const { container } = render(<AgentStrip selectedId={null} onSelect={vi.fn()} />);
    const meters = container.querySelectorAll(".strip-meter");
    expect(meters).toHaveLength(2);
    expect(meters[0].querySelectorAll(".strip-seg")).toHaveLength(8);
    expect(meters[0].querySelectorAll(".strip-seg.is-on")).toHaveLength(4);
    expect(meters[0].className).toContain("is-ok");
    expect(meters[1].querySelectorAll(".strip-seg.is-on")).toHaveLength(6);
    expect(meters[1].className).toContain("is-warn");
    expect(meters[0].getAttribute("title")).toBe("Contexto: 100,0 k de 200,0 k (50 %)");
    expect(screen.getByText("$1,50")).toBeTruthy();
  });

  it("un run en vivo manda sobre los totales y a 7/8 se pone en coral", () => {
    useStore.setState({
      metricsByAgent: { a1: metrics("a1", 1000) },
      liveRuns: { r9: { runId: "r9", taskId: "t", agentId: "a1", model: "opus", input: 0, output: 0, cacheRead: 0, cacheWrite: 0, contextTokens: 180000, contextWindow: 200000, costUsd: 1, live: true } },
    } as never);
    const { container } = render(<AgentStrip selectedId={null} onSelect={vi.fn()} />);
    const meter = container.querySelector(".strip-meter")!;
    expect(meter.className).toContain("is-high");
    expect(meter.querySelectorAll(".strip-seg.is-on")).toHaveLength(8);
    expect(screen.getAllByText("opus").length).toBeGreaterThan(0);
  });

  it("clic selecciona, el seleccionado queda marcado y el jefe tiene su clase", () => {
    const onSelect = vi.fn();
    render(<AgentStrip selectedId="a2" onSelect={onSelect} />);
    const clau = screen.getByRole("button", { name: /^Clau/ });
    const jefe = screen.getByRole("button", { name: /^Jefe/ });
    expect(clau.getAttribute("aria-pressed")).toBe("true");
    expect(jefe.getAttribute("aria-pressed")).toBe("false");
    expect(jefe.className).toContain("is-boss");
    expect(clau.className).not.toContain("is-boss");
    fireEvent.click(jefe);
    expect(onSelect).toHaveBeenCalledWith("a1");
  });
});
