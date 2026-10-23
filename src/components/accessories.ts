// Accesorios del robot (mock Agente/Creador): capas dibujadas en canvas 2D sobre el sprite de 32x40.
// Las coordenadas están en píxeles del sprite y se escalan con el zoom. En la escena de PixiJS aún no se dibujan.

export const ACCESSORIES = [
  { id: "gorra", label: "Gorra" },
  { id: "audifonos", label: "Audífonos" },
  { id: "lentes", label: "Lentes" },
  { id: "corbata", label: "Corbata" },
] as const;
export type AccessoryId = (typeof ACCESSORIES)[number]["id"];

const INK = "#231e16";
type Box = [x: number, y: number, w: number, h: number, color: string];

const LAYERS: Record<AccessoryId, Box[]> = {
  gorra: [
    [8, 3, 16, 1, INK], [7, 4, 18, 1, INK], [6, 5, 20, 3, INK],
    [9, 4, 14, 1, "#d9483b"], [8, 5, 16, 2, "#d9483b"], [9, 5, 4, 1, "#f28b7e"],
    [2, 7, 9, 2, INK], [3, 7, 8, 1, "#b8352c"],
  ],
  audifonos: [
    [9, 6, 14, 1, INK], [7, 7, 2, 4, INK], [23, 7, 2, 4, INK], [8, 7, 1, 3, "#f4c542"], [23, 7, 1, 3, "#f4c542"],
    [3, 10, 4, 8, INK], [25, 10, 4, 8, INK], [4, 11, 2, 6, "#f4c542"], [26, 11, 2, 6, "#f4c542"],
  ],
  lentes: [
    [10, 10, 6, 1, "#f4c542"], [10, 16, 6, 1, "#f4c542"], [10, 10, 1, 7, "#f4c542"], [15, 10, 1, 7, "#f4c542"],
    [17, 10, 6, 1, "#f4c542"], [17, 16, 6, 1, "#f4c542"], [17, 10, 1, 7, "#f4c542"], [22, 10, 1, 7, "#f4c542"],
    [16, 12, 1, 1, "#f4c542"],
  ],
  corbata: [
    [14, 20, 4, 2, INK], [15, 20, 2, 2, "#d9483b"],
    [14, 22, 4, 1, INK], [15, 23, 2, 5, "#d9483b"], [14, 23, 1, 4, INK], [17, 23, 1, 4, INK], [15, 28, 2, 1, INK],
  ],
};

export function drawAccessories(ctx: CanvasRenderingContext2D, ids: readonly string[], zoom: number, ox: number, oy: number) {
  for (const { id } of ACCESSORIES) {
    if (!ids.includes(id)) continue;
    for (const [x, y, w, h, c] of LAYERS[id]) {
      ctx.fillStyle = c;
      ctx.fillRect(ox + x * zoom, oy + y * zoom, w * zoom, h * zoom);
    }
  }
}

// El núcleo (`agent.create`) aún no guarda accesorios: se recuerdan en localStorage por agentId (pendiente de núcleo).
const KEY = (agentId: string | number) => `kiji.accessories.${agentId}`;
const VALID = new Set<string>(ACCESSORIES.map((a) => a.id));

export function loadAccessories(agentId: string | number): AccessoryId[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY(agentId)) ?? "[]") as unknown;
    return Array.isArray(raw) ? (raw.filter((x) => typeof x === "string" && VALID.has(x)) as AccessoryId[]) : [];
  } catch {
    return [];
  }
}

export function saveAccessories(agentId: string | number, ids: readonly string[]): void {
  try {
    const clean = ids.filter((x) => VALID.has(x));
    if (clean.length === 0) localStorage.removeItem(KEY(agentId));
    else localStorage.setItem(KEY(agentId), JSON.stringify(clean));
  } catch {
    // sin almacenamiento (modo privado, cuota): el robot se queda sin accesorios, no es un fallo.
  }
}
