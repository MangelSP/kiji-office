import { describe, expect, it } from "vitest";
import { bump, bumpCargoLock, bumpCargoToml, bumpJson } from "./bump-version.mjs";
import { cpSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("bump-version", () => {
  it("bumpJson solo toca el campo version", () => {
    const t = '{\n  "name": "x",\n  "version": "0.1.0",\n  "dependencies": {"a": "^1"}\n}\n';
    expect(bumpJson(t, "0.3.0")).toBe(t.replace("0.1.0", "0.3.0"));
  });

  it("bumpCargoToml solo toca [package].version, no las dependencias", () => {
    const t = '[package]\nname = "k"\nversion = "0.1.0"\nedition = "2024"\n\n[dependencies]\nserde = { version = "1" }\n';
    expect(bumpCargoToml(t, "0.3.0")).toBe(t.replace('version = "0.1.0"', 'version = "0.3.0"'));
  });

  it("bumpCargoLock cambia solo el paquete indicado", () => {
    const t = '[[package]]\nname = "a"\nversion = "1.0.0"\n\n[[package]]\nname = "kiji-office"\nversion = "0.1.0"\n';
    expect(bumpCargoLock(t, "kiji-office", "0.3.0")).toContain('name = "kiji-office"\nversion = "0.3.0"');
    expect(bumpCargoLock(t, "kiji-office", "0.3.0")).toContain('name = "a"\nversion = "1.0.0"');
  });

  it("rechaza versiones no válidas y deja los archivos de una copia con 0.3.0", () => {
    const root = mkdtempSync(join(tmpdir(), "kiji-bump-"));
    mkdirSync(join(root, "core"));
    mkdirSync(join(root, "src-tauri"));
    const src = new URL("..", import.meta.url).pathname;
    for (const f of ["package.json", "core/package.json", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock", "src-tauri/tauri.conf.json"]) {
      cpSync(join(src, f), join(root, f));
    }
    expect(() => bump("v3", root)).toThrow(/no válida/);
    bump("9.8.7", root);
    expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version).toBe("9.8.7");
    expect(JSON.parse(readFileSync(join(root, "core/package.json"), "utf8")).version).toBe("9.8.7");
    expect(JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8")).version).toBe("9.8.7");
    expect(readFileSync(join(root, "src-tauri/Cargo.toml"), "utf8")).toMatch(/^version = "9\.8\.7"$/m);
  });
});
