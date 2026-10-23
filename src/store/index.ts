// Store único de la UI (zustand) compuesto por slices simples, y su conexión con los eventos del core.
import { create } from "zustand";
import { core } from "../core/client";
import type { Event as CoreEvent, ProviderStatus, RelayRow, RunMetrics } from "../../shared/protocol";
import { createAgentsSlice, type Agent, type AgentsSlice } from "./agents";
import { createApprovalsSlice, type Approval, type ApprovalsSlice } from "./approvals";
import { createCoreSlice, type CoreSlice } from "./core";
import { createEventsSlice, type EventsSlice } from "./events";
import { createMetricsSlice, type MetricsSlice } from "./metrics";
import {
  createOfficeSlice,
  createProvidersSlice,
  relayNotice,
  type OfficeSlice,
  type ProvidersSlice,
} from "./providers";
import { createTasksSlice, type Task, type TasksSlice } from "./tasks";

export type AppState = CoreSlice &
  AgentsSlice &
  TasksSlice &
  EventsSlice &
  ApprovalsSlice &
  MetricsSlice &
  ProvidersSlice &
  OfficeSlice & {
    /** Vuelve a pedir agentes, tareas, proveedores y relevos (los métodos que no existan se ignoran en silencio). */
    refreshAll: () => Promise<void>;
  };

export const useStore = create<AppState>()((...a) => ({
  ...createCoreSlice(...a),
  ...createAgentsSlice(...a),
  ...createTasksSlice(...a),
  ...createEventsSlice(...a),
  ...createApprovalsSlice(...a),
  ...createMetricsSlice(...a),
  ...createProvidersSlice(...a),
  ...createOfficeSlice(...a),
  refreshAll: async () => {
    const s = a[1]();
    await Promise.all([s.refreshAgents(), s.refreshTasks(), s.refreshProviders(), s.refreshRelays()]);
  },
}));

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object";
}

/** Reparte un evento del core en las slices correspondientes. */
export function applyEvent(event: CoreEvent) {
  const s = useStore.getState();
  s.pushEvent(event.name, event.payload);
  const p = event.payload;
  switch (event.name) {
    case "core.ready":
      s.setCoreStatus("connecting");
      // Tras un reinicio el core no recuerda el proyecto activo: se vuelve a abrir el que había.
      void s.ping().then((ok) => {
        if (!ok) return;
        const project = useStore.getState().project;
        return project ? s.openProject(project.path) : s.refreshAll();
      });
      break;
    case "core.crashed":
      s.setCoreStatus("down", "caído");
      break;
    case "task.changed":
      if (isObject(p) && "id" in p) s.upsertTask(p as unknown as Task);
      break;
    case "agent.status":
      if (isObject(p) && "status" in p) {
        const id = p.agent_id ?? p.id;
        if (id !== undefined) s.setAgentStatus(id as Agent["id"], String(p.status));
      }
      break;
    case "approval.requested":
      if (isObject(p) && "id" in p) s.addApproval(p as unknown as Approval);
      break;
    case "event.appended":
      // Alimenta los globos de pensamiento de la escena.
      if (isObject(p) && p.agent_id != null && typeof p.kind === "string") s.noteActivity(p.agent_id as Agent["id"], p.kind, p.payload);
      break;
    case "run.metrics":
      if (isObject(p) && "runId" in p) s.applyRunMetrics(p as unknown as RunMetrics);
      break;
    case "agent.changed":
      if (isObject(p) && "id" in p) s.upsertAgent(p as unknown as Agent);
      break;
    case "limits.changed":
      if (Array.isArray(p)) s.applyLimits(p as ProviderStatus[]);
      break;
    case "relay.happened":
      if (isObject(p) && "id" in p) {
        const row = p as unknown as RelayRow;
        s.addRelay(row);
        s.setNotice(relayNotice(row, s.agents));
      }
      break;
  }
}

/** Conecta el store al cliente del core: eventos, ping inicial y primera carga. Devuelve la baja. */
export function connectStore(): () => void {
  const off = core.onEvent("*", applyEvent);
  void core.start().then(async (available) => {
    const s = useStore.getState();
    if (!available) {
      s.setCoreStatus("down", "sin conexión"); // fuera de Tauri no hay eventos
      return;
    }
    if (await s.ping()) await s.refreshAll();
  });
  return off;
}
