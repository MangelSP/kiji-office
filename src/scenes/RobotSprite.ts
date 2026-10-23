// Un robot de la oficina: AnimatedSprite (en la capa escalada ×3) + etiqueta nombre/estado y puntito (capa sin escalar).
import { AnimatedSprite, Container, Graphics, Text, type Texture } from "pixi.js";
import { SCALE } from "./officeLayout";
import { normalizeStatus, ROBOT_STATE_TABLE, type RobotState } from "./robotStates";
import type { RobotFrames } from "./spriteAssets";

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

  constructor(opts: { id: string; name: string; frames: RobotFrames; x: number; y: number }) {
    this.id = opts.id;
    this.name = opts.name;
    this.frames = opts.frames;
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
    this.x = x;
    this.y = y;
    this.sprite.position.set(x, y);
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

  /** Cada fotograma de la escena: el puntito de "te necesita" parpadea. */
  tick(nowMs: number) {
    this.dot.alpha = this.state === "needs_you" && Math.floor(nowMs / 400) % 2 === 1 ? 0.25 : 1;
  }

  destroy() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.sprite.destroy();
    this.label.destroy({ children: true });
  }
}
