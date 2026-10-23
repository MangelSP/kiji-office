// Tarjeta de un workspace abierto en el Home: robots, runs, cola, gasto, tokens, tareas por estado y último relevo.
import type { WorkspaceSummary } from "../../../shared/protocol";
import { relayWho } from "../../store/providers";
import { TASK_STATES } from "../../store/tasks";
import { fmtTokens, fmtUsd, paletteHex, STATE_LABEL, statusInfo, timeAgo } from "../Agents/format";
import { workspaceColor } from "../Workspaces/color";

const STATE_COLOR: Record<string, string> = {
  todo: "#6b7090",
  assigned: "#9aa0d8",
  running: "#5aa9f0",
  needs_you: "#ff7a45",
  review: "#f4c542",
  changes: "#e0a63a",
  approved: "#8fd9a8",
  integrated: "#4cc38a",
  blocked: "#ff6b57",
  failed: "#c0392b",
  paused_limit: "#b58cf0",
};

/** Mini barra apilada: un tramo por estado de tarea, proporcional a cuántas hay. */
export function TaskBar({ byStatus }: { byStatus: Record<string, number> }) {
  const known = new Set<string>(TASK_STATES);
  const states = [...TASK_STATES, ...Object.keys(byStatus).filter((s) => !known.has(s))].filter((s) => (byStatus[s] ?? 0) > 0);
  const total = states.reduce((n, s) => n + byStatus[s], 0);
  if (total === 0) return <p className="hm-muted hm-small">Sin tareas todavía.</p>;
  const summary = states.map((s) => `${byStatus[s]} ${(STATE_LABEL[s] ?? s).toLowerCase()}`).join(", ");
  return (
    <div>
      <div className="hm-taskbar" role="img" aria-label={`Tareas: ${summary}`}>
        {states.map((s) => (
          <span
            key={s}
            title={`${STATE_LABEL[s] ?? s}: ${byStatus[s]}`}
            style={{ flexGrow: byStatus[s], background: STATE_COLOR[s] ?? "#c9cbe0" }}
          />
        ))}
      </div>
      <p className="hm-muted hm-small">{summary}</p>
    </div>
  );
}

type Props = { w: WorkspaceSummary; onEnter: () => void; onClose: () => void };

export default function WorkspaceCard({ w, onEnter, onClose }: Props) {
  const t = w.tokensToday;
  const relay = w.lastRelay;
  const cache = t.cacheRead + t.cacheWrite;
  return (
    <article className="hm-card" aria-label={`Workspace ${w.name}`} style={{ borderTopColor: workspaceColor(w.color, w.projectId) }}>
      <header className="hm-card-head">
        <span className="hm-dot" style={{ background: workspaceColor(w.color, w.projectId) }} aria-hidden="true" />
        <div className="hm-card-title">
          <h3>{w.name}</h3>
          <p className="hm-muted hm-small hm-path" title={w.path}>
            {w.path}
          </p>
        </div>
      </header>

      {w.agents.length > 0 && (
        <ul className="hm-robots" aria-label="Robots">
          {w.agents.map((a) => {
            const st = statusInfo(a.status);
            return (
              <li key={a.id} className="hm-robot" title={`${a.name} · ${a.model} · ${st.label}`}>
                <span className="hm-avatar" style={{ background: paletteHex(a.color) }} aria-hidden="true">
                  <span className="hm-avatar-dot" style={{ background: st.dot }} />
                </span>
                <span className="hm-robot-name">{a.name}</span>
                <span className="hm-sr">{`, ${st.label}`}</span>
              </li>
            );
          })}
        </ul>
      )}

      <p className="hm-chips">
        <span className="hm-chip hm-chip-runs" title="Runs vivos">
          ⚙ {w.liveRuns} <span className="hm-chip-label">vivos</span>
        </span>
        <span className="hm-chip hm-chip-queue" title="En cola">
          ⏳ {w.queued} <span className="hm-chip-label">en cola</span>
        </span>
        <span className={`hm-chip hm-chip-needs${w.needsYou + w.approvalsPending > 0 ? " is-on" : ""}`} title="Te necesitan">
          ✋ {Math.max(w.needsYou, w.approvalsPending)} <span className="hm-chip-label">te necesitan</span>
        </span>
      </p>

      <TaskBar byStatus={w.tasksByStatus} />

      <dl className="hm-metrics">
        <div>
          <dt>Gasto hoy</dt>
          <dd>{fmtUsd(w.costTodayUsd)}</dd>
        </div>
        <div>
          <dt>Gasto total</dt>
          <dd>{fmtUsd(w.costTotalUsd)}</dd>
        </div>
        <div className="hm-metrics-wide">
          <dt>Tokens de hoy</dt>
          <dd>
            {fmtTokens(t.input)} entrada · {fmtTokens(t.output)} salida · {fmtTokens(cache)} caché
          </dd>
        </div>
      </dl>

      <p className="hm-muted hm-small">Última actividad: {timeAgo(w.lastActivityAt)}</p>
      {relay && (
        <p className="hm-muted hm-small">
          Último relevo: {relayWho(relay, w.agents).change} · {timeAgo(relay.createdAt)}
        </p>
      )}

      <footer className="hm-card-actions">
        <button type="button" className="hm-btn hm-btn-primary" onClick={onEnter} aria-label={`Entrar en ${w.name}`}>
          Entrar
        </button>
        <button type="button" className="hm-btn" onClick={onClose} aria-label={`Cerrar ${w.name}`}>
          Cerrar
        </button>
      </footer>
    </article>
  );
}
