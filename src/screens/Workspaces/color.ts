// Color del punto de un workspace: el del proyecto (`#rrggbb`) o uno estable derivado de su id.
const FALLBACK = ["#f4c542", "#5aa9f0", "#4cc38a", "#ff7a45", "#b58cf0", "#e86f9f"];

export function workspaceColor(color: string | null | undefined, projectId: string): string {
  if (color && /^#[0-9a-fA-F]{6}$/.test(color)) return color;
  let h = 0;
  for (let i = 0; i < projectId.length; i++) h = (h * 31 + projectId.charCodeAt(i)) >>> 0;
  return FALLBACK[h % FALLBACK.length];
}
