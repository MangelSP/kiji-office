// Slices de la oficina 0.2a:
//  - `providers`: estado de cupo de cada IA (`providers.status`, `limits.changed`, global) y relevos (por proyecto).
//  - `office`: último evento de cada agente (para los globos de la escena) y borradores de la caja de pedido.
import type { StateCreator } from "zustand";
import type { ConnectionView, ProviderStatus, RelayRow } from "../../shared/protocol";
import { modelLabel } from "./modelLabel";
import { bubbleText } from "../scenes/bubbleText";
import type { Agent, Id } from "./agents";
import type { AppState } from "./index";

/** Relevos que se guardan en memoria (el core manda el más nuevo primero). */
export const MAX_RELAYS = 50;

export type ProvidersSlice = {
  /** Estado de cupo de cada IA: es de la cuenta, común a todos los proyectos. */
  providers: ProviderStatus[];
  refreshProviders: () => Promise<void>;
  refreshRelays: (projectId: string) => Promise<void>;
  /** `limits.changed`: reemplaza el estado de todos los proveedores. */
  applyLimits: (list: ProviderStatus[]) => void;
  /** `relay.happened` (lleva su `projectId`): añade el relevo arriba (sin duplicar por id). */
  addRelay: (row: RelayRow) => void;
};

export const createProvidersSlice: StateCreator<AppState, [], [], ProvidersSlice> = (set, get) => ({
  providers: [],
  refreshProviders: async () => {
    const list = await get().callSafe<ProviderStatus[]>("providers.status", undefined, { silent: true });
    if (Array.isArray(list)) set({ providers: list });
  },
  refreshRelays: async (pid) => {
    const list = await get().callSafe<RelayRow[]>("relays.list", { limit: MAX_RELAYS, projectId: pid }, { silent: true });
    if (Array.isArray(list)) get().patchProject(pid, () => ({ relays: list.slice(0, MAX_RELAYS) }));
  },
  applyLimits: (list) => {
    if (Array.isArray(list)) set({ providers: list });
  },
  addRelay: (row) =>
    get().patchProject(row.projectId, (p) =>
      p.relays.some((r) => r.id === row.id) ? null : { relays: [row, ...p.relays].slice(0, MAX_RELAYS) },
    ),
});

// ---------------------------------------------------------------------------

export type AgentActivity = { kind: string; payload: unknown; at: number };

export type OfficeDraft = { request: string; files: string };

export type OfficeSlice = {
  noteActivity: (projectId: string, agentId: Id, kind: string, payload: unknown, at?: number) => void;
  setDraft: (projectId: string, agentId: Id, draft: OfficeDraft) => void;
};

export const createOfficeSlice: StateCreator<AppState, [], [], OfficeSlice> = (_set, get) => ({
  noteActivity: (pid, agentId, kind, payload, at = Date.now()) => {
    // Los eventos que no cambian el globo (git, tests...) no pisan al anterior.
    const text = bubbleText({ kind, payload });
    if (text === null) return;
    get().patchProject(pid, (p) => {
      const prev = p.activity[String(agentId)];
      // Mismo globo (tipo y texto): no se toca el estado, para no repintar la pantalla por cada token. "¡listo!" sí
      // renueva `at`, que fija cuánto dura el globo.
      if (prev && prev.kind === kind && text !== "¡listo!" && bubbleText(prev) === text) return null;
      return { activity: { ...p.activity, [String(agentId)]: { kind, payload, at } } };
    });
  },
  setDraft: (pid, agentId, draft) =>
    get().patchProject(pid, (p) => {
      const key = String(agentId);
      if (draft.request === "" && draft.files === "") {
        if (!(key in p.drafts)) return null;
        const { [key]: _gone, ...rest } = p.drafts;
        return { drafts: rest };
      }
      return { drafts: { ...p.drafts, [key]: draft } };
    }),
});

// ---------------------------------------------------------------------------
// Textos de los relevos (puros, para el historial y el aviso).

const REASON_LABEL: Record<RelayRow["reason"], string> = {
  limit: "límite alcanzado",
  manual: "cambio manual",
  resume_after_reset: "reanudado tras el reset",
};

function agentName(agents: readonly Pick<Agent, "id" | "name">[], id: string | null): string | undefined {
  return id == null ? undefined : agents.find((a) => String(a.id) === id)?.name;
}

/** "Clau: sonnet → haiku" o "Clau → Nico" (si cambió de agente). */
export function relayWho(row: RelayRow, agents: readonly Pick<Agent, "id" | "name">[], connections: readonly Pick<ConnectionView, "id" | "name">[] = []): { who: string; change: string } {
  const from = agentName(agents, row.fromAgentId);
  const to = agentName(agents, row.toAgentId);
  const models = `${row.fromModel ? modelLabel(row.fromModel, connections) : "?"} → ${row.toModel ? modelLabel(row.toModel, connections) : "?"}`;
  if (row.fromAgentId && row.toAgentId && row.fromAgentId !== row.toAgentId) {
    return { who: from ?? "Un robot", change: `${from ?? "?"} → ${to ?? "?"}` };
  }
  return { who: from ?? to ?? "Un robot", change: models };
}

const two = (n: number) => String(n).padStart(2, "0");

/** "01:20 · Clau: sonnet → haiku · límite semanal de Sonnet" */
export function relayLine(row: RelayRow, agents: readonly Pick<Agent, "id" | "name">[], connections: readonly Pick<ConnectionView, "id" | "name">[] = []): string {
  const d = new Date(row.createdAt);
  const { who, change } = relayWho(row, agents, connections);
  return `${two(d.getHours())}:${two(d.getMinutes())} · ${who}: ${change} · ${row.detail || REASON_LABEL[row.reason]}`;
}

/** Aviso corto: "Clau pasó de sonnet a haiku". */
export function relayNotice(row: RelayRow, agents: readonly Pick<Agent, "id" | "name">[], connections: readonly Pick<ConnectionView, "id" | "name">[] = []): string {
  const { who } = relayWho(row, agents, connections);
  if (row.fromAgentId && row.toAgentId && row.fromAgentId !== row.toAgentId) {
    return `${who} pasó el trabajo a ${agentName(agents, row.toAgentId) ?? "otro robot"}`;
  }
  if (row.fromModel && row.toModel) return `${who} pasó de ${modelLabel(row.fromModel, connections)} a ${modelLabel(row.toModel, connections)}`;
  return `${who} cambió de IA`;
}
