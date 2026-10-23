// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../../core/client", () => ({
  core: { request: mocks.request, start: vi.fn(), onEvent: vi.fn(() => () => {}) },
  CoreError: class CoreError extends Error {
    code: string;
    constructor(e: { code: string; message: string }) {
      super(e.message);
      this.code = e.code;
    }
  },
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

import { useStore } from "../../store";
import { resetStore, seed } from "../../store/testing";
import AgentTabs from "./AgentTabs";

const LM = { id: "c1", name: "LM Studio", preset: "lmstudio", baseUrl: "http://localhost:1234/v1", auth: "none", hasSecret: false, defaultModel: "qwen3-coder", contextWindow: 8192, toolQuality: "ok", lastTestAt: 1, lastTestOk: true, agents: [], prices: {} };
const CLAU = { id: "a2", name: "Clau", role: "programador", color: "azul", status: "idle", model: "sonnet", relay_order: ["opus"], auto_relay: 1 };
const calls = (m: string) => mocks.request.mock.calls.filter((c) => c[0] === m);

beforeEach(() => {
  mocks.request.mockReset();
  mocks.request.mockImplementation(async (m: string) => {
    if (m === "connection.list") return [LM];
    if (m === "connection.models") return ["qwen3-coder", "gemma-3"];
    if (m === "agent.update") return CLAU;
    return [];
  });
  resetStore();
  useStore.setState({ skills: [], connections: [] });
  seed({ agents: [CLAU], tasks: [] } as never);
});
afterEach(cleanup);

describe("Perfil con conexiones", () => {
  it("el relevo admite conn:<id>/<modelo> y se envía en relayOrder", async () => {
    render(<AgentTabs selectedId="a2" onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Perfil" }));
    const conn = await screen.findByLabelText("Conexión de relevo");
    await waitFor(() => expect(within_options(conn)).toContain("c1"));
    fireEvent.change(conn, { target: { value: "c1" } });
    await waitFor(() => expect(within_options(screen.getByLabelText("Modelo de relevo"))).toContain("gemma-3"));
    fireEvent.change(screen.getByLabelText("Modelo de relevo"), { target: { value: "gemma-3" } });
    fireEvent.click(screen.getByRole("button", { name: "Añadir al relevo" }));
    expect(screen.getByText("LM Studio · gemma-3")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(calls("agent.update")).toHaveLength(1));
    expect(calls("agent.update")[0]![1]).toEqual({ projectId: "p1", agentId: "a2", relayOrder: ["opus", "conn:c1/gemma-3"] });
  });

  it("cambiar la IA a una conexión envía connectionId y el modelo", async () => {
    render(<AgentTabs selectedId="a2" onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Perfil" }));
    const ia = (await screen.findByLabelText("IA")) as HTMLSelectElement;
    await waitFor(() => expect(within_options(ia)).toContain("c1"));
    fireEvent.change(ia, { target: { value: "c1" } });
    await waitFor(() => expect(within_options(screen.getByLabelText("Modelo"))).toContain("gemma-3"));
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(calls("agent.update")).toHaveLength(1));
    expect(calls("agent.update")[0]![1]).toEqual({ projectId: "p1", agentId: "a2", connectionId: "c1", model: "qwen3-coder" });
  });
});

describe("nombres de conexión y avisos", () => {
  it("el modelo conn:<id>/<m> se pinta como nombre · modelo y el warning de agent.update se muestra", async () => {
    mocks.request.mockImplementation(async (m: string) => {
      if (m === "connection.list") return [LM];
      if (m === "connection.models") return ["qwen3-coder"];
      if (m === "agent.update") return { ...CLAU, name: "Clau2", warning: "el modelo no aparece en la lista de la conexión" };
      return [];
    });
    seed({ agents: [{ ...CLAU, current_model: "conn:c1/qwen3-coder" }], tasks: [] } as never);
    useStore.setState({ connections: [LM] as never });
    render(<AgentTabs selectedId="a2" onSelect={vi.fn()} />);
    expect(screen.getAllByText("LM Studio · qwen3-coder").length).toBeGreaterThan(0);
    expect(screen.queryByText(/conn:c1/)).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Perfil" }));
    fireEvent.change(await screen.findByLabelText("Nombre"), { target: { value: "Clau2" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await screen.findByText(/Aviso: el modelo no aparece en la lista de la conexión/);
  });
});

function within_options(el: HTMLElement): string[] {
  return Array.from((el as HTMLSelectElement).options).map((o) => o.value);
}
