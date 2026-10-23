// Vista del store acotada a un proyecto (workspace): `useScoped(selector)` ve el estado global más la partición del
// proyecto de su pestaña (`agents`, `tasks`, `events`...) y las acciones de proyecto ya con su `projectId` puesto.
// Los componentes de la oficina no necesitan saber de particiones; solo cambia el proyecto del contexto.
import { createContext, useContext } from "react";
import { useStore, type AppState } from ".";
import { EMPTY_PROJECT, type ProjectData } from "./partition";

/** Proyecto de la oficina que se está dibujando; sin proveedor se usa la pestaña activa. */
export const ProjectContext = createContext<string | null>(null);

/** Id del proyecto del contexto (o de la pestaña activa). Cadena vacía si no hay ninguno. */
export function useProjectId(): string {
  const fromContext = useContext(ProjectContext);
  const active = useStore((s) => s.activeProjectId);
  return fromContext ?? active ?? "";
}

/** Acciones del store cuyo primer parámetro es el id del proyecto. */
const PID_ACTIONS = [
  "setAgents",
  "setAgentStatus",
  "refreshAgents",
  "upsertAgent",
  "updateAgent",
  "upsertTask",
  "refreshTasks",
  "createTask",
  "startTask",
  "loadDiff",
  "addApproval",
  "answerApproval",
  "clearEvents",
  "refreshMetrics",
  "refreshSteps",
  "switchTask",
  "refreshRelays",
  "noteActivity",
  "setDraft",
] as const;
type PidAction = (typeof PID_ACTIONS)[number];

type Bind<F> = F extends (projectId: string, ...args: infer A) => infer R ? (...args: A) => R : never;
type BoundActions = { [K in PidAction]: Bind<AppState[K]> };

export type ScopedState = Omit<AppState, PidAction | "byProject"> & ProjectData & BoundActions & { projectId: string };

const boundCache = new Map<string, BoundActions>();
function bound(pid: string): BoundActions {
  let b = boundCache.get(pid);
  if (!b) {
    const out: Record<string, unknown> = {};
    for (const name of PID_ACTIONS) {
      out[name] = (...args: unknown[]) => (useStore.getState()[name] as (...a: unknown[]) => unknown)(pid, ...args);
    }
    b = out as BoundActions;
    boundCache.set(pid, b);
  }
  return b;
}

// Una vista por (estado, proyecto): los selectores de una misma renderización la comparten.
const viewCache = new WeakMap<AppState, Map<string, ScopedState>>();
export function scopedView(s: AppState, pid: string): ScopedState {
  let perState = viewCache.get(s);
  if (!perState) viewCache.set(s, (perState = new Map()));
  let v = perState.get(pid);
  if (!v) {
    v = { ...s, ...(s.byProject[pid] ?? EMPTY_PROJECT), ...bound(pid), projectId: pid } as ScopedState;
    perState.set(pid, v);
  }
  return v;
}

/** Como `useStore(selector)`, pero con el estado y las acciones del proyecto de la pestaña. */
export function useScoped<T>(selector: (s: ScopedState) => T): T {
  const pid = useProjectId();
  return useStore((s) => selector(scopedView(s, pid)));
}
