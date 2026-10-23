// Descarga el Node 24 LTS oficial para un target de Rust y lo deja como sidecar de Tauri:
//   node tools/fetch-node.mjs <rust-target-triple>   →   src-tauri/binaries/node-<triple>[.exe]
// Verifica el sha256 contra SHASUMS256.txt de nodejs.org. Sin dependencias npm (fetch, crypto, `tar` del sistema).
// NODE_VERSION=24.11.0 fija la versión; KIJI_CACHE_DIR cambia el directorio de caché.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = "https://nodejs.org/dist";
const MAJOR = 24;

// triple de Rust → plataforma de nodejs.org y formato del archivo
export const TARGETS = {
  "aarch64-apple-darwin": { platform: "darwin-arm64", ext: "tar.gz" },
  "x86_64-apple-darwin": { platform: "darwin-x64", ext: "tar.gz" },
  "x86_64-pc-windows-msvc": { platform: "win-x64", ext: "zip", exe: true },
  "aarch64-pc-windows-msvc": { platform: "win-arm64", ext: "zip", exe: true },
  "x86_64-unknown-linux-gnu": { platform: "linux-x64", ext: "tar.xz" },
  "aarch64-unknown-linux-gnu": { platform: "linux-arm64", ext: "tar.xz" },
};

const cmpVersion = (a, b) => {
  const pa = a.replace(/^v/, "").split(".").map(Number);
  const pb = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
};

/** Última 24.x LTS del índice de nodejs.org (`index.json`). Devuelve "v24.x.y". */
export function pickLatestLts(index) {
  const c = index.filter((e) => e.lts && e.version.startsWith(`v${MAJOR}.`)).map((e) => e.version);
  if (c.length === 0) throw new Error(`No hay Node ${MAJOR} LTS en el índice de nodejs.org`);
  return c.sort(cmpVersion).at(-1);
}

/** Nombre del archivo y del binario dentro de él para una versión y un target. */
export function layout(version, triple) {
  const t = TARGETS[triple];
  if (!t) throw new Error(`Target no soportado: ${triple}. Soportados: ${Object.keys(TARGETS).join(", ")}`);
  const dir = `node-${version}-${t.platform}`;
  return {
    archive: `${dir}.${t.ext}`,
    member: t.exe ? `${dir}/node.exe` : `${dir}/bin/node`,
    outName: `node-${triple}${t.exe ? ".exe" : ""}`,
  };
}

/** sha256 esperado de `file` según el texto de SHASUMS256.txt. */
export function expectedSha(shasums, file) {
  for (const line of shasums.split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(\S+)$/i.exec(line.trim());
    if (m && m[2] === file) return m[1].toLowerCase();
  }
  throw new Error(`${file} no aparece en SHASUMS256.txt`);
}

/** Lanza si el sha256 de `data` no es el esperado. */
export function verifySha256(data, expected, label = "archivo") {
  const actual = createHash("sha256").update(data).digest("hex");
  if (actual !== String(expected).toLowerCase()) {
    throw new Error(`sha256 de ${label} no coincide: esperado ${expected}, obtenido ${actual}`);
  }
}

function cacheDir() {
  if (process.env.KIJI_CACHE_DIR) return process.env.KIJI_CACHE_DIR;
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "kiji-office", "node");
  if (process.platform === "darwin") return join(homedir(), "Library", "Caches", "kiji-office", "node");
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "kiji-office", "node");
}

async function get(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function fetchNode(triple, { outDir } = {}) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  outDir ??= join(root, "src-tauri", "binaries");
  let version = process.env.NODE_VERSION;
  if (version) version = version.startsWith("v") ? version : `v${version}`;
  else version = pickLatestLts(JSON.parse((await get(`${DIST}/index.json`)).toString()));
  const { archive, member, outName } = layout(version, triple);

  const cache = join(cacheDir(), version);
  mkdirSync(cache, { recursive: true });
  const shasums = (await get(`${DIST}/${version}/SHASUMS256.txt`)).toString();
  const want = expectedSha(shasums, archive);

  const cached = join(cache, archive);
  let data = existsSync(cached) ? readFileSync(cached) : null;
  if (data) {
    try {
      verifySha256(data, want, archive);
      console.log(`Caché: ${cached}`);
    } catch {
      data = null; // caché corrupta: se descarga de nuevo
    }
  }
  if (!data) {
    console.log(`Descargando ${archive}…`);
    data = await get(`${DIST}/${version}/${archive}`);
    verifySha256(data, want, archive);
    writeFileSync(`${cached}.part`, data);
    renameSync(`${cached}.part`, cached);
  }

  const tmp = mkdtempSync(join(tmpdir(), "kiji-node-"));
  try {
    // `tar` (bsdtar en macOS y Windows 10+, GNU en Linux) extrae solo el binario; en Windows también lee .zip.
    execFileSync("tar", ["-xf", cached, "-C", tmp, member], { stdio: "inherit" });
    mkdirSync(outDir, { recursive: true });
    const out = join(outDir, outName);
    copyFileSync(join(tmp, member), out);
    if (!outName.endsWith(".exe")) chmodSync(out, 0o755);
    console.log(`Node ${version} → ${out}`);
    return out;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const triple = process.argv[2];
  if (!triple) {
    console.error("Uso: node tools/fetch-node.mjs <rust-target-triple>");
    process.exit(2);
  }
  fetchNode(triple).catch((e) => {
    console.error(`fetch-node: ${e.message}`);
    process.exit(1);
  });
}
