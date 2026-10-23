// Partición del estado por proyecto (workspace): cada proyecto abierto tiene su propio `ProjectData` en
// `byProject[projectId]`. Los eventos del core se enrutan por `payload.projectId`, así lo que ocurre en un workspace
// en segundo plano no se mezcla con el que se ve. `activeProjectId` es la pestaña visible (null = Home).
import type { StateCreator } from "zustand";
import type { AgentMetrics, QueueChange, RelayRow, RunMetrics, ToolStep } from "../../shared/protocol";
import type { Agent } from "./agents";
import type { Approval } from "./approvals";
import type { BoardMoveItem } from "./boardMoves";
import type { LogEntry } from "./events";
import type { AppState } from "./index";
import type { AgentActivity, OfficeDraft } from "./providers";
import type { Task } from "./tasks";

export type ProjectData = {
  agents: Agent[];
  tasks: Task[];
  approvals: Approval[];
  /** Registro en vivo del proyecto (máx. 500, el más nuevo al final). */
  events: LogEntry[];
  /** Totales por agente (clave = id del agente como texto). */
  metricsByAgent: Record<string, AgentMetrics>;
  /** Runs en curso (clave = runId); se quitan cuando llega `live: false`. */
  liveRuns: Record<string, RunMetrics>;
  /** Pasos de herramientas del último run de cada tarea (clave = id de la tarea). */
  stepsByTask: Record<string, ToolStep[]>;
  /** Último evento con globo de cada agente (clave = id del agente en texto). */
  activity: Record<string, AgentActivity>;
  relays: RelayRow[];
  /** Borrador de la caja de pedido por robot (en memoria). */
  drafts: Record<string, OfficeDraft>;
  /** Tareas en cola global (clave = id de la tarea): posición y motivo de la espera. */
  queue: Record<string, QueueChange>;
  /** Animaciones de la pizarra pendientes de ver en la escena (`board.moved`, máx. 50). */
  boardMoves: BoardMoveItem[];
};

/** Partición vacía y compartida: los selectores de un proyecto aún sin datos devuelven siempre la misma referencia. */
export const EMPTY_PROJECT: ProjectData = Object.freeze({
  agents: [],
  tasks: [],
  approvals: [],
  events: [],
  metricsByAgent: {},
  liveRuns: {},
  stepsByTask: {},
  activity: {},
  relays: [],
  drafts: {},
  queue: {},
  boardMoves: [],
}) as ProjectData;

export type PartitionSlice = {
  byProject: Record<string, ProjectData>;
  /** Pestaña visible; null = Home. */
  activeProjectId: string | null;
  /** Eventos del core que no son de ningún proyecto (`limits.changed`, `core.*`). */
  coreEvents: LogEntry[];
  /** Modifica la partición de un proyecto (la crea si no existe). `fn` devuelve los campos a cambiar o null para no tocar nada. */
  patchProject: (projectId: string, fn: (p: ProjectData) => Partial<ProjectData> | null) => void;
  dropProject: (projectId: string) => void;
};

export const createPartitionSlice: StateCreator<AppState, [], [], PartitionSlice> = (set) => ({
  byProject: {},
  activeProjectId: null,
  coreEvents: [],
  patchProject: (projectId, fn) =>
    set((s) => {
      const cur = s.byProject[projectId] ?? EMPTY_PROJECT;
      const patch = fn(cur);
      if (patch === null) return s;
      return { byProject: { ...s.byProject, [projectId]: { ...cur, ...patch } } };
    }),
  dropProject: (projectId) =>
    set((s) => {
      if (!(projectId in s.byProject)) return s;
      const { [projectId]: _gone, ...rest } = s.byProject;
      return { byProject: rest };
    }),
});

/** Partición de un proyecto (la vacía compartida si aún no hay datos). */
export const projectOf = (s: Pick<PartitionSlice, "byProject">, projectId: string | null | undefined): ProjectData =>
  (projectId ? s.byProject[projectId] : undefined) ?? EMPTY_PROJECT;
