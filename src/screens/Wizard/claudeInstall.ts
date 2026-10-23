// Claude Code instalado + versión mínima (PLAN-0.3, D2). Los comandos son los oficiales de code.claude.com/docs/en/setup.
export type OsKind = "windows" | "unix";

/** Igual que MIN_CLAUDE_VERSION de core/src/adapters/claude.ts (el SDK fijado trae el CLI 2.1.308). */
export const CLAUDE_MIN_VERSION = "2.1.308";
export const CLAUDE_DOCS_URL = "https://code.claude.com/docs/en/setup";
export const CLAUDE_INSTALL = {
  unix: "curl -fsSL https://claude.ai/install.sh | bash",
  windows: "irm https://claude.ai/install.ps1 | iex",
} as const;

export const detectOs = (): OsKind =>
  /win/i.test(typeof navigator !== "undefined" ? navigator.platform || navigator.userAgent : "") &&
  !/darwin|mac/i.test(typeof navigator !== "undefined" ? navigator.platform : "")
    ? "windows"
    : "unix";

export type ClaudeProblem = "missing" | "tooOld" | null;

/** `missing` si no se encontró; `tooOld` si su versión es menor que la mínima; null si está bien o no se sabe. */
export function claudeProblem(found: boolean, version: string | null | undefined): ClaudeProblem {
  if (!found) return "missing";
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(version ?? "");
  if (!m) return null;
  const v = [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
  const min = CLAUDE_MIN_VERSION.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (v[i] !== min[i]) return v[i]! < min[i]! ? "tooOld" : null;
  }
  return null;
}
