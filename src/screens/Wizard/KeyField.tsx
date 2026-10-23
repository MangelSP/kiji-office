// Campo de una clave de API. El valor escrito vive SOLO en el estado local de este componente: no se sube al
// store, no se registra y se vacía en cuanto se guarda. Del llavero solo vuelve la máscara ("…abcd").
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { coreRestart, secretDelete, secretGet, secretSet, tauriError, type SecretUser } from "./tauri";

type Status = { kind: "loading" } | { kind: "none" } | { kind: "saved"; mask: string } | { kind: "unknown"; why: string };

type Props = { user: SecretUser; label: string; hint?: string };

export default function KeyField({ user, label, hint }: Props) {
  const [value, setValue] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const inputId = `wz-key-${user}`;

  const refresh = useCallback(async () => {
    try {
      const mask = await secretGet(user);
      setStatus(mask ? { kind: "saved", mask } : { kind: "none" });
    } catch (err) {
      setStatus({ kind: "unknown", why: tauriError(err) });
    }
  }, [user]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** El core recibe las claves por entorno al arrancar: hay que reiniciarlo para que vea la nueva. */
  const restartCore = async () => {
    try {
      await coreRestart();
      return "Core reiniciado con el cambio.";
    } catch (err) {
      return `No se pudo reiniciar el core (${tauriError(err)}).`;
    }
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (value === "" || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      await secretSet(user, value);
    } catch (err) {
      setMessage({ text: `No se pudo guardar: ${tauriError(err)}`, error: true });
      setBusy(false);
      return;
    }
    setValue(""); // el valor escrito no se conserva en ningún sitio
    await refresh();
    setMessage({ text: `Clave guardada. ${await restartCore()}`, error: false });
    setBusy(false);
  };

  const remove = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await secretDelete(user);
    } catch (err) {
      setMessage({ text: `No se pudo borrar: ${tauriError(err)}`, error: true });
      setBusy(false);
      return;
    }
    setValue("");
    await refresh();
    setMessage({ text: `Clave borrada. ${await restartCore()}`, error: false });
    setBusy(false);
  };

  return (
    <form className="wz-key" onSubmit={(e) => void save(e)} autoComplete="off">
      <div className="wz-key-head">
        <label htmlFor={inputId}>{label}</label>
        <span className={`wz-badge ${status.kind === "saved" ? "wz-ok" : "wz-off"}`} data-testid={`status-${user}`}>
          {status.kind === "loading" && "comprobando…"}
          {status.kind === "none" && "sin clave"}
          {status.kind === "saved" && `guardada ${status.mask}`}
          {status.kind === "unknown" && `estado desconocido (${status.why})`}
        </span>
      </div>
      {hint && <p className="wz-muted wz-small">{hint}</p>}
      <div className="wz-key-controls">
        <input
          id={inputId}
          type="password"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          data-1p-ignore
          placeholder="Pega aquí la clave"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button type="submit" className="wz-btn wz-btn-primary" disabled={busy || value === ""}>
          Guardar
        </button>
        <button type="button" className="wz-btn" disabled={busy || status.kind !== "saved"} onClick={() => void remove()}>
          Borrar
        </button>
      </div>
      {message && (
        <p className={`wz-small ${message.error ? "wz-err-text" : "wz-ok-text"}`} role="status">
          {message.text}
        </p>
      )}
    </form>
  );
}
