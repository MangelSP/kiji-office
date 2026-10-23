// Home · Panel: `stats.overview` (una llamada con todas las cifras). Sin estado global: lo pide el Panel y lo refresca.
import { CoreError } from "../core/client";
import type { StatsOverview } from "../../shared/protocol";
import { errorMessage } from "./core";
import { useSettings } from "./settings";
import { useStore } from ".";

export type StatsOverviewResult = { ok: true; data: StatsOverview } | { ok: false; reason: string };

const isOverview = (v: unknown): v is StatsOverview =>
  v !== null && typeof v === "object" && "cost" in v && "tokens" in v && "workTimeMs" in v && "agents" in v && "projects" in v;

export async function fetchStatsOverview(): Promise<StatsOverviewResult> {
  if (useSettings.getState().demo) return { ok: true, data: DEMO_STATS };
  try {
    const data = await useStore.getState().call<unknown>("stats.overview");
    return isOverview(data) ? { ok: true, data } : { ok: false, reason: "El core no devolvió estadísticas." };
  } catch (err) {
    const aun = err instanceof CoreError && err.code === "unknown_method";
    return { ok: false, reason: aun ? "Las estadísticas del panel aún no están disponibles en el core." : `No se pudieron cargar (${errorMessage(err)}).` };
  }
}

const H = 3_600_000;
export const DEMO_STATS: StatsOverview = {
  projects: { open: 2, total: 3, mostActive: "mi-web" },
  agents: { total: 6, working: 3, queued: 1 },
  ais: { configured: 3, ok: 1, warning: 1, limited: 1 },
  cost: { today: 4.52, last7: 31.8, total: 66.05, perDay7: [2.1, 5.4, 3.2, 6.9, 4.1, 5.6, 4.52] },
  tokens: {
    today: { in: 562_000, out: 79_000, cacheRead: 3_000_000 },
    last7: { in: 3_900_000, out: 540_000, cacheRead: 21_000_000 },
  },
  workTimeMs: { today: 3.2 * H, last7: 19.5 * H },
  manager: { ticksToday: 14, costToday: 0.38 },
};
