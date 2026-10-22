// Store único de la UI (zustand) compuesto por slices simples, y su conexión con los eventos del core.
import { create } from "zustand";
import { core } from "../core/client";
import type { Event as CoreEvent } from "../../shared/protocol";
import { createAgentsSlice, type Agent, type AgentsSlice } from "./agents";
import { createApprovalsSlice, type Approval, type ApprovalsSlice } from "./approvals";
import { createCoreSlice, type CoreSlice } from "./core";
import { createEventsSlice, type EventsSlice } from "./events";
import { createTasksSlice, type Task, type TasksSlice } from "./tasks";

export type AppState = CoreSlice &
  AgentsSlice &
  TasksSlice &
  EventsSlice &
  ApprovalsSlice & {
    /** Vuelve a pedir agentes y tareas (los métodos que no existan se ignoran en silencio). */
    refreshAll: () => Promise<void>;
  };

export const useStore = create<AppState>()((...a) => ({
  ...createCoreSlice(...a),
  ...createAgentsSlice(...a),
  ...createTasksSlice(...a),
  ...createEventsSlice(...a),
  ...createApprovalsSlice(...a),
  refreshAll: async () => {
    const s = a[1]();
    await Promise.all([s.refreshAgents(), s.refreshTasks()]);
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
      void s.ping().then((ok) => (ok ? s.refreshAll() : undefined));
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
