// Slice `events`: registro en vivo de lo que emite el core (máx. 500, el más nuevo al final).
import type { StateCreator } from "zustand";
import type { AppState } from "./index";

export const MAX_EVENTS = 500;

export type LogEntry = { seq: number; at: number; name: string; summary: string };

export type EventsSlice = {
  events: LogEntry[];
  pushEvent: (name: string, payload: unknown) => void;
  clearEvents: () => void;
};

let seq = 0;

/** Resumen de una línea del payload, recortado para no llenar la pantalla. */
export function summarize(payload: unknown): string {
  if (payload === undefined || payload === null) return "";
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  return text.length > 240 ? `${text.slice(0, 240)}…` : text;
}

export const createEventsSlice: StateCreator<AppState, [], [], EventsSlice> = (set) => ({
  events: [],
  pushEvent: (name, payload) =>
    set((s) => ({
      events: [...s.events, { seq: ++seq, at: Date.now(), name, summary: summarize(payload) }].slice(-MAX_EVENTS),
    })),
  clearEvents: () => set({ events: [] }),
});
