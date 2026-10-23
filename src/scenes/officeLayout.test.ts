import { describe, expect, it } from "vitest";
import { assignSlots, DEFAULT_OFFICE, paletteFor, parseOfficeData, pickRobot, sheetKey } from "./officeLayout";

const mk = (n: number, boss = false) =>
  Array.from({ length: n }, (_, i) => ({ id: i + 1, is_boss: boss && i === 0 ? 1 : 0 }));

describe("assignSlots", () => {
  it("el jefe va a su sitio y no gasta escritorio", () => {
    const slots = assignSlots(mk(7, true));
    expect(slots.get("1")).toMatchObject({ kind: "boss", ...DEFAULT_OFFICE.boss });
    for (let i = 0; i < 6; i++) expect(slots.get(String(i + 2))).toMatchObject({ kind: "desk", ...DEFAULT_OFFICE.desks[i] });
  });

  it("hay 6 escritorios por defecto y se asignan por orden de creación", () => {
    expect(DEFAULT_OFFICE.desks).toHaveLength(6);
    const slots = assignSlots(mk(6));
    expect([...slots.values()].map((s) => s.kind)).toEqual(Array(6).fill("desk"));
    expect(slots.get("3")).toMatchObject(DEFAULT_OFFICE.desks[2]);
  });

  it("el 7º agente cae en un sitio de pie y muchos más no rompen", () => {
    const slots = assignSlots(mk(7));
    expect(slots.get("7")).toMatchObject({ kind: "standing", ...DEFAULT_OFFICE.standing[0] });
    const many = assignSlots(mk(30));
    expect(many.size).toBe(30);
    expect(many.get("30")?.kind).toBe("standing");
  });
});

describe("paletteFor / sheetKey", () => {
  it("usa el color del agente y mapea claude a terracota", () => {
    expect(paletteFor({ color: "azul" })).toBe("azul");
    expect(paletteFor({ color: "claude" })).toBe("terracota");
  });
  it("sin color válido cae al proveedor", () => {
    expect(paletteFor({ provider: "claude" })).toBe("terracota");
    expect(paletteFor({ provider: "openai", color: "morado" })).toBe("azul");
    expect(paletteFor({ provider: "gemini" })).toBe("verde");
    expect(paletteFor({ provider: "ollama" })).toBe("crema");
    expect(paletteFor({})).toBe("crema");
  });
  it("el jefe usa la variante jefe", () => {
    expect(sheetKey({ id: 1, is_boss: 1, color: "azul" })).toBe("terracota-jefe");
    expect(sheetKey({ id: 2, color: "verde" })).toBe("verde");
  });
});

describe("parseOfficeData / pickRobot", () => {
  it("lee oficina.json y completa lo que falta", () => {
    const d = parseOfficeData({ desks: [{ x: 1, y: 2 }, [3, 4]], jefe: { x: 9, y: 9 } });
    expect(d.desks).toEqual([{ x: 1, y: 2 }, { x: 3, y: 4 }]);
    expect(d.boss).toEqual({ x: 9, y: 9 });
    expect(d.standing).toEqual(DEFAULT_OFFICE.standing);
    expect(parseOfficeData(null)).toEqual(DEFAULT_OFFICE);
  });
  it("pickRobot devuelve el agente bajo el punto y el más cercano a cámara si se solapan", () => {
    const robots = [{ id: "a", x: 50, y: 100 }, { id: "b", x: 60, y: 110 }];
    expect(pickRobot(robots, 36, 90)).toBe("a");
    expect(pickRobot(robots, 55, 105)).toBe("b");
    expect(pickRobot(robots, 200, 10)).toBeNull();
  });
});
