import { useState } from "react";
import type { Approval } from "../store/approvals";
import "./components.css";

function formatInput(input: unknown): string {
  if (input === undefined) return "";
  const text = typeof input === "string" ? input : JSON.stringify(input, null, 2);
  return text.length > 1200 ? `${text.slice(0, 1200)}…` : text;
}

// Tarjeta de una acción que el agente pide permiso para hacer.
export default function ApprovalCard({
  approval,
  agentName,
  onAnswer,
}: {
  approval: Approval;
  agentName?: string;
  onAnswer: (allow: boolean) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const answer = async (allow: boolean) => {
    setBusy(true);
    try {
      await onAnswer(allow);
    } finally {
      setBusy(false);
    }
  };
  const input = formatInput(approval.input);
  return (
    <article className="card card-warn" aria-label={`Permiso pedido: ${approval.tool ?? "acción"}`}>
      <p className="card-title">
        {agentName ? `${agentName} pide permiso` : "Un agente pide permiso"}
        {approval.tool ? <>: <code>{approval.tool}</code></> : null}
      </p>
      {input && <pre className="pre">{input}</pre>}
      <div className="row">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void answer(true)}>
          Permitir
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => void answer(false)}>
          Denegar
        </button>
      </div>
    </article>
  );
}
