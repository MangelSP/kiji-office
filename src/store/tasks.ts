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
  /** Texto completo del pedido. */
  description?: string;
  /** Tarea de consulta: sin archivos que modificar (el core la marca así si no reserva ninguno). */
  read_only?: boolean;
  /** Respuesta final del agente (último `done`, máx. 20 000 caracteres). */
  result?: string | null;
  /** En la cola global esperando hueco (0.2c); conserva su estado (`assigned`, `paused_limit`...). */
  queued?: boolean;
  /** Posición en la cola, 1-based; null si no está en cola. */
  queue_position?: number | null;
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
  upsertTask: (projectId: string, task: Task) => void;
  refreshTasks: (projectId: string) => Promise<void>;
  /** Nombre del método de creación: no está en la lista de 0.1 (ver informe del paso 7). */
  createTask: (
    projectId: string,
    input: { title: string; description?: string; files: string[]; agentId?: Id },
  ) => Promise<Task | undefined>;
  startTask: (projectId: string, id: Id) => Promise<void>;
  /** Devuelve el texto del diff, o `undefined` si no se pudo obtener. */
  loadDiff: (projectId: string, id: Id) => Promise<string | undefined>;
};

export const createTasksSlice: StateCreator<AppState, [], [], TasksSlice> = (set, get) => ({
  upsertTask: (pid, task) =>
    get().patchProject(pid, (p) => {
      const i = p.tasks.findIndex((t) => String(t.id) === String(task.id));
      if (i < 0) return { tasks: [...p.tasks, task] };
      const tasks = p.tasks.slice();
      tasks[i] = { ...tasks[i], ...task };
      return { tasks };
    }),
  refreshTasks: async (pid) => {
    const list = await get().callSafe<Task[]>("task.list", { projectId: pid }, { silent: true });
    if (Array.isArray(list)) get().patchProject(pid, () => ({ tasks: list }));
  },
  createTask: async (pid, { title, description, files, agentId }) => {
    const created = await get().callSafe<Task | null>("task.create", {
      projectId: pid,
      title,
      ...(description ? { description } : {}),
      files,
      agent_id: agentId ?? null,
    });
    if (created === undefined) return undefined;
    set({ notice: null });
    if (created && typeof created === "object" && "id" in created) {
      get().upsertTask(pid, created);
      return created;
    }
    await get().refreshTasks(pid);
    return undefined;
  },
  startTask: async (pid, id) => {
    await get().callSafe("task.start", { id, projectId: pid });
  },
  loadDiff: async (pid, id) => {
    const res = await get().callSafe<string | { diff?: string }>("task.diff", { id, projectId: pid });
    if (res === undefined) return undefined;
    if (typeof res === "string") return res;
    return typeof res?.diff === "string" ? res.diff : JSON.stringify(res, null, 2);
  },
});
