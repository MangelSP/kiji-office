// Slice `metrics`: consumo, contexto y modelo por agente (en vivo con `run.metrics`), skills y pasos de herramientas.
import type { StateCreator } from "zustand";
import type { AgentMetrics, RunMetrics, SkillInfo, TaskSwitchParams, ToolStep } from "../../shared/protocol";
import type { Id } from "./agents";
import type { AppState } from "./index";
import type { Task } from "./tasks";

export type { AgentMetrics, RunMetrics, SkillInfo, ToolStep, TaskSwitchParams };

export type MetricsSlice = {
  skills: SkillInfo[];
  /** Aplica una notificación `run.metrics` (lleva su `projectId`): actualiza `liveRuns` y suma la diferencia a los totales del agente. */
  applyRunMetrics: (m: RunMetrics) => void;
  refreshMetrics: (projectId: string, agentId: Id) => Promise<void>;
  refreshSkills: () => Promise<void>;
  refreshSteps: (projectId: string, taskId: Id) => Promise<void>;
  /** Cambia el modelo o el agente de una tarea. `true` si el core aceptó el cambio. */
  switchTask: (projectId: string, params: TaskSwitchParams) => Promise<boolean>;
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

export const createMetricsSlice: StateCreator<AppState, [], [], MetricsSlice> = (set, get) => ({
  skills: [],

  applyRunMetrics: (m) =>
    get().patchProject(m.projectId, (p) => {
      const key = String(m.agentId);
      const liveRuns = { ...p.liveRuns };
      if (m.live) liveRuns[m.runId] = m;
      else delete liveRuns[m.runId];
      return {
        liveRuns,
        metricsByAgent: { ...p.metricsByAgent, [key]: mergeRunIntoAgent(p.metricsByAgent[key], m, p.liveRuns[m.runId]) },
      };
    }),

  refreshMetrics: async (pid, agentId) => {
    const res = await get().callSafe<AgentMetrics>("agent.metrics", { agentId: String(agentId), projectId: pid }, { silent: true });
    if (res && typeof res === "object" && Array.isArray(res.recent)) {
      get().patchProject(pid, (p) => ({ metricsByAgent: { ...p.metricsByAgent, [String(agentId)]: res } }));
    }
  },

  refreshSkills: async () => {
    const res = await get().callSafe<SkillInfo[]>("skills.list", undefined, { silent: true });
    if (Array.isArray(res)) set({ skills: res });
  },

  refreshSteps: async (pid, taskId) => {
    const res = await get().callSafe<ToolStep[]>("task.steps", { taskId: String(taskId), projectId: pid }, { silent: true });
    if (Array.isArray(res)) get().patchProject(pid, (p) => ({ stepsByTask: { ...p.stepsByTask, [String(taskId)]: res } }));
  },

  switchTask: async (pid, params) => {
    const res = await get().callSafe<Task | null>("task.switch", { ...params, projectId: pid });
    if (res === undefined) return false;
    if (res && typeof res === "object" && "id" in res) get().upsertTask(pid, res);
    else await get().refreshTasks(pid);
    return true;
  },
});
