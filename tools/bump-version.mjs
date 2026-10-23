// Pone una versión en todos los sitios: node tools/bump-version.mjs <x.y.z> [raíz]
//   package.json, core/package.json, src-tauri/tauri.conf.json (solo el campo `version`),
//   src-tauri/Cargo.toml (solo [package].version) y la entrada `kiji-office` de src-tauri/Cargo.lock.
// Decisión: tauri.conf.json lleva la versión escrita (no "../package.json") para que el número sea explícito en
// el diff y en la config del bundler; este script es el único que la cambia. Se edita el texto, no se reformatea.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** Cambia el primer `"version": "…"` de nivel superior de un JSON. */
export function bumpJson(text, version) {
  const re = /^(\s*"version"\s*:\s*)"[^"]*"/m;
  if (!re.test(text)) throw new Error('no hay campo "version"');
  return text.replace(re, `$1"${version}"`);
}

/** Cambia `version` dentro de la tabla [package] de Cargo.toml. */
export function bumpCargoToml(text, version) {
  const m = /^\[package\][^\[]*?^version\s*=\s*"[^"]*"/ms.exec(text);
  if (!m) throw new Error("no hay version en [package]");
  return text.replace(m[0], m[0].replace(/(version\s*=\s*)"[^"]*"$/, `$1"${version}"`));
}

/** Cambia la versión del paquete `name` en Cargo.lock. */
export function bumpCargoLock(text, name, version) {
  const re = new RegExp(`(\\[\\[package\\]\\]\\r?\\nname = "${name}"\\r?\\nversion = )"[^"]*"`);
  if (!re.test(text)) throw new Error(`${name} no está en Cargo.lock`);
  return text.replace(re, `$1"${version}"`);
}

export function bump(version, root) {
  if (!SEMVER.test(version)) throw new Error(`versión no válida: ${version} (esperado x.y.z)`);
  const edits = [
    ["package.json", (t) => bumpJson(t, version)],
    ["core/package.json", (t) => bumpJson(t, version)],
    ["src-tauri/tauri.conf.json", (t) => bumpJson(t, version)],
    ["src-tauri/Cargo.toml", (t) => bumpCargoToml(t, version)],
    ["src-tauri/Cargo.lock", (t) => bumpCargoLock(t, "kiji-office", version)],
  ];
  // Primero se calcula todo y luego se escribe: si algo falla no queda a medias.
  const out = edits.map(([f, fn]) => {
    const p = join(root, f);
    try {
      return [p, fn(readFileSync(p, "utf8"))];
    } catch (e) {
      throw new Error(`${f}: ${e.message}`);
    }
  });
  for (const [p, t] of out) writeFileSync(p, t);
  return edits.map(([f]) => f);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [version, rootArg] = process.argv.slice(2);
  if (!version) {
    console.error("Uso: node tools/bump-version.mjs <x.y.z> [raíz]");
    process.exit(2);
  }
  try {
    const root = rootArg ? resolve(rootArg) : resolve(dirname(fileURLToPath(import.meta.url)), "..");
    for (const f of bump(version, root)) console.log(`${f} → ${version}`);
  } catch (e) {
    console.error(`bump-version: ${e.message}`);
    process.exit(1);
  }
}
