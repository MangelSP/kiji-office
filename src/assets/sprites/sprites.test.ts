/// <reference types="node" />
// Test de humo de los sprites generados por tools/sprites/gen.py: JSON coherentes, PNG presentes y ligeros.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Spritesheet, Texture, TextureSource } from "pixi.js";
import { describe, expect, it } from "vitest";

const DIR = dirname(fileURLToPath(import.meta.url));
const MAX_PNG = 256 * 1024;

const FRAMES_POR_ANIM: Record<string, number> = {
  idle: 4,
  thinking: 4,
  writing: 6,
  needs_you: 2,
  error: 2,
  done: 4,
};
const ROBOTS = ["terracota", "azul", "verde", "crema", "terracota-jefe"].map((p) => `robot-${p}`);

type Rect = { x: number; y: number; w: number; h: number };
type Sheet = {
  frames: Record<string, { frame: Rect }>;
  animations: Record<string, string[]>;
  meta: { image: string; size: { w: number; h: number }; scale: string };
};

const leerJson = <T>(nombre: string): T => JSON.parse(readFileSync(join(DIR, nombre), "utf8")) as T;

/** Ancho y alto de un PNG leyendo la cabecera IHDR. */
function tamPng(nombre: string): { w: number; h: number } {
  const buf = readFileSync(join(DIR, nombre));
  expect(buf.subarray(1, 4).toString("latin1")).toBe("PNG");
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

describe("spritesheets de robots", () => {
  for (const nombre of ROBOTS) {
    describe(nombre, () => {
      const sheet = leerJson<Sheet>(`${nombre}.json`);

      it("meta.image existe y coincide con meta.size", () => {
        expect(sheet.meta.image).toBe(`${nombre}.png`);
        expect(sheet.meta.scale).toBe("1");
        expect(tamPng(sheet.meta.image)).toEqual(sheet.meta.size);
      });

      it("tiene las seis animaciones con su número de fotogramas", () => {
        expect(Object.keys(sheet.animations).sort()).toEqual(Object.keys(FRAMES_POR_ANIM).sort());
        for (const [anim, n] of Object.entries(FRAMES_POR_ANIM)) expect(sheet.animations[anim]).toHaveLength(n);
      });

      it("PixiJS lo parsea (Spritesheet.parse sobre una textura vacía del mismo tamaño)", async () => {
        const tex = new Texture({ source: new TextureSource({ width: sheet.meta.size.w, height: sheet.meta.size.h }) });
        const parsed = new Spritesheet(tex, structuredClone(sheet) as never);
        await parsed.parse();
        for (const [anim, n] of Object.entries(FRAMES_POR_ANIM)) expect(parsed.animations[anim]).toHaveLength(n);
        parsed.destroy(true);
      });

      it("cada animación referencia fotogramas existentes de 32×40 dentro de la imagen", () => {
        for (const claves of Object.values(sheet.animations)) {
          for (const k of claves) {
            const f = sheet.frames[k]?.frame;
            expect(f, k).toBeDefined();
            expect([f.w, f.h]).toEqual([32, 40]);
            expect(f.x + f.w).toBeLessThanOrEqual(sheet.meta.size.w);
            expect(f.y + f.h).toBeLessThanOrEqual(sheet.meta.size.h);
          }
        }
      });
    });
  }
});

describe("oficina", () => {
  const ofi = leerJson<{
    size: { w: number; h: number };
    desks: { x: number; y: number }[];
    boss: { x: number; y: number };
    standing: { x: number; y: number }[];
  }>("oficina.json");

  it("fondo y frente existen y miden lo que dice oficina.json", () => {
    expect(ofi.size).toEqual({ w: 320, h: 180 });
    expect(tamPng("oficina.png")).toEqual(ofi.size);
    expect(tamPng("oficina-frente.png")).toEqual(ofi.size);
  });

  it("hay 6 escritorios y el sitio del jefe, todos dentro de la oficina", () => {
    expect(ofi.desks).toHaveLength(6);
    for (const p of [...ofi.desks, ofi.boss, ...ofi.standing]) {
      expect(p.x).toBeGreaterThanOrEqual(16);
      expect(p.x).toBeLessThanOrEqual(ofi.size.w - 16);
      expect(p.y).toBeGreaterThanOrEqual(40);
      expect(p.y).toBeLessThanOrEqual(ofi.size.h);
    }
  });
});

describe("pesos", () => {
  it("ningún PNG pesa más de 256 KB", () => {
    const pngs = readdirSync(DIR).filter((f) => f.endsWith(".png"));
    expect(pngs.length).toBeGreaterThanOrEqual(7);
    for (const f of pngs) expect(statSync(join(DIR, f)).size, f).toBeLessThanOrEqual(MAX_PNG);
  });
});
