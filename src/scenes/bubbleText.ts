// Texto de los globos de pensamiento sobre los robots. Sin PixiJS: se puede testear en vitest.
// Sale del último evento del agente (`event.appended`: kind + payload), no de la terminal.

/** Máximo de caracteres de un globo. */
export const BUBBLE_MAX = 40;
/** Cuánto se queda el globo "¡listo!" tras terminar. */
export const DONE_BUBBLE_MS = 8000;

export type BubbleEvent = { kind: string; payload?: unknown };

function obj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Recorta a `max` caracteres con "…" al final. */
export function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** "src/a/b.ts" -> "b.ts" (también con barras de Windows). */
function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** Prefijo + objetivo, recortando el objetivo para que el total no pase de BUBBLE_MAX. */
function withTarget(prefix: string, target: string): string {
  if (!target) return clip(prefix, BUBBLE_MAX);
  return `${prefix} ${clip(target, BUBBLE_MAX - prefix.length - 1)}`;
}

const READ_TOOLS = new Set(["Read", "Grep", "Glob", "NotebookRead"]);
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

function toolText(payload: Record<string, unknown>): string {
  const name = str(payload.name);
  const input = obj(payload.input);
  if (READ_TOOLS.has(name)) {
    const file = str(input.file_path) || str(input.notebook_path) || str(input.path);
    return withTarget("leyendo", file ? baseName(file) : str(input.pattern));
  }
  if (EDIT_TOOLS.has(name)) {
    return withTarget("editando", baseName(str(input.file_path) || str(input.notebook_path) || str(input.path)));
  }
  if (name === "Bash") {
    const command = str(input.command).replace(/\s+/g, " ").trim();
    return withTarget("ejecutando", command);
  }
  return withTarget("usando", name);
}

/** Texto del globo para un evento, o `null` si ese evento no cambia lo que dice el globo. */
export function bubbleText(event: BubbleEvent): string | null {
  const payload = obj(event.payload);
  switch (event.kind) {
    case "tool":
      return toolText(payload);
    case "permission":
      return payload.decision === "pending" ? "¡te necesito!" : "pensando…";
    case "thinking":
      return "pensando…";
    case "text":
      return "escribiendo…";
    case "status":
      return payload.type === "done" ? "¡listo!" : null;
    case "error":
      return "¡algo falló!";
    case "limit":
      return "límite alcanzado";
    default:
      return null;
  }
}

/**
 * ¿Se muestra el globo? `done` dura DONE_BUBBLE_MS aunque el robot ya esté libre; el resto solo
 * mientras el robot no esté libre (un evento viejo no debe quedarse flotando).
 */
export function bubbleVisible(event: BubbleEvent & { at: number }, robotIdle: boolean, now: number): boolean {
  if (bubbleText(event) === "¡listo!") return now - event.at < DONE_BUBBLE_MS;
  return !robotIdle;
}

export type Rect = { x: number; y: number; w: number; h: number };
export type BubbleSlot = { id: string; x: number; w: number; h: number; bottom: number };

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Apila los globos que se solapan: cada uno sube lo justo (alto + hueco) hasta quedar libre.
 * `x` es la izquierda, `bottom` el borde inferior deseado. Devuelve el borde superior de cada uno.
 */
export function stackBubbles(slots: readonly BubbleSlot[], gap = 2): Map<string, number> {
  const placed: Rect[] = [];
  const out = new Map<string, number>();
  for (const s of [...slots].sort((a, b) => a.x - b.x || a.bottom - b.bottom)) {
    const rect: Rect = { x: s.x, y: s.bottom - s.h, w: s.w, h: s.h };
    while (placed.some((p) => overlaps(p, rect))) rect.y -= s.h + gap;
    placed.push(rect);
    out.set(s.id, rect.y);
  }
  return out;
}

/** ¿El sistema pide menos movimiento? (Sin `matchMedia`, p. ej. en tests, se asume que no.) */
export function prefersReducedMotion(): boolean {
  try {
    return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}
