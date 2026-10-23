// Avatar del robot: el fotograma `idle` de su hoja (robot-<color>.png; el jefe, robot-terracota-jefe) dibujado en un
// canvas 2D pixelado, con accesorios opcionales encima. Sin PixiJS a propósito: una segunda `Application` rompe la escena.
import { useEffect, useRef, useState } from "react";
import { ROBOT_H, ROBOT_W } from "../scenes/officeLayout";
import { ROBOT_STATE_TABLE } from "../scenes/robotStates";
import { COLORS } from "../screens/CreateAgent/options";
import { drawAccessories } from "./accessories";
import { loadSheetImage, robotSheet } from "./robotSheets";

type Props = {
  /** Clave de la hoja: `azul`, `verde`, `terracota-jefe`... (ver `sheetKey`). */
  sheet: string;
  /** Aumento entero del sprite de 32x40: 1 = tarjeta compacta, 2 = cabecera, 6 = vista previa. */
  zoom?: number;
  /** Anima el `idle` (se ignora con «reducir movimiento»); sin esto se dibuja solo el primer fotograma. */
  animate?: boolean;
  accessories?: readonly string[];
  /** Texto para lectores de pantalla; sin él el avatar es decorativo. */
  label?: string;
  className?: string;
};

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export default function RobotAvatar({ sheet, zoom = 1, animate = false, accessories, label, className }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);
  const W = ROBOT_W * zoom;
  const H = ROBOT_H * zoom;
  const accKey = (accessories ?? []).join("|");

  useEffect(() => {
    const ctx = canvas.current?.getContext("2d");
    const { url, frames } = robotSheet(sheet);
    if (!ctx || !url || frames.length === 0) {
      setFailed(true);
      return;
    }
    setFailed(false);
    let stopped = false;
    let timer = 0;
    let i = 0;
    const acc = accKey ? accKey.split("|") : [];
    // `speed` es la velocidad de AnimatedSprite: fotogramas por tic a 60 fps.
    const ms = Math.max(60, Math.round(1000 / (ROBOT_STATE_TABLE.idle.speed * 60)));
    loadSheetImage(url).then(
      (img) => {
        const draw = () => {
          if (stopped) return;
          const f = frames[i % frames.length];
          ctx.imageSmoothingEnabled = false;
          ctx.clearRect(0, 0, W, H);
          // Anclado abajo y al centro, como en la escena.
          const dw = f.w * zoom;
          const dh = f.h * zoom;
          const ox = Math.round((W - dw) / 2);
          const oy = H - dh;
          ctx.drawImage(img, f.x, f.y, f.w, f.h, ox, oy, dw, dh);
          drawAccessories(ctx, acc, zoom, ox, oy);
          i += 1;
          if (animate && !reducedMotion() && frames.length > 1) timer = window.setTimeout(draw, ms);
        };
        draw();
      },
      () => !stopped && setFailed(true),
    );
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [sheet, zoom, animate, accKey, W, H]);

  const key = sheet.replace(/-jefe$/, "");
  const hex = COLORS.find((c) => c.id === key)?.hex ?? "#888";
  return (
    <span
      className={`robot-avatar${className ? ` ${className}` : ""}`}
      style={{ position: "relative", display: "inline-block", flex: "none", width: W, height: H, lineHeight: 0 }}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    >
      <canvas ref={canvas} width={W} height={H} style={{ width: W, height: H, imageRendering: "pixelated" }} />
      {failed && <span style={{ position: "absolute", inset: "15% 20% 0", background: hex, borderRadius: 4 }} />}
    </span>
  );
}
