// La pizarra de la escena: 10 franjas verticales finas con notitas de colores, dibujadas sobre el rectángulo de la
// pizarra del fondo (px lógicos, capa escalada ×3).
import { Container, Graphics } from "pixi.js";
import type { BoardColumn } from "../../shared/protocol";
import { BOARD_COLUMNS, COLUMN_COLORS, noteColorOf, visibleNotes } from "./boardLogic";
import type { Rect } from "./officeLayout";

const PAPER = 0xf7f7f2;
const INK = 0x4a4f5c;
const STRIP_W = 6;
const NOTE_STEP = 5;
const POP_MS = 450;
const FLASH_MS = 400;

/** Cifras 3×5 (una fila por cadena). */
const DIGITS = [
  "111101101101111", "010110010010111", "111001111100111", "111001111001111", "101101111001001",
  "111100111001111", "111100111101111", "111001001001001", "111101111101111", "111101111001111",
];

export class BoardView {
  readonly view = new Container();
  private g = new Graphics();
  private fx = new Graphics();
  private pop: { col: number; t0: number } | null = null;
  private flashAt = -Infinity;
  /** Notas dibujadas por columna (para saber dónde está la última). */
  private shown: number[] = BOARD_COLUMNS.map(() => 0);

  constructor(private rect: Rect) {
    this.view.addChild(this.g, this.fx);
  }

  /** ¿Está el punto lógico dentro de la pizarra (con un margen para el marco)? */
  contains(px: number, py: number, margin = 3): boolean {
    const r = this.rect;
    return px >= r.x - margin && px < r.x + r.w + margin && py >= r.y - margin && py < r.y + r.h + margin;
  }

  render(byColumn: Record<BoardColumn, string[]>) {
    const { x, y, w, h } = this.rect;
    const g = this.g.clear();
    g.rect(x, y, w, h).fill(PAPER);
    BOARD_COLUMNS.forEach((col, i) => {
      const x0 = x + 1 + i * STRIP_W;
      g.rect(x0, y + 1, STRIP_W - 1, 2).fill(COLUMN_COLORS[i]);
      const ids = byColumn[col];
      const { shown, extra } = visibleNotes(ids.length);
      this.shown[i] = shown;
      for (let k = 0; k < shown; k++) {
        const ny = y + 5 + k * NOTE_STEP;
        const nx = x0 + (k % 2); // un pixel de vaivén: parecen pegadas a mano
        g.rect(nx, ny + 1, STRIP_W - 2, 3).fill(0xd6d6cc); // sombra
        g.rect(nx, ny, STRIP_W - 2, 3).fill(noteColorOf(ids[k]));
      }
      if (extra > 0) this.digit(Math.min(9, extra), x0 + 1, y + 5 + shown * NOTE_STEP);
      else if (ids.length > 0) g.rect(x0, y + h - 2, STRIP_W - 1, 1).fill(INK);
    });
  }

  private digit(n: number, x: number, y: number) {
    const bits = DIGITS[n];
    for (let i = 0; i < 15; i++) if (bits[i] === "1") this.g.rect(x + (i % 3), y + Math.floor(i / 3), 1, 1).fill(INK);
  }

  /** Resalta la nota que acaba de pegar un robot en `col`. */
  popColumn(col: BoardColumn, now: number) {
    this.pop = { col: BOARD_COLUMNS.indexOf(col), t0: now };
  }

  /** Reduced motion: destello de toda la pizarra. */
  flash(now: number) {
    this.flashAt = now;
  }

  tick(now: number) {
    const fx = this.fx.clear();
    const { x, y, w, h } = this.rect;
    if (this.pop) {
      const k = (now - this.pop.t0) / POP_MS;
      if (k >= 1) this.pop = null;
      else {
        const i = this.pop.col;
        const x0 = x + 1 + i * STRIP_W;
        const last = Math.max(0, this.shown[i] - 1);
        const ny = y + 5 + last * NOTE_STEP;
        fx.rect(x0 - 1, ny - 1, STRIP_W, 5).stroke({ color: 0xffffff, width: 1, alignment: 1, alpha: 1 - k });
        fx.rect(x0, y + 1, STRIP_W - 1, 2).fill({ color: 0xffffff, alpha: 0.9 * (1 - k) });
      }
    }
    const f = (now - this.flashAt) / FLASH_MS;
    if (f >= 0 && f < 1) fx.rect(x, y, w, h).fill({ color: 0xfff3b0, alpha: 0.85 * (1 - f) });
  }

  destroy() {
    this.view.destroy({ children: true });
  }
}
