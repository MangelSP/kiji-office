// Slice `metrics`: consumo, contexto y modelo por agente (en vivo con `run.metrics`), skills y pasos de herramientas.
import type { StateCreator } from "zustand";
import type { AgentMetrics, RunMetrics, SkillInfo, TaskSwitchParams, ToolStep } from "../../shared/protocol";
import type { Id } from "./agents";
import type { AppState } from "./index";
import type { Task } from "./tasks";

export type { AgentMetrics, RunMetrics, SkillInfo, ToolStep, TaskSwitchParams };

export type MetricsSlice = {
  /** Totales por agente (clave = id del agente como texto). */
  metricsByAgent: Record<string, AgentMetrics>;
  /** Runs en curso (clave = runId); se quitan cuando llega `live: false`. */
  liveRuns: Record<string, RunMetrics>;
  skills: SkillInfo[];
  /** Pasos de herramientas del último run de cada tarea (clave = id de la tarea). */
  stepsByTask: Record<string, ToolStep[]>;
  /** Aplica una notificación `run.metrics`: actualiza `liveRuns` y suma la diferencia a los totales del agente. */
  applyRunMetrics: (m: RunMetrics) => void;
  refreshMetrics: (agentId: Id) => Promise<void>;
  refreshSkills: () => Promise<void>;
  refreshSteps: (taskId: Id) => Promise<void>;
  /** Cambia el modelo o el agente de una tarea. `true` si el core aceptó el cambio. */
  switchTask: (params: TaskSwitchParams) => Promise<boolean>;
};

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function emptyMetrics(m: RunMetrics): AgentMetrics {
  return {
    agentId: m.agentId,
    model: m.model,
    runs: 0,
    costUsd: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    lastContextTokens: 0,
    lastContextWindow: m.contextWindow,
    recent: [],
  };
}

/** Suma al agente solo lo que cambió respecto a la última vez que vimos este run. */
export function mergeRunIntoAgent(prev: AgentMetrics | undefined, m: RunMetrics, seen: RunMetrics | undefined): AgentMetrics {
  const base = prev ?? emptyMetrics(m);
  const old = base.recent.find((r) => r.runId === m.runId) ?? seen;
  const d = (k: "input" | "output" | "cacheRead" | "cacheWrite" | "costUsd") => num(m[k]) - num(old?.[k]);
  const known = base.recent.some((r) => r.runId === m.runId);
  const recent = known ? base.recent.map((r) => (r.runId === m.runId ? m : r)) : [m, ...base.recent].slice(0, 20);
  return {
    ...base,
    model: m.live ? m.model : base.model,
    runs: known || old ? base.runs : base.runs + 1,
    costUsd: base.costUsd + d("costUsd"),
    input: base.input + d("input"),
    output: base.output + d("output"),
    cacheRead: base.cacheRead + d("cacheRead"),
    cacheWrite: base.cacheWrite + d("cacheWrite"),
    lastContextTokens: m.contextTokens,
    lastContextWindow: m.contextWindow,
    recent,
  };
}

export const createMetricsSlice: StateCreator<AppState & MetricsSlice, [], [], MetricsSlice> = (set, get) => ({
  metricsByAgent: {},
  liveRuns: {},
  skills: [],
  stepsByTask: {},

  applyRunMetrics: (m) =>
    set((s) => {
      const key = String(m.agentId);
      const liveRuns = { ...s.liveRuns };
      if (m.live) liveRuns[m.runId] = m;
      else delete liveRuns[m.runId];
      return {
        liveRuns,
        metricsByAgent: { ...s.metricsByAgent, [key]: mergeRunIntoAgent(s.metricsByAgent[key], m, s.liveRuns[m.runId]) },
      };
    }),

  refreshMetrics: async (agentId) => {
    const res = await get().callSafe<AgentMetrics>("agent.metrics", { agentId: String(agentId) }, { silent: true });
    if (res && typeof res === "object" && Array.isArray(res.recent)) {
      set((s) => ({ metricsByAgent: { ...s.metricsByAgent, [String(agentId)]: res } }));
    }
  },

  refreshSkills: async () => {
    const res = await get().callSafe<SkillInfo[]>("skills.list", undefined, { silent: true });
    if (Array.isArray(res)) set({ skills: res });
  },

  refreshSteps: async (taskId) => {
    const res = await get().callSafe<ToolStep[]>("task.steps", { taskId: String(taskId) }, { silent: true });
    if (Array.isArray(res)) set((s) => ({ stepsByTask: { ...s.stepsByTask, [String(taskId)]: res } }));
  },

  switchTask: async (params) => {
    const res = await get().callSafe<Task | null>("task.switch", params);
    if (res === undefined) return false;
    if (res && typeof res === "object" && "id" in res) get().upsertTask(res);
    else await get().refreshTasks();
    return true;
  },
});
