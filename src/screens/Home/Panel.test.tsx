// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StatsOverview } from "../../../shared/protocol";

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../../core/client", () => ({
  core: { request: mocks.request, start: vi.fn(), onEvent: vi.fn(() => () => {}) },
  CoreError: class CoreError extends Error {},
}));

import { resetStore } from "../../store/testing";
import Panel, { Sparkline, fmtSpan } from "./Panel";

const H = 3_600_000;
const STATS: StatsOverview = {
  projects: { open: 2, total: 3, mostActive: "mi-web" },
  agents: { total: 6, working: 3, queued: 1 },
  ais: { configured: 3, ok: 1, warning: 1, limited: 1 },
  cost: { today: 4.5, last7: 30, total: 66, perDay7: [1, 2, 3, 4, 5, 6, 4.5] },
  tokens: { today: { in: 1000, out: 500, cacheRead: 9000 }, last7: { in: 7000, out: 3000, cacheRead: 60000 } },
  workTimeMs: { today: 3.2 * H, last7: 19 * H },
  manager: { ticksToday: 14, costToday: 0.38 },
};

beforeEach(() => {
  mocks.request.mockReset();
  mocks.request.mockImplementation(async (m: string) => (m === "stats.overview" ? STATS : null));
  resetStore(null);
});
afterEach(cleanup);

describe("Panel", () => {
  it("fmtSpan formatea horas y minutos", () => {
    expect([fmtSpan(0), fmtSpan(20_000), fmtSpan(45 * 60_000), fmtSpan(3.2 * H)]).toEqual(["0 s", "20 s", "45 min", "3 h 12 min"]);
  });

  it("Sparkline dibuja la serie y no falla con todo a cero", () => {
    const { container } = render(<Sparkline values={[0, 0, 0]} label="x" />);
    expect(container.querySelector("path.pn-spark-line")?.getAttribute("d")).not.toContain("NaN");
  });

  it("pinta las tarjetas con lo que devuelve stats.overview", async () => {
    render(<Panel open={2} editing={false} onEditLimits={() => {}} totals={{ costTodayUsd: 4.5, liveRuns: 3, queued: 1, maxConcurrentRuns: 4, dailyBudgetUsd: 10 }} />);
    await waitFor(() => expect(within(screen.getByLabelText("Agentes")).getByText("6")).toBeTruthy());
    expect(screen.getByLabelText("Agentes").textContent).toContain("3 trabajando · 1 en cola");
    expect(screen.getByLabelText("Proyectos").textContent).toContain("Más activo: mi-web");
    expect(screen.getByLabelText("IAs").textContent).toContain("1 ok · 1 aviso · 1 límite");
    expect(screen.getByLabelText("Gasto").textContent).toContain("/ $10,00");
    expect(screen.getByLabelText("Tiempo").textContent).toContain("3 h 12 min");
    expect(screen.getByLabelText("Gerente").textContent).toContain("14");
    expect(screen.getByRole("img", { name: "Gasto por día, últimos 7 días" })).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Gasto de hoy frente al tope diario" }).getAttribute("aria-valuenow")).toBe("45");
  });
});
