// Vista previa del robot: el fotograma `idle` animado de la paleta elegida, dibujado en un canvas 2D.
// No usa PixiJS a propósito: una segunda `Application` en la misma página rompía el renderizador de la oficina
// (BatcherPipe "reading 'geometry'") y la escena se quedaba en negro.
import { useEffect, useRef, useState } from "react";
import { ROBOT_H, ROBOT_W } from "../../scenes/officeLayout";
import { ROBOT_STATE_TABLE } from "../../scenes/robotStates";
import { COLORS } from "./options";

const ZOOM = 5;
const W = ROBOT_W * ZOOM;
const H = ROBOT_H * ZOOM;

type Rect = { x: number; y: number; w: number; h: number };
type SheetJson = { frames?: Record<string, { frame: Rect }>; animations?: Record<string, string[]> };

const pngUrls = import.meta.glob("../../assets/sprites/robot-*.png", { eager: true, query: "?url", import: "default" }) as Record<string, string>;
const jsonData = import.meta.glob("../../assets/sprites/robot-*.json", { eager: true, import: "default" }) as Record<string, SheetJson>;
const byName = <T,>(rec: Record<string, T>) => new Map(Object.entries(rec).map(([p, v]) => [p.split("/").pop()!.replace(/\.(png|json)$/, ""), v]));
const pngs = byName(pngUrls);
const sheets = byName(jsonData);

/** Rectángulos del `idle` de una hoja (por `animations` o por prefijo del nombre del fotograma). */
export function idleFrames(sheet: SheetJson | undefined): Rect[] {
  if (!sheet?.frames) return [];
  const names = sheet.animations?.idle ?? Object.keys(sheet.frames).filter((n) => n.startsWith("idle")).sort();
  return names.map((n) => sheet.frames![n]?.frame).filter((r): r is Rect => !!r);
}

export default function RobotPreview({ palette }: { palette: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const ctx = canvas.current?.getContext("2d");
    const url = pngs.get(`robot-${palette}`);
    const frames = idleFrames(sheets.get(`robot-${palette}`));
    if (!ctx || !url || frames.length === 0) {
      setFailed(true);
      return;
    }
    setFailed(false);
    let stopped = false;
    let timer = 0;
    let i = 0;
    const img = new Image();
    // `speed` es la velocidad de AnimatedSprite: fotogramas por tic a 60 fps.
    const ms = Math.max(60, Math.round(1000 / (ROBOT_STATE_TABLE.idle.speed * 60)));
    const draw = () => {
      if (stopped) return;
      const f = frames[i % frames.length];
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, W, H);
      // Anclado abajo y al centro, como en la escena.
      const dw = f.w * ZOOM;
      const dh = f.h * ZOOM;
      ctx.drawImage(img, f.x, f.y, f.w, f.h, Math.round((W - dw) / 2), H - dh, dw, dh);
      i += 1;
      const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (!reduce && frames.length > 1) timer = window.setTimeout(draw, ms);
    };
    img.onload = draw;
    img.onerror = () => !stopped && setFailed(true);
    img.src = url;
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [palette]);

  const hex = COLORS.find((c) => c.id === palette)?.hex ?? "#888";
  return (
    <div className="ca-preview" role="img" aria-label={`Vista previa del robot, paleta ${palette}`}>
      <canvas ref={canvas} className="ca-preview-canvas" width={W} height={H} style={{ width: W, height: H, imageRendering: "pixelated" }} />
      {failed && <div className="ca-preview-fallback" style={{ background: hex }} />}
    </div>
  );
}
