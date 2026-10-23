// Subpestaña "Diario" del jefe: cronología de turnos del gerente con su resumen, coste y acciones.
import { useEffect, useState } from "react";
import type { AutonomyLevel, ManagerActionView } from "../../../shared/protocol";
import { useStore } from "../../store";
import { NO_DIARY } from "../../store/manager";
import { fmtUsd, timeAgo } from "../Agents/format";
import "./Manager.css";

export const LEVEL_ICON: Record<AutonomyLevel, { icon: string; label: string }> = {
  auto: { icon: "⚡", label: "automático" },
  notify: { icon: "🔔", label: "avisó" },
  ask: { icon: "❓", label: "preguntó" },
};

export const DECIDED_LABEL: Record<string, string> = {
  policy: "política",
  user: "tú",
  timeout: "tiempo agotado",
};

/** Lo que decidió el gerente solo, sin que nadie lo contestara: la política lo permitía. */
export const decidedAlone = (a: ManagerActionView) => a.decidedBy === "policy";

const trim = (s: string, n = 140) => (s.length > n ? `${s.slice(0, n)}…` : s);

export default function ManagerDiary({ projectId }: { projectId: string }) {
  const entries = useStore((s) => s.diary[projectId] ?? NO_DIARY);
  const unavailable = useStore((s) => s.unavailable["manager.diary"]);
  const refresh = useStore((s) => s.refreshDiary);
  const [onlyAuto, setOnlyAuto] = useState(false);

  useEffect(() => {
    void refresh(projectId);
  }, [projectId, refresh]);

  if (unavailable) return <p className="muted">Aún no disponible: el core no implementa el diario del gerente.</p>;

  const sorted = [...entries].sort((a, b) => b.startedAt - a.startedAt);
  const shown = onlyAuto
    ? sorted.map((e) => ({ ...e, actions: e.actions.filter(decidedAlone) })).filter((e) => e.actions.length > 0)
    : sorted;

  return (
    <div className="mg">
      <label className="mg-check">
        <input type="checkbox" checked={onlyAuto} onChange={(e) => setOnlyAuto(e.target.checked)} />
        <span>Solo lo que decidió solo</span>
      </label>
      {shown.length === 0 ? (
        <p className="muted">{onlyAuto ? "El gerente no ha decidido nada solo todavía." : "El gerente aún no ha hecho ningún turno."}</p>
      ) : (
        <ol className="plain mg-diary" aria-label="Diario del gerente">
          {shown.map((e) => (
            <li key={e.id} className="card mg-tick" aria-label={`Turno ${e.summary || e.trigger || e.id}`}>
              <p className="mg-tick-head">
                <span className="muted small">{timeAgo(e.startedAt)}</span>
                {e.trigger && <span className="tag muted">{e.trigger}</span>}
                <span className="mg-tick-cost small muted">{fmtUsd(e.costUsd)}</span>
                {e.endedAt == null && <span className="tag">en curso</span>}
              </p>
              {e.summary && <p className="mg-tick-summary">{e.summary}</p>}
              {e.actions.length > 0 && (
                <ul className="plain mg-actions">
                  {e.actions.map((a) => {
                    const lv = LEVEL_ICON[a.level];
                    return (
                      <li key={a.id} className="small">
                        <span title={lv.label} aria-label={lv.label} role="img" className="mg-lv">
                          {lv.icon}
                        </span>
                        <code>{a.tool}</code>
                        {a.result && <span className="muted"> → {trim(a.result)}</span>}
                        <span className="tag muted">{a.decidedBy ? `decidió: ${DECIDED_LABEL[a.decidedBy] ?? a.decidedBy}` : "pendiente"}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
