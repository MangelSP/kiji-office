// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionView, ManagerDiaryEntry, ManagerPolicy } from "../../../shared/protocol";

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

import { applyEvent, useStore } from "../../store";
import { P, resetStore, seed } from "../../store/testing";
import ManagerDiary from "./ManagerDiary";
import ManagerSettings from "./ManagerSettings";
import MemoryPanel from "./MemoryPanel";
import ObjectivesList, { objectiveProgress } from "./ObjectivesList";
import { brainInfo, defaultPolicy, pickBrain, presetOf, PRESETS, validateLimits } from "./policy";

const calls = (m: string) => mocks.request.mock.calls.filter((c) => c[0] === m);
const conn = (over: Partial<ConnectionView>): ConnectionView => ({
  id: "c1", name: "LM Studio", preset: "lmstudio", baseUrl: "", auth: "none", hasSecret: false, defaultModel: null,
  contextWindow: 8192, toolQuality: "ok", lastTestAt: null, lastTestOk: null, agents: [], prices: {}, ...over,
});
const BOSS = { id: "a1", name: "Jefe", is_boss: 1, provider: "claude", model: "opus" };
const ANA = { id: "a2", name: "Ana", provider: "api", connection_id: "c1", model: "conn:c1/qwen" };

beforeEach(() => {
  mocks.request.mockReset();
  mocks.request.mockImplementation(async () => null);
  resetStore();
  seed({ agents: [BOSS, ANA] });
});
afterEach(cleanup);

describe("policy", () => {
  it("las plantillas coinciden con el contrato", () => {
    expect(PRESETS.prudente).toEqual({ plan: "notify", assign: "ask", start: "ask", retry: "ask", relay: "ask", integrate: "ask", spend: "ask" });
    expect(PRESETS.equilibrado).toEqual({ plan: "auto", assign: "auto", start: "auto", retry: "auto", relay: "notify", integrate: "ask", spend: "ask" });
    expect(PRESETS.autonomo).toEqual({ plan: "auto", assign: "auto", start: "auto", retry: "auto", relay: "auto", integrate: "ask", spend: "ask" });
    expect(presetOf(PRESETS.autonomo)).toBe("autonomo");
    expect(presetOf({ ...PRESETS.autonomo, start: "ask" })).toBeNull();
  });
  it("recomienda Claude o una conexión con toolQuality ok y avisa del resto", () => {
    expect(brainInfo(BOSS, []).ok).toBe(true);
    expect(brainInfo(ANA, [conn({ toolQuality: "ok" })]).ok).toBe(true);
    const weak = brainInfo(ANA, [conn({ toolQuality: "weak" })]);
    expect(weak.ok).toBe(false);
    expect(weak.note).toMatch(/Poco recomendable/);
    expect(brainInfo({ ...ANA, connection_id: "nada" }, []).ok).toBe(false);
    expect(pickBrain([{ ...BOSS, provider: "ollama" }, ANA], [conn({})])).toBe("a2");
    expect(pickBrain([BOSS, ANA], [])).toBe("a1");
  });
  it("valida límites", () => {
    expect(validateLimits(defaultPolicy("a1"))).toEqual([]);
    expect(validateLimits({ ...defaultPolicy("a1"), spendAskUsd: 20 })).toHaveLength(1);
    expect(validateLimits({ ...defaultPolicy("a1"), askTimeoutMinutes: 0 })).toHaveLength(1);
  });
});

describe("ManagerSettings", () => {
  it("activar abre el asistente de 3 pasos y guarda con manager.set", async () => {
    useStore.setState({ connections: [conn({ toolQuality: "weak" })] });
    render(<ManagerSettings projectId={P} />);
    expect(screen.getByTestId("manager-status").textContent).toBe("apagado");
    fireEvent.click(screen.getByRole("switch", { name: "Gerente autónomo" }));

    // Paso 1: cerebro. El jefe (Claude) es el recomendado; la conexión débil lleva aviso.
    expect(screen.getByText(/Paso 1 de 3/)).toBeTruthy();
    expect(screen.getByText(/Recomendado/)).toBeTruthy();
    expect(screen.getByText(/Poco recomendable: usa herramientas con fallos/)).toBeTruthy();
    expect((screen.getByRole("radio", { name: /Jefe/ }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));

    // Paso 2: deslizador + Ajustar.
    expect(screen.getByText(/Paso 2 de 3/)).toBeTruthy();
    const slider = screen.getByRole("slider", { name: "Nivel general" }) as HTMLInputElement;
    expect(slider.value).toBe("1");
    fireEvent.change(slider, { target: { value: "0" } });
    expect(screen.getByTestId("preset-help").textContent).toMatch(/Planea y te avisa/);
    fireEvent.click(screen.getByRole("button", { name: "Ajustar" }));
    const rows = screen.getByRole("list", { name: "Nivel por categoría" });
    expect(within(rows).getAllByRole("group")).toHaveLength(7);
    expect(rows.querySelectorAll('[data-locked="true"]')).toHaveLength(6);
    expect(rows.textContent).toContain("esto siempre te lo pregunto");
    fireEvent.click(within(within(rows).getByRole("group", { name: "Arrancar tareas" })).getByRole("button", { name: "Auto" }));
    expect(screen.getByTestId("preset-help").textContent).toMatch(/Personalizado/);
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));

    // Paso 3: límites.
    expect(screen.getByText(/Paso 3 de 3/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Tope del día (USD)"), { target: { value: "20" } });
    fireEvent.click(screen.getByLabelText(/Horas de silencio/));
    fireEvent.click(screen.getByRole("button", { name: "Guardar y activar" }));
    await waitFor(() => expect(calls("manager.set")).toHaveLength(1));
    const sent = calls("manager.set")[0][1] as { projectId: string; policy: ManagerPolicy };
    expect(sent.projectId).toBe(P);
    expect(sent.policy).toMatchObject({
      enabled: true, brain: { agentId: "a1" }, spendAskUsd: 5, dayBudgetUsd: 20, askTimeoutMinutes: 60,
      quietHours: { from: "23:00", to: "08:00" },
      levels: { ...PRESETS.prudente, start: "auto" },
    });
  });

  it("los límites inválidos bloquean el guardado", () => {
    render(<ManagerSettings projectId={P} />);
    fireEvent.click(screen.getByRole("switch"));
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    fireEvent.change(screen.getByLabelText(/Gasto del día para preguntarte/), { target: { value: "99" } });
    expect(screen.getByRole("alert").textContent).toMatch(/no puede superar el tope/);
    expect((screen.getByRole("button", { name: "Guardar y activar" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("activo: estado, gasto, último turno y 'Habla con el gerente'", async () => {
    const policy = { ...defaultPolicy("a1") };
    useStore.setState({
      manager: {
        [P]: { projectId: P, policy, halted: false, running: false, todayCostUsd: 2.35,
          lastTick: { id: "k", projectId: P, trigger: "x", summary: "Arrancó la validación", costUsd: 0, startedAt: Date.now() - 180_000, endedAt: null } },
      },
    });
    render(<ManagerSettings projectId={P} />);
    expect(screen.getByTestId("manager-status").textContent).toBe("activo");
    expect(screen.getByText(/Arrancó la validación/).textContent).toContain("hace 3 min");
    expect(screen.getByText("$2,35")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Mensaje para el gerente"), { target: { value: "prioriza el login" } });
    fireEvent.click(screen.getByRole("button", { name: "Habla con el gerente" }));
    await waitFor(() => expect(calls("manager.tick")).toHaveLength(1));
    expect(calls("manager.tick")[0][1]).toEqual({ projectId: P, message: "prioriza el login" });
    act(() => useStore.setState({ manager: { [P]: { ...useStore.getState().manager[P], running: true } } }));
    expect(screen.getByTestId("manager-status").textContent).toBe("pensando");
    act(() => applyEvent({ type: "event", name: "manager.halted", payload: { halted: true } }));
    expect(screen.getByTestId("manager-status").textContent).toBe("parado");
  });

  it("apagar guarda la política con enabled=false", async () => {
    useStore.setState({ manager: { [P]: { projectId: P, policy: defaultPolicy("a1"), halted: false, running: false, lastTick: null, todayCostUsd: 0 } } });
    render(<ManagerSettings projectId={P} />);
    fireEvent.click(screen.getByRole("switch", { name: "Gerente autónomo" }));
    await waitFor(() => expect(calls("manager.set")).toHaveLength(1));
    expect((calls("manager.set")[0][1] as { policy: ManagerPolicy }).policy.enabled).toBe(false);
  });

  it("sin el método en el core: 'aún no disponible'", async () => {
    mocks.request.mockRejectedValue(Object.assign(new Error("x"), { code: "unknown_method", name: "CoreError" }));
    useStore.setState({ unavailable: { "manager.get": true } });
    render(<ManagerSettings projectId={P} />);
    expect(screen.getByText(/Aún no disponible/)).toBeTruthy();
  });
});

describe("ManagerDiary", () => {
  const entry = (id: string, startedAt: number, actions: ManagerDiaryEntry["actions"] = []): ManagerDiaryEntry => ({
    id, projectId: P, trigger: "task.changed", summary: `Resumen ${id}`, costUsd: 0.5, startedAt, endedAt: startedAt + 1, actions,
  });
  const act1 = (id: number, tickId: string, level: "auto" | "notify" | "ask", decidedBy: "policy" | "user" | "timeout" | null) => ({
    id, tickId, projectId: P, tool: `tool_${id}`, input: "", result: "hecho", level, decidedBy, createdAt: 1,
  });

  it("cronología con coste, icono por nivel y quién decidió; filtro 'solo lo que decidió solo'", () => {
    useStore.setState({
      diary: {
        [P]: [
          entry("old", 1000, [act1(1, "old", "ask", "timeout")]),
          entry("new", 5000, [act1(2, "new", "auto", "policy"), act1(3, "new", "ask", "user"), act1(4, "new", "notify", "policy")]),
          entry("vacio", 3000),
        ],
      },
    });
    render(<ManagerDiary projectId={P} />);
    const ticks = within(screen.getByRole("list", { name: "Diario del gerente" })).getAllByRole("listitem", { name: /^Turno/ });
    expect(ticks.map((t) => t.getAttribute("aria-label"))).toEqual(["Turno Resumen new", "Turno Resumen vacio", "Turno Resumen old"]);
    expect(ticks[0].textContent).toContain("$0,500");
    expect(ticks[0].textContent).toContain("decidió: política");
    expect(ticks[0].textContent).toContain("decidió: tú");
    expect(within(ticks[0]).getByRole("img", { name: "automático" })).toBeTruthy();
    expect(within(ticks[0]).getByRole("img", { name: "avisó" })).toBeTruthy();
    expect(within(ticks[0]).getByRole("img", { name: "preguntó" })).toBeTruthy();
    expect(ticks[2].textContent).toContain("decidió: tiempo agotado");

    fireEvent.click(screen.getByLabelText("Solo lo que decidió solo"));
    const only = within(screen.getByRole("list", { name: "Diario del gerente" })).getAllByRole("listitem", { name: /^Turno/ });
    expect(only).toHaveLength(1);
    expect(only[0].textContent).toContain("tool_2");
    expect(only[0].textContent).toContain("tool_4");
    expect(only[0].textContent).not.toContain("tool_3");
  });

  it("se actualiza con los eventos manager.action y manager.tick", () => {
    render(<ManagerDiary projectId={P} />);
    expect(screen.getByText(/aún no ha hecho ningún turno/)).toBeTruthy();
    act(() =>
      applyEvent({
        type: "event", name: "manager.tick",
        payload: { projectId: P, phase: "started", tick: { id: "k9", projectId: P, trigger: "manual", summary: "Pensando", costUsd: 0, startedAt: Date.now(), endedAt: null } },
      }),
    );
    expect(screen.getByLabelText("Turno Pensando").textContent).toContain("en curso");
    act(() => applyEvent({ type: "event", name: "manager.action", payload: act1(7, "k9", "auto", "policy") }));
    expect(screen.getByLabelText("Turno Pensando").textContent).toContain("tool_7");
  });
});

describe("MemoryPanel", () => {
  const rows = [
    { id: 1, projectId: P, kind: "fact", text: "Usa React 19", source: "manager", archived: false, createdAt: 1 },
    { id: 2, projectId: P, kind: "decision", text: "Pagos con Stripe", source: "user", archived: false, createdAt: 2 },
    { id: 3, projectId: P, kind: "todo", text: "Revisar estilos", source: "manager", archived: false, createdAt: 3 },
  ];

  it("lista por tipo, busca con query, añade y archiva", async () => {
    mocks.request.mockImplementation(async (m: string, p: { query?: string }) => {
      if (m === "memory.list") return p.query ? rows.filter((r) => r.text.includes(p.query!)) : rows;
      if (m === "memory.add") return { id: 9, projectId: P, kind: "preference", text: "En español", source: "user", archived: false, createdAt: 9 };
      return null;
    });
    render(<MemoryPanel projectId={P} />);
    await screen.findByText("Usa React 19");
    expect(screen.getByRole("region", { name: "Hechos" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Decisiones" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Preferencias" })).toBeNull();
    expect(screen.getByRole("region", { name: "Pendientes" })).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Buscar en la memoria"), { target: { value: "Stripe" } });
    await waitFor(() => expect(calls("memory.list").some((c) => (c[1] as { query?: string }).query === "Stripe")).toBe(true));
    await waitFor(() => expect(screen.queryByText("Usa React 19")).toBeNull());
    fireEvent.change(screen.getByLabelText("Buscar en la memoria"), { target: { value: "" } });
    await screen.findByText("Usa React 19");

    fireEvent.change(screen.getByLabelText("Tipo de nota"), { target: { value: "preference" } });
    fireEvent.change(screen.getByLabelText("Nueva nota"), { target: { value: "En español" } });
    fireEvent.click(screen.getByRole("button", { name: "Añadir" }));
    await screen.findByText("En español");
    expect(calls("memory.add")[0][1]).toEqual({ projectId: P, kind: "preference", text: "En español" });
    expect(screen.getByRole("region", { name: "Preferencias" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Archivar: Usa React 19" }));
    await waitFor(() => expect(screen.queryByText("Usa React 19")).toBeNull());
    expect(calls("memory.archive")[0][1]).toEqual({ projectId: P, id: 1 });
  });
});

describe("ObjectivesList", () => {
  it("progreso = tareas integradas sobre el total", () => {
    expect(objectiveProgress({ tasksByStatus: { integrated: 2, review: 1, running: 1 } })).toEqual({ done: 2, total: 4 });
    expect(objectiveProgress({ tasksByStatus: {} })).toEqual({ done: 0, total: 0 });
  });

  it("lista compacta con barra de progreso y estado", () => {
    useStore.setState({
      objectives: {
        [P]: [
          { id: "o1", projectId: P, text: "Renovar el pago", status: "active", createdAt: 2, tasksByStatus: { integrated: 1, review: 3 } },
          { id: "o2", projectId: P, text: "Documentar", status: "planning", createdAt: 1, tasksByStatus: {} },
        ],
      },
    });
    render(<ObjectivesList projectId={P} />);
    const o1 = screen.getByRole("listitem", { name: "Objetivo Renovar el pago" });
    expect(o1.textContent).toContain("En marcha");
    expect(o1.textContent).toContain("1 de 4 tareas integradas");
    expect(within(o1).getByRole("progressbar").getAttribute("aria-valuenow")).toBe("25");
    expect(screen.getByRole("listitem", { name: "Objetivo Documentar" }).textContent).toContain("sin tareas todavía");
  });

  it("vacío", () => {
    render(<ObjectivesList projectId={P} />);
    expect(screen.getByText(/No hay objetivos/)).toBeTruthy();
  });
});
