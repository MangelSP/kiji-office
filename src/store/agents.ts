// Slice `agents`: lista de agentes y su estado (robots), por proyecto.
import type { StateCreator } from "zustand";
import type { AgentUpdateParams } from "../../shared/protocol";
import type { AppState } from "./index";

export type Id = string | number;
export type Agent = {
  id: Id;
  name: string;
  provider?: string;
  /** 0.2b: conexión del agente (provider "api"); null/ausente = Claude. */
  connection_id?: string | null;
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
  setAgents: (projectId: string, agents: Agent[]) => void;
  setAgentStatus: (projectId: string, id: Id, status: string) => void;
  refreshAgents: (projectId: string) => Promise<void>;
  /** Inserta o fusiona un agente (notificación `agent.changed`). */
  upsertAgent: (projectId: string, agent: Agent) => void;
  /** Guarda el perfil con `agent.update`. `true` si el core lo aceptó; si no, el aviso queda en `notice`. */
  updateAgent: (projectId: string, params: AgentUpdateParams) => Promise<boolean>;
};

export const createAgentsSlice: StateCreator<AppState, [], [], AgentsSlice> = (_set, get) => ({
  setAgents: (pid, agents) => get().patchProject(pid, () => ({ agents })),
  setAgentStatus: (pid, id, status) =>
    get().patchProject(pid, (p) =>
      p.agents.some((a) => String(a.id) === String(id))
        ? { agents: p.agents.map((a) => (String(a.id) === String(id) ? { ...a, status } : a)) }
        : null,
    ),
  refreshAgents: async (pid) => {
    const list = await get().callSafe<Agent[]>("agent.list", { projectId: pid }, { silent: true });
    if (Array.isArray(list)) get().setAgents(pid, list);
  },
  upsertAgent: (pid, agent) =>
    get().patchProject(pid, (p) => {
      const i = p.agents.findIndex((a) => String(a.id) === String(agent.id));
      if (i < 0) return { agents: [...p.agents, agent] };
      const agents = p.agents.slice();
      agents[i] = { ...agents[i], ...agent };
      return { agents };
    }),
  updateAgent: async (pid, params) => {
    const res = await get().callSafe<Agent | null>("agent.update", { ...params, projectId: pid });
    if (res === undefined) return false;
    if (res && typeof res === "object" && "id" in res) get().upsertAgent(pid, res);
    else await get().refreshAgents(pid);
    return true;
  },
});
