// Store único de la UI (zustand) compuesto por slices simples, y su conexión con los eventos del core.
// El estado de cada proyecto (workspace) vive en `byProject[projectId]` (ver `partition.ts`); los componentes lo leen
// con `useScoped` (ver `scoped.ts`), que ya apunta al proyecto de su pestaña.
import { create } from "zustand";
import { core } from "../core/client";
import type {
  BudgetNotice,
  Event as CoreEvent,
  ProviderStatus,
  QueueChange,
  RelayRow,
  RunMetrics,
  WorkspaceOverview,
} from "../../shared/protocol";
import { createAgentsSlice, type Agent, type AgentsSlice } from "./agents";
import { createApprovalsSlice, type Approval, type ApprovalsSlice } from "./approvals";
import { createCoreSlice, type CoreSlice } from "./core";
import { createEventsSlice, type EventsSlice } from "./events";
import { createMetricsSlice, type MetricsSlice } from "./metrics";
import { createPartitionSlice, projectOf, type PartitionSlice } from "./partition";
import {
  createOfficeSlice,
  createProvidersSlice,
  relayNotice,
  type OfficeSlice,
  type ProvidersSlice,
} from "./providers";
import { createTasksSlice, type Task, type TasksSlice } from "./tasks";
import { createWorkspacesSlice, type WorkspacesSlice } from "./workspaces";

export type AppState = CoreSlice &
  PartitionSlice &
  WorkspacesSlice &
  AgentsSlice &
  TasksSlice &
  EventsSlice &
  ApprovalsSlice &
  MetricsSlice &
  ProvidersSlice &
  OfficeSlice;

export const useStore = create<AppState>()((...a) => ({
  ...createCoreSlice(...a),
  ...createPartitionSlice(...a),
  ...createWorkspacesSlice(...a),
  ...createAgentsSlice(...a),
  ...createTasksSlice(...a),
  ...createEventsSlice(...a),
  ...createApprovalsSlice(...a),
  ...createMetricsSlice(...a),
  ...createProvidersSlice(...a),
  ...createOfficeSlice(...a),
}));

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object";
}

/** Proyecto al que pertenece un evento (`payload.projectId`), o null si no lo trae. */
function projectIdOf(payload: unknown): string | null {
  return isObject(payload) && typeof payload.projectId === "string" && payload.projectId !== "" ? payload.projectId : null;
}

/** `agent.status` puede llegar sin proyecto: se busca la partición que tiene ese agente. */
function projectOfAgent(agentId: unknown): string | null {
  const { byProject } = useStore.getState();
  for (const [pid, p] of Object.entries(byProject)) {
    if (p.agents.some((a) => String(a.id) === String(agentId))) return pid;
  }
  return null;
}

/**
 * Reparte un evento del core. Los eventos de proyecto se enrutan por `payload.projectId` a su partición, estén o no
 * en pantalla; así un workspace en segundo plano sigue acumulando lo suyo sin mezclarse con el visible.
 */
export function applyEvent(event: CoreEvent) {
  const s = useStore.getState();
  const p = event.payload;
  let pid = projectIdOf(p);
  if (pid === null && event.name === "agent.status" && isObject(p)) pid = projectOfAgent(p.agent_id ?? p.id);
  if (event.name !== "workspaces.changed") s.pushEvent(pid, event.name, p);
  switch (event.name) {
    case "core.ready":
      s.setCoreStatus("connecting");
      // Tras un reinicio el core no recuerda los proyectos abiertos: se reabren y se recarga todo.
      void s.ping().then((ok) => {
        if (ok) return useStore.getState().bootstrap();
      });
      break;
    case "core.crashed":
      s.setCoreStatus("down", "caído");
      break;
    case "task.changed":
      if (pid && isObject(p) && "id" in p) s.upsertTask(pid, p as unknown as Task);
      break;
    case "agent.status":
      if (pid && isObject(p) && "status" in p) {
        const id = p.agent_id ?? p.id;
        if (id !== undefined) s.setAgentStatus(pid, id as Agent["id"], String(p.status));
      }
      break;
    case "approval.requested":
      if (pid && isObject(p) && "id" in p) s.addApproval(pid, p as unknown as Approval);
      break;
    case "event.appended":
      // Alimenta los globos de pensamiento de la escena.
      if (pid && isObject(p) && p.agent_id != null && typeof p.kind === "string") {
        s.noteActivity(pid, p.agent_id as Agent["id"], p.kind, p.payload);
      }
      break;
    case "run.metrics":
      if (pid && isObject(p) && "runId" in p) s.applyRunMetrics(p as unknown as RunMetrics);
      break;
    case "agent.changed":
      if (pid && isObject(p) && "id" in p) s.upsertAgent(pid, p as unknown as Agent);
      break;
    case "limits.changed":
      if (Array.isArray(p)) s.applyLimits(p as ProviderStatus[]);
      break;
    case "relay.happened":
      if (pid && isObject(p) && "id" in p) {
        const row = p as unknown as RelayRow;
        s.addRelay(row);
        const text = relayNotice(row, projectOf(useStore.getState(), pid).agents);
        const name = s.projects.find((x) => x.projectId === pid)?.name;
        s.setNotice(name && pid !== s.activeProjectId ? `${name}: ${text}` : text);
      }
      break;
    case "queue.changed":
      if (pid && isObject(p) && "taskId" in p) s.applyQueue(p as unknown as QueueChange);
      break;
    case "budget.reached":
      if (isObject(p) && typeof p.message === "string") s.setBudgetNotice(p as unknown as BudgetNotice);
      break;
    case "workspaces.changed":
      if (isObject(p) && Array.isArray(p.workspaces)) s.applyOverview(p as unknown as WorkspaceOverview);
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
      s.setBooted(true);
      return;
    }
    if (await s.ping()) await s.bootstrap();
    s.setBooted(true);
  });
  return off;
}
