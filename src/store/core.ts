// Slice `core`: estado de la conexión con el core, proyecto abierto y llamadas con manejo de errores.
import type { StateCreator } from "zustand";
import { core, CoreError } from "../core/client";
import type { AppState } from "./index";

export type CoreStatus = "connecting" | "ok" | "down";
export type Project = { path: string; name?: string };

export type CoreSlice = {
  coreStatus: CoreStatus;
  /** Motivo cuando está caído (p. ej. "sin conexión"). */
  coreDetail?: string;
  project: Project | null;
  /** Métodos que el core aún no implementa (`unknown_method`). */
  unavailable: Record<string, boolean>;
  /** Último aviso para la persona usuaria (error o "aún no disponible"). */
  notice: string | null;
  setCoreStatus: (status: CoreStatus, detail?: string) => void;
  setNotice: (notice: string | null) => void;
  /** Petición al core; marca `unavailable` si el método no existe y relanza el error. */
  call: <T = unknown>(method: string, params?: unknown) => Promise<T>;
  /** Como `call`, pero nunca lanza: deja un aviso (salvo `silent`) y devuelve `undefined`. */
  callSafe: <T = unknown>(method: string, params?: unknown, opts?: { silent?: boolean }) => Promise<T | undefined>;
  ping: () => Promise<boolean>;
  openProject: (path: string) => Promise<void>;
};

export const createCoreSlice: StateCreator<AppState, [], [], CoreSlice> = (set, get) => ({
  coreStatus: "connecting",
  coreDetail: undefined,
  project: null,
  unavailable: {},
  notice: null,

  setCoreStatus: (coreStatus, coreDetail) => set({ coreStatus, coreDetail }),
  setNotice: (notice) => set({ notice }),

  call: async <T>(method: string, params?: unknown) => {
    try {
      return await core.request<T>(method, params);
    } catch (err) {
      if (err instanceof CoreError && err.code === "unknown_method") {
        set((s) => ({ unavailable: { ...s.unavailable, [method]: true } }));
      }
      throw err;
    }
  },

  callSafe: async <T>(method: string, params?: unknown, opts?: { silent?: boolean }) => {
    try {
      const result = await get().call<T>(method, params);
      return result;
    } catch (err) {
      if (!opts?.silent) {
        const aun = err instanceof CoreError && err.code === "unknown_method";
        set({ notice: aun ? `${method}: aún no disponible en el core` : `${method}: ${errorMessage(err)}` });
      }
      return undefined;
    }
  },

  ping: async () => {
    try {
      const pong = await core.request("ping");
      if (pong === "pong") {
        set({ coreStatus: "ok", coreDetail: undefined });
        return true;
      }
      set({ coreStatus: "down", coreDetail: "respuesta inesperada" });
    } catch (err) {
      // Un reinicio ya avisa con core.ready, que vuelve a hacer ping.
      if (err instanceof CoreError && err.code === "core_restarted") return false;
      const detail =
        err instanceof CoreError && err.code === "offline"
          ? "sin conexión"
          : err instanceof CoreError && err.code === "timeout"
            ? "sin respuesta"
            : "caído";
      set({ coreStatus: "down", coreDetail: detail });
    }
    return false;
  },

  openProject: async (path) => {
    const result = await get().callSafe<{ name?: string } | null>("project.open", { path });
    if (result === undefined) return; // error o método no disponible: el aviso ya está puesto
    set({ project: { path, name: result?.name }, notice: null });
    await get().refreshAll();
  },
});

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
