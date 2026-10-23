// Subpestaña "Perfil": Identidad, Motor e Instrucciones. Guarda con `agent.update`.
import { useEffect, useId, useMemo, useState, type FormEvent } from "react";
import type { AgentUpdateParams, ConnectionView, RelayTarget } from "../../../shared/protocol";
import type { Agent } from "../../store/agents";
import { CLAUDE_MODELS, COLORS, NAME_MAX, validateName } from "../CreateAgent/options";
import { ROLE_LABEL } from "./format";
import { useStore } from "../../store";
import Led from "../Connections/Led";
import { useConnectionModels } from "../Connections/useConnectionModels";
import "../Connections/Connections.css";
import { modelLabel } from "../../store/modelLabel";
import { useAgentsStore } from "./useAgentsStore";

export const PERSONA_MAX = 4000;
const DEFAULT_RELAY = ["opus", "sonnet", "haiku"];

const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((v, i) => v === b[i]);
const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((v) => b.includes(v));

function initialRelay(agent: Agent): string[] {
  if (Array.isArray(agent.relay_order) && agent.relay_order.length > 0) return agent.relay_order;
  if (agent.connection_id) return []; // una conexión no tiene relevo por defecto
  return DEFAULT_RELAY.filter((m) => m !== agent.model);
}

const isConnTarget = (m: string) => /^conn:[^/]+\/.+/.test(m);


/** Selector para añadir `conn:<id>/<modelo>` al orden de relevo. */
function RelayAdder({ connections, relay, onAdd }: { connections: ConnectionView[]; relay: string[]; onAdd: (target: RelayTarget) => void }) {
  const uid = useId();
  const [connId, setConnId] = useState("");
  const [model, setModel] = useState("");
  const { models } = useConnectionModels(connId === "" ? null : connId);
  if (connections.length === 0) return null;
  const chosen = connId === "" ? null : connections.find((c) => c.id === connId);
  const list = chosen?.defaultModel && !models.includes(chosen.defaultModel) ? [chosen.defaultModel, ...models] : models;
  const value = model !== "" ? model : (chosen?.defaultModel ?? list[0] ?? "");
  const target = connId !== "" && value !== "" ? (`conn:${connId}/${value}` as RelayTarget) : null;
  const dup = target !== null && relay.includes(target);
  return (
    <div className="row ag-relay-add" role="group" aria-label="Añadir una conexión al relevo">
      <select aria-label="Conexión de relevo" value={connId} id={`${uid}-rc`} onChange={(e) => { setConnId(e.target.value); setModel(""); }}>
        <option value="">Añadir IA al relevo…</option>
        {connections.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      {chosen &&
        (list.length > 0 ? (
          <select aria-label="Modelo de relevo" value={value} onChange={(e) => setModel(e.target.value)}>
            {list.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        ) : (
          <input aria-label="Modelo de relevo" value={model} placeholder="modelo" onChange={(e) => setModel(e.target.value)} />
        ))}
      <button type="button" className="btn" disabled={target === null || dup} onClick={() => target && onAdd(target)}>
        Añadir al relevo
      </button>
    </div>
  );
}

export default function AgentProfile({ agent }: { agent: Agent }) {
  const uid = useId();
  const agents = useAgentsStore((s) => s.agents);
  const skills = useAgentsStore((s) => s.skills);
  const refreshSkills = useAgentsStore((s) => s.refreshSkills);
  const skillsUnavailable = useAgentsStore((s) => s.unavailable["skills.list"]);
  const updateAgent = useAgentsStore((s) => s.updateAgent);

  const orig = useMemo(
    () => ({
      name: agent.name,
      color: agent.color && agent.color !== "claude" ? agent.color : "terracota",
      model: agent.model ?? "sonnet",
      connectionId: agent.connection_id ?? null,
      persona: agent.persona ?? "",
      skills: agent.skills ?? [],
      relay: initialRelay(agent),
      autoRelay: agent.auto_relay === undefined ? true : Boolean(agent.auto_relay),
    }),
    [agent],
  );

  const [name, setName] = useState(orig.name);
  const [color, setColor] = useState(orig.color);
  const [model, setModel] = useState(orig.model);
  const [connectionId, setConnectionId] = useState<string | null>(orig.connectionId);
  const connections = useStore((s) => s.connections);
  const refreshConnections = useStore((s) => s.refreshConnections);
  const { models: connModels, loading: modelsLoading } = useConnectionModels(connectionId);
  const [persona, setPersona] = useState(orig.persona);
  const [chosen, setChosen] = useState<string[]>(orig.skills);
  const [relay, setRelay] = useState<string[]>(orig.relay);
  const [autoRelay, setAutoRelay] = useState(orig.autoRelay);
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);

  useEffect(() => {
    void refreshSkills();
    void refreshConnections();
  }, [refreshSkills, refreshConnections]);

  const others = agents.filter((a) => String(a.id) !== String(agent.id)).map((a) => a.name);
  const nameError = name.trim() === orig.name ? null : validateName(name, others);
  const q = query.trim().toLowerCase();
  const visible = skills.filter((s) => q === "" || `${s.name} ${s.description}`.toLowerCase().includes(q));
  const knownNames = new Set(skills.map((s) => s.name));
  const orphans = chosen.filter((n) => !knownNames.has(n));
  const conn = connections.find((c) => c.id === connectionId) ?? null;
  const connNameOf = (id: string) => connections.find((c) => c.id === id)?.name ?? "conexión borrada";
  const pickConnection = (id: string | null) => {
    setConnectionId(id);
    setModel(id === null ? "sonnet" : (connections.find((c) => c.id === id)?.defaultModel ?? ""));
    setSaved(false);
  };
  const connList = model !== "" && !connModels.includes(model) ? [model, ...connModels] : connModels;
  const models = CLAUDE_MODELS.some((m) => m.id === model) ? CLAUDE_MODELS.map((m) => m.id as string) : [model, ...CLAUDE_MODELS.map((m) => m.id as string)];

  const patch: Omit<AgentUpdateParams, "agentId"> = {};
  if (name.trim() !== orig.name) patch.name = name.trim();
  if (color !== orig.color) patch.color = color;
  if (connectionId !== orig.connectionId) patch.connectionId = connectionId;
  if (model !== orig.model || connectionId !== orig.connectionId) patch.model = model;
  if (persona !== orig.persona) patch.persona = persona;
  if (!sameSet(chosen, orig.skills)) patch.skills = chosen;
  if (!same(relay, orig.relay)) patch.relayOrder = relay;
  if (autoRelay !== orig.autoRelay) patch.autoRelay = autoRelay;
  const dirty = Object.keys(patch).length > 0;

  const move = (i: number, d: -1 | 1) =>
    setRelay((r) => {
      const j = i + d;
      if (j < 0 || j >= r.length) return r;
      const next = r.slice();
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  const toggleSkill = (n: string) => setChosen((c) => (c.includes(n) ? c.filter((x) => x !== n) : [...c, n]));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!dirty || nameError) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    const ok = await updateAgent({ agentId: String(agent.id), ...patch });
    setSaving(false);
    setWarning(ok ? (ok.warning ?? null) : null);
    if (ok) setSaved(true);
    else setError(useStore.getState().notice ?? "El core no aceptó los cambios.");
  };

  return (
    <form className="form ag-profile" onSubmit={(e) => void submit(e)} aria-label={`Perfil de ${agent.name}`}>
      <fieldset className="ag-fieldset">
        <legend>Identidad</legend>
        <div className="field">
          <label htmlFor={`${uid}-name`}>Nombre</label>
          <input
            id={`${uid}-name`}
            value={name}
            maxLength={NAME_MAX}
            aria-invalid={nameError ? true : undefined}
            onChange={(e) => {
              setName(e.target.value);
              setSaved(false);
            }}
          />
          {nameError && (
            <p className="ag-error" role="alert">
              {nameError}
            </p>
          )}
        </div>
        <div className="field">
          <span id={`${uid}-color`}>Color</span>
          <div role="radiogroup" aria-labelledby={`${uid}-color`} className="ag-swatches">
            {COLORS.map((c) => (
              <button
                key={c.id}
                type="button"
                role="radio"
                aria-checked={color === c.id}
                aria-label={c.label}
                className={`ag-swatch${color === c.id ? " is-on" : ""}`}
                style={{ background: c.hex }}
                onClick={() => {
                  setColor(c.id);
                  setSaved(false);
                }}
              />
            ))}
          </div>
        </div>
        <p className="muted small">
          Rol: <strong>{ROLE_LABEL[agent.role ?? ""] ?? agent.role ?? "sin rol"}</strong> (no se puede cambiar)
        </p>
      </fieldset>

      <fieldset className="ag-fieldset">
        <legend>Motor</legend>
        <div className="field">
          <label htmlFor={`${uid}-ia`}>IA</label>
          <select
            id={`${uid}-ia`}
            value={connectionId ?? ""}
            disabled={Boolean(agent.is_boss)}
            onChange={(e) => pickConnection(e.target.value === "" ? null : e.target.value)}
          >
            <option value="">Claude</option>
            {connectionId !== null && !conn && <option value={connectionId}>{connNameOf(connectionId)}</option>}
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          {conn && (
            <p className="muted small">
              <Led conn={conn} /> {conn.toolQuality === "none" ? "Esta IA solo responde consultas: el robot no podrá editar archivos." : conn.baseUrl}
            </p>
          )}
          {agent.is_boss ? <p className="muted small">El jefe siempre usa Claude.</p> : null}
        </div>
        <div className="field">
          <label htmlFor={`${uid}-model`}>Modelo</label>
          {conn === null ? (
            <select id={`${uid}-model`} value={model} onChange={(e) => setModel(e.target.value)}>
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          ) : connList.length > 0 ? (
            <select id={`${uid}-model`} value={model} onChange={(e) => setModel(e.target.value)}>
              {connList.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          ) : (
            <input
              id={`${uid}-model`}
              value={model}
              spellCheck={false}
              placeholder={modelsLoading ? "Cargando modelos…" : "nombre del modelo"}
              onChange={(e) => setModel(e.target.value)}
            />
          )}
        </div>
        <div className="field">
          <span id={`${uid}-relay`}>Orden de relevo</span>
          {relay.length === 0 ? (
            <p className="muted small">Sin modelos de relevo.</p>
          ) : (
            <ol className="ag-relay" aria-labelledby={`${uid}-relay`}>
              {relay.map((m, i) => (
                <li key={m}>
                  <span className="ag-relay-n">{i + 1}</span>
                  <span className="ag-chip">{modelLabel(m, connections)}</span>
                  <button type="button" className="btn btn-ghost" aria-label={`Subir ${m}`} disabled={i === 0} onClick={() => move(i, -1)}>
                    ↑
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    aria-label={`Bajar ${m}`}
                    disabled={i === relay.length - 1}
                    onClick={() => move(i, 1)}
                  >
                    ↓
                  </button>
                  {isConnTarget(m) && (
                    <button type="button" className="btn btn-ghost" aria-label={`Quitar ${m}`} onClick={() => setRelay((r) => r.filter((x) => x !== m))}>
                      ×
                    </button>
                  )}
                </li>
              ))}
            </ol>
          )}
          <RelayAdder connections={connections} relay={relay} onAdd={(t) => setRelay((r) => [...r, t])} />
          <p className="muted small field-help">Si el modelo llega a su límite, sigue con el primero de la lista que esté libre.</p>
        </div>
        <label className="ag-switch-row">
          <input type="checkbox" role="switch" checked={autoRelay} onChange={(e) => setAutoRelay(e.target.checked)} />
          <span>Relevo automático</span>
        </label>
      </fieldset>

      <fieldset className="ag-fieldset">
        <legend>Instrucciones</legend>
        <div className="field">
          <label htmlFor={`${uid}-persona`}>Personalidad</label>
          <textarea
            id={`${uid}-persona`}
            value={persona}
            maxLength={PERSONA_MAX}
            placeholder="Cómo debe hablar y trabajar este robot."
            onChange={(e) => setPersona(e.target.value)}
          />
          <p className="muted small field-help" aria-live="off">
            {persona.length} / {PERSONA_MAX}
          </p>
        </div>
        <div className="field">
          <label htmlFor={`${uid}-q`}>Buscar skills</label>
          <input id={`${uid}-q`} type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="nombre o descripción" />
        </div>
        {skillsUnavailable ? (
          <p className="muted small">Aún no disponible: el core no implementa skills.list.</p>
        ) : skills.length === 0 ? (
          <p className="muted small">No hay skills instaladas.</p>
        ) : visible.length === 0 ? (
          <p className="muted small">Ninguna skill coincide con «{query}».</p>
        ) : null}
        <ul className="plain ag-skills" aria-label="Skills">
          {visible.map((s) => (
            <li key={s.name}>
              <label>
                <input type="checkbox" checked={chosen.includes(s.name)} onChange={() => toggleSkill(s.name)} />
                <span>
                  <strong>{s.name}</strong>
                  <span className="muted small ag-skill-desc">{s.description}</span>
                </span>
              </label>
            </li>
          ))}
          {orphans.map((n) => (
            <li key={n}>
              <label>
                <input type="checkbox" checked onChange={() => toggleSkill(n)} />
                <span>
                  <strong>{n}</strong>
                  <span className="muted small ag-skill-desc">(no está en la lista actual)</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      </fieldset>

      {error && (
        <p className="ag-error" role="alert">
          No se pudo guardar: {error}
        </p>
      )}
      {saved && !dirty && (
        <p className="ag-ok" role="status">
          Guardado.
        </p>
      )}
      {warning && (
        <p className="cx-warn" role="status">
          Aviso: {warning}
        </p>
      )}
      <div className="row">
        <button type="submit" className="btn btn-primary" disabled={!dirty || saving || Boolean(nameError)}>
          {saving ? "Guardando…" : "Guardar"}
        </button>
      </div>
    </form>
  );
}
