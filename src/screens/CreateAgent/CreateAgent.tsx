// Pantalla "Crear agente": vista previa del robot a la izquierda y formulario a la derecha.
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { errorMessage } from "../../store/core";
import { useStore } from "../../store";
import RobotPreview from "./RobotPreview";
import { CLAUDE_MODELS, COLORS, NAME_MAX, PROVIDERS, ROLES, validateName } from "./options";
import "./CreateAgent.css";

type Props = {
  /** Cierra la pantalla (Cancelar, Esc o tras crear). */
  onClose: () => void;
  /** Se llama tras crear el robot, antes de cerrar. */
  onCreated?: (name: string) => void;
};

export default function CreateAgent({ onClose, onCreated }: Props) {
  const agents = useStore((s) => s.agents);
  const call = useStore((s) => s.call);
  const refreshAgents = useStore((s) => s.refreshAgents);

  const [provider] = useState("claude"); // en 0.1 solo Claude; los demás están deshabilitados
  const [model, setModel] = useState<string>("sonnet");
  const [role, setRole] = useState<string>(ROLES[0].id);
  const [name, setName] = useState("");
  const [color, setColor] = useState<string>(COLORS[0].id);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const ids = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const nameErrId = `${ids}-name-err`;
  const roleDescId = `${ids}-role-desc`;

  const nameError = validateName(
    name,
    agents.map((a) => a.name),
  );
  const showNameError = touched && nameError !== null;
  const roleInfo = ROLES.find((r) => r.id === role) ?? ROLES[0];

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    setServerError(null);
    if (nameError) {
      nameRef.current?.focus();
      return;
    }
    setBusy(true);
    try {
      const finalName = name.trim();
      await call("agent.create", { name: finalName, provider, model, role, color });
      await refreshAgents(); // el robot aparece en la oficina con su paleta
      onCreated?.(finalName);
      onClose();
    } catch (err) {
      setServerError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ca-backdrop">
      <div className="ca-dialog" role="dialog" aria-modal="true" aria-labelledby={`${ids}-title`}>
        <h2 id={`${ids}-title`} className="ca-title">
          Crear agente
        </h2>
        <div className="ca-body">
          <aside className="ca-side" aria-label="Vista previa">
            <RobotPreview palette={color} />
            <p className="ca-preview-name">{name.trim() || "Sin nombre"}</p>
            <p className="muted small">
              {roleInfo.label} · {provider} {model}
            </p>
          </aside>

          <form className="ca-form" onSubmit={(e) => void submit(e)} noValidate>
            <fieldset className="ca-field">
              <legend>IA</legend>
              <div className="ca-providers">
                {PROVIDERS.map((p) => (
                  <label key={p.id} className={`ca-provider${p.enabled ? "" : " is-disabled"}`}>
                    <input type="radio" name="provider" value={p.id} checked={p.id === provider} disabled={!p.enabled} readOnly />
                    <span>
                      {p.label}
                      {p.note && <small> · {p.note}</small>}
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            <div className="ca-field">
              <label htmlFor={`${ids}-model`}>Modelo</label>
              <select id={`${ids}-model`} value={model} onChange={(e) => setModel(e.target.value)}>
                {CLAUDE_MODELS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label} — {m.note}
                  </option>
                ))}
              </select>
            </div>

            <div className="ca-field">
              <label htmlFor={`${ids}-role`}>Rol</label>
              <select id={`${ids}-role`} value={role} onChange={(e) => setRole(e.target.value)} aria-describedby={roleDescId}>
                {ROLES.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
              </select>
              <p id={roleDescId} className="muted small">
                {roleInfo.desc}
              </p>
            </div>

            <div className="ca-field">
              <label htmlFor={`${ids}-name`}>Nombre</label>
              <input
                ref={nameRef}
                id={`${ids}-name`}
                value={name}
                maxLength={NAME_MAX}
                autoComplete="off"
                onChange={(e) => setName(e.target.value)}
                onBlur={() => name !== "" && setTouched(true)}
                aria-required="true"
                aria-invalid={showNameError}
                aria-describedby={showNameError ? nameErrId : undefined}
                placeholder="Pixel"
              />
              {showNameError && (
                <p id={nameErrId} className="ca-error" role="alert">
                  {nameError}
                </p>
              )}
            </div>

            <fieldset className="ca-field">
              <legend>Color</legend>
              <div className="ca-colors">
                {COLORS.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className="ca-swatch"
                    style={{ background: c.hex }}
                    aria-pressed={color === c.id}
                    aria-label={`Color ${c.label}`}
                    title={c.label}
                    onClick={() => setColor(c.id)}
                  />
                ))}
              </div>
            </fieldset>

            {serverError && (
              <p className="ca-error" role="alert">
                {serverError}
              </p>
            )}

            <div className="ca-actions">
              <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
                Cancelar
              </button>
              <button type="submit" className="btn btn-primary" disabled={busy}>
                {busy ? "Creando…" : "Crear robot"}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
