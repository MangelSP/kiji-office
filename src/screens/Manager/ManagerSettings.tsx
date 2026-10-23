// Subpestaña "Gerente" del jefe: interruptor "Gerente autónomo", estado y "Habla con el gerente".
import { useEffect, useState } from "react";
import type { ManagerPolicy } from "../../../shared/protocol";
import { useStore } from "../../store";
import { useAgentsStore } from "../Agents/useAgentsStore";
import { fmtUsd, timeAgo } from "../Agents/format";
import ManagerWizard from "./ManagerWizard";
import { AUTONOMY_LABEL, defaultPolicy, LEVEL_KEYS, LEVEL_LABEL, pickBrain, presetOf, PRESET_LABEL } from "./policy";
import "./Manager.css";

export type ManagerStatus = "off" | "halted" | "thinking" | "active";

export const STATUS_LABEL: Record<ManagerStatus, string> = {
  off: "apagado",
  halted: "parado",
  thinking: "pensando",
  active: "activo",
};

export default function ManagerSettings({ projectId }: { projectId: string }) {
  const state = useStore((s) => s.manager[projectId]);
  const halted = useStore((s) => s.halted);
  const unavailable = useStore((s) => s.unavailable["manager.get"] || s.unavailable["manager.set"]);
  const connections = useStore((s) => s.connections);
  const agents = useAgentsStore((s) => s.agents);
  const refresh = useStore((s) => s.refreshManager);
  const save = useStore((s) => s.saveManager);
  const tick = useStore((s) => s.tickManager);
  const [wizard, setWizard] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [sent, setSent] = useState(false);

  useEffect(() => {
    void refresh(projectId);
  }, [projectId, refresh]);

  const policy = state?.policy ?? null;
  const enabled = !!policy?.enabled;
  const status: ManagerStatus = !enabled ? "off" : halted ? "halted" : state?.running ? "thinking" : "active";
  const brain = policy ? agents.find((a) => String(a.id) === policy.brain.agentId) : undefined;
  const preset = policy ? presetOf(policy.levels) : null;

  const toggle = async (on: boolean) => {
    if (on) return setWizard(true);
    if (!policy) return;
    setSaving(true);
    await save(projectId, { ...policy, enabled: false });
    setSaving(false);
  };

  const onSave = async (p: ManagerPolicy) => {
    setSaving(true);
    const ok = await save(projectId, p);
    setSaving(false);
    if (ok) setWizard(false);
  };

  const talk = async () => {
    const ok = await tick(projectId, message);
    if (ok) {
      setMessage("");
      setSent(true);
    }
  };

  if (unavailable) return <p className="muted">Aún no disponible: el core no implementa el gerente.</p>;

  return (
    <div className="mg">
      <div className="mg-switch-row">
        <label className="mg-switch">
          <input type="checkbox" role="switch" aria-label="Gerente autónomo" checked={enabled} disabled={saving} onChange={(e) => void toggle(e.target.checked)} />
          <span>Gerente autónomo</span>
        </label>
        <span className={`ag-badge mg-status mg-status-${status}`} data-testid="manager-status">
          {STATUS_LABEL[status]}
        </span>
      </div>
      <p className="muted small">El jefe planea, reparte y arranca el trabajo solo, dentro de los límites que fijes. Lo delicado siempre te lo pregunta.</p>

      {wizard && (
        <ManagerWizard
          agents={agents}
          connections={connections}
          initial={policy ? { ...policy, enabled: true } : defaultPolicy(pickBrain(agents, connections))}
          saving={saving}
          onSave={(p) => void onSave(p)}
          onCancel={() => setWizard(false)}
        />
      )}

      {enabled && policy && !wizard && (
        <>
          <dl className="mg-facts">
            <div>
              <dt>Cerebro</dt>
              <dd>{brain?.name ?? policy.brain.agentId}</dd>
            </div>
            <div>
              <dt>Último turno</dt>
              <dd>{state?.lastTick ? `${timeAgo(state.lastTick.startedAt)}${state.lastTick.summary ? ` · ${state.lastTick.summary}` : ""}` : "todavía ninguno"}</dd>
            </div>
            <div>
              <dt>Gasto de hoy</dt>
              <dd>
                {fmtUsd(state?.todayCostUsd ?? 0)} <span className="muted">de {fmtUsd(policy.dayBudgetUsd)}</span>
              </dd>
            </div>
            <div>
              <dt>Nivel</dt>
              <dd>{preset ? PRESET_LABEL[preset] : "Personalizado"}</dd>
            </div>
          </dl>
          <ul className="plain mg-summary" aria-label="Niveles actuales">
            {LEVEL_KEYS.map((k) => (
              <li key={k} className="small">
                {LEVEL_LABEL[k]}: <strong>{AUTONOMY_LABEL[policy.levels[k]]}</strong>
              </li>
            ))}
          </ul>
          <button type="button" className="btn" onClick={() => setWizard(true)}>
            Cambiar ajustes
          </button>

          <section className="mg-talk" aria-label="Habla con el gerente">
            <label className="mg-label" htmlFor="mg-talk-msg">
              Mensaje para el gerente
            </label>
            <textarea
              id="mg-talk-msg"
              rows={2}
              value={message}
              placeholder="Por ejemplo: prioriza el login y deja los estilos para mañana"
              onChange={(e) => {
                setMessage(e.target.value);
                setSent(false);
              }}
            />
            <div className="row">
              <button type="button" className="btn btn-primary" disabled={message.trim() === "" || halted} onClick={() => void talk()}>
                Habla con el gerente
              </button>
              {sent && <span className="muted small" role="status">Mensaje enviado: lo verás en el diario.</span>}
              {halted && <span className="muted small">Todo está parado: reanuda para hablar con el gerente.</span>}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
