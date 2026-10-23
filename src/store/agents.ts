// Slice `agents`: lista de agentes y su estado (robots).
import type { StateCreator } from "zustand";
import type { AgentUpdateParams } from "../../shared/protocol";
import type { AppState } from "./index";

export type Id = string | number;
export type Agent = {
  id: Id;
  name: string;
  provider?: string;
  model?: string;
  role?: string;
  /** Paleta del robot (terracota, azul, verde, crema; `claude` = terracota). */
  color?: string | null;
  is_boss?: number | boolean;
  /** Estado del robot (`agent.status`): thinking, writing, needs_you, done... */
  status?: string;
  /** Personalidad: texto libre (máx. 4000) que se añade al system prompt tras el rol. */
  persona?: string;
  /** Nombres de skills activas (`skills.list`). */
  skills?: string[];
  /** Modelos de relevo, por orden. */
  relay_order?: string[];
  auto_relay?: number | boolean;
  /** Modelo en uso ahora (puede diferir del preferido si hubo relevo). */
  current_model?: string;
};

export type AgentsSlice = {
  agents: Agent[];
  setAgents: (agents: Agent[]) => void;
  setAgentStatus: (id: Id, status: string) => void;
  refreshAgents: () => Promise<void>;
  /** Inserta o fusiona un agente (notificación `agent.changed`). */
  upsertAgent: (agent: Agent) => void;
  /** Guarda el perfil con `agent.update`. `true` si el core lo aceptó; si no, el aviso queda en `notice`. */
  updateAgent: (params: AgentUpdateParams) => Promise<boolean>;
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
  upsertAgent: (agent) =>
    set((s) => {
      const i = s.agents.findIndex((a) => String(a.id) === String(agent.id));
      if (i < 0) return { agents: [...s.agents, agent] };
      const agents = s.agents.slice();
      agents[i] = { ...agents[i], ...agent };
      return { agents };
    }),
  updateAgent: async (params) => {
    const res = await get().callSafe<Agent | null>("agent.update", params);
    if (res === undefined) return false;
    if (res && typeof res === "object" && "id" in res) get().upsertAgent(res);
    else await get().refreshAgents();
    return true;
  },
});
