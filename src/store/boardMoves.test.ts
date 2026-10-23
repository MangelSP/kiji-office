import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../core/client", () => ({
  core: { request: vi.fn(), start: vi.fn(), onEvent: vi.fn(() => () => {}) },
  CoreError: class CoreError extends Error {},
}));

import { applyEvent } from ".";
import { P, proj, resetStore } from "./testing";

beforeEach(() => resetStore());

describe("board.moved", () => {
  it("se encola en la partición del proyecto con seq creciente", () => {
    const ev = { taskId: "t1", agentId: "a1", from: "refined", to: "doing_dev", auto: true };
    applyEvent({ name: "board.moved", payload: { projectId: P, ...ev } } as never);
    applyEvent({ name: "board.moved", payload: { projectId: P, ...ev, to: "committed" } } as never);
    const q = proj().boardMoves;
    expect(q.map((m) => m.to)).toEqual(["doing_dev", "committed"]);
    expect(q[1].seq).toBeGreaterThan(q[0].seq);
    expect(proj("otro").boardMoves).toEqual([]);
  });
});
