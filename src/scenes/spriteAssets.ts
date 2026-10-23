// Carga los sprites reales de src/assets/sprites/ si existen; si no, usa los placeholders.
// Usa import.meta.glob, así que compila y funciona aunque la carpeta esté vacía o no exista.
import { Assets, Spritesheet, type Renderer, type Texture } from "pixi.js";
import { DEFAULT_OFFICE, PALETTES, parseOfficeData, type OfficeData } from "./officeLayout";
import { makePlaceholderFrames } from "./placeholders";
import { ROBOT_STATES, type RobotState } from "./robotStates";

export type RobotFrames = Record<RobotState, Texture[]>;

export type OfficeAssets = {
  office: OfficeData;
  /** `oficina.png` / `oficina-frente.png` o null si no existen (la escena dibuja placeholders). */
  background: Texture | null;
  front: Texture | null;
  /** Por clave de spritesheet (`azul`, `terracota-jefe`...); true = sprites reales, false = placeholder. */
  robotFrames: (key: string) => RobotFrames;
  realSheets: string[];
  destroy: () => void;
};

// Sin workers: PixiJS los crea desde URLs blob:, que la CSP de la app (sin worker-src) bloquea en silencio
// y la carga se queda esperando para siempre (oficina en negro dentro de Tauri).
Assets.setPreferences({ preferWorkers: false });

/** Por si una carga se cuelga igualmente: a los 5 s se usa el placeholder en vez de dejar la escena en negro. */
const withTimeout = <T,>(p: Promise<T>, ms = 5000) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))]);

const pngUrls = import.meta.glob("../assets/sprites/*.png", { eager: true, query: "?url", import: "default" }) as Record<string, string>;
const jsonData = import.meta.glob("../assets/sprites/*.json", { eager: true, import: "default" }) as Record<string, unknown>;

const byName = (rec: Record<string, unknown>) =>
  new Map(Object.entries(rec).map(([path, v]) => [path.split("/").pop()!.replace(/\.(png|json)$/, ""), v]));
const pngs = byName(pngUrls) as Map<string, string>;
const jsons = byName(jsonData);

async function loadPng(name: string): Promise<Texture | null> {
  const url = pngs.get(name);
  if (!url) return null;
  try {
    const tex = await withTimeout(Assets.load<Texture>(url));
    tex.source.scaleMode = "nearest";
    return tex;
  } catch {
    return null;
  }
}

/** Extrae las animaciones por estado de un spritesheet; null si no trae al menos `idle`. */
async function loadRobotSheet(name: string): Promise<RobotFrames | null> {
  const data = jsons.get(name) as { frames?: Record<string, unknown>; animations?: Record<string, string[]> } | undefined;
  const tex = await loadPng(name);
  if (!data || !tex) return null;
  try {
    const sheet = new Spritesheet(tex, structuredClone(data) as never);
    await sheet.parse();
    const names = Object.keys(sheet.textures);
    const out = {} as RobotFrames;
    for (const st of ROBOT_STATES) {
      let frames: Texture[] = sheet.animations[st] ?? [];
      // Sin bloque `animations`: agrupa por prefijo del nombre del fotograma (`idle_0`, `idle-1`...).
      if (frames.length === 0) frames = names.filter((n) => n.startsWith(st)).sort().map((n) => sheet.textures[n]);
      out[st] = frames;
    }
    if (out.idle.length === 0) return null;
    for (const st of ROBOT_STATES) if (out[st].length === 0) out[st] = out.idle; // estado sin arte → idle
    return out;
  } catch {
    return null;
  }
}

export async function loadOfficeAssets(renderer: Renderer): Promise<OfficeAssets> {
  const [background, front] = await Promise.all([loadPng("oficina"), loadPng("oficina-frente")]);
  const office = jsons.has("oficina") ? parseOfficeData(jsons.get("oficina")) : DEFAULT_OFFICE;

  const cache = new Map<string, RobotFrames>();
  const placeholders = new Map<string, RobotFrames>();
  const realSheets: string[] = [];
  for (const key of [...PALETTES, "terracota-jefe"]) {
    const real = await loadRobotSheet(`robot-${key}`);
    if (real) {
      cache.set(key, real);
      realSheets.push(key);
    }
  }

  return {
    office,
    background,
    front,
    realSheets,
    robotFrames(key) {
      const hit = cache.get(key);
      if (hit) return hit;
      // Sin sprite del jefe pero con el normal: usa el de terracota antes que un placeholder.
      if (key === "terracota-jefe" && cache.has("terracota")) return cache.get("terracota")!;
      let ph = placeholders.get(key);
      if (!ph) {
        ph = makePlaceholderFrames(renderer, key);
        placeholders.set(key, ph);
      }
      return ph;
    },
    destroy() {
      for (const ph of placeholders.values()) for (const list of Object.values(ph)) for (const t of list) t.destroy(true);
      placeholders.clear();
    },
  };
}
