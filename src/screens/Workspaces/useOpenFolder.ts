// Selector de carpeta nativo + `project.open`: lo comparten el botón «+» de las pestañas y el Home.
import { open } from "@tauri-apps/plugin-dialog";
import { useCallback } from "react";
import { useStore } from "../../store";

export function useOpenFolder(): () => Promise<void> {
  const openProject = useStore((s) => s.openProject);
  const setNotice = useStore((s) => s.setNotice);
  return useCallback(async () => {
    let path: unknown;
    try {
      path = await open({ directory: true, multiple: false, title: "Elige la carpeta del proyecto" });
    } catch {
      // Fuera de Tauri no existe el selector nativo.
      setNotice("El selector de carpetas solo está disponible en la app de escritorio.");
      return;
    }
    if (typeof path === "string") await openProject(path);
  }, [openProject, setNotice]);
}
