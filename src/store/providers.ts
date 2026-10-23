// Slices de la oficina 0.2a:
//  - `providers`: estado de cupo de cada IA (`providers.status`, `limits.changed`) e historial de relevos.
//  - `office`: último evento de cada agente (para los globos de la escena) y borradores de la caja de pedido.
import type { StateCreator } from "zustand";
import type { ProviderStatus, RelayRow } from "../../shared/protocol";
import { bubbleText } from "../scenes/bubbleText";
import type { Agent, Id } from "./agents";
import type { AppState } from "./index";

/** Relevos que se guardan en memoria (el core manda el más nuevo primero). */
export const MAX_RELAYS = 50;

export type ProvidersSlice = {
  providers: ProviderStatus[];
  relays: RelayRow[];
  refreshProviders: () => Promise<void>;
  refreshRelays: () => Promise<void>;
  /** `limits.changed`: reemplaza el estado de todos los proveedores. */
  applyLimits: (list: ProviderStatus[]) => void;
  /** `relay.happened`: añade el relevo arriba (sin duplicar por id). */
  addRelay: (row: RelayRow) => void;
};

export const createProvidersSlice: StateCreator<AppState, [], [], ProvidersSlice> = (set, get) => ({
  providers: [],
  relays: [],
  refreshProviders: async () => {
    const list = await get().callSafe<ProviderStatus[]>("providers.status", undefined, { silent: true });
    if (Array.isArray(list)) set({ providers: list });
  },
  refreshRelays: async () => {
    const list = await get().callSafe<RelayRow[]>("relays.list", { limit: MAX_RELAYS }, { silent: true });
    if (Array.isArray(list)) set({ relays: list.slice(0, MAX_RELAYS) });
  },
  applyLimits: (list) => {
    if (Array.isArray(list)) set({ providers: list });
  },
  addRelay: (row) =>
    set((s) =>
      s.relays.some((r) => r.id === row.id) ? s : { relays: [row, ...s.relays].slice(0, MAX_RELAYS) },
    ),
});

// ---------------------------------------------------------------------------

export type AgentActivity = { kind: string; payload: unknown; at: number };

export type OfficeDraft = { request: string; files: string };

export type OfficeSlice = {
  /** Último evento con globo de cada agente (clave = id del agente en texto). */
  activity: Record<string, AgentActivity>;
  /** Borrador de la caja de pedido por robot (en memoria). */
  drafts: Record<string, OfficeDraft>;
  noteActivity: (agentId: Id, kind: string, payload: unknown, at?: number) => void;
  setDraft: (agentId: Id, draft: OfficeDraft) => void;
};

export const createOfficeSlice: StateCreator<AppState, [], [], OfficeSlice> = (set) => ({
  activity: {},
  drafts: {},
  noteActivity: (agentId, kind, payload, at = Date.now()) => {
    // Los eventos que no cambian el globo (git, tests...) no pisan al anterior.
    if (bubbleText({ kind, payload }) === null) return;
    set((s) => ({ activity: { ...s.activity, [String(agentId)]: { kind, payload, at } } }));
  },
  setDraft: (agentId, draft) =>
    set((s) => {
      const key = String(agentId);
      if (draft.request === "" && draft.files === "") {
        if (!(key in s.drafts)) return s;
        const { [key]: _gone, ...rest } = s.drafts;
        return { drafts: rest };
      }
      return { drafts: { ...s.drafts, [key]: draft } };
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
export function relayWho(row: RelayRow, agents: readonly Pick<Agent, "id" | "name">[]): { who: string; change: string } {
  const from = agentName(agents, row.fromAgentId);
  const to = agentName(agents, row.toAgentId);
  const models = `${row.fromModel ?? "?"} → ${row.toModel ?? "?"}`;
  if (row.fromAgentId && row.toAgentId && row.fromAgentId !== row.toAgentId) {
    return { who: from ?? "Un robot", change: `${from ?? "?"} → ${to ?? "?"}` };
  }
  return { who: from ?? to ?? "Un robot", change: models };
}

const two = (n: number) => String(n).padStart(2, "0");

/** "01:20 · Clau: sonnet → haiku · límite semanal de Sonnet" */
export function relayLine(row: RelayRow, agents: readonly Pick<Agent, "id" | "name">[]): string {
  const d = new Date(row.createdAt);
  const { who, change } = relayWho(row, agents);
  return `${two(d.getHours())}:${two(d.getMinutes())} · ${who}: ${change} · ${row.detail || REASON_LABEL[row.reason]}`;
}

/** Aviso corto: "Clau pasó de sonnet a haiku". */
export function relayNotice(row: RelayRow, agents: readonly Pick<Agent, "id" | "name">[]): string {
  const { who } = relayWho(row, agents);
  if (row.fromAgentId && row.toAgentId && row.fromAgentId !== row.toAgentId) {
    return `${who} pasó el trabajo a ${agentName(agents, row.toAgentId) ?? "otro robot"}`;
  }
  if (row.fromModel && row.toModel) return `${who} pasó de ${row.fromModel} a ${row.toModel}`;
  return `${who} cambió de IA`;
}
