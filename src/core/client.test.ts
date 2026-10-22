import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));

import { CoreError, createCoreClient } from "./client";

// Simula lo que emite Rust: una línea NDJSON por `core:line`.
let emitLine: (line: string) => void;
const emit = (msg: unknown) => emitLine(JSON.stringify(msg));
const sentRequests = () =>
  mocks.invoke.mock.calls.map(([, args]) => JSON.parse((args as { line: string }).line) as { id: string; method: string; params?: unknown });
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.useRealTimers();
  mocks.invoke.mockReset().mockResolvedValue(undefined);
  mocks.listen.mockReset().mockImplementation(async (_name: string, cb: (e: { payload: string }) => void) => {
    emitLine = (line) => cb({ payload: line });
    return () => {};
  });
});

describe("createCoreClient", () => {
  it("correlaciona respuestas por id aunque lleguen desordenadas", async () => {
    const client = createCoreClient();
    const a = client.request("agent.list");
    const b = client.request("task.list", { x: 1 });
    await tick();
    const [ra, rb] = sentRequests();
    expect(ra.method).toBe("agent.list");
    expect(rb).toMatchObject({ method: "task.list", params: { x: 1 } });
    emit({ id: rb.id, type: "res", result: "B" });
    emit({ id: ra.id, type: "res", result: "A" });
    await expect(a).resolves.toBe("A");
    await expect(b).resolves.toBe("B");
  });

  it("usa un único listen('core:line') para toda la app", async () => {
    const client = createCoreClient();
    void client.request("ping").catch(() => {});
    void client.request("ping").catch(() => {});
    await client.start();
    expect(mocks.listen).toHaveBeenCalledTimes(1);
    expect(mocks.listen.mock.calls[0][0]).toBe("core:line");
  });

  it("rechaza con el error del core", async () => {
    const client = createCoreClient();
    const p = client.request("task.create");
    await tick();
    emit({ id: sentRequests()[0].id, type: "res", error: { code: "unknown_method", message: "método desconocido" } });
    await expect(p).rejects.toMatchObject({ name: "CoreError", code: "unknown_method", message: "método desconocido" });
  });

  it("rechaza por timeout y libera la petición", async () => {
    const client = createCoreClient(50);
    const err = await client.request("ping").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CoreError);
    expect((err as CoreError).code).toBe("timeout");
    // Una respuesta tardía no rompe nada.
    emit({ id: sentRequests()[0].id, type: "res", result: "pong" });
  });

  it("core.ready rechaza las peticiones pendientes y sigue despachando el evento", async () => {
    const client = createCoreClient();
    const handler = vi.fn();
    client.onEvent("core.ready", handler);
    const p = client.request("ping");
    await tick();
    emit({ type: "event", name: "core.ready", payload: { version: "0.1.0" } });
    await expect(p).rejects.toMatchObject({ code: "core_restarted", message: "el core se reinició" });
    expect(handler).toHaveBeenCalledTimes(1);
    // El core nuevo responde a peticiones nuevas.
    const q = client.request("ping");
    await tick();
    emit({ id: sentRequests()[1].id, type: "res", result: "pong" });
    await expect(q).resolves.toBe("pong");
  });

  it("onEvent filtra por nombre, admite '*' y se puede dar de baja", async () => {
    const client = createCoreClient();
    await client.start();
    const solo = vi.fn();
    const todos = vi.fn();
    const off = client.onEvent("task.changed", solo);
    client.onEvent("*", todos);
    emit({ type: "event", name: "task.changed", payload: { id: 1 } });
    emit({ type: "event", name: "agent.status", payload: {} });
    expect(solo).toHaveBeenCalledTimes(1);
    expect(solo.mock.calls[0][0]).toMatchObject({ name: "task.changed", payload: { id: 1 } });
    expect(todos).toHaveBeenCalledTimes(2);
    off();
    emit({ type: "event", name: "task.changed", payload: {} });
    expect(solo).toHaveBeenCalledTimes(1);
  });

  it("ignora líneas que no son JSON y respuestas de ids desconocidos", async () => {
    const client = createCoreClient();
    await client.start();
    expect(() => emitLine("no es json")).not.toThrow();
    expect(() => emit({ id: "zzz", type: "res", result: 1 })).not.toThrow();
  });

  it("falla con 'offline' si no hay Tauri (listen lanza) o si invoke falla", async () => {
    mocks.listen.mockRejectedValueOnce(new Error("no tauri"));
    const client = createCoreClient();
    await expect(client.request("ping")).rejects.toMatchObject({ code: "offline" });

    mocks.invoke.mockRejectedValueOnce("core no disponible");
    await expect(client.request("ping")).rejects.toMatchObject({ code: "offline" });
  });
});
