// Formatos de números y textos compartidos por las pestañas de agente y la tira de tarjetas (todo en español).
import type { Agent } from "../../store/agents";
import { normalizeStatus, ROBOT_STATE_TABLE } from "../../scenes/robotStates";
import { COLORS } from "../CreateAgent/options";

/** Tokens con coma decimal: 950, 12,3 k, 1,2 M. */
export function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(".", ",")} k`;
  return `${(n / 1_000_000).toFixed(1).replace(".", ",")} M`;
}

/** Dólares: 3 decimales por debajo de 1 $ (los runs baratos cuestan céntimos de céntimo). */
export function fmtUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0,00";
  return `$${n.toFixed(n < 1 ? 3 : 2).replace(".", ",")}`;
}

/** Porcentaje entero 0..100 de `used` sobre `total` (0 si no hay ventana). */
export function pct(used: number, total: number): number {
  if (!(total > 0) || !(used > 0)) return 0;
  return Math.min(100, Math.round((used / total) * 100));
}

export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1).replace(".", ",")} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

export const isBoss = (a: Agent) => a.is_boss === true || a.is_boss === 1;

/** Color de la muestra del agente (`claude` y desconocidos = terracota/crema como en la escena). */
export function paletteHex(color?: string | null): string {
  if (color === "claude") return COLORS[0].hex;
  return COLORS.find((c) => c.id === color)?.hex ?? COLORS[3].hex;
}

export function statusInfo(status?: string): { label: string; dot: string } {
  const def = ROBOT_STATE_TABLE[normalizeStatus(status)];
  return { label: def.label, dot: `#${def.dot.toString(16).padStart(6, "0")}` };
}

export const ROLE_LABEL: Record<string, string> = {
  jefe: "Jefe",
  programador: "Programador",
  tester: "Tester",
  explorador: "Explorador",
  "modelador-2d": "Modelador 2D",
  documentador: "Documentador",
  "revisor-critico": "Revisor crítico",
};

export const STATE_LABEL: Record<string, string> = {
  todo: "Por hacer",
  assigned: "Asignada",
  running: "En curso",
  needs_you: "Te necesita",
  review: "En revisión",
  changes: "Con cambios pedidos",
  approved: "Aprobada",
  integrated: "Integrada",
  blocked: "Bloqueada",
  failed: "Fallida",
  paused_limit: "Pausada por límite",
};

/** Meter de contexto de 8 segmentos: cuántos se llenan y de qué color (normal, ≥6/8 aviso, ≥7/8 alto). */
export const SEGMENTS = 8;
export type MeterLevel = "ok" | "warn" | "high";
export function contextSegments(used: number, total: number): { filled: number; level: MeterLevel } {
  if (!(total > 0) || !(used > 0)) return { filled: 0, level: "ok" };
  const filled = Math.max(1, Math.min(SEGMENTS, Math.ceil((used / total) * SEGMENTS)));
  return { filled, level: filled >= 7 ? "high" : filled >= 6 ? "warn" : "ok" };
}
