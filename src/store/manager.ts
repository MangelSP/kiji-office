// Slice `manager` (0.2d): objetivos, revisión e integración de tareas, Gerente autónomo (política, diario), memoria,
// campana de avisos y parada global. El estado por proyecto va en mapas por `projectId`; avisos y parada son globales.
// Los métodos que el core aún no tenga quedan en `unavailable` (slice core) y nunca rompen la pantalla.
import type { StateCreator } from "zustand";
import type {
  IntegrationChangedEvent,
  IntegrationFailReason,
  IntegrationPhase,
  IntegrationView,
  ManagerActionView,
  ManagerDiaryEntry,
  ManagerPolicy,
  ManagerState,
  ManagerTickView,
  MemoryArchiveParams,
  MemoryKind,
  MemoryRow,
  NotificationRow,
  NotificationsMarkReadParams,
  NotifyEvent,
  ObjectiveView,
} from "../../shared/protocol";
import { CoreError } from "../core/client";
import { errorMessage } from "./core";
import type { AppState } from "./index";

/** Fases con progreso visible de `integration.apply`, en orden (`done` y `failed` cierran el progreso). */
export const INTEGRATION_PHASES = ["rebase", "tests", "merge"] as const satisfies readonly IntegrationPhase[];
export type ProgressPhase = (typeof INTEGRATION_PHASES)[number];

/** Por qué falló una integración, ya interpretado para mostrarlo en español. */
export type IntegrationFailure =
  | { kind: "conflict"; files: string[]; message: string }
  | { kind: "tests"; output: string; message: string }
  | { kind: "dirty"; message: string }
  | { kind: "merge"; output: string; message: string }
  | { kind: "other"; message: string };

/** Estado de una integración o reversión en curso (clave = id de la tarea). */
export type IntegrationRun = { busy: boolean; phase: ProgressPhase | null; failure: IntegrationFailure | null };

const EMPTY_RUN: IntegrationRun = { busy: false, phase: null, failure: null };

export const dirtyMessage = (baseBranch?: string) =>
  `Tu repo principal tiene cambios sin guardar o está en otra rama: haz commit o cambia a ${baseBranch ?? "la rama base"} y vuelve a intentarlo`;

/** Fallo estructurado de una integración (evento `integration.changed` con `status: 'failed'`). */
export function integrationFailureFromView(v: Pick<IntegrationView, "detail" | "reason" | "files" | "output">, baseBranch?: string): IntegrationFailure {
  const reason: IntegrationFailReason | undefined = v.reason;
  const message = String(v.detail ?? "");
  if (reason === "conflict") return { kind: "conflict", files: v.files ?? [], message };
  if (reason === "tests_failed") return { kind: "tests", output: v.output ?? "", message };
  if (reason === "dirty") return { kind: "dirty", message: dirtyMessage(baseBranch) };
  if (reason === "merge") return { kind: "merge", output: v.output ?? "", message };
  if (reason === "halted") return { kind: "other", message: "Parada global activa: reanuda y vuelve a integrar." };
  return { kind: "other", message };
}

/** Error lanzado por `integration.apply` (no se pudo ni empezar): `dirty` = repo principal sucio u otra rama. */
export function integrationFailureFromError(code: string, message: string, baseBranch?: string): IntegrationFailure {
  if (code === "dirty") return { kind: "dirty", message: dirtyMessage(baseBranch) };
  return { kind: "other", message };
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object";
const NO_ROWS: never[] = [];

export type ManagerSlice = {
  /** Estado del gerente por proyecto (`manager.get`). */
  manager: Record<string, ManagerState>;
  objectives: Record<string, ObjectiveView[]>;
  integrations: Record<string, IntegrationView[]>;
  /** Integraciones / reversiones en curso o falladas, por id de tarea. */
  integrationRuns: Record<string, IntegrationRun>;
  /** Cronología de ticks por proyecto, el más nuevo primero. */
  diary: Record<string, ManagerDiaryEntry[]>;
  memory: Record<string, MemoryRow[]>;
  /** Avisos de todos los workspaces, el más nuevo primero. */
  notifications: NotificationRow[];
  /** Parada global (`manager.stopAll`): nada arranca hasta reanudar. */
  halted: boolean;
  /** Aprobación a resaltar tras pulsar un aviso. */
  focusApproval: { projectId: string; approvalId: string } | null;

  refreshManager: (projectId: string) => Promise<void>;
  saveManager: (projectId: string, policy: ManagerPolicy) => Promise<boolean>;
  /** `manager.tick` devuelve `{tickId}`; aquí solo importa si el core lo aceptó. */
  tickManager: (projectId: string, message?: string) => Promise<boolean>;
  refreshObjectives: (projectId: string) => Promise<void>;
  createObjective: (projectId: string, text: string) => Promise<boolean>;
  refreshDiary: (projectId: string) => Promise<void>;
  refreshMemory: (projectId: string, query?: string) => Promise<void>;
  addMemory: (projectId: string, kind: MemoryKind, text: string) => Promise<boolean>;
  archiveMemory: (projectId: string, id: number) => Promise<void>;
  refreshNotifications: () => Promise<void>;
  markRead: (ids: NotificationsMarkReadParams["ids"]) => Promise<void>;
  stopAll: () => Promise<boolean>;
  resume: () => Promise<boolean>;
  setFocusApproval: (projectId: string, approvalId: string) => void;
  /** Aprueba la tarea o pide cambios con hallazgos (`task.review`). */
  reviewTask: (projectId: string, id: string | number, verdict: "approve" | "changes", findings?: string[]) => Promise<boolean>;
  refreshIntegrations: (projectId: string) => Promise<void>;
  applyTask: (projectId: string, taskId: string | number) => Promise<boolean>;
  revertTask: (projectId: string, taskId: string | number) => Promise<boolean>;
  clearIntegrationFailure: (taskId: string | number) => void;

  // Eventos del core.
  applyObjective: (o: ObjectiveView) => void;
  applyIntegration: (payload: unknown) => void;
  applyManagerTick: (projectId: string, payload: unknown) => void;
  applyManagerAction: (a: ManagerActionView) => void;
  applyHalted: (payload: unknown) => void;
  applyNotify: (n: NotifyEvent) => void;
};

function upsertBy<T>(list: T[], item: T, same: (a: T) => boolean, front = false): T[] {
  const i = list.findIndex(same);
  if (i < 0) return front ? [item, ...list] : [...list, item];
  const out = list.slice();
  out[i] = { ...out[i], ...item };
  return out;
}

export const createManagerSlice: StateCreator<AppState, [], [], ManagerSlice> = (set, get) => {
  const patchMap = <K extends "manager" | "objectives" | "integrations" | "diary" | "memory">(
    key: K,
    pid: string,
    value: ManagerSlice[K][string],
  ) => set((s) => ({ [key]: { ...s[key], [pid]: value } }) as unknown as Pick<ManagerSlice, K>);
  const baseBranchOf = (pid: string) => get().projects.find((p) => p.projectId === pid)?.baseBranch;
  const setRun = (taskId: string | number, run: Partial<IntegrationRun>) =>
    set((s) => {
      const key = String(taskId);
      return { integrationRuns: { ...s.integrationRuns, [key]: { ...(s.integrationRuns[key] ?? EMPTY_RUN), ...run } } };
    });

  return {
    manager: {},
    objectives: {},
    integrations: {},
    integrationRuns: {},
    diary: {},
    memory: {},
    notifications: [],
    halted: false,
    focusApproval: null,

    refreshManager: async (pid) => {
      const res = await get().callSafe<Partial<ManagerState>>("manager.get", { projectId: pid }, { silent: true });
      if (!isObj(res)) return;
      const state: ManagerState = {
        projectId: pid,
        policy: res.policy ?? null,
        halted: !!res.halted,
        running: !!res.running,
        lastTick: res.lastTick ?? null,
        todayCostUsd: res.todayCostUsd ?? 0,
      };
      set((s) => ({ manager: { ...s.manager, [pid]: state }, halted: state.halted }));
    },

    saveManager: async (pid, policy) => {
      const res = await get().callSafe<Partial<ManagerState>>("manager.set", { projectId: pid, policy });
      if (res === undefined) return false;
      const prev = get().manager[pid];
      const state: ManagerState = {
        projectId: pid,
        policy: isObj(res) && "policy" in res ? (res.policy ?? null) : policy,
        halted: isObj(res) && typeof res.halted === "boolean" ? res.halted : (prev?.halted ?? false),
        running: prev?.running ?? false,
        lastTick: isObj(res) && res.lastTick !== undefined ? (res.lastTick ?? null) : (prev?.lastTick ?? null),
        todayCostUsd: isObj(res) && typeof res.todayCostUsd === "number" ? res.todayCostUsd : (prev?.todayCostUsd ?? 0),
      };
      patchMap("manager", pid, state);
      return true;
    },

    tickManager: async (pid, message) => {
      const text = message?.trim();
      const res = await get().callSafe<{ tickId: string }>("manager.tick", { projectId: pid, ...(text ? { message: text } : {}) });
      return res !== undefined;
    },

    refreshObjectives: async (pid) => {
      const list = await get().callSafe<ObjectiveView[]>("objective.list", { projectId: pid }, { silent: true });
      if (Array.isArray(list)) patchMap("objectives", pid, list);
    },

    createObjective: async (pid, text) => {
      const res = await get().callSafe<ObjectiveView | null>("objective.create", { projectId: pid, text });
      if (res === undefined) return false;
      set({ notice: null });
      if (isObj(res) && "id" in res) get().applyObjective({ ...(res as ObjectiveView), projectId: pid });
      return true;
    },

    refreshDiary: async (pid) => {
      const list = await get().callSafe<ManagerDiaryEntry[]>("manager.diary", { projectId: pid, limit: 50 }, { silent: true });
      if (!Array.isArray(list)) return;
      patchMap("diary", pid, list.map((e) => ({ ...e, actions: Array.isArray(e.actions) ? e.actions : [] })));
    },

    refreshMemory: async (pid, query) => {
      const q = query?.trim();
      const list = await get().callSafe<MemoryRow[]>("memory.list", { projectId: pid, ...(q ? { query: q } : {}) }, { silent: true });
      if (Array.isArray(list)) patchMap("memory", pid, list);
    },

    addMemory: async (pid, kind, text) => {
      const row = await get().callSafe<MemoryRow | null>("memory.add", { projectId: pid, kind, text });
      if (row === undefined) return false;
      if (isObj(row) && "id" in row) {
        set((s) => ({ memory: { ...s.memory, [pid]: upsertBy(s.memory[pid] ?? [], row as MemoryRow, (m) => m.id === row.id, true) } }));
      } else await get().refreshMemory(pid);
      return true;
    },

    archiveMemory: async (pid, id) => {
      const params: MemoryArchiveParams = { projectId: pid, id };
      const ok = await get().callSafe("memory.archive", params);
      if (ok === undefined) return;
      set((s) => ({ memory: { ...s.memory, [pid]: (s.memory[pid] ?? []).filter((m) => m.id !== id) } }));
    },

    refreshNotifications: async () => {
      const list = await get().callSafe<NotificationRow[]>("notifications.list", {}, { silent: true });
      if (Array.isArray(list)) set({ notifications: [...list].sort((a, b) => b.createdAt - a.createdAt) });
    },

    markRead: async (ids) => {
      if (ids !== "all" && ids.length === 0) return;
      const now = Date.now();
      const mark = ids === "all" ? null : new Set(ids);
      set((s) => ({
        notifications: s.notifications.map((n) => ((mark === null || mark.has(n.id)) && n.readAt == null ? { ...n, readAt: now } : n)),
      }));
      const params: NotificationsMarkReadParams = { ids };
      await get().callSafe("notifications.markRead", params, { silent: true });
    },

    stopAll: async () => {
      const res = await get().callSafe<{ halted?: boolean }>("manager.stopAll");
      if (res === undefined) return false;
      set({ halted: isObj(res) && typeof res.halted === "boolean" ? res.halted : true });
      return true;
    },

    resume: async () => {
      const res = await get().callSafe<{ halted?: boolean }>("manager.resume");
      if (res === undefined) return false;
      set({ halted: isObj(res) && typeof res.halted === "boolean" ? res.halted : false });
      return true;
    },

    setFocusApproval: (projectId, approvalId) => {
      set({ focusApproval: { projectId, approvalId } });
      setTimeout(() => {
        const cur = get().focusApproval;
        if (cur && cur.projectId === projectId && cur.approvalId === approvalId) set({ focusApproval: null });
      }, 8000);
    },

    reviewTask: async (pid, id, verdict, findings) => {
      const res = await get().callSafe("task.review", {
        id,
        projectId: pid,
        verdict,
        ...(findings && findings.length > 0 ? { findings } : {}),
      });
      if (res === undefined) return false;
      if (isObj(res) && "id" in res && "status" in res) get().upsertTask(pid, res as never);
      else void get().refreshTasks(pid);
      return true;
    },

    refreshIntegrations: async (pid) => {
      const list = await get().callSafe<IntegrationView[]>("integration.list", { projectId: pid }, { silent: true });
      if (Array.isArray(list)) patchMap("integrations", pid, list);
    },

    // El core responde ya `{phase:'started'}` y sigue en segundo plano: el progreso y el resultado (done | failed)
    // llegan por `integration.changed` (applyIntegration), que es quien suelta `busy`.
    applyTask: async (pid, taskId) => {
      setRun(taskId, { busy: true, phase: null, failure: null });
      try {
        await get().call<{ phase: "started"; taskId: string } | null>("integration.apply", { id: taskId, projectId: pid });
        return true;
      } catch (err) {
        const code = err instanceof CoreError ? err.code : "";
        const message = errorMessage(err);
        setRun(taskId, {
          busy: false,
          phase: null,
          failure:
            code === "unknown_method"
              ? { kind: "other", message: "Integrar aún no está disponible en el core." }
              : integrationFailureFromError(code, message, baseBranchOf(pid)),
        });
        return false;
      }
    },

    revertTask: async (pid, taskId) => {
      const find = () =>
        (get().integrations[pid] ?? [])
          .filter((i) => String(i.taskId) === String(taskId) && i.status === "applied")
          .sort((a, b) => b.createdAt - a.createdAt)[0];
      let integration = find();
      if (!integration) {
        await get().refreshIntegrations(pid);
        integration = find();
      }
      if (!integration) {
        set({ notice: "No encuentro la integración de esta tarea para deshacerla." });
        return false;
      }
      setRun(taskId, { busy: true, failure: null });
      const res = await get().callSafe("integration.revert", { integrationId: integration.id, projectId: pid });
      setRun(taskId, { busy: false });
      if (res === undefined) return false;
      void get().refreshTasks(pid);
      void get().refreshIntegrations(pid);
      return true;
    },

    clearIntegrationFailure: (taskId) => setRun(taskId, { failure: null }),

    applyObjective: (o) =>
      set((s) => ({
        objectives: { ...s.objectives, [o.projectId]: upsertBy(s.objectives[o.projectId] ?? [], o, (x) => x.id === o.id, true) },
      })),

    applyIntegration: (payload) => {
      if (!isObj(payload) || typeof payload.projectId !== "string") return;
      const ev = payload as unknown as IntegrationChangedEvent;
      const pid = ev.projectId;
      if (ev.taskId !== undefined && ev.status !== undefined && ev.id !== undefined) {
        const { phase: _phase, ...rest } = ev;
        const row = rest as IntegrationView;
        set((s) => ({ integrations: { ...s.integrations, [pid]: upsertBy(s.integrations[pid] ?? [], row, (x) => x.id === row.id, true) } }));
        if (row.status === "failed") setRun(row.taskId, { busy: false, phase: null, failure: integrationFailureFromView(row, baseBranchOf(pid)) });
      }
      // Progreso en vivo: rebase -> tests -> merge; `done` y `failed` lo cierran.
      if (ev.taskId === undefined || ev.phase === undefined) return;
      if ((INTEGRATION_PHASES as readonly string[]).includes(ev.phase)) setRun(ev.taskId, { phase: ev.phase as ProgressPhase });
      else if (ev.phase === "done") {
        setRun(ev.taskId, { busy: false, phase: null });
        void get().refreshTasks(pid);
        void get().refreshIntegrations(pid);
      } else setRun(ev.taskId, { busy: false, phase: null });
    },

    applyManagerTick: (pid, payload) => {
      if (!isObj(payload)) return;
      const tick = isObj(payload.tick) ? (payload.tick as unknown as ManagerTickView) : null;
      const phase: "started" | "ended" = payload.phase === "ended" ? "ended" : "started";
      const prev = get().manager[pid];
      if (prev) {
        patchMap("manager", pid, { ...prev, running: phase === "started", lastTick: tick ?? prev.lastTick });
      }
      if (tick) {
        set((s) => {
          const list = s.diary[pid] ?? [];
          const old = list.find((e) => e.id === tick.id);
          return { diary: { ...s.diary, [pid]: upsertBy(list, { ...tick, actions: old?.actions ?? [] }, (e) => e.id === tick.id, true) } };
        });
      }
      if (phase === "ended") {
        void get().refreshManager(pid);
        void get().refreshDiary(pid);
      }
    },

    applyManagerAction: (a) =>
      set((s) => {
        const pid = a.projectId;
        const list = s.diary[pid] ?? [];
        const entry = list.find((e) => e.id === a.tickId);
        if (!entry) {
          const stub: ManagerDiaryEntry = {
            id: a.tickId, projectId: pid, trigger: "", summary: "", costUsd: 0, startedAt: a.createdAt, endedAt: null, actions: [a],
          };
          return { diary: { ...s.diary, [pid]: [stub, ...list] } };
        }
        const next = { ...entry, actions: upsertBy(entry.actions, a, (x) => x.id === a.id) };
        return { diary: { ...s.diary, [pid]: list.map((e) => (e.id === entry.id ? next : e)) } };
      }),

    applyHalted: (payload) => {
      const halted = typeof payload === "boolean" ? payload : isObj(payload) && typeof payload.halted === "boolean" ? payload.halted : true;
      set({ halted });
    },

    applyNotify: (n) =>
      set((s) => {
        if (s.notifications.some((x) => x.id === n.id)) return s;
        const row: NotificationRow = {
          id: n.id, projectId: n.projectId, level: n.level, title: n.title, body: n.body,
          approvalId: n.approvalId ?? null, readAt: null, createdAt: Date.now(),
        };
        return { notifications: [row, ...s.notifications] };
      }),
  };
};

export const NO_OBJECTIVES: ObjectiveView[] = NO_ROWS;
export const NO_DIARY: ManagerDiaryEntry[] = NO_ROWS;
export const NO_MEMORY: MemoryRow[] = NO_ROWS;
export const NO_INTEGRATIONS: IntegrationView[] = NO_ROWS;
export { EMPTY_RUN };
