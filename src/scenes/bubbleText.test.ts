import { describe, expect, it } from "vitest";
import { BUBBLE_MAX, bubbleText, bubbleVisible, clip, DONE_BUBBLE_MS, stackBubbles } from "./bubbleText";

const tool = (name: string, input: unknown) => ({ kind: "tool", payload: { name, status: "start", input } });

describe("bubbleText", () => {
  it("Read, Grep y Glob -> leyendo", () => {
    expect(bubbleText(tool("Read", { file_path: "/repo/src/store/index.ts" }))).toBe("leyendo index.ts");
    expect(bubbleText(tool("Grep", { pattern: "useStore", path: "src/store" }))).toBe("leyendo store");
    expect(bubbleText(tool("Grep", { pattern: "useStore" }))).toBe("leyendo useStore");
    expect(bubbleText(tool("Glob", { pattern: "**/*.ts" }))).toBe("leyendo **/*.ts");
  });

  it("Edit y Write -> editando", () => {
    expect(bubbleText(tool("Edit", { file_path: "src/App.tsx" }))).toBe("editando App.tsx");
    expect(bubbleText(tool("Write", { file_path: "C:\\x\\y\\nuevo.md" }))).toBe("editando nuevo.md");
  });

  it("Bash -> ejecutando <comando corto>", () => {
    expect(bubbleText(tool("Bash", { command: "npm test" }))).toBe("ejecutando npm test");
    const largo = bubbleText(tool("Bash", { command: "npm run build && npm run lint -- --fix --max-warnings 0" }))!;
    expect(largo.length).toBeLessThanOrEqual(BUBBLE_MAX);
    expect(largo.startsWith("ejecutando npm run build")).toBe(true);
    expect(largo.endsWith("…")).toBe(true);
  });

  it("nunca pasa de 40 caracteres", () => {
    const t = bubbleText(tool("Read", { file_path: `/a/${"x".repeat(200)}.ts` }))!;
    expect(t.length).toBeLessThanOrEqual(BUBBLE_MAX);
    expect(bubbleText(tool("Herramienta".repeat(10), {}))!.length).toBeLessThanOrEqual(BUBBLE_MAX);
  });

  it("herramienta desconocida o sin entrada no rompe", () => {
    expect(bubbleText(tool("WebFetch", {}))).toBe("usando WebFetch");
    expect(bubbleText({ kind: "tool", payload: null })).toBe("usando");
    expect(bubbleText(tool("Read", null))).toBe("leyendo");
  });

  it("permiso pendiente, pensando y listo", () => {
    expect(bubbleText({ kind: "permission", payload: { decision: "pending", tool: "Bash" } })).toBe("¡te necesito!");
    expect(bubbleText({ kind: "permission", payload: { decision: "approved" } })).toBe("pensando…");
    expect(bubbleText({ kind: "thinking", payload: {} })).toBe("pensando…");
    expect(bubbleText({ kind: "status", payload: { type: "done", text: "ok" } })).toBe("¡listo!");
  });

  it("eventos que no cambian el globo devuelven null", () => {
    expect(bubbleText({ kind: "status", payload: { reason: "x" } })).toBeNull();
    expect(bubbleText({ kind: "git", payload: {} })).toBeNull();
    expect(bubbleText({ kind: "test", payload: {} })).toBeNull();
  });
});

describe("bubbleVisible", () => {
  const done = { kind: "status", payload: { type: "done" }, at: 1000 };
  const read = { ...tool("Read", { file_path: "a.ts" }), at: 1000 };
  it("¡listo! desaparece a los 8 s aunque el robot ya esté libre", () => {
    expect(bubbleVisible(done, true, 1000 + DONE_BUBBLE_MS - 1)).toBe(true);
    expect(bubbleVisible(done, true, 1000 + DONE_BUBBLE_MS)).toBe(false);
  });
  it("el robot libre no muestra globo", () => {
    expect(bubbleVisible(read, true, 1500)).toBe(false);
    expect(bubbleVisible(read, false, 1500)).toBe(true);
  });
});

describe("stackBubbles", () => {
  it("globos que no se solapan se quedan donde estaban", () => {
    const m = stackBubbles([
      { id: "a", x: 0, w: 100, h: 20, bottom: 100 },
      { id: "b", x: 200, w: 100, h: 20, bottom: 100 },
    ]);
    expect(m.get("a")).toBe(80);
    expect(m.get("b")).toBe(80);
  });
  it("los que se solapan suben uno encima de otro", () => {
    const m = stackBubbles([
      { id: "a", x: 0, w: 100, h: 20, bottom: 100 },
      { id: "b", x: 50, w: 100, h: 20, bottom: 100 },
      { id: "c", x: 60, w: 100, h: 20, bottom: 100 },
    ]);
    expect(m.get("a")).toBe(80);
    expect(m.get("b")).toBe(58);
    expect(m.get("c")).toBe(36);
  });
});

describe("clip", () => {
  it("recorta con puntos suspensivos", () => {
    expect(clip("abcdefghij", 5)).toBe("abcd…");
    expect(clip("abc", 5)).toBe("abc");
  });
});
