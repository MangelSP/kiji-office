// Node mínimo: `node:sqlite` del core exige >= 22.13.
export const NODE_MIN = [22, 13] as const;

export function parseVersion(text: string | null | undefined): [number, number, number] | null {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text ?? "");
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}

/** Texto del error bloqueante si Node falta o es demasiado viejo; `null` si está bien o no se puede saber. */
export function nodeProblem(found: boolean, version: string | null | undefined): string | null {
  if (!found) return "No se encontró Node.js. Kiji Office necesita Node 22.13 o superior.";
  const v = parseVersion(version);
  if (!v) return null; // no se pudo leer la versión: no se bloquea sin motivo
  if (v[0] < NODE_MIN[0] || (v[0] === NODE_MIN[0] && v[1] < NODE_MIN[1])) {
    return `Tu Node es ${v.join(".")} y Kiji Office necesita 22.13 o superior.`;
  }
  return null;
}

export const NODE_HELP = [
  "Con Homebrew: brew install node@22",
  "Con nvm: nvm install 22 && nvm alias default 22",
  "O descarga el instalador de nodejs.org (versión LTS 22 o superior).",
];
