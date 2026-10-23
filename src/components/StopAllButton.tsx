// Botón rojo "Parar todo" de la barra superior (con confirmación) y banner global "Todo parado" con "Reanudar".
import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import "./StopAllButton.css";

export default function StopAllButton() {
  const halted = useStore((s) => s.halted);
  const stopAll = useStore((s) => s.stopAll);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const cancel = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!confirming) return;
    cancel.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setConfirming(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [confirming]);

  const doStop = async () => {
    setBusy(true);
    await stopAll();
    setBusy(false);
    setConfirming(false);
  };

  return (
    <>
      <button type="button" className="stop-all" disabled={halted} title="Parar todos los robots y el gerente" onClick={() => setConfirming(true)}>
        {halted ? "Parado" : "Parar todo"}
      </button>
      {confirming && (
        <div className="stop-backdrop">
          <div className="stop-dialog" role="alertdialog" aria-modal="true" aria-labelledby="stop-title" aria-describedby="stop-desc">
            <h2 id="stop-title">¿Parar todo?</h2>
            <p id="stop-desc">
              Se detienen todos los robots en marcha de todos los workspaces y el gerente. No arrancará nada hasta que pulses «Reanudar».
            </p>
            <div className="stop-actions">
              <button type="button" className="stop-confirm" disabled={busy} onClick={() => void doStop()}>
                {busy ? "Parando…" : "Sí, parar todo"}
              </button>
              <button type="button" ref={cancel} className="stop-cancel" onClick={() => setConfirming(false)}>
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/** Banner rojo global mientras la parada está activa. */
export function HaltedBanner() {
  const halted = useStore((s) => s.halted);
  const resume = useStore((s) => s.resume);
  const [busy, setBusy] = useState(false);
  if (!halted) return null;
  return (
    <div className="halted-banner" role="alert">
      <strong>Todo parado</strong>
      <span>Los robots y el gerente no arrancarán nada hasta que reanudes.</span>
      <button
        type="button"
        className="halted-btn"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await resume();
          setBusy(false);
        }}
      >
        Reanudar
      </button>
    </div>
  );
}
