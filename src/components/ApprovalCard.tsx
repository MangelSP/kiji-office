import { useEffect, useRef, useState } from "react";
import type { Approval } from "../store/approvals";
import "./components.css";

function formatInput(input: unknown): string {
  if (input === undefined) return "";
  const text = typeof input === "string" ? input : JSON.stringify(input, null, 2);
  return text.length > 1200 ? `${text.slice(0, 1200)}…` : text;
}

export type ApprovalVariant = "tool" | "manager" | "integrate";

/** Variante de la tarjeta: permiso de un robot, pregunta del gerente (`manager:*`) o integrar una tarea. */
export function approvalVariant(a: Pick<Approval, "tool" | "kind">): ApprovalVariant {
  const tool = a.tool ?? "";
  if (a.kind === "integrate" || /^manager:.*integra/i.test(tool) || tool === "integrate") return "integrate";
  // `kind: "question"` también lo usan los robots (AskUserQuestion): solo es del gerente si la herramienta es `manager:*`.
  if (a.kind === "manager" || tool.startsWith("manager:")) return "manager";
  return "tool";
}

const asRecord = (v: unknown): Record<string, unknown> => (v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {});

/** Pregunta y opciones de una petición del gerente (`input` puede ser texto o `{question, options}`). */
export function managerQuestion(input: unknown): { question: string; options: string[] } {
  if (typeof input === "string") return { question: input, options: [] };
  const o = asRecord(input);
  const q = [o.question, o.text, o.message, o.summary].find((v) => typeof v === "string" && v !== "") as string | undefined;
  const options = Array.isArray(o.options) ? o.options.filter((x): x is string => typeof x === "string") : [];
  return { question: q ?? (input === undefined ? "El gerente pregunta si puede continuar." : formatInput(input)), options };
}

// Tarjeta de una acción que el agente (o el gerente) pide permiso para hacer.
export default function ApprovalCard({
  approval,
  agentName,
  onAnswer,
  taskTitle,
  highlighted,
  timeoutMinutes,
}: {
  approval: Approval;
  agentName?: string;
  /** `option` = texto exacto de la opción elegida (solo en preguntas del gerente con opciones). */
  onAnswer: (allow: boolean, option?: string) => Promise<void>;
  /** Título de la tarea a integrar (variante integrar). */
  taskTitle?: string;
  /** Resaltada al llegar desde un aviso de la campana. */
  highlighted?: boolean;
  /** Minutos tras los que una pregunta sin respuesta se da por NO. */
  timeoutMinutes?: number;
}) {
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView?.({ block: "center", behavior: "smooth" });
  }, [highlighted]);
  const answer = async (allow: boolean, option?: string) => {
    setBusy(true);
    try {
      await (option === undefined ? onAnswer(allow) : onAnswer(allow, option));
    } finally {
      setBusy(false);
    }
  };
  const variant = approvalVariant(approval);
  const cls = `card ${variant === "tool" ? "card-warn" : "card-manager"}${highlighted ? " card-focus" : ""}`;

  if (variant === "manager" || variant === "integrate") {
    const q = managerQuestion(approval.input);
    const integrate = variant === "integrate";
    return (
      <article ref={ref} className={cls} data-variant={variant} data-highlighted={highlighted ? "true" : undefined} aria-label={integrate ? "Integrar pedido por el gerente" : "Pregunta del gerente"}>
        <p className="card-title">
          <span className="approval-boss" aria-hidden="true">👔</span> {integrate ? "El gerente quiere integrar" : "El gerente te pregunta"}
        </p>
        {integrate ? (
          <p>
            {taskTitle ? <>¿Integro «{taskTitle}» en la rama principal?</> : q.question}
            <span className="muted small"> Se hace rebase, se pasan los tests y se une con merge; luego puedes deshacerlo.</span>
          </p>
        ) : (
          <p className="approval-question">{q.question}</p>
        )}
        {timeoutMinutes !== undefined && timeoutMinutes > 0 && (
          <p className="muted small">Si no contestas en {timeoutMinutes} min se da por NO.</p>
        )}
        <div className="row" role="group" aria-label="Respuestas">
          {integrate || q.options.length === 0 ? (
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void answer(true)}>
              {integrate ? "Integrar" : "Sí"}
            </button>
          ) : (
            q.options.map((o, i) => (
              <button key={`${i}-${o}`} type="button" className={i === 0 ? "btn btn-primary" : "btn"} disabled={busy} onClick={() => void answer(true, o)}>
                {o}
              </button>
            ))
          )}
          <button type="button" className="btn" disabled={busy} onClick={() => void answer(false)}>
            {integrate ? "Ahora no" : "No"}
          </button>
        </div>
      </article>
    );
  }

  const input = formatInput(approval.input);
  return (
    <article ref={ref} className={cls} data-variant="tool" data-highlighted={highlighted ? "true" : undefined} aria-label={`Permiso pedido: ${approval.tool ?? "acción"}`}>
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
