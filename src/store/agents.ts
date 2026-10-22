// Slice `agents`: lista de agentes y su estado (robots).
import type { StateCreator } from "zustand";
import type { AppState } from "./index";

export type Id = string | number;
export type Agent = {
  id: Id;
  name: string;
  provider?: string;
  model?: string;
  role?: string;
  is_boss?: number | boolean;
  /** Estado del robot (`agent.status`): thinking, writing, needs_you, done... */
  status?: string;
};

export type AgentsSlice = {
  agents: Agent[];
  setAgents: (agents: Agent[]) => void;
  setAgentStatus: (id: Id, status: string) => void;
  refreshAgents: () => Promise<void>;
};

export const createAgentsSlice: StateCreator<AppState, [], [], AgentsSlice> = (set, get) => ({
  agents: [],
  setAgents: (agents) => set({ agents }),
  setAgentStatus: (id, status) =>
    set((s) => ({ agents: s.agents.map((a) => (String(a.id) === String(id) ? { ...a, status } : a)) })),
  refreshAgents: async () => {
    const list = await get().callSafe<Agent[]>("agent.list", undefined, { silent: true });
    if (Array.isArray(list)) set({ agents: list });
  },
});
