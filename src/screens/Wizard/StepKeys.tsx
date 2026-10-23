import KeyField from "./KeyField";

export default function StepKeys() {
  return (
    <section aria-labelledby="wz-keys-title">
      <h2 id="wz-keys-title">Claves</h2>
      <p className="wz-muted">Es opcional. Las claves se guardan en el llavero de tu sistema.</p>
      <KeyField
        user="anthropic"
        label="Anthropic (Claude)"
        hint="Si usas la sesión de Claude Code que ya tienes iniciada, esta clave es opcional en desarrollo."
      />
      <p className="wz-muted wz-small">Añade otras IAs (OpenAI, Gemini, Ollama, LM Studio…) después en Conexiones.</p>
    </section>
  );
}
