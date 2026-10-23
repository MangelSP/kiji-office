// Un robot de la oficina: AnimatedSprite (en la capa escalada ×3) + etiqueta nombre/estado y puntito (capa sin escalar).
import { AnimatedSprite, Container, Graphics, Text, type Texture } from "pixi.js";
import { MoveQueue, tripPose } from "./boardLogic";
import { type Point, SCALE } from "./officeLayout";
import { prefersReducedMotion } from "./bubbleText";
import { normalizeStatus, ROBOT_STATE_TABLE, type RobotState } from "./robotStates";
import type { RobotFrames } from "./spriteAssets";

/** Viaje a la pizarra: `onPaste` se llama al empezar la pausa (cuando la notita aparece). */
export type BoardTrip = { board: Point; onPaste: () => void };

const LABEL_H = 16;
const FONT = "ui-monospace, Menlo, Consolas, monospace";

export class RobotSprite {
  readonly id: string;
  /** Va en la capa de robots (escalada ×3, coordenadas lógicas). */
  readonly sprite: AnimatedSprite;
  /** Va en la capa de etiquetas (sin escalar, píxeles de pantalla). */
  readonly label = new Container();
  state: RobotState = "idle";
  /** Último estado crudo recibido del store, para no reaplicar lo mismo. */
  lastRaw: string | undefined;
  x = 0;
  y = 0;

  private name: string;
  private frames: RobotFrames;
  private bg = new Graphics();
  private dot = new Graphics();
  private text: Text;
  private selected = false;
  private labelW = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private home: Point;
  private queue = new MoveQueue<BoardTrip>();
  private trip: { t0: number; def: BoardTrip; pasted: boolean } | null = null;
  /** Estado que llegó mientras caminaba: se aplica al volver. */
  private deferred: unknown;
  private hasDeferred = false;
  private reduced = prefersReducedMotion();

  constructor(opts: { id: string; name: string; frames: RobotFrames; x: number; y: number }) {
    this.id = opts.id;
    this.name = opts.name;
    this.frames = opts.frames;
    this.home = { x: opts.x, y: opts.y };
    this.sprite = new AnimatedSprite({ textures: this.framesOf("idle"), autoPlay: false });
    this.sprite.anchor.set(0.5, 1);
    this.text = new Text({
      text: "",
      style: { fontFamily: FONT, fontSize: 11, fill: 0xffffff },
      resolution: 1,
    });
    this.text.position.set(14, 2);
    this.label.addChild(this.bg, this.dot, this.text);
    this.setPosition(opts.x, opts.y);
    this.applyState("idle");
  }

  private framesOf(s: RobotState): Texture[] {
    const f = this.frames[ROBOT_STATE_TABLE[s].anim];
    return f && f.length > 0 ? f : this.frames.idle;
  }

  /** Cambia de animación según la tabla. Reaplicar el mismo estado no reinicia nada. */
  setState(raw: unknown) {
    if (this.trip) {
      this.lastRaw = typeof raw === "string" ? raw : undefined;
      this.deferred = raw;
      this.hasDeferred = true;
      return;
    }
    const next = normalizeStatus(raw);
    this.lastRaw = typeof raw === "string" ? raw : undefined;
    if (next === this.state) return;
    this.applyState(next);
  }

  private applyState(next: RobotState) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const def = ROBOT_STATE_TABLE[next];
    this.state = next;
    // Se reasignan las texturas del mismo sprite: no se recrea nada ni parpadea.
    this.sprite.textures = this.framesOf(next);
    this.sprite.loop = def.loop;
    this.sprite.animationSpeed = def.speed;
    this.sprite.gotoAndPlay(0);
    this.refreshLabel();
    if (def.volverA) {
      const { estado, ms } = def.volverA;
      this.timer = setTimeout(() => {
        this.timer = null;
        this.applyState(estado);
      }, ms);
    }
  }

  setName(name: string) {
    if (name === this.name) return;
    this.name = name;
    this.refreshLabel();
  }

  setSelected(v: boolean) {
    if (v === this.selected) return;
    this.selected = v;
    this.refreshLabel();
  }

  /** Posición de los pies en px lógicos. */
  setPosition(x: number, y: number) {
    this.home = { x, y };
    if (this.trip) return; // caminando: solo cambia el sitio al que vuelve
    this.place(x, y, 0);
  }

  private place(x: number, y: number, bob: number) {
    this.x = x;
    this.y = y;
    this.sprite.position.set(x, y + bob);
    this.sprite.zIndex = y; // ordena por y: el de más abajo se ve delante
    this.placeLabel();
  }

  private placeLabel() {
    this.label.position.set(Math.round(this.x * SCALE - this.labelW / 2), Math.round(this.y * SCALE + 6));
  }

  private refreshLabel() {
    const def = ROBOT_STATE_TABLE[this.state];
    this.text.text = `${this.name} · ${def.label}`;
    this.labelW = Math.ceil(this.text.width) + 20;
    this.bg.clear().rect(0, 0, this.labelW, LABEL_H).fill({ color: 0x0e0f13, alpha: 0.82 });
    if (this.selected) this.bg.rect(0, 0, this.labelW, LABEL_H).stroke({ color: 0xf4c542, width: 1, alignment: 1 });
    this.dot.clear().rect(4, 5, 6, 6).fill(def.dot);
    this.placeLabel();
  }

  /** Encola un viaje a la pizarra (los de un mismo robot van uno tras otro). Con reduced motion no camina. */
  enqueueTrip(trip: BoardTrip) {
    if (this.reduced) trip.onPaste();
    else this.queue.push(trip);
  }

  /** ¿Está caminando o con viajes pendientes? */
  get busy() {
    return this.trip !== null || this.queue.length > 0;
  }

  private startTrip(def: BoardTrip, now: number) {
    this.trip = { t0: now, def, pasted: false };
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.playLoop(this.frames.walk ?? this.frames.idle, 0.15);
  }

  private playLoop(tex: Texture[], speed: number) {
    this.sprite.textures = tex;
    this.sprite.loop = true;
    this.sprite.animationSpeed = speed;
    this.sprite.gotoAndPlay(0);
  }

  private stepTrip(now: number) {
    if (!this.trip) {
      const next = this.queue.next();
      if (!next) return;
      this.startTrip(next, now);
    }
    const t = this.trip!;
    const pose = tripPose(now - t.t0, this.home, t.def.board);
    if (pose.phase === "done") {
      this.trip = null;
      this.sprite.scale.x = 1;
      this.place(this.home.x, this.home.y, 0);
      if (this.hasDeferred) {
        this.hasDeferred = false;
        this.setState(this.deferred);
      } else this.applyState(this.state);
      return;
    }
    if (pose.phase === "pause" && !t.pasted) {
      t.pasted = true;
      this.playLoop(this.framesOf("writing"), 0.15);
      t.def.onPaste();
    }
    this.sprite.scale.x = pose.dir;
    this.place(Math.round(pose.x), Math.round(pose.y), pose.bob);
  }

  /** Cada fotograma de la escena: avanza el viaje y el puntito de "te necesita" parpadea. */
  tick(nowMs: number) {
    this.stepTrip(nowMs);
    this.dot.alpha = this.state === "needs_you" && Math.floor(nowMs / 400) % 2 === 1 ? 0.25 : 1;
  }

  destroy() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.queue.clear();
    this.trip = null;
    this.sprite.destroy();
    this.label.destroy({ children: true });
  }
}
