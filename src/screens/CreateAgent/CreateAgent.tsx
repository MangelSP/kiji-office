// Pantalla "Crear agente": vista previa del robot a la izquierda y formulario a la derecha.
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { errorMessage } from "../../store/core";
import { useScoped } from "../../store/scoped";
import Led from "../Connections/Led";
import "../Connections/Connections.css";
import { toolQualityText } from "../Connections/presets";
import { useConnectionModels } from "../Connections/useConnectionModels";
import RobotPreview from "./RobotPreview";
import { CLAUDE_MODELS, COLORS, NAME_MAX, ROLES, validateName } from "./options";
import "./CreateAgent.css";

type Props = {
  /** Cierra la pantalla (Cancelar, Esc o tras crear). */
  onClose: () => void;
  /** Se llama tras crear el robot, antes de cerrar. */
  onCreated?: (name: string) => void;
};

export default function CreateAgent({ onClose, onCreated }: Props) {
  const agents = useScoped((s) => s.agents);
  const call = useScoped((s) => s.call);
  const projectId = useScoped((s) => s.projectId);
  const refreshAgents = useScoped((s) => s.refreshAgents);
  const connections = useScoped((s) => s.connections);
  const refreshConnections = useScoped((s) => s.refreshConnections);

  // null = Claude (Agent SDK); si no, el id de una conexión (provider "api" en el core).
  const [connectionId, setConnectionId] = useState<string | null>(null);
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
  const conn = connections.find((c) => c.id === connectionId) ?? null;
  const provider = conn ? "api" : "claude";
  const { models: connModels, loading: modelsLoading } = useConnectionModels(connectionId);
  const connModelList = conn && conn.defaultModel && !connModels.includes(conn.defaultModel) ? [conn.defaultModel, ...connModels] : connModels;

  const pickProvider = (id: string | null) => {
    setConnectionId(id);
    setModel(id === null ? "sonnet" : (connections.find((c) => c.id === id)?.defaultModel ?? ""));
  };

  useEffect(() => {
    void refreshConnections();
  }, [refreshConnections]);

  // Con la lista cargada y sin modelo elegido (conexión sin modelo por defecto) se parte del primero.
  useEffect(() => {
    if (conn && model === "" && connModels.length > 0) setModel(connModels[0]!);
  }, [conn, model, connModels]);

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
      await call("agent.create", {
        projectId,
        name: finalName,
        provider,
        model,
        role,
        color,
        ...(conn ? { connectionId: conn.id } : {}),
      });
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
              {roleInfo.label} · {conn ? conn.name : "Claude"} {model}
            </p>
          </aside>

          <form className="ca-form" onSubmit={(e) => void submit(e)} noValidate>
            <fieldset className="ca-field">
              <legend>IA</legend>
              <div className="ca-providers">
                <label className="ca-provider">
                  <input type="radio" name="provider" value="claude" checked={connectionId === null} onChange={() => pickProvider(null)} />
                  <span>Claude</span>
                </label>
                {connections.map((c) => (
                  <label key={c.id} className="ca-provider">
                    <input type="radio" name="provider" value={c.id} checked={connectionId === c.id} onChange={() => pickProvider(c.id)} />
                    <span>
                      <Led conn={c} /> {c.name}
                    </span>
                  </label>
                ))}
              </div>
              {connections.length === 0 && <p className="muted small">Añade otras IAs (Ollama, LM Studio, OpenAI…) en Conexiones.</p>}
              {conn?.toolQuality === "none" && (
                <p className="ca-warn small" role="status">
                  Esta IA {toolQualityText("none")}: este robot solo podrá responder consultas.
                </p>
              )}
              {conn?.toolQuality === "weak" && (
                <p className="ca-warn small" role="status">
                  Esta IA {toolQualityText("weak")}.
                </p>
              )}
            </fieldset>

            <div className="ca-field">
              <label htmlFor={`${ids}-model`}>Modelo</label>
              {conn === null ? (
                <select id={`${ids}-model`} value={model} onChange={(e) => setModel(e.target.value)}>
                  {CLAUDE_MODELS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label} — {m.note}
                    </option>
                  ))}
                </select>
              ) : connModelList.length > 0 ? (
                <select id={`${ids}-model`} value={model} onChange={(e) => setModel(e.target.value)}>
                  {model !== "" && !connModelList.includes(model) && <option value={model}>{model}</option>}
                  {connModelList.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id={`${ids}-model`}
                  value={model}
                  spellCheck={false}
                  placeholder={modelsLoading ? "Cargando modelos…" : "nombre del modelo"}
                  onChange={(e) => setModel(e.target.value)}
                />
              )}
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
