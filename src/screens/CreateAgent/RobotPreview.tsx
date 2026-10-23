// Vista previa del robot: mini canvas PixiJS con el fotograma `idle` animado de la paleta elegida.
// Reutiliza los sprites reales de src/assets/sprites/ si existen y, si no, los placeholders de la escena.
import { useEffect, useRef, useState } from "react";
import { AnimatedSprite, Application, TextureStyle } from "pixi.js";
import { ROBOT_H, ROBOT_W } from "../../scenes/officeLayout";
import { loadOfficeAssets, type OfficeAssets } from "../../scenes/spriteAssets";
import { ROBOT_STATE_TABLE } from "../../scenes/robotStates";
import { COLORS } from "./options";

TextureStyle.defaultOptions.scaleMode = "nearest";

const ZOOM = 5;
const W = ROBOT_W * ZOOM;
const H = ROBOT_H * ZOOM;

export default function RobotPreview({ palette }: { palette: string }) {
  const host = useRef<HTMLDivElement>(null);
  const setPalette = useRef<((p: string) => void) | null>(null);
  const latest = useRef(palette);
  latest.current = palette;
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let inited = false;
    let destroyed = false;
    let assets: OfficeAssets | null = null;
    const app = new Application();

    // A prueba de StrictMode: si el cleanup llega antes de acabar el init, se destruye al terminar.
    const destroyApp = () => {
      if (destroyed || !inited) return;
      destroyed = true;
      setPalette.current = null;
      app.destroy(true, { children: true });
      assets?.destroy();
    };

    void (async () => {
      try {
        await app.init({ width: W, height: H, backgroundAlpha: 0, antialias: false, roundPixels: true, resolution: 1 });
        inited = true;
        if (cancelled) return destroyApp();
        assets = await loadOfficeAssets(app.renderer);
        if (cancelled) return destroyApp();
        const idle = ROBOT_STATE_TABLE.idle;
        const sprite = new AnimatedSprite({ textures: assets.robotFrames(latest.current).idle, autoPlay: false });
        sprite.anchor.set(0.5, 1);
        sprite.scale.set(ZOOM);
        sprite.position.set(W / 2, H);
        sprite.loop = idle.loop;
        sprite.animationSpeed = idle.speed;
        sprite.play();
        app.stage.addChild(sprite);
        const a = assets;
        setPalette.current = (p) => {
          sprite.textures = a.robotFrames(p).idle;
          sprite.play();
        };
        host.current?.appendChild(app.canvas);
      } catch {
        if (!cancelled) setFailed(true); // sin WebGL: se muestra solo la muestra de color
      }
    })();

    return () => {
      cancelled = true;
      destroyApp();
    };
  }, []);

  useEffect(() => {
    setPalette.current?.(palette);
  }, [palette]);

  const hex = COLORS.find((c) => c.id === palette)?.hex ?? "#888";
  return (
    <div className="ca-preview" role="img" aria-label={`Vista previa del robot, paleta ${palette}`}>
      <div ref={host} className="ca-preview-canvas" style={{ width: W, height: H }} />
      {failed && <div className="ca-preview-fallback" style={{ background: hex }} />}
    </div>
  );
}
