// Escena PixiJS de la oficina dentro de un componente React.
// Capas (de atrás adelante): fondo, robots (ordenados por y), frente de escritorios, etiquetas.
import { useEffect, useImperativeHandle, useRef, type Ref } from "react";
import { Application, Container, Graphics, Sprite, TextureStyle, type Texture } from "pixi.js";
import { useStore } from "../store";
import type { Agent } from "../store/agents";
import type { BoardColumn } from "../../shared/protocol";
import { projectOf } from "../store/partition";
import { BoardView } from "./BoardView";
import { tasksByColumn } from "./boardLogic";
import { bubbleText, bubbleVisible, prefersReducedMotion, stackBubbles, type BubbleSlot } from "./bubbleText";
import { assignSlots, type OfficeData, OFFICE_H, OFFICE_W, pickRobot, type Point, ROBOT_H, SCALE, sheetKey } from "./officeLayout";
import { drawPlaceholderBackground, drawPlaceholderFront } from "./placeholders";
import { RobotSprite } from "./RobotSprite";
import { loadOfficeAssets, type OfficeAssets } from "./spriteAssets";
import { TAIL_H, ThoughtBubble } from "./ThoughtBubble";

// Píxel perfecto: todas las texturas con vecino más cercano.
TextureStyle.defaultOptions.scaleMode = "nearest";

export type OfficeSceneHandle = {
  /** Agente bajo unas coordenadas de pantalla (`clientX/clientY`), o null. */
  robotAt: (clientX: number, clientY: number) => string | null;
};

type Props = {
  ref?: Ref<OfficeSceneHandle>;
  /** Workspace que se dibuja. Al cambiar, la misma escena (una sola `Application`) re-sincroniza sus robots. */
  projectId: string;
  /** Clic en un robot. */
  onSelect?: (agentId: string) => void;
  selectedId?: string | null;
  /** Clic en la pizarra de la escena (la UI abre la vista Pizarra). */
  onBoardClick?: () => void;
};

/** Cada cuánto se recalculan los globos (ms). */
const BUBBLE_REFRESH_MS = 200;

/** Lógica de la escena una vez inicializada la `Application` (separada del ciclo de vida de React). */
class SceneController {
  private robots = new Map<string, RobotSprite>();
  private robotsLayer = new Container();
  private labelsLayer = new Container();
  private bubblesLayer = new Container();
  private bubbles = new Map<string, ThoughtBubble>();
  private lastBubbleUpdate = -Infinity;
  private selectedId: string | null = null;
  private unsubscribe: () => void;
  private board: BoardView;
  /** Tareas cuya nota aún no ha pegado el robot: siguen dibujadas en su columna de origen. */
  private holds = new Map<string, BoardColumn>();
  private lastSeq = 0;
  private reduced = prefersReducedMotion();
  onSelect?: (id: string) => void;
  onBoardClick?: () => void;

  constructor(
    private app: Application,
    private assets: OfficeAssets,
    private projectId: string,
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
    this.board = new BoardView(assets.office.board.rect);
    world.addChild(this.board.view);
    world.addChild(this.robotsLayer);
    world.addChild(layer(assets.front, drawPlaceholderFront));
    app.stage.addChild(world, this.labelsLayer, this.bubblesLayer);

    app.ticker.add(this.tick);
    app.canvas.addEventListener("pointerdown", this.onPointerDown);
    app.canvas.addEventListener("pointermove", this.onPointerMove);
    this.sync(projectOf(useStore.getState(), projectId).agents);
    this.resetBoard();
    this.unsubscribe = useStore.subscribe((s, prev) => {
      const cur = projectOf(s, this.projectId);
      const old = projectOf(prev, this.projectId);
      if (cur.agents !== old.agents) this.sync(cur.agents);
      if (cur.tasks !== old.tasks) this.renderBoard();
      if (cur.boardMoves !== old.boardMoves) this.consumeMoves();
    });
  }

  private resetBoard() {
    this.holds.clear();
    this.lastSeq = Math.max(0, ...projectOf(useStore.getState(), this.projectId).boardMoves.map((m) => m.seq));
    this.renderBoard();
  }

  private renderBoard() {
    this.board.render(tasksByColumn(projectOf(useStore.getState(), this.projectId).tasks, this.holds));
  }

  /** `board.moved` nuevos: el robot de la tarea (o el jefe) camina a la pizarra y pega la nota. */
  private consumeMoves() {
    const p = projectOf(useStore.getState(), this.projectId);
    for (const m of p.boardMoves) {
      if (m.seq <= this.lastSeq) continue;
      this.lastSeq = m.seq;
      const robot =
        (m.agentId != null ? this.robots.get(String(m.agentId)) : undefined) ??
        this.robots.get(String(p.agents.find((a) => a.is_boss)?.id));
      const paste = () => {
        this.holds.delete(m.taskId);
        this.renderBoard();
        const now = performance.now();
        if (this.reduced) this.board.flash(now);
        else this.board.popColumn(m.to, now);
      };
      if (!robot) {
        paste();
        continue;
      }
      if (!this.reduced && m.from && !this.holds.has(m.taskId)) {
        this.holds.set(m.taskId, m.from);
        this.renderBoard();
      }
      robot.enqueueTrip({ board: this.assets.office.board.stand, onPaste: paste });
    }
  }

  /** Cambia de workspace: quita los robots y globos del anterior y dibuja los del nuevo. */
  setProject(projectId: string) {
    if (projectId === this.projectId) return;
    this.projectId = projectId;
    this.selectedId = null;
    for (const b of this.bubbles.values()) b.destroy();
    this.bubbles.clear();
    this.sync(projectOf(useStore.getState(), projectId).agents);
    this.resetBoard();
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

  /** Coordenadas de pantalla → px lógicos de la oficina. */
  private toLogical(clientX: number, clientY: number): Point | null {
    const rect = this.app.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    return { x: ((clientX - rect.left) / rect.width) * OFFICE_W, y: ((clientY - rect.top) / rect.height) * OFFICE_H };
  }

  robotAt = (clientX: number, clientY: number): string | null => {
    const p = this.toLogical(clientX, clientY);
    return p ? pickRobot([...this.robots.values()], p.x, p.y) : null;
  };

  private onPointerDown = (e: PointerEvent) => {
    const id = this.robotAt(e.clientX, e.clientY);
    if (id) return this.onSelect?.(id);
    const p = this.toLogical(e.clientX, e.clientY);
    if (p && this.board.contains(p.x, p.y)) this.onBoardClick?.();
  };

  private onPointerMove = (e: PointerEvent) => {
    const p = this.toLogical(e.clientX, e.clientY);
    const over = !!p && !this.robotAt(e.clientX, e.clientY) && this.board.contains(p.x, p.y);
    this.app.canvas.style.cursor = over && this.onBoardClick ? "pointer" : "";
  };

  private tick = () => {
    const now = performance.now();
    let walking = false;
    for (const r of this.robots.values()) {
      r.tick(now);
      walking ||= r.busy;
    }
    this.board.tick(now);
    for (const b of this.bubbles.values()) b.tick(now);
    // Mientras alguien camina los globos se recolocan en cada fotograma para seguirle.
    if (walking || now - this.lastBubbleUpdate >= BUBBLE_REFRESH_MS) {
      this.lastBubbleUpdate = now;
      this.updateBubbles(now);
    }
  };

  /** Crea, actualiza y quita los globos según el último evento de cada agente; apila los que se solapan. */
  private updateBubbles(now: number) {
    const activity = projectOf(useStore.getState(), this.projectId).activity;
    const slots: BubbleSlot[] = [];
    const wanted = new Set<string>();
    for (const r of this.robots.values()) {
      const ev = activity[r.id];
      const text = ev && bubbleVisible(ev, r.state === "idle", Date.now()) ? bubbleText(ev) : null;
      if (!text) continue;
      wanted.add(r.id);
      let b = this.bubbles.get(r.id);
      if (!b) {
        b = new ThoughtBubble();
        this.bubbles.set(r.id, b);
        this.bubblesLayer.addChild(b.view);
      }
      b.setText(text, now);
      const maxLeft = OFFICE_W * SCALE - b.w - 2;
      const left = Math.min(maxLeft, Math.max(2, Math.round(r.x * SCALE - b.w / 2)));
      slots.push({ id: r.id, x: left, w: b.w, h: b.h + TAIL_H, bottom: Math.round((r.y - ROBOT_H) * SCALE) - 2 });
    }
    for (const [id, b] of this.bubbles) {
      if (wanted.has(id)) continue;
      this.bubbles.delete(id);
      b.destroy();
    }
    const tops = stackBubbles(slots);
    for (const s of slots) this.bubbles.get(s.id)?.place(s.x, Math.max(0, tops.get(s.id) ?? 0));
  }

  destroy() {
    this.unsubscribe();
    this.app.ticker.remove(this.tick);
    this.app.canvas.removeEventListener("pointerdown", this.onPointerDown);
    for (const r of this.robots.values()) r.destroy();
    this.robots.clear();
    for (const b of this.bubbles.values()) b.destroy();
    this.bubbles.clear();
    this.board.destroy();
    this.assets.destroy();
  }
}

export default function OfficeScene({ ref, projectId, onSelect, onBoardClick, selectedId = null }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const ctrl = useRef<SceneController | null>(null);
  const latest = useRef({ onSelect, onBoardClick, selectedId, projectId });
  latest.current = { onSelect, onBoardClick, selectedId, projectId };

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
      const c = new SceneController(app, assets, latest.current.projectId);
      c.onSelect = (id) => latest.current.onSelect?.(id);
      c.onBoardClick = () => latest.current.onBoardClick?.();
      c.setSelected(latest.current.selectedId);
      ctrl.current = c;
    })();

    return () => {
      cancelled = true;
      destroyApp();
    };
  }, []);

  useEffect(() => {
    ctrl.current?.setProject(projectId);
    ctrl.current?.setSelected(selectedId);
  }, [projectId, selectedId]);

  return <div ref={host} className="office-scene" aria-label="Oficina con los robots de los agentes" role="img" />;
}
