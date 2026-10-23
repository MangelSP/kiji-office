import { useState } from "react";
import { core, CoreError } from "../../core/client";

type Provider = "claude" | "ollama" | "openai" | "gemini";
type Result = { state: "idle" } | { state: "running" } | { state: "ok" | "fail"; detail: string };

const PROVIDERS: { id: Provider; label: string; note: string }[] = [
  { id: "claude", label: "Claude", note: "Una llamada mínima (modelo haiku, menos de 0,02 USD)." },
  { id: "ollama", label: "Ollama", note: "Comprueba que responde en la URL configurada." },
  { id: "openai", label: "OpenAI", note: "Lista los modelos con tu clave." },
  { id: "gemini", label: "Gemini", note: "Lista los modelos con tu clave." },
];

// El test de Claude puede tardar unos segundos (el core lo corta a los 60 s).
const CLIENT_TIMEOUT_MS: Record<Provider, number> = { claude: 70_000, ollama: 10_000, openai: 12_000, gemini: 12_000 };

export default function StepTest() {
  const [results, setResults] = useState<Record<string, Result>>({});
  const anyRunning = Object.values(results).some((r) => r.state === "running");

  const run = async (provider: Provider) => {
    setResults((r) => ({ ...r, [provider]: { state: "running" } }));
    try {
      const res = await core.request<{ ok: boolean; detail: string }>("providers.test", { provider }, CLIENT_TIMEOUT_MS[provider]);
      setResults((r) => ({ ...r, [provider]: { state: res.ok ? "ok" : "fail", detail: res.detail } }));
    } catch (err) {
      const detail =
        err instanceof CoreError && err.code === "offline"
          ? "sin conexión con el core (¿estás fuera de la app de escritorio?)"
          : err instanceof CoreError && err.code === "unknown_method"
            ? "el core no implementa providers.test"
            : err instanceof Error
              ? err.message
              : String(err);
      setResults((r) => ({ ...r, [provider]: { state: "fail", detail } }));
    }
  };

  return (
    <section aria-labelledby="wz-test-title">
      <h2 id="wz-test-title">Probar conexión</h2>
      <p className="wz-muted">Prueba solo lo que vayas a usar: los demás pueden quedarse en rojo.</p>
      <ul className="wz-list">
        {/* El core atiende de una en una: probar Claude puede tardar, así que no se lanzan dos pruebas a la vez. */}
        {PROVIDERS.map((p) => {
          const r = results[p.id] ?? { state: "idle" };
          return (
            <li key={p.id} className="wz-row">
              <div className="wz-row-main">
                <strong>{p.label}</strong>
                <span className="wz-muted wz-small">{p.note}</span>
                {(r.state === "ok" || r.state === "fail") && (
                  <span className={`wz-small ${r.state === "ok" ? "wz-ok-text" : "wz-err-text"}`} role="status">
                    {r.state === "ok" ? "✓ Funciona. " : "✕ Falló. "}
                    {r.detail}
                  </span>
                )}
              </div>
              <div className="wz-row-side">
                <span className={`wz-dot wz-dot-${r.state}`} aria-hidden="true" />
                <button type="button" className="wz-btn" disabled={anyRunning} onClick={() => void run(p.id)} aria-label={`Probar ${p.label}`}>
                  {r.state === "running" ? "Probando…" : "Probar"}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
