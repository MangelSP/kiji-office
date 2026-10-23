// Protocolo NDJSON entre la UI (vía Rust) y el core: una línea JSON por mensaje.
// Solo tipos: este archivo no emite JS (el core lo importa con `import type`).

/** Petición UI -> core. */
export type Request = {
  id: string;
  type: 'req';
  method: string;
  params?: unknown;
};

export type ProtocolError = { code: string; message: string };

/** Respuesta core -> UI a una petición con el mismo `id`. */
export type Response = {
  id: string;
  type: 'res';
  result?: unknown;
  error?: ProtocolError;
};

/** Evento core -> UI sin petición previa. */
export type Event = {
  type: 'event';
  name: string;
  payload: unknown;
};

export type Message = Request | Response | Event;

/** Métodos de 0.1 (PLAN-0.1.md, sección 4) más `ping`, de prueba. */
export type MethodName =
  | 'ping'
  | 'project.open'
  | 'project.get'
  | 'providers.detect'
  | 'providers.test'
  | 'agent.create'
  | 'agent.list'
  | 'agent.update'
  | 'objective.create'
  | 'plan.accept'
  | 'task.list'
  | 'task.create'
  | 'task.diff'
  | 'task.assign'
  | 'task.start'
  | 'task.stop'
  | 'task.undo'
  | 'approval.answer'
  | 'integration.apply'
  | 'integration.revert'
  | 'chat.send'
  | 'chat.history'
  | 'events.tail';

/** Eventos de 0.1 (sección 4) más los propios del servidor. */
export type EventName =
  | 'core.ready'
  | 'core.error'
  | 'plan.proposed'
  | 'task.changed'
  | 'agent.status'
  | 'event.appended'
  | 'approval.requested'
  | 'review.ready';
