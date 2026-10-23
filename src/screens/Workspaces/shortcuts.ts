// Atajos de teclado entre workspaces: Cmd/Ctrl+1..9 cambia de pestaña y Cmd/Ctrl+0 va al Home.
import { useEffect } from "react";
import { useStore } from "../../store";

/** A qué va un atajo: un id de workspace, `null` (Home) o `undefined` (no es un atajo o no hay esa pestaña). */
export function shortcutTarget(
  e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  tabs: readonly string[],
): string | null | undefined {
  if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return undefined;
  if (!/^[0-9]$/.test(e.key)) return undefined;
  if (e.key === "0") return null;
  return tabs[Number(e.key) - 1];
}

export function useWorkspaceShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useStore.getState();
      const target = shortcutTarget(e, s.tabs);
      if (target === undefined) return;
      e.preventDefault();
      s.setActiveProject(target);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
