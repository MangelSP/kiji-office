// Escena PixiJS de la oficina dentro de un componente React.
// Capas (de atrás adelante): fondo, robots (ordenados por y), frente de escritorios, etiquetas.
import { useEffect, useImperativeHandle, useRef, type Ref } from "react";
import { Application, Container, Graphics, Sprite, TextureStyle, type Texture } from "pixi.js";
import { useStore } from "../store";
import type { Agent } from "../store/agents";
import { assignSlots, type OfficeData, OFFICE_H, OFFICE_W, pickRobot, SCALE, sheetKey } from "./officeLayout";
import { drawPlaceholderBackground, drawPlaceholderFront } from "./placeholders";
import { RobotSprite } from "./RobotSprite";
import { loadOfficeAssets, type OfficeAssets } from "./spriteAssets";

// Píxel perfecto: todas las texturas con vecino más cercano.
TextureStyle.defaultOptions.scaleMode = "nearest";

export type OfficeSceneHandle = {
  /** Agente bajo unas coordenadas de pantalla (`clientX/clientY`), o null. */
  robotAt: (clientX: number, clientY: number) => string | null;
};

type Props = {
  ref?: Ref<OfficeSceneHandle>;
  /** Clic en un robot. */
  onSelect?: (agentId: string) => void;
  selectedId?: string | null;
};

/** Lógica de la escena una vez inicializada la `Application` (separada del ciclo de vida de React). */
class SceneController {
  private robots = new Map<string, RobotSprite>();
  private robotsLayer = new Container();
  private labelsLayer = new Container();
  private selectedId: string | null = null;
  private unsubscribe: () => void;
  onSelect?: (id: string) => void;

  constructor(
    private app: Application,
    private assets: OfficeAssets,
  ) {
    const world = new Container();
    world.scale.set(SCALE);
    this.robotsLayer.sortableChildren = true;

    const layer = (tex: Texture | null, draw: (g: Graphics, o: OfficeData) => void) => {
      if (tex) return new Sprite(tex);
      const g = new Graphics();
      draw(g, assets.office);
      return g;
    };
    world.addChild(layer(assets.background, drawPlaceholderBackground));
    world.addChild(this.robotsLayer);
    world.addChild(layer(assets.front, drawPlaceholderFront));
    app.stage.addChild(world, this.labelsLayer);

    app.ticker.add(this.tick);
    app.canvas.addEventListener("pointerdown", this.onPointerDown);
    this.sync(useStore.getState().agents);
    this.unsubscribe = useStore.subscribe((s, prev) => {
      if (s.agents !== prev.agents) this.sync(s.agents);
    });
  }

  /** Crea/mueve/borra robots según los agentes; solo llama a `setState` cuando cambia el estado. */
  sync(agents: Agent[]) {
    const slots = assignSlots(agents, this.assets.office);
    const seen = new Set<string>();
    for (const a of agents) {
      const id = String(a.id);
      seen.add(id);
      const slot = slots.get(id)!;
      let r = this.robots.get(id);
      if (!r) {
        r = new RobotSprite({ id, name: a.name, frames: this.assets.robotFrames(sheetKey(a)), x: slot.x, y: slot.y });
        this.robots.set(id, r);
        this.robotsLayer.addChild(r.sprite);
        this.labelsLayer.addChild(r.label);
        r.setSelected(id === this.selectedId);
      } else {
        r.setName(a.name);
        if (r.x !== slot.x || r.y !== slot.y) r.setPosition(slot.x, slot.y);
      }
      if (r.lastRaw !== a.status) r.setState(a.status);
    }
    for (const [id, r] of this.robots) {
      if (seen.has(id)) continue;
      this.robots.delete(id);
      r.destroy();
    }
  }

  setSelected(id: string | null) {
    this.selectedId = id;
    for (const r of this.robots.values()) r.setSelected(r.id === id);
  }

  robotAt = (clientX: number, clientY: number): string | null => {
    const rect = this.app.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const px = ((clientX - rect.left) / rect.width) * OFFICE_W;
    const py = ((clientY - rect.top) / rect.height) * OFFICE_H;
    return pickRobot([...this.robots.values()], px, py);
  };

  private onPointerDown = (e: PointerEvent) => {
    const id = this.robotAt(e.clientX, e.clientY);
    if (id) this.onSelect?.(id);
  };

  private tick = () => {
    const now = performance.now();
    for (const r of this.robots.values()) r.tick(now);
  };

  destroy() {
    this.unsubscribe();
    this.app.ticker.remove(this.tick);
    this.app.canvas.removeEventListener("pointerdown", this.onPointerDown);
    for (const r of this.robots.values()) r.destroy();
    this.robots.clear();
    this.assets.destroy();
  }
}

export default function OfficeScene({ ref, onSelect, selectedId = null }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const ctrl = useRef<SceneController | null>(null);
  const latest = useRef({ onSelect, selectedId });
  latest.current = { onSelect, selectedId };

  useImperativeHandle(ref, () => ({ robotAt: (x, y) => ctrl.current?.robotAt(x, y) ?? null }), []);

  useEffect(() => {
    let cancelled = false;
    let inited = false;
    let destroyed = false;
    const app = new Application();

    // A prueba de StrictMode: si el cleanup llega antes de que acabe el init, se destruye al terminar.
    const destroyApp = () => {
      if (destroyed || !inited) return;
      destroyed = true;
      ctrl.current?.destroy();
      ctrl.current = null;
      app.destroy(true, { children: true });
    };

    void (async () => {
      await app.init({
        width: OFFICE_W * SCALE,
        height: OFFICE_H * SCALE,
        background: 0x15151a,
        antialias: false,
        roundPixels: true,
        resolution: 1,
      });
      inited = true;
      if (cancelled) return destroyApp();
      const assets = await loadOfficeAssets(app.renderer);
      if (cancelled) {
        assets.destroy();
        return destroyApp();
      }
      host.current?.appendChild(app.canvas);
      const c = new SceneController(app, assets);
      c.onSelect = (id) => latest.current.onSelect?.(id);
      c.setSelected(latest.current.selectedId);
      ctrl.current = c;
    })();

    return () => {
      cancelled = true;
      destroyApp();
    };
  }, []);

  useEffect(() => {
    ctrl.current?.setSelected(selectedId);
  }, [selectedId]);

  return <div ref={host} className="office-scene" aria-label="Oficina con los robots de los agentes" role="img" />;
}
