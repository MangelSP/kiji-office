// Acceso tipado al store con la slice `metrics` incluida. Mientras `src/store/index.ts` no la componga,
// los tipos de `useStore` no la conocen; este alias evita casts repartidos por los componentes.
import type { StoreApi, UseBoundStore } from "zustand";
import { useStore } from "../../store";
import type { AppState } from "../../store";
import type { MetricsSlice } from "../../store/metrics";

export type AgentsState = AppState & MetricsSlice;
export const useAgentsStore = useStore as unknown as UseBoundStore<StoreApi<AgentsState>>;
