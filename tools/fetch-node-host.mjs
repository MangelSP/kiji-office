// Deja el sidecar `kiji-node` del host en src-tauri/binaries si falta (no redescarga si ya existe).
// Lo usan beforeDevCommand / beforeBuildCommand de tauri.conf.json: un clon nuevo necesita Rust y Node.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchNode, layout } from "./fetch-node.mjs";

/** Triple de Rust del host según la salida de `rustc -vV`. */
export function hostTriple(rustcOutput) {
  const m = /^host:\s*(\S+)\s*$/m.exec(rustcOutput);
  if (!m) throw new Error("`rustc -vV` no indica el host");
  return m[1];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const triple = hostTriple(execFileSync("rustc", ["-vV"], { encoding: "utf8" }));
    const out = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "src-tauri", "binaries", layout("v0", triple).outName);
    if (existsSync(out)) console.log(`Sidecar presente: ${out}`);
    else await fetchNode(triple);
  } catch (e) {
    console.error(`fetch-node-host: ${e.message} (¿está Rust instalado?)`);
    process.exit(1);
  }
}
