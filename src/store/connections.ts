// Slice `connections` (0.2b): conexiones a IAs compatibles con OpenAI. Son GLOBALES (de la cuenta), no de un proyecto.
// Aquí nunca entra una clave: el valor escrito en el formulario va directo a `secret_set` (llavero) y no se guarda.
import type { StateCreator } from "zustand";
import type { ConnectionCreateParams, ConnectionTest, ConnectionView, DiscoveredServer } from "../../shared/protocol";
import { errorMessage } from "./core";
import { secretDelete, tauriError } from "../screens/Wizard/tauri";
import { presetInfo } from "../screens/Connections/presets";
import type { AppState } from "./index";

export type ConnectionsSlice = {
  connections: ConnectionView[];
  /** Resultado de `connections.discover` (servidores locales encontrados). */
  discovered: DiscoveredServer[];
  discovering: boolean;
  /** Pantalla Conexiones abierta (vista global, por encima de Home/oficina). */
  connectionsOpen: boolean;
  setConnectionsOpen: (open: boolean) => void;
  refreshConnections: () => Promise<void>;
  /** `connections.changed`: si trae la lista la usa; si no, la vuelve a pedir. */
  applyConnections: (list: unknown) => void;
  discover: () => Promise<void>;
  /** "Conectar" de un servidor encontrado: crea la conexión (sin clave) y lanza la prueba. */
  connectDiscovered: (server: DiscoveredServer) => Promise<ConnectionView | undefined>;
  testConnection: (id: string, model?: string) => Promise<ConnectionTest | undefined>;
  /** Borra primero la clave del llavero y luego la conexión; intenta ambas aunque una falle. null = todo bien, si no el error. */
  removeConnection: (id: string, hasSecret: boolean) => Promise<string | null>;
  deleteConnection: (id: string, hasSecret?: boolean) => Promise<boolean>;
};

export const createConnectionsSlice: StateCreator<AppState, [], [], ConnectionsSlice> = (set, get) => ({
  connections: [],
  discovered: [],
  discovering: false,
  connectionsOpen: false,
  setConnectionsOpen: (connectionsOpen) => set({ connectionsOpen }),

  refreshConnections: async () => {
    const list = await get().callSafe<ConnectionView[]>("connection.list", undefined, { silent: true });
    if (Array.isArray(list)) set({ connections: list });
  },
  applyConnections: (list) => {
    if (Array.isArray(list)) set({ connections: list as ConnectionView[] });
    else void get().refreshConnections();
  },

  discover: async () => {
    set({ discovering: true });
    const list = await get().callSafe<DiscoveredServer[]>("connections.discover", undefined, { silent: true });
    set({ discovering: false, ...(Array.isArray(list) ? { discovered: list } : {}) });
  },

  connectDiscovered: async (server) => {
    const info = presetInfo(server.preset);
    const params: ConnectionCreateParams = {
      name: info.label,
      preset: server.preset,
      baseUrl: server.baseUrl,
      auth: "none",
      ...(server.models[0] ? { defaultModel: server.models[0] } : {}),
    };
    const created = await get().callSafe<ConnectionView>("connection.create", params);
    if (!created) return undefined;
    await get().refreshConnections();
    await get().testConnection(created.id);
    void get().discover();
    return get().connections.find((c) => c.id === created.id) ?? created;
  },

  testConnection: async (id, model) => {
    const res = await get().callSafe<ConnectionTest>("connection.test", model ? { id, model } : { id });
    await get().refreshConnections();
    return res;
  },

  removeConnection: async (id, hasSecret) => {
    const errors: string[] = [];
    if (hasSecret) {
      try {
        await secretDelete(`conn:${id}`);
      } catch (err) {
        errors.push(`No se pudo borrar la clave del llavero: ${tauriError(err)}`);
      }
    }
    try {
      await get().call("connection.delete", { id });
    } catch (err) {
      errors.push(`No se pudo borrar la conexión: ${errorMessage(err)}`);
    }
    await get().refreshConnections();
    return errors.length ? errors.join(" ") : null;
  },

  deleteConnection: async (id, hasSecret = false) => {
    const err = await get().removeConnection(id, hasSecret);
    if (err) set({ notice: err });
    return err === null;
  },
});
