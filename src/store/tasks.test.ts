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

import { useStore } from ".";

beforeEach(() => {
  mocks.request.mockReset();
  useStore.setState({ tasks: [], notice: null });
});

describe("createTask", () => {
  it("manda description y devuelve la tarea creada", async () => {
    mocks.request.mockResolvedValue({ id: "t1", title: "x", status: "assigned" });
    const t = await useStore.getState().createTask({ title: "x", description: "x\ny", files: [], agentId: "a2" });
    expect(mocks.request).toHaveBeenCalledWith("task.create", { title: "x", description: "x\ny", files: [], agent_id: "a2" });
    expect(t?.id).toBe("t1");
    expect(useStore.getState().tasks).toHaveLength(1);
  });

  it("el error del core no repite el prefijo del método", async () => {
    mocks.request.mockRejectedValue(new Error("task.create: falta \"title\" (texto)"));
    expect(await useStore.getState().createTask({ title: "", files: [] })).toBeUndefined();
    expect(useStore.getState().notice).toBe('task.create: falta "title" (texto)');
  });

  it("un error sin prefijo conserva el del método", async () => {
    mocks.request.mockRejectedValue(new Error("no hay un proyecto abierto"));
    await useStore.getState().createTask({ title: "x", files: [] });
    expect(useStore.getState().notice).toBe("task.create: no hay un proyecto abierto");
  });
});
