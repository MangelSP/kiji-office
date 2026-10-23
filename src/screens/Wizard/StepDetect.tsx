import { NODE_HELP, nodeProblem } from "./nodeVersion";
import type { CliInfo } from "./tauri";

const LABELS: Record<string, { title: string; note?: string }> = {
  claude: { title: "Claude Code", note: "Jefe y trabajadores con Claude (sesión local o clave de Anthropic)." },
  codex: { title: "Codex (OpenAI)", note: "Opcional: llega en una entrega posterior." },
  agy: { title: "Antigravity (agy)", note: "Gemini en 0.1 va por API key: agy solo se detecta, aún no se usa." },
  gemini: { title: "Gemini CLI", note: "Gemini en 0.1 va por API key: la CLI solo se detecta, aún no se usa." },
  ollama: { title: "Ollama", note: "Opcional: modelos locales." },
  node: { title: "Node.js", note: "Necesario (22.13 o superior): ejecuta el cerebro de la oficina." },
};

type Props = {
  clis: CliInfo[] | null;
  error: string | null;
  loading: boolean;
  onRefresh: () => void;
};

export default function StepDetect({ clis, error, loading, onRefresh }: Props) {
  const node = clis?.find((c) => c.name === "node");
  const problem = node ? nodeProblem(node.found, node.version) : null;

  return (
    <section aria-labelledby="wz-detect-title">
      <h2 id="wz-detect-title">Inteligencias detectadas</h2>
      <p className="wz-muted">Kiji Office busca en tu equipo las herramientas que puede usar.</p>

      {error && (
        <p className="wz-alert wz-alert-warn" role="alert">
          No se pudo detectar: {error}
        </p>
      )}

      {problem && (
        <div className="wz-alert wz-alert-error" role="alert">
          <strong>Error: {problem}</strong>
          <p>Instálalo y pulsa «Volver a buscar». Hasta entonces no puedes continuar.</p>
          <ul>
            {NODE_HELP.map((h) => (
              <li key={h}>{h}</li>
            ))}
          </ul>
        </div>
      )}

      {clis && (
        <ul className="wz-list">
          {clis.map((c) => {
            const info = LABELS[c.name] ?? { title: c.name };
            const bad = c.name === "node" && problem !== null;
            return (
              <li key={c.name} className="wz-row">
                <div className="wz-row-main">
                  <strong>{info.title}</strong>
                  {info.note && <span className="wz-muted wz-small">{info.note}</span>}
                  {c.found && c.path && <span className="wz-muted wz-small wz-path">{c.path}</span>}
                </div>
                <div className="wz-row-side">
                  {c.version && <span className="wz-muted wz-small">{c.version}</span>}
                  <span className={`wz-badge ${bad ? "wz-bad" : c.found ? "wz-ok" : "wz-off"}`}>
                    {bad ? "versión insuficiente" : c.found ? "detectado" : "no encontrado"}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <button type="button" className="wz-btn" onClick={onRefresh} disabled={loading}>
        {loading ? "Buscando…" : "Volver a buscar"}
      </button>
    </section>
  );
}
