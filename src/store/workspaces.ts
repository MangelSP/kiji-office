// Slice `workspaces` (0.2c): un workspace = un proyecto abierto. Lista de proyectos conocidos, orden de las pestañas,
// resumen del Home (`workspaces.overview`), aviso de tope de gasto y las acciones abrir / cerrar / entrar.
import type { StateCreator } from "zustand";
import type {
  BudgetNotice,
  ProjectCloseParams,
  ProjectCloseResult,
  ProjectListItem,
  ProjectReopenResult,
  QueueChange,
  WorkspaceOverview,
} from "../../shared/protocol";
import type { AppState } from "./index";

export type WorkspacesSlice = {
  /** Proyectos conocidos (`project.list`): abiertos primero. */
  projects: ProjectListItem[];
  /** Ids de los workspaces abiertos, en el orden de las pestañas (el de apertura). */
  tabs: string[];
  overview: WorkspaceOverview | null;
  budgetNotice: BudgetNotice | null;
  /** El primer intento de conexión con el core ya terminó (con o sin éxito): evita enseñar el asistente de más. */
  booted: boolean;
  setBooted: (booted: boolean) => void;
  setActiveProject: (projectId: string | null) => void;
  applyProjects: (list: ProjectListItem[]) => void;
  /** `workspaces.changed` / `workspaces.overview`: guarda el resumen y refresca los contadores de las pestañas. */
  applyOverview: (overview: WorkspaceOverview) => void;
  applyQueue: (change: QueueChange) => void;
  setBudgetNotice: (notice: BudgetNotice | null) => void;
  /** `project.list` + `workspaces.overview`. */
  refreshWorkspaces: () => Promise<void>;
  /** Carga agentes, tareas y relevos de un proyecto en su partición. */
  hydrateProject: (projectId: string) => Promise<void>;
  /** Tras `core.ready`: reabre los proyectos de la sesión anterior y carga lista, resumen y datos de cada uno. */
  bootstrap: () => Promise<void>;
  /** Abre (o reabre) una carpeta como workspace y entra en él. Devuelve su id, o `undefined` si falló (aviso en `notice`). */
  openProject: (path: string) => Promise<string | undefined>;
  /** Abre un proyecto conocido y cerrado (Recientes) y entra en él. */
  reopenProject: (projectId: string) => Promise<void>;
  /** Cierra el workspace. `true` si el core lo cerró; con runs vivos y sin `force` el core lo rechaza y deja un aviso. */
  closeProject: (projectId: string, force?: boolean) => Promise<boolean>;
  /** Va a la pestaña del workspace; si está cerrado lo abre antes. */
  enterWorkspace: (projectId: string) => Promise<void>;
};

/** Mantiene el orden de las pestañas ya abiertas y añade al final las nuevas. */
export function syncTabs(prev: string[], list: ProjectListItem[]): string[] {
  const open = new Set(list.filter((p) => p.open).map((p) => p.projectId));
  const kept = prev.filter((id) => open.has(id));
  const added = list.filter((p) => p.open && !kept.includes(p.projectId)).map((p) => p.projectId);
  return [...kept, ...added];
}

export const createWorkspacesSlice: StateCreator<AppState, [], [], WorkspacesSlice> = (set, get) => ({
  projects: [],
  tabs: [],
  overview: null,
  budgetNotice: null,
  booted: false,
  setBooted: (booted) => set({ booted }),

  setActiveProject: (activeProjectId) => set({ activeProjectId }),

  applyProjects: (list) =>
    set((s) => {
      const tabs = syncTabs(s.tabs, list);
      const active = s.activeProjectId && tabs.includes(s.activeProjectId) ? s.activeProjectId : null;
      return { projects: list, tabs, activeProjectId: active };
    }),

  applyOverview: (overview) =>
    set((s) => {
      const byId = new Map(overview.workspaces.map((w) => [w.projectId, w]));
      const projects = s.projects.map((p) => {
        const w = byId.get(p.projectId);
        if (!w) return p;
        return {
          ...p,
          name: w.name,
          open: w.open,
          color: w.color,
          scene: w.scene,
          liveRuns: w.liveRuns,
          queued: w.queued,
          needsYou: w.needsYou,
          approvalsPending: w.approvalsPending,
          tasksByStatus: w.tasksByStatus,
        };
      });
      return { overview, projects };
    }),

  applyQueue: (change) =>
    get().patchProject(change.projectId, (p) => {
      const key = String(change.taskId);
      if (!change.queued) {
        if (!(key in p.queue)) return null;
        const { [key]: _gone, ...rest } = p.queue;
        return { queue: rest };
      }
      return { queue: { ...p.queue, [key]: change } };
    }),

  setBudgetNotice: (budgetNotice) => set({ budgetNotice }),

  refreshWorkspaces: async () => {
    const [list, overview] = await Promise.all([
      get().callSafe<ProjectListItem[]>("project.list", undefined, { silent: true }),
      get().callSafe<WorkspaceOverview>("workspaces.overview", undefined, { silent: true }),
    ]);
    if (Array.isArray(list)) get().applyProjects(list);
    if (overview && Array.isArray(overview.workspaces)) get().applyOverview(overview);
  },

  hydrateProject: async (pid) => {
    const s = get();
    await Promise.all([s.refreshAgents(pid), s.refreshTasks(pid), s.refreshRelays(pid)]);
  },

  bootstrap: async () => {
    const s = get();
    void s.refreshProviders();
    const reopened = await s.callSafe<ProjectReopenResult>("project.reopen", undefined, { silent: true });
    if (reopened && reopened.failed?.length > 0) {
      const f = reopened.failed[0];
      set({ notice: `No se pudo reabrir ${f.path}: ${f.error}` });
    }
    await s.refreshWorkspaces();
    await Promise.all(get().tabs.map((id) => get().hydrateProject(id)));
    set({ booted: true });
  },

  openProject: async (path) => {
    const row = await get().callSafe<{ id?: string } | null>("project.open", { path });
    if (row === undefined) return undefined; // error o método no disponible: el aviso ya está puesto
    const id = row?.id;
    set({ notice: null });
    if (typeof id !== "string") {
      await get().bootstrap();
      return undefined;
    }
    await get().refreshWorkspaces();
    await get().hydrateProject(id);
    set({ activeProjectId: id });
    return id;
  },

  reopenProject: async (projectId) => {
    const path = get().projects.find((p) => p.projectId === projectId)?.path;
    if (path) await get().openProject(path);
  },

  closeProject: async (projectId, force = false) => {
    const params: ProjectCloseParams = { projectId, ...(force ? { force: true } : {}) };
    const res = await get().callSafe<ProjectCloseResult>("project.close", params);
    if (res === undefined) return false;
    get().dropProject(projectId);
    set((s) => (s.activeProjectId === projectId ? { activeProjectId: null } : s));
    await get().refreshWorkspaces();
    return true;
  },

  enterWorkspace: async (projectId) => {
    if (get().tabs.includes(projectId)) {
      set({ activeProjectId: projectId });
      return;
    }
    await get().reopenProject(projectId);
  },
});
