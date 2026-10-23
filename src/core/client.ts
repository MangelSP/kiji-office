// Cliente del core: una sola escucha de `core:line` para toda la app, peticiones con correlación por `id`.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Event as CoreEvent, Message, ProtocolError, Request } from "../../shared/protocol";

/** Error devuelto por el core (o generado por el cliente: `timeout`, `core_restarted`, `offline`...). */
export class CoreError extends Error {
  code: string;
  constructor(error: ProtocolError) {
    super(error.message);
    this.name = "CoreError";
    this.code = error.code;
  }
}

type EventHandler = (event: CoreEvent) => void;

type Pending = {
  resolve: (value: unknown) => void;
  reject: (reason: CoreError) => void;
  timer: ReturnType<typeof setTimeout>;
};

export const DEFAULT_TIMEOUT_MS = 15_000;

export function createCoreClient(timeoutMs = DEFAULT_TIMEOUT_MS) {
  const pending = new Map<string, Pending>();
  const handlers = new Map<string, Set<EventHandler>>();
  let counter = 0;
  let starting: Promise<boolean> | undefined;

  function rejectAll(error: ProtocolError) {
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      pending.delete(id);
      p.reject(new CoreError(error));
    }
  }

  let debugSeen = 0;
  function dispatch(event: CoreEvent) {
    // Solo desarrollo: los primeros eventos al log de Rust para diagnosticar.
    if (import.meta.env.DEV && debugSeen < 40) {
      debugSeen++;
      const handlersCount = (handlers.get(event.name)?.size ?? 0) + (handlers.get("*")?.size ?? 0);
      (globalThis as { __kijiLog?: (m: string) => void }).__kijiLog?.(`evento ${event.name} (handlers ${handlersCount})`);
    }
    // Copia: un handler puede darse de baja mientras se despacha.
    for (const key of [event.name, "*"]) {
      for (const h of [...(handlers.get(key) ?? [])]) {
        try {
          h(event);
        } catch (err) {
          console.error("handler de evento del core falló", err);
        }
      }
    }
  }

  function handleLine(line: string) {
    let msg: Message;
    try {
      msg = JSON.parse(line) as Message;
    } catch {
      return; // línea que no es JSON: se ignora
    }
    if (msg === null || typeof msg !== "object") return;
    if (msg.type === "res") {
      const p = pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      pending.delete(msg.id);
      if (msg.error) p.reject(new CoreError(msg.error));
      else p.resolve(msg.result);
    } else if (msg.type === "event") {
      // Un core nuevo no conoce las peticiones del anterior: nadie las contestará.
      if (msg.name === "core.ready") rejectAll({ code: "core_restarted", message: "el core se reinició" });
      else if (msg.name === "core.crashed") rejectAll({ code: "core_crashed", message: "el core se cayó" });
      dispatch(msg);
    }
  }

  /** Registra la única escucha de `core:line`. Devuelve false si no hay Tauri (p. ej. en el navegador). */
  function start(): Promise<boolean> {
    starting ??= (async () => {
      try {
        await listen<string>("core:line", (e) => handleLine(e.payload));
        return true;
      } catch {
        starting = undefined; // permitir reintentar
        return false;
      }
    })();
    return starting;
  }

  async function request<T = unknown>(method: string, params?: unknown, timeout = timeoutMs): Promise<T> {
    if (!(await start())) throw new CoreError({ code: "offline", message: "sin conexión con el core" });
    const id = `ui-${++counter}`;
    const req: Request = { id, type: "req", method, params };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new CoreError({ code: "timeout", message: `el core no respondió a ${method} en ${timeout} ms` }));
      }, timeout);
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      invoke("core_send", { line: JSON.stringify(req) }).catch((err: unknown) => {
        const p = pending.get(id);
        if (!p) return;
        clearTimeout(p.timer);
        pending.delete(id);
        reject(new CoreError({ code: "offline", message: String(err) }));
      });
    });
  }

  /** Suscribe a un evento por nombre o a todos con `'*'`. Devuelve la función para darse de baja. */
  function onEvent(name: string, handler: EventHandler): () => void {
    let set = handlers.get(name);
    if (!set) handlers.set(name, (set = new Set()));
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }

  return { start, request, onEvent };
}

export type CoreClient = ReturnType<typeof createCoreClient>;

export const core = createCoreClient();

// Desarrollo: un cliente nuevo por recarga en caliente perdería la escucha de `core:line`; mejor recargar todo.
if (import.meta.hot) import.meta.hot.accept(() => window.location.reload());
