// Globo de pensamiento pixel-art sobre un robot: fondo crema, borde oscuro de 2 px, esquinas cortadas y colita.
// Vive en la capa sin escalar (píxeles de pantalla), como las etiquetas.
import { Container, Graphics, Text } from "pixi.js";
import { prefersReducedMotion } from "./bubbleText";

const FONT = "ui-monospace, Menlo, Consolas, monospace";
const PAD_X = 5;
const PAD_Y = 3;
const BORDER = 2;
/** Alto de la colita bajo el cuerpo. */
export const TAIL_H = 4;
const FADE_MS = 160;
const INK = 0x2b2118;
const PAPER = 0xfff3d6;

export class ThoughtBubble {
  readonly view = new Container();
  /** Ancho y alto del cuerpo (sin la colita), en px de pantalla. */
  w = 0;
  h = 0;

  private bg = new Graphics();
  private text: Text;
  private shown = "";
  private born = 0;
  private reduced = prefersReducedMotion();

  constructor() {
    this.text = new Text({
      text: "",
      style: { fontFamily: FONT, fontSize: 11, fontWeight: "bold", fill: INK },
      resolution: 1,
    });
    this.text.position.set(PAD_X + BORDER, PAD_Y + BORDER);
    this.view.addChild(this.bg, this.text);
    this.view.alpha = this.reduced ? 1 : 0;
  }

  setText(t: string, now: number) {
    if (t === this.shown) return;
    if (this.shown === "") this.born = now;
    this.shown = t;
    this.text.text = t;
    this.w = Math.ceil(this.text.width) + (PAD_X + BORDER) * 2;
    this.h = Math.ceil(this.text.height) + (PAD_Y + BORDER) * 2;
    this.draw();
  }

  private draw() {
    const { w, h } = this;
    const g = this.bg.clear();
    // Rectángulo con las esquinas cortadas (dos rectángulos en cruz): primero el borde, luego el papel.
    const cross = (color: number, inset: number) => {
      g.rect(inset + 2, inset, w - (inset + 2) * 2, h - inset * 2).fill(color);
      g.rect(inset, inset + 2, w - inset * 2, h - (inset + 2) * 2).fill(color);
    };
    cross(INK, 0);
    cross(PAPER, BORDER);
    // Colita en escalera, centrada.
    const cx = Math.round(w / 2);
    g.rect(cx - 4, h - BORDER, 8, BORDER).fill(PAPER);
    g.rect(cx - 4, h, 2, 2).fill(INK);
    g.rect(cx - 2, h, 4, 2).fill(PAPER);
    g.rect(cx + 2, h, 2, 2).fill(INK);
    g.rect(cx - 2, h + 2, 4, 2).fill(INK);
  }

  /** `left` y `top` en px de pantalla. */
  place(left: number, top: number) {
    this.view.position.set(Math.round(left), Math.round(top));
  }

  tick(now: number) {
    this.view.alpha = this.reduced ? 1 : Math.min(1, Math.max(0, (now - this.born) / FADE_MS));
  }

  destroy() {
    this.view.destroy({ children: true });
  }
}
