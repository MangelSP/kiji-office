// Dónde se sienta cada agente y de qué color es su robot. Sin PixiJS: se puede testear en vitest.

/** Tamaño lógico de la oficina (px del arte); la escena lo amplía ×3. */
export const OFFICE_W = 320;
export const OFFICE_H = 180;
export const SCALE = 3;
export const ROBOT_W = 32;
export const ROBOT_H = 40;

export type Point = { x: number; y: number };
export type Rect = { x: number; y: number; w: number; h: number };
/** Pizarra: `stand` = donde apoyan los pies del robot delante; `rect` = zona útil (px lógicos). */
export type BoardSpot = { stand: Point; rect: Rect };
export type OfficeData = { desks: Point[]; boss: Point; standing: Point[]; board: BoardSpot };

/** Las posiciones son donde apoyan los pies del robot (ancla abajo-centro), en px lógicos. */
export const DEFAULT_OFFICE: OfficeData = {
  desks: [
    { x: 60, y: 108 },
    { x: 160, y: 108 },
    { x: 260, y: 108 },
    { x: 60, y: 160 },
    { x: 160, y: 160 },
    { x: 260, y: 160 },
  ],
  boss: { x: 160, y: 56 },
  standing: [
    { x: 110, y: 150 },
    { x: 210, y: 150 },
    { x: 18, y: 120 },
    { x: 302, y: 120 },
    { x: 18, y: 165 },
    { x: 302, y: 165 },
  ],
  board: { stand: { x: 200, y: 90 }, rect: { x: 169, y: 10, w: 62, h: 38 } },
};

function toPoint(v: unknown): Point | null {
  if (Array.isArray(v) && typeof v[0] === "number" && typeof v[1] === "number") return { x: v[0], y: v[1] };
  if (v && typeof v === "object") {
    const { x, y } = v as Record<string, unknown>;
    if (typeof x === "number" && typeof y === "number") return { x, y };
  }
  return null;
}

function toPoints(v: unknown): Point[] {
  return Array.isArray(v) ? v.map(toPoint).filter((p): p is Point => p !== null) : [];
}

function toRect(v: unknown): Rect | null {
  if (!v || typeof v !== "object") return null;
  const { x, y, w, h } = v as Record<string, unknown>;
  return [x, y, w, h].every((n) => typeof n === "number") && (w as number) > 0 && (h as number) > 0
    ? { x: x as number, y: y as number, w: w as number, h: h as number }
    : null;
}

function toBoard(v: unknown): BoardSpot {
  const r = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  return { stand: toPoint(r.stand) ?? DEFAULT_OFFICE.board.stand, rect: toRect(r.rect) ?? DEFAULT_OFFICE.board.rect };
}

/** Lee `oficina.json` de forma tolerante (`desks`, `boss`|`jefe`, `standing`); lo que falte usa los valores por defecto. */
export function parseOfficeData(raw: unknown): OfficeData {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const desks = toPoints(r.desks ?? r.escritorios);
  const standing = toPoints(r.standing ?? r.depie);
  return {
    desks: desks.length > 0 ? desks : DEFAULT_OFFICE.desks,
    boss: toPoint(r.boss ?? r.jefe) ?? DEFAULT_OFFICE.boss,
    standing: standing.length > 0 ? standing : DEFAULT_OFFICE.standing,
    board: toBoard(r.board ?? r.pizarra),
  };
}

export type SlotKind = "boss" | "desk" | "standing";
export type Slot = Point & { kind: SlotKind };

export type LayoutAgent = {
  id: string | number;
  provider?: string;
  color?: string | null;
  is_boss?: number | boolean;
};

/**
 * Reparte sitios por orden de creación (orden de la lista): el jefe va a su sitio, los demás ocupan los
 * escritorios en orden y los que sobran se quedan "de pie" (si también se acaban, se reutilizan en círculo).
 */
export function assignSlots(agents: readonly LayoutAgent[], office: OfficeData = DEFAULT_OFFICE): Map<string, Slot> {
  const out = new Map<string, Slot>();
  let n = 0;
  let bossPlaced = false;
  for (const a of agents) {
    const id = String(a.id);
    if (a.is_boss && !bossPlaced) {
      bossPlaced = true;
      out.set(id, { ...office.boss, kind: "boss" });
      continue;
    }
    if (n < office.desks.length) {
      out.set(id, { ...office.desks[n], kind: "desk" });
    } else {
      const spots = office.standing.length > 0 ? office.standing : [office.boss];
      out.set(id, { ...spots[(n - office.desks.length) % spots.length], kind: "standing" });
    }
    n++;
  }
  return out;
}

export const PALETTES = ["terracota", "azul", "verde", "crema"] as const;
export type Palette = (typeof PALETTES)[number];

/** Paleta del robot: el `color` del agente (`claude` → terracota) o, si no vale, según el proveedor. */
export function paletteFor(agent: Pick<LayoutAgent, "color" | "provider">): Palette {
  const c = agent.color?.trim().toLowerCase();
  if (c === "claude") return "terracota";
  if (c && (PALETTES as readonly string[]).includes(c)) return c as Palette;
  switch (agent.provider?.toLowerCase()) {
    case "claude":
    case "anthropic":
      return "terracota";
    case "codex":
    case "openai":
      return "azul";
    case "gemini":
    case "google":
      return "verde";
    default:
      return "crema";
  }
}

/** Clave del spritesheet: el jefe usa la variante `-jefe` (solo existe en terracota). */
export function sheetKey(agent: LayoutAgent): string {
  return agent.is_boss ? "terracota-jefe" : paletteFor(agent);
}

/** Robot bajo un punto lógico (pies en `pos`, ancla abajo-centro). Gana el más cercano a cámara (mayor y). */
export function pickRobot(robots: readonly { id: string; x: number; y: number }[], px: number, py: number): string | null {
  let best: { id: string; y: number } | null = null;
  for (const r of robots) {
    const inside = px >= r.x - ROBOT_W / 2 && px < r.x + ROBOT_W / 2 && py >= r.y - ROBOT_H && py < r.y;
    if (inside && (!best || r.y > best.y)) best = { id: r.id, y: r.y };
  }
  return best?.id ?? null;
}
