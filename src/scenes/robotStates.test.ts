import { describe, expect, it } from "vitest";
import { DONE_RETURN_MS, normalizeStatus, ROBOT_STATE_TABLE, ROBOT_STATES } from "./robotStates";

describe("robotStates", () => {
  it("define los seis estados del core con su animación", () => {
    expect([...ROBOT_STATES].sort()).toEqual(["done", "error", "idle", "needs_you", "thinking", "writing"]);
    for (const s of ROBOT_STATES) {
      const def = ROBOT_STATE_TABLE[s];
      expect(def.anim).toBe(s);
      expect(def.speed).toBeGreaterThan(0);
      expect(def.label).not.toBe("");
      expect(typeof def.loop).toBe("boolean");
    }
  });

  it("done vuelve a idle a los 4 s y ningún otro estado vuelve solo", () => {
    expect(DONE_RETURN_MS).toBe(4000);
    expect(ROBOT_STATE_TABLE.done.volverA).toEqual({ estado: "idle", ms: 4000 });
    for (const s of ROBOT_STATES.filter((x) => x !== "done")) expect(ROBOT_STATE_TABLE[s].volverA).toBeUndefined();
  });

  it("los destinos de volverA existen en la tabla", () => {
    for (const s of ROBOT_STATES) {
      const to = ROBOT_STATE_TABLE[s].volverA?.estado;
      if (to) expect(ROBOT_STATE_TABLE[to]).toBeDefined();
    }
  });

  it("normaliza estados desconocidos a idle", () => {
    expect(normalizeStatus("writing")).toBe("writing");
    expect(normalizeStatus("raro")).toBe("idle");
    expect(normalizeStatus(undefined)).toBe("idle");
  });
});
