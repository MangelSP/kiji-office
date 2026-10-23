import { useEffect, useState, type FormEvent } from "react";
import { useStore } from "../../store";
import KeyField from "./KeyField";

export const OLLAMA_DEFAULT = "http://localhost:11434/v1";

function OllamaUrl() {
  const call = useStore((s) => s.call);
  const [url, setUrl] = useState(OLLAMA_DEFAULT);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  useEffect(() => {
    let alive = true;
    call<string | null>("settings.get", { key: "ollama_url" })
      .then((v) => alive && v && setUrl(v))
      .catch(() => undefined); // sin core: se queda el valor por defecto
    return () => {
      alive = false;
    };
  }, [call]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const r = await call<{ value: string }>("settings.set", { key: "ollama_url", value: url });
      setUrl(r.value);
      setMessage({ text: "URL guardada.", error: false });
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : String(err), error: true });
    }
  };

  return (
    <form className="wz-key" onSubmit={(e) => void save(e)}>
      <div className="wz-key-head">
        <label htmlFor="wz-ollama-url">URL de Ollama</label>
      </div>
      <p className="wz-muted wz-small">Ollama no necesita clave. Solo cambia esto si lo ejecutas en otro puerto o equipo.</p>
      <div className="wz-key-controls">
        <input id="wz-ollama-url" type="url" value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} />
        <button type="submit" className="wz-btn wz-btn-primary">
          Guardar
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

export default function StepKeys() {
  return (
    <section aria-labelledby="wz-keys-title">
      <h2 id="wz-keys-title">Claves</h2>
      <p className="wz-muted">Todas son opcionales. Las claves se guardan en el llavero de tu sistema.</p>
      <KeyField
        user="anthropic"
        label="Anthropic (Claude)"
        hint="Si usas la sesión de Claude Code que ya tienes iniciada, esta clave es opcional en desarrollo."
      />
      <KeyField user="openai" label="OpenAI" />
      <KeyField user="gemini" label="Gemini (Google)" hint="En 0.1 Gemini se usa por API key." />
      <OllamaUrl />
    </section>
  );
}
