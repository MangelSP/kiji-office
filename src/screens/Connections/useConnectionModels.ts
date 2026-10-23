// Modelos de una conexión (`connection.models`). Sin conexión (Claude) no pide nada.
import { useEffect, useState } from "react";
import { useStore } from "../../store";

export function useConnectionModels(connectionId: string | null): { models: string[]; loading: boolean } {
  const call = useStore((s) => s.call);
  const [state, setState] = useState<{ id: string | null; models: string[] }>({ id: null, models: [] });

  useEffect(() => {
    if (connectionId === null) return;
    let alive = true;
    call<string[]>("connection.models", { id: connectionId })
      .then((list) => alive && setState({ id: connectionId, models: Array.isArray(list) ? list : [] }))
      .catch(() => alive && setState({ id: connectionId, models: [] })); // sin lista: se escribe a mano
    return () => {
      alive = false;
    };
  }, [connectionId, call]);

  if (connectionId === null) return { models: [], loading: false };
  return state.id === connectionId ? { models: state.models, loading: false } : { models: [], loading: true };
}
