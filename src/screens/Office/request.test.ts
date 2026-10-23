import { describe, expect, it } from "vitest";
import { parseFiles, parseRequest, TITLE_MAX } from "./request";

describe("parseRequest", () => {
  it("el título es la primera línea y la descripción el texto completo", () => {
    expect(parseRequest("  Revisa el proyecto\nExplícame qué hace.  ")).toEqual({
      title: "Revisa el proyecto",
      description: "Revisa el proyecto\nExplícame qué hace.",
    });
  });
  it("recorta el título a 80 caracteres sin perder la descripción", () => {
    const largo = "a".repeat(120);
    const r = parseRequest(largo);
    expect(r.title).toHaveLength(TITLE_MAX);
    expect(r.description).toBe(largo);
  });
  it("texto vacío o en blanco: sin título", () => {
    expect(parseRequest("  \n ").title).toBe("");
  });
});

describe("parseFiles", () => {
  it("separa por comas, recorta y descarta vacíos; vacío = solo lectura", () => {
    expect(parseFiles(" src/a.ts, ,src/b.ts ,")).toEqual(["src/a.ts", "src/b.ts"]);
    expect(parseFiles("")).toEqual([]);
  });
});
