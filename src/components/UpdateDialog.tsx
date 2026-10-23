// Actualizaciones: diálogo con la versión nueva y comprobación automática (1 vez al día) al arrancar.
// Todo pasa por los comandos de Rust `check_update` / `install_update`; no hay dependencias npm del updater.
import { useEffect, useId, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { useStore } from "../store";
import { settingValue, useSettings } from "../store/settings";
import "./CloseGuard.css";

export type UpdateInfo = { available: boolean; version: string; notes: string | null; date: string | null };

export const LAST_CHECK_KEY = "kiji.update.lastCheck";
const DAY_MS = 24 * 60 * 60 * 1000;

/** Texto legible de un error de `invoke` (Rust devuelve un string). */
export function errText(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : "Error desconocido.";
}

export async function checkForUpdate(): Promise<UpdateInfo | null> {
  return (await invoke<UpdateInfo | null>("check_update")) ?? null;
}

/** ¿Toca comprobar? Máximo una vez al día; si localStorage falla, se comprueba (sin guardar). */
export function shouldAutoCheck(now = Date.now()): boolean {
  try {
    const last = Number(localStorage.getItem(LAST_CHECK_KEY));
    return !(last > 0 && now - last < DAY_MS);
  } catch {
    return true;
  }
}

export function markChecked(now = Date.now()) {
  try {
    localStorage.setItem(LAST_CHECK_KEY, String(now));
  } catch {
    /* almacenamiento no disponible */
  }
}

/** Mismo criterio que CloseGuard: tareas en marcha o esperando y aprobaciones sin responder, en todos los workspaces. */
export function useBusyReason(): string | null {
  const robots = useStore((s) =>
    Object.values(s.byProject).reduce((n, p) => n + p.tasks.filter((t) => ["running", "needs_you"].includes(t.status)).length, 0),
  );
  const approvals = useStore((s) => Object.values(s.byProject).reduce((n, p) => n + p.approvals.length, 0));
  if (robots === 0 && approvals === 0) return null;
  const parts = [];
  if (robots > 0) parts.push(robots === 1 ? "1 robot trabajando" : `${robots} robots trabajando`);
  if (approvals > 0) parts.push(approvals === 1 ? "1 aprobación pendiente" : `${approvals} aprobaciones pendientes`);
  return parts.join(" y ");
}

export default function UpdateDialog({ update, onClose }: { update: UpdateInfo; onClose: () => void }) {
  const ids = useId();
  const busy = useBusyReason();
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const install = async () => {
    setInstalling(true);
    setError(null);
    try {
      await invoke("install_update"); // si todo va bien, la app se reinicia
    } catch (e) {
      setError(errText(e));
      setInstalling(false);
    }
  };

  return (
    <div className="cg-backdrop">
      <div
        className="cg-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${ids}-title`}
        onKeyDown={(e) => e.key === "Escape" && !installing && onClose()}
      >
        <h2 id={`${ids}-title`} className="cg-title">
          Hay una versión nueva: {update.version}
        </h2>
        {update.notes && (
          <p className="cg-text" style={{ whiteSpace: "pre-wrap", maxHeight: 200, overflow: "auto" }}>
            {update.notes}
          </p>
        )}
        {busy && (
          <p className="cg-text" role="status">
            No se puede instalar ahora: hay {busy}. Espera a que terminen o responde las aprobaciones.
          </p>
        )}
        {error && (
          <p className="cg-text" role="alert">
            {error}
          </p>
        )}
        <div className="cg-actions">
          <button type="button" className="cg-btn" onClick={onClose} disabled={installing} autoFocus>
            Más tarde
          </button>
          <button type="button" className="cg-btn" onClick={() => void install()} disabled={busy !== null || installing}>
            {installing ? "Instalando…" : "Instalar y reiniciar"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Al arrancar comprueba (1 vez al día) y, si hay versión nueva, deja un aviso discreto; nunca abre el diálogo. */
export function UpdateAutoCheck() {
  const setNotice = useStore((s) => s.setNotice);
  // Ajuste `update_auto_check` («0» = no comprobar solo; sin dato, sí).
  const enabled = useSettings((s) => settingValue(s.specs, "update_auto_check") !== "0");
  useEffect(() => {
    if (!enabled || !isTauri() || !shouldAutoCheck()) return;
    markChecked();
    checkForUpdate()
      .then((u) => u && setNotice(`Hay una versión nueva de Kiji Office (${u.version}). Instálala desde «Acerca de».`))
      .catch(() => {}); // sin red o sin publicar: en silencio; el botón manual explica el motivo
  }, [setNotice, enabled]);
  return null;
}
