import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderStatus, RelayRow } from "../../shared/protocol";

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
import { relayLine, relayNotice } from "./providers";

const claude: ProviderStatus = { id: "claude", label: "Claude", configured: true, state: "ok", windows: [], models: [] };
const relay = (over: Partial<RelayRow> = {}): RelayRow => ({
  id: 1,
  taskId: "t1",
  fromAgentId: "a2",
  toAgentId: "a2",
  fromModel: "sonnet",
  toModel: "haiku",
  reason: "limit",
  detail: "límite semanal de Sonnet",
  createdAt: new Date(2026, 9, 23, 1, 20).getTime(),
  ...over,
});

beforeEach(() => {
  mocks.request.mockReset();
  useStore.setState({
    providers: [],
    relays: [],
    activity: {},
    drafts: {},
    unavailable: {},
    notice: null,
    agents: [{ id: "a2", name: "Clau" }, { id: "a3", name: "Nico" }],
  });
});

describe("slice de proveedores", () => {
  it("refreshProviders guarda la lista del core", async () => {
    mocks.request.mockResolvedValue([claude]);
    await useStore.getState().refreshProviders();
    expect(mocks.request).toHaveBeenCalledWith("providers.status", undefined);
    expect(useStore.getState().providers).toEqual([claude]);
  });

  it("si el método aún no existe no rompe, no deja aviso y lo marca como no disponible", async () => {
    const { CoreError } = await import("../core/client");
    mocks.request.mockRejectedValue(new CoreError({ code: "unknown_method", message: "x" }));
    await useStore.getState().refreshProviders();
    await useStore.getState().refreshRelays();
    const s = useStore.getState();
    expect(s.providers).toEqual([]);
    expect(s.relays).toEqual([]);
    expect(s.notice).toBeNull();
    expect(s.unavailable["providers.status"]).toBe(true);
    expect(s.unavailable["relays.list"]).toBe(true);
  });

  it("refreshRelays pide el límite y guarda el resultado", async () => {
    mocks.request.mockResolvedValue([relay({ id: 2 }), relay({ id: 1 })]);
    await useStore.getState().refreshRelays();
    expect(mocks.request).toHaveBeenCalledWith("relays.list", { limit: 50 });
    expect(useStore.getState().relays.map((r) => r.id)).toEqual([2, 1]);
  });

  it("applyLimits reemplaza los proveedores", () => {
    useStore.getState().applyLimits([claude]);
    useStore.getState().applyLimits([{ ...claude, state: "limited" }]);
    expect(useStore.getState().providers).toEqual([{ ...claude, state: "limited" }]);
  });

  it("addRelay pone el nuevo arriba y no duplica", () => {
    const { addRelay } = useStore.getState();
    addRelay(relay({ id: 1 }));
    addRelay(relay({ id: 2 }));
    addRelay(relay({ id: 2 }));
    expect(useStore.getState().relays.map((r) => r.id)).toEqual([2, 1]);
  });
});

describe("notificaciones del core", () => {
  const ev = (name: string, payload: unknown) => applyEvent({ type: "event", name, payload });

  it("limits.changed y relay.happened actualizan el store y avisan", () => {
    ev("limits.changed", [claude]);
    expect(useStore.getState().providers).toEqual([claude]);
    ev("relay.happened", relay({ id: 7 }));
    expect(useStore.getState().relays[0].id).toBe(7);
    expect(useStore.getState().notice).toBe("Clau pasó de sonnet a haiku");
  });

  it("event.appended guarda el último evento del agente para el globo", () => {
    ev("event.appended", { agent_id: "a2", kind: "tool", payload: { name: "Read", input: { file_path: "a.ts" } } });
    expect(useStore.getState().activity.a2.kind).toBe("tool");
    ev("event.appended", { agent_id: "a2", kind: "git", payload: {} }); // no cambia el globo
    expect(useStore.getState().activity.a2.kind).toBe("tool");
  });

  it("noteActivity no hace set si el globo no cambia, pero renueva `at` en ¡listo!", () => {
    const { noteActivity } = useStore.getState();
    noteActivity("a2", "tool", { name: "Read", input: { file_path: "a.ts" } }, 1);
    const before = useStore.getState().activity;
    let calls = 0;
    const unsub = useStore.subscribe(() => calls++);
    noteActivity("a2", "tool", { name: "Read", input: { file_path: "a.ts" } }, 2);
    expect(calls).toBe(0);
    expect(useStore.getState().activity).toBe(before);
    noteActivity("a2", "tool", { name: "Edit", input: { file_path: "a.ts" } }, 3);
    expect(calls).toBe(1);
    noteActivity("a2", "status", { type: "done" }, 4);
    noteActivity("a2", "status", { type: "done" }, 5);
    expect(useStore.getState().activity.a2.at).toBe(5);
    unsub();
  });

  it("agent.changed actualiza el agente", () => {
    ev("agent.changed", { id: "a2", name: "Clau 2" });
    expect(useStore.getState().agents.find((a) => a.id === "a2")?.name).toBe("Clau 2");
  });

  it("run.metrics llega al slice de métricas", () => {
    ev("run.metrics", {
      runId: "r1", taskId: "t1", agentId: "a2", model: "sonnet", input: 10, output: 5, cacheRead: 0, cacheWrite: 0,
      contextTokens: 100, contextWindow: 200000, costUsd: 0.01, live: true,
    });
    expect(useStore.getState().liveRuns.r1).toBeDefined();
  });

  it("refreshAll pide también proveedores y relevos", async () => {
    mocks.request.mockResolvedValue([]);
    await useStore.getState().refreshAll();
    const methods = mocks.request.mock.calls.map((c) => c[0]);
    expect(methods).toEqual(expect.arrayContaining(["providers.status", "relays.list", "agent.list", "task.list"]));
  });
});

describe("textos de relevo", () => {
  const agents = [{ id: "a2", name: "Clau" }, { id: "a3", name: "Nico" }];
  it("línea del historial", () => {
    expect(relayLine(relay(), agents)).toBe("01:20 · Clau: sonnet → haiku · límite semanal de Sonnet");
  });
  it("sin detalle usa el motivo", () => {
    expect(relayLine(relay({ detail: "", reason: "manual" }), agents)).toContain("cambio manual");
  });
  it("cambio de agente", () => {
    const r = relay({ toAgentId: "a3", reason: "manual" });
    expect(relayLine(r, agents)).toContain("Clau: Clau → Nico");
    expect(relayNotice(r, agents)).toBe("Clau pasó el trabajo a Nico");
  });
  it("agente desconocido no rompe", () => {
    expect(relayNotice(relay({ fromAgentId: null, toAgentId: null }), [])).toBe("Un robot pasó de sonnet a haiku");
  });
});

describe("borradores", () => {
  it("guarda por robot y se limpia al vaciarlo", () => {
    const { setDraft } = useStore.getState();
    setDraft("a2", { request: "hola", files: "" });
    expect(useStore.getState().drafts.a2.request).toBe("hola");
    setDraft("a2", { request: "", files: "" });
    expect(useStore.getState().drafts).toEqual({});
  });
});
