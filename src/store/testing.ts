// Ayudas para las pruebas: proyecto de ejemplo, reinicio del store y siembra de la partición de un proyecto.
import { useStore } from ".";
import { EMPTY_PROJECT, projectOf, type ProjectData } from "./partition";

/** Proyecto activo por defecto en las pruebas. */
export const P = "p1";

/** Estado limpio con `P` como pestaña activa (y sin datos). Complementa lo que ya reinicie cada prueba. */
export function resetStore(activeProjectId: string | null = P): void {
  useStore.setState({
    byProject: {},
    activeProjectId,
    coreEvents: [],
    projects: [],
    tabs: [],
    overview: null,
    budgetNotice: null,
    notice: null,
    unavailable: {},
  });
}

/** Mezcla `patch` en la partición de `pid` (parte de la vacía si no existe). */
export function seed(patch: Partial<ProjectData>, pid: string = P): void {
  useStore.getState().patchProject(pid, () => patch);
}

/** Partición actual de `pid`. */
export const proj = (pid: string = P): ProjectData => projectOf(useStore.getState(), pid);

export { EMPTY_PROJECT };
