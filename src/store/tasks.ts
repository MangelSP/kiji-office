// Slice `tasks`: tareas del proyecto, agrupadas por estado en la interfaz.
import type { StateCreator } from "zustand";
import type { Id } from "./agents";
import type { AppState } from "./index";

export type Task = {
  id: Id;
  title: string;
  status: string;
  agent_id?: Id | null;
  /** Archivos que posee la tarea (si el core los incluye en `task.list`). */
  files?: string[];
};

/** Estados de tarea de la sección 3 de PLAN-0.1.md, en orden de flujo. */
export const TASK_STATES = [
  "todo",
  "assigned",
  "running",
  "needs_you",
  "review",
  "changes",
  "approved",
  "integrated",
  "blocked",
  "failed",
  "paused_limit",
] as const;

export type TasksSlice = {
  tasks: Task[];
  upsertTask: (task: Task) => void;
  refreshTasks: () => Promise<void>;
  /** Nombre del método de creación: no está en la lista de 0.1 (ver informe del paso 7). */
  createTask: (input: { title: string; files: string[]; agentId?: Id }) => Promise<boolean>;
  startTask: (id: Id) => Promise<void>;
  /** Devuelve el texto del diff, o `undefined` si no se pudo obtener. */
  loadDiff: (id: Id) => Promise<string | undefined>;
};

export const createTasksSlice: StateCreator<AppState, [], [], TasksSlice> = (set, get) => ({
  tasks: [],
  upsertTask: (task) =>
    set((s) => {
      const i = s.tasks.findIndex((t) => String(t.id) === String(task.id));
      if (i < 0) return { tasks: [...s.tasks, task] };
      const tasks = s.tasks.slice();
      tasks[i] = { ...tasks[i], ...task };
      return { tasks };
    }),
  refreshTasks: async () => {
    const list = await get().callSafe<Task[]>("task.list", undefined, { silent: true });
    if (Array.isArray(list)) set({ tasks: list });
  },
  createTask: async ({ title, files, agentId }) => {
    const created = await get().callSafe<Task | null>("task.create", {
      title,
      files,
      agent_id: agentId ?? null,
    });
    if (created === undefined) return false;
    if (created && typeof created === "object" && "id" in created) get().upsertTask(created);
    else await get().refreshTasks();
    set({ notice: null });
    return true;
  },
  startTask: async (id) => {
    await get().callSafe("task.start", { id });
  },
  loadDiff: async (id) => {
    const res = await get().callSafe<string | { diff?: string }>("task.diff", { id });
    if (res === undefined) return undefined;
    if (typeof res === "string") return res;
    return typeof res?.diff === "string" ? res.diff : JSON.stringify(res, null, 2);
  },
});
