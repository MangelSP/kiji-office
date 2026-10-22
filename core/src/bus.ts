import type { Event } from '../../shared/protocol.js';

type Listener = (event: Event) => void;

const listeners: Listener[] = [];

/** Escribe un mensaje como una línea NDJSON por stdout (único canal hacia la UI). */
export function writeLine(message: unknown): void {
  process.stdout.write(JSON.stringify(message) + '\n');
}

/** Suscripción interna a los eventos emitidos. */
export function onEvent(listener: Listener): void {
  listeners.push(listener);
}

/** Emite un evento: lo escribe a stdout y avisa a los suscriptores internos. */
export function emit(name: string, payload: unknown = null): void {
  const event: Event = { type: 'event', name, payload };
  writeLine(event);
  for (const listener of listeners) listener(event);
}
