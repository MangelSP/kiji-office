// Hojas de sprites de los robots (PNG + JSON de `src/assets/sprites/robot-*`) para dibujarlas en canvas 2D.
// Lo usan RobotAvatar y RobotPreview; la escena de PixiJS carga las suyas en `scenes/spriteAssets.ts`.

export type Rect = { x: number; y: number; w: number; h: number };
export type SheetJson = { frames?: Record<string, { frame: Rect }>; animations?: Record<string, string[]> };

const pngUrls = import.meta.glob("../assets/sprites/robot-*.png", { eager: true, query: "?url", import: "default" }) as Record<string, string>;
const jsonData = import.meta.glob("../assets/sprites/robot-*.json", { eager: true, import: "default" }) as Record<string, SheetJson>;
const byName = <T,>(rec: Record<string, T>) => new Map(Object.entries(rec).map(([p, v]) => [p.split("/").pop()!.replace(/\.(png|json)$/, ""), v]));
const pngs = byName(pngUrls);
const sheets = byName(jsonData);

/** Rectángulos del `idle` de una hoja (por `animations` o por prefijo del nombre del fotograma). */
export function idleFrames(sheet: SheetJson | undefined): Rect[] {
  if (!sheet?.frames) return [];
  const names = sheet.animations?.idle ?? Object.keys(sheet.frames).filter((n) => n.startsWith("idle")).sort();
  return names.map((n) => sheet.frames![n]?.frame).filter((r): r is Rect => !!r);
}

/** URL del PNG y fotogramas `idle` de `robot-<key>` (`azul`, `terracota-jefe`...). */
export function robotSheet(key: string): { url: string | undefined; frames: Rect[] } {
  return { url: pngs.get(`robot-${key}`), frames: idleFrames(sheets.get(`robot-${key}`)) };
}

const images = new Map<string, Promise<HTMLImageElement>>();
/** Imagen de la hoja, cargada una sola vez y compartida por todos los avatares. */
export function loadSheetImage(url: string): Promise<HTMLImageElement> {
  let p = images.get(url);
  if (!p) {
    p = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("sprite"));
      img.src = url;
    });
    images.set(url, p);
    p.catch(() => images.delete(url));
  }
  return p;
}
