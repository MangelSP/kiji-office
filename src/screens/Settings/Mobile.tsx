// Ajustes › Móvil (M1 de PLAN-movil.md): sesión con Google, conexión con tu servidor, vincular un móvil con un QR y
// la lista de móviles vinculados. Todo lo hace Rust (`src-tauri/src/mobile.rs`); aquí solo se muestra y se pide.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { tauriError } from "../Wizard/tauri";

type Device = { pubkey: string; name: string; pairedAt: number; online: boolean };
export type MobileStatus = {
  configured: boolean;
  signedIn: boolean;
  email: string;
  enabled: boolean;
  connection: "off" | "connecting" | "connected" | "error";
  error: string | null;
  devices: Device[];
};

const CONNECTION: Record<MobileStatus["connection"], string> = {
  off: "Apagado",
  connecting: "Conectando…",
  connected: "Conectado",
  error: "Sin conexión",
};

export default function Mobile() {
  const [st, setSt] = useState<MobileStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [qr, setQr] = useState<{ svg: string; until: number } | null>(null);
  const [left, setLeft] = useState(0);

  useEffect(() => {
    let alive = true;
    invoke<MobileStatus>("mobile_status")
      .then((s) => alive && setSt(s))
      .catch((e) => alive && setError(tauriError(e)));
    const offs = [
      listen<MobileStatus>("mobile:status", (e) => setSt(e.payload)),
      listen("mobile:paired", () => setQr(null)),
    ];
    return () => {
      alive = false;
      offs.forEach((p) => void p.then((off) => off()).catch(() => {}));
    };
  }, []);

  // Cuenta atrás del QR: a los 5 minutos la oferta caduca en el relay.
  useEffect(() => {
    if (!qr) return;
    const tick = () => {
      const s = Math.max(0, Math.round((qr.until - Date.now()) / 1000));
      setLeft(s);
      if (s === 0) setQr(null);
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [qr]);

  const run = async (cmd: string, args?: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const s = await invoke<MobileStatus>(cmd, args);
      setSt(s);
    } catch (e) {
      setError(tauriError(e));
    } finally {
      setBusy(false);
    }
  };

  const pair = async () => {
    setError(null);
    try {
      const r = await invoke<{ svg: string; expiresInSecs: number }>("mobile_pair_start");
      setQr({ svg: r.svg, until: Date.now() + r.expiresInSecs * 1000 });
    } catch (e) {
      setError(tauriError(e));
    }
  };

  if (!st) {
    return <p className="st-hint">{error ?? "Cargando…"}</p>;
  }

  return (
    <>
      <p className="st-hint">
        Mira y gestiona tus workspaces desde el móvil. Todo va cifrado de punta a punta: tu servidor solo pasa mensajes que
        no puede leer, y el móvil solo puede hacer lo permitido (nunca toca claves ni ajustes).
      </p>
      {!st.configured && (
        <p className="st-banner" role="status">
          Esta versión no tiene configurado el servidor móvil (beta).
        </p>
      )}

      <div className="st-field">
        <span>Cuenta</span>
        {st.signedIn ? (
          <p className="st-inline">
            {st.email}{" "}
            <button type="button" className="st-btn" disabled={busy} onClick={() => void run("mobile_sign_out")}>
              Cerrar sesión
            </button>
          </p>
        ) : (
          <button type="button" className="st-btn st-btn-primary" disabled={busy || !st.configured} onClick={() => void run("mobile_sign_in")}>
            {busy ? "Esperando a Google…" : "Iniciar sesión con Google"}
          </button>
        )}
      </div>

      {st.signedIn && (
        <div className="st-field">
          <label className="st-check">
            <input type="checkbox" checked={st.enabled} disabled={busy} onChange={(e) => void run("mobile_set_enabled", { enabled: e.target.checked })} />
            Conectar con mi servidor
          </label>
          <p className={st.connection === "connected" ? "st-ok" : st.connection === "error" ? "st-error" : "st-hint"} role="status">
            {CONNECTION[st.connection]}
            {st.connection === "error" && st.error ? `: ${st.error}` : ""}
          </p>
        </div>
      )}

      {st.signedIn && st.enabled && (
        <div className="st-field">
          <span>Vincular un móvil</span>
          {qr ? (
            <div className="mb-qr">
              <div className="mb-qr-img" role="img" aria-label="Código QR para vincular un móvil" dangerouslySetInnerHTML={{ __html: qr.svg }} />
              <p className="st-hint">
                Escanéalo con la app Kiji en tu móvil (con la misma cuenta de Google). Caduca en {Math.floor(left / 60)}:
                {String(left % 60).padStart(2, "0")}.
              </p>
              <button type="button" className="st-btn" onClick={() => setQr(null)}>
                Cancelar
              </button>
            </div>
          ) : (
            <button type="button" className="st-btn" disabled={st.connection !== "connected"} onClick={() => void pair()}>
              Mostrar QR
            </button>
          )}
        </div>
      )}

      {st.devices.length > 0 && (
        <div className="st-field">
          <span>Móviles vinculados</span>
          <ul className="st-list">
            {st.devices.map((d) => (
              <li key={d.pubkey}>
                <span>
                  {d.online ? "🟢" : "⚪️"} {d.name} · desde {new Date(d.pairedAt * 1000).toLocaleDateString()}
                </span>
                <button type="button" className="st-btn" disabled={busy} onClick={() => void run("mobile_revoke", { pubkey: d.pubkey })}>
                  Desvincular
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {error && (
        <p className="st-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
