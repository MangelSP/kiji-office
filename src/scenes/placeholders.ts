// Arte provisional (rectángulos de color) para cuando aún no existen los sprites reales.
import { Graphics, Rectangle, type Renderer, type Texture } from "pixi.js";
import { OFFICE_H, OFFICE_W, ROBOT_H, ROBOT_W, type OfficeData } from "./officeLayout";
import { ROBOT_STATES, type RobotState } from "./robotStates";

const PALETTE_RGB: Record<string, number> = {
  terracota: 0xc8643c,
  azul: 0x4a7fc8,
  verde: 0x4fa370,
  crema: 0xe6d5b0,
};

function shade(rgb: number, f: number): number {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * f)));
  return (c((rgb >> 16) & 255) << 16) | (c((rgb >> 8) & 255) << 8) | c(rgb & 255);
}

/** Dibuja un robot de 32×40 para un estado y un fotograma (0|1: respira / mueve brazos). */
function drawRobot(g: Graphics, key: string, state: RobotState, frame: number) {
  const base = PALETTE_RGB[key.replace("-jefe", "")] ?? PALETTE_RGB.crema;
  const dark = shade(base, 0.7);
  const bob = state === "idle" ? frame : 0; // idle: sube y baja un píxel
  const y0 = bob;
  g.rect(8, 33, 6, 7).fill(dark).rect(18, 33, 6, 7).fill(dark); // piernas
  g.rect(6, 19 + y0, 20, 14 - y0).fill(base); // torso
  // brazos
  const armUp = state === "needs_you" || state === "done";
  const armY = armUp ? 8 + frame * 3 : state === "writing" ? 24 + frame * 2 : 22 + y0;
  g.rect(2, armY, 4, 10).fill(dark);
  g.rect(26, state === "needs_you" ? 22 : armY, 4, 10).fill(dark);
  g.rect(4, 3 + y0, 24, 16).fill(base); // cabeza
  g.rect(8, 7 + y0, 16, 8).fill(0x14161c); // pantalla
  const eye = state === "error" ? 0xe5484d : state === "done" ? 0x4cc38a : 0xf2f2f2;
  if (state === "error") {
    g.rect(10, 9 + y0, 4, 4).fill(eye).rect(18, 9 + y0, 4, 4).fill(eye);
  } else if (state === "done") {
    g.rect(10, 9 + y0, 4, 2).fill(eye).rect(18, 9 + y0, 4, 2).fill(eye);
  } else {
    const h = state === "idle" && frame === 1 ? 2 : 4; // parpadeo
    const dy = state === "thinking" ? 8 : 9;
    g.rect(10, dy + y0, 4, h).fill(eye).rect(18, dy + y0, 4, h).fill(eye);
  }
  // antena: parpadea según el estado
  const antenna = state === "thinking" ? 0xf4c542 : state === "needs_you" ? 0xff7a45 : dark;
  g.rect(15, 0, 2, 3 + y0).fill(dark);
  if (frame === 0 || state === "idle") g.rect(14, 0, 4, 2).fill(antenna);
  if (key.endsWith("-jefe")) g.rect(8, 0, 16, 3).fill(0xf4c542); // corona
}

/** Genera 2 fotogramas por estado para una clave de spritesheet (`azul`, `terracota-jefe`...). */
export function makePlaceholderFrames(renderer: Renderer, key: string): Record<RobotState, Texture[]> {
  const out = {} as Record<RobotState, Texture[]>;
  for (const state of ROBOT_STATES) {
    out[state] = [0, 1].map((frame) => {
      const g = new Graphics();
      drawRobot(g, key, state, frame);
      const tex = renderer.generateTexture({
        target: g,
        frame: new Rectangle(0, 0, ROBOT_W, ROBOT_H),
        resolution: 1,
        antialias: false,
      });
      tex.source.scaleMode = "nearest";
      g.destroy();
      return tex;
    });
  }
  return out;
}

/** Suelo, pared y la parte de arriba de los escritorios. */
export function drawPlaceholderBackground(g: Graphics, office: OfficeData) {
  g.rect(0, 0, OFFICE_W, OFFICE_H).fill(0x3a3a46); // suelo
  g.rect(0, 0, OFFICE_W, 36).fill(0x2a2a35); // pared
  g.rect(0, 36, OFFICE_W, 2).fill(0x1d1d26);
  for (const d of [...office.desks]) {
    g.rect(d.x - 22, d.y - 16, 44, 4).fill(0x8a6b4a); // tablero visto desde detrás
  }
  g.rect(office.boss.x - 26, office.boss.y - 14, 52, 5).fill(0x6b4f35); // mesa del jefe
}

/** Frentes de los escritorios: van ENCIMA de los robots y les tapan las piernas. */
export function drawPlaceholderFront(g: Graphics, office: OfficeData) {
  for (const d of office.desks) {
    g.rect(d.x - 22, d.y - 12, 44, 18).fill(0x5c4630);
    g.rect(d.x - 22, d.y - 12, 44, 2).fill(0x7a5d3f);
  }
}
