import { useCallback } from "react";
import { useStore } from "../../store";
import { modelLabel } from "../../store/modelLabel";

/** Función que pinta un modelo (`conn:<id>/<modelo>` incluido) usando `connection.list` del store. */
export function useModelLabel(): (model: string) => string {
  const connections = useStore((s) => s.connections);
  return useCallback((m: string) => modelLabel(m, connections), [connections]);
}
