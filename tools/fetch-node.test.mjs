import { describe, expect, it } from "vitest";
import { expectedSha, layout, pickLatestLts, verifySha256 } from "./fetch-node.mjs";
import { createHash } from "node:crypto";

const sha = (s) => createHash("sha256").update(s).digest("hex");

describe("fetch-node", () => {
  it("verifySha256 acepta el hash correcto y rechaza uno alterado", () => {
    const data = Buffer.from("contenido");
    expect(() => verifySha256(data, sha("contenido"))).not.toThrow();
    const bad = (sha("contenido")[0] === "a" ? "b" : "a") + sha("contenido").slice(1);
    expect(() => verifySha256(data, bad, "x.tar.gz")).toThrow(/no coincide/);
  });

  it("expectedSha lee SHASUMS256.txt y falla si falta el archivo", () => {
    const txt = `${"a".repeat(64)}  node-v24.1.0-darwin-arm64.tar.gz\n${"b".repeat(64)}  node-v24.1.0-win-x64.zip\n`;
    expect(expectedSha(txt, "node-v24.1.0-win-x64.zip")).toBe("b".repeat(64));
    expect(() => expectedSha(txt, "otro.zip")).toThrow();
  });

  it("pickLatestLts elige la mayor 24.x LTS", () => {
    const idx = [
      { version: "v26.0.0", lts: false },
      { version: "v24.9.0", lts: "Krypton" },
      { version: "v24.11.1", lts: "Krypton" },
      { version: "v24.12.0", lts: false },
      { version: "v22.20.0", lts: "Jod" },
    ];
    expect(pickLatestLts(idx)).toBe("v24.11.1");
  });

  it("layout da archivo, miembro y nombre de sidecar por target", () => {
    expect(layout("v24.1.0", "aarch64-apple-darwin")).toEqual({
      archive: "node-v24.1.0-darwin-arm64.tar.gz",
      member: "node-v24.1.0-darwin-arm64/bin/node",
      outName: "kiji-node-aarch64-apple-darwin",
    });
    expect(layout("v24.1.0", "x86_64-pc-windows-msvc").outName).toBe("kiji-node-x86_64-pc-windows-msvc.exe");
    expect(() => layout("v24.1.0", "riscv")).toThrow();
  });
});

import { hostTriple } from "./fetch-node-host.mjs";
describe("hostTriple", () => {
  it("extrae el host de rustc -vV", () => {
    expect(hostTriple("rustc 1.90.0\nbinary: rustc\nhost: aarch64-apple-darwin\nrelease: 1.90.0\n")).toBe("aarch64-apple-darwin");
    expect(() => hostTriple("nada")).toThrow();
  });
});
