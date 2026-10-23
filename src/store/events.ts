// Slice `events`: registro en vivo de lo que emite el core (máx. 500 por proyecto, el más nuevo al final).
import type { StateCreator } from "zustand";
import type { AppState } from "./index";

export const MAX_EVENTS = 500;

export type LogEntry = { seq: number; at: number; name: string; summary: string };

export type EventsSlice = {
  /** `projectId` null = evento del core que no es de ningún proyecto. */
  pushEvent: (projectId: string | null, name: string, payload: unknown) => void;
  clearEvents: (projectId: string) => void;
};

let seq = 0;

/** Resumen de una línea del payload, recortado para no llenar la pantalla. */
export function summarize(payload: unknown): string {
  if (payload === undefined || payload === null) return "";
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  return text.length > 240 ? `${text.slice(0, 240)}…` : text;
}

export const createEventsSlice: StateCreator<AppState, [], [], EventsSlice> = (set, get) => ({
  pushEvent: (pid, name, payload) => {
    const entry: LogEntry = { seq: ++seq, at: Date.now(), name, summary: summarize(payload) };
    if (pid === null) set((s) => ({ coreEvents: [...s.coreEvents, entry].slice(-MAX_EVENTS) }));
    else get().patchProject(pid, (p) => ({ events: [...p.events, entry].slice(-MAX_EVENTS) }));
  },
  clearEvents: (pid) => get().patchProject(pid, (p) => (p.events.length === 0 ? null : { events: [] })),
});
