import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { CLAUDE_DOCS_URL, CLAUDE_INSTALL, detectOs, type ClaudeProblem, type OsKind } from "./claudeInstall";

type Props = { problem: Exclude<ClaudeProblem, null>; os?: OsKind };

/** Tarjeta de Claude Code ausente o antiguo, con el comando oficial por sistema (no lo ejecutamos nosotros). */
export default function ClaudeCard({ problem, os = detectOs() }: Props) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const command = problem === "tooOld" ? "claude update" : CLAUDE_INSTALL[os];

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  const guide = async () => {
    try {
      await openUrl(CLAUDE_DOCS_URL);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  };

  return (
    <div className="wz-alert wz-alert-error" role="alert">
      <strong>{problem === "tooOld" ? "Tu Claude Code es antiguo" : "Claude Code no está instalado"}</strong>
      {problem === "tooOld" ? (
        <p>
          Tu Claude Code es antiguo: actualízalo con <code>claude update</code> y pulsa «Volver a buscar».
        </p>
      ) : (
        <p>
          Kiji Office necesita Claude Code instalado en tu equipo, además de tu clave de API de Anthropic, que añades en el paso
          «Claves». Abre una terminal, pega este comando ({os === "windows" ? "PowerShell" : "macOS/Linux"}) y pulsa «Volver a buscar».
        </p>
      )}
      <p>
        <code className="wz-path">{command}</code>
      </p>
      <div className="wz-actions">
        <button type="button" className="wz-btn" onClick={() => void copy()}>
          {copied ? "Copiado" : "Copiar"}
        </button>
        <button type="button" className="wz-btn" onClick={() => void guide()}>
          Abrir guía
        </button>
      </div>
      {failed && <p>No se pudo abrir el navegador. Guía: {CLAUDE_DOCS_URL}</p>}
    </div>
  );
}
