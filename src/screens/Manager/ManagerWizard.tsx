// Asistente de 3 pasos del Gerente autónomo: cerebro, nivel general (deslizador + "Ajustar") y límites.
import { useId, useState } from "react";
import type { AutonomyLevel, ConnectionView, ManagerPolicy } from "../../../shared/protocol";
import type { Agent } from "../../store/agents";
import {
  AUTONOMY_LABEL,
  AUTONOMY_ORDER,
  brainInfo,
  LEVEL_KEYS,
  LEVEL_LABEL,
  LOCKED_ACTIONS,
  PRESET_HELP,
  PRESET_LABEL,
  PRESET_ORDER,
  PRESETS,
  presetOf,
  validateLimits,
} from "./policy";

type Props = {
  agents: Agent[];
  connections: ConnectionView[];
  initial: ManagerPolicy;
  saving: boolean;
  onSave: (policy: ManagerPolicy) => void;
  onCancel: () => void;
};

const STEPS = ["Cerebro", "Nivel de autonomía", "Límites"] as const;

export default function ManagerWizard({ agents, connections, initial, saving, onSave, onCancel }: Props) {
  const uid = useId();
  const [step, setStep] = useState(0);
  const [policy, setPolicy] = useState<ManagerPolicy>(initial);
  const [adjust, setAdjust] = useState(false);
  const [quiet, setQuiet] = useState(!!initial.quietHours);
  const set = (patch: Partial<ManagerPolicy>) => setPolicy((p) => ({ ...p, ...patch }));

  const final: ManagerPolicy = { ...policy, enabled: true };
  if (!quiet) delete final.quietHours;
  else final.quietHours = policy.quietHours ?? { from: "23:00", to: "08:00" };
  const errors = step === 2 ? validateLimits(final) : [];
  const preset = presetOf(policy.levels);
  const sliderValue = preset ? PRESET_ORDER.indexOf(preset) : 1;

  const num = (v: string) => (v === "" ? NaN : Number(v));

  return (
    <section className="card mg-wizard" aria-label="Asistente del gerente">
      <p className="mg-step-title">
        Paso {step + 1} de {STEPS.length} · {STEPS[step]}
      </p>

      {step === 0 && (
        <div role="radiogroup" aria-label="Agente que hará de cerebro" className="mg-brains">
          <p className="muted small">El cerebro es el agente cuya IA decide qué hacer en cada turno del gerente.</p>
          {agents.map((a) => {
            const id = String(a.id);
            const info = brainInfo(a, connections);
            return (
              <label key={id} className={`card mg-brain${policy.brain.agentId === id ? " is-on" : ""}`}>
                <input
                  type="radio"
                  name={`${uid}-brain`}
                  checked={policy.brain.agentId === id}
                  onChange={() => set({ brain: { agentId: id } })}
                />
                <span>
                  <strong>{a.name}</strong> <span className="ag-chip">{info.label}</span>
                  <span className={`small mg-note ${info.ok ? "is-ok" : "is-warn"}`}>
                    {info.ok ? "✓ " : "⚠ "}
                    {info.note}
                  </span>
                </span>
              </label>
            );
          })}
          {agents.length === 0 && <p className="muted">Este proyecto aún no tiene agentes.</p>}
        </div>
      )}

      {step === 1 && (
        <div>
          <label htmlFor={`${uid}-slider`} className="mg-label">
            Nivel general
          </label>
          <input
            id={`${uid}-slider`}
            type="range"
            min={0}
            max={2}
            step={1}
            value={sliderValue}
            aria-valuetext={preset ? PRESET_LABEL[preset] : "Personalizado"}
            onChange={(e) => set({ levels: { ...PRESETS[PRESET_ORDER[Number(e.target.value)]] } })}
          />
          <div className="mg-slider-labels" aria-hidden="true">
            {PRESET_ORDER.map((p) => (
              <span key={p} className={preset === p ? "is-on" : ""}>
                {PRESET_LABEL[p]}
              </span>
            ))}
          </div>
          <p className="muted small" data-testid="preset-help">
            {preset ? PRESET_HELP[preset] : "Personalizado: has ajustado las categorías a mano."}
          </p>
          <button type="button" className="btn" aria-expanded={adjust} onClick={() => setAdjust((v) => !v)}>
            Ajustar
          </button>
          {adjust && (
            <ul className="plain mg-levels" aria-label="Nivel por categoría">
              {LEVEL_KEYS.map((k) => (
                <li key={k} className="mg-level">
                  <span>{LEVEL_LABEL[k]}</span>
                  <span className="mg-seg" role="group" aria-label={LEVEL_LABEL[k]}>
                    {AUTONOMY_ORDER.map((l: AutonomyLevel) => (
                      <button
                        key={l}
                        type="button"
                        className="mg-seg-btn"
                        aria-pressed={policy.levels[k] === l}
                        onClick={() => set({ levels: { ...policy.levels, [k]: l } })}
                      >
                        {AUTONOMY_LABEL[l]}
                      </button>
                    ))}
                  </span>
                </li>
              ))}
              {LOCKED_ACTIONS.map((a) => (
                <li key={a} className="mg-level mg-locked" data-locked="true">
                  <span>
                    <span aria-hidden="true">🔒</span> {a}
                  </span>
                  <span className="muted small">esto siempre te lo pregunto</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {step === 2 && (
        <div className="mg-limits">
          <label className="mg-field">
            <span>Gasto del día para preguntarte (USD)</span>
            <input type="number" min={0} step={0.5} value={Number.isNaN(policy.spendAskUsd) ? "" : policy.spendAskUsd} onChange={(e) => set({ spendAskUsd: num(e.target.value) })} />
          </label>
          <label className="mg-field">
            <span>Tope del día (USD)</span>
            <input type="number" min={0} step={1} value={Number.isNaN(policy.dayBudgetUsd) ? "" : policy.dayBudgetUsd} onChange={(e) => set({ dayBudgetUsd: num(e.target.value) })} />
          </label>
          <label className="mg-field mg-check">
            <input type="checkbox" checked={quiet} onChange={(e) => setQuiet(e.target.checked)} />
            <span>Horas de silencio (solo avisa, no arranca nada)</span>
          </label>
          {quiet && (
            <div className="mg-quiet">
              <label className="mg-field">
                <span>Desde</span>
                <input
                  type="time"
                  value={policy.quietHours?.from ?? "23:00"}
                  onChange={(e) => set({ quietHours: { from: e.target.value, to: policy.quietHours?.to ?? "08:00" } })}
                />
              </label>
              <label className="mg-field">
                <span>Hasta</span>
                <input
                  type="time"
                  value={policy.quietHours?.to ?? "08:00"}
                  onChange={(e) => set({ quietHours: { from: policy.quietHours?.from ?? "23:00", to: e.target.value } })}
                />
              </label>
            </div>
          )}
          <label className="mg-field">
            <span>Minutos para dar una pregunta por NO</span>
            <input type="number" min={1} step={5} value={Number.isNaN(policy.askTimeoutMinutes) ? "" : policy.askTimeoutMinutes} onChange={(e) => set({ askTimeoutMinutes: num(e.target.value) })} />
          </label>
          {errors.length > 0 && (
            <ul className="mg-errors" role="alert">
              {errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="row">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Cancelar
        </button>
        {step > 0 && (
          <button type="button" className="btn" onClick={() => setStep(step - 1)}>
            Atrás
          </button>
        )}
        {step < STEPS.length - 1 ? (
          <button type="button" className="btn btn-primary" disabled={step === 0 && !policy.brain.agentId} onClick={() => setStep(step + 1)}>
            Siguiente
          </button>
        ) : (
          <button type="button" className="btn btn-primary" disabled={saving || errors.length > 0} onClick={() => onSave(final)}>
            {saving ? "Guardando…" : "Guardar y activar"}
          </button>
        )}
      </div>
    </section>
  );
}
