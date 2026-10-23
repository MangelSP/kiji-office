// Alta/edición de una conexión en 3 pasos: (1) preset, (2) URL + clave + Probar, (3) modelo y contexto.
// La clave escrita vive SOLO en el estado de este componente: se guarda en el llavero con `secret_set` (cuenta
// `conn:<id>`), se vacía al instante y no pasa por el store ni por el core.
import { useEffect, useId, useRef, useState } from "react";
import type { ConnectionAuth, ConnectionPreset, ConnectionTest, ConnectionView } from "../../../shared/protocol";
import { useStore } from "../../store";
import { errorMessage } from "../../store/core";
import { secretSet, tauriError } from "../Wizard/tauri";
import { AUTH_LABEL, OLLAMA_CONTEXT_WARNING, PRESETS, presetInfo, toolQualityText } from "./presets";
import PresetIcon from "./PresetIcon";

type Props = { initial?: ConnectionView; onClose: () => void };

const STEP_LABEL = { models: "Modelos", chat: "Chat", tools: "Herramientas" } as const;
const DEFAULT_CONTEXT = 8192;

/** Host (con puerto) de una URL, o null si no se puede leer. */
export const hostOf = (url: string): string | null => {
  try {
    return new URL(url.trim()).host.toLowerCase();
  } catch {
    return null;
  }
};

export default function ConnectionForm({ initial, onClose }: Props) {
  const uid = useId();
  const call = useStore((s) => s.call);
  const refresh = useStore((s) => s.refreshConnections);
  const removeConnection = useStore((s) => s.removeConnection);

  const [step, setStep] = useState<1 | 2 | 3>(initial ? 2 : 1);
  const [preset, setPreset] = useState<ConnectionPreset>(initial?.preset ?? "ollama");
  const [name, setName] = useState(initial?.name ?? "Ollama");
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? presetInfo("ollama").baseUrl);
  const [auth, setAuth] = useState<ConnectionAuth>(initial?.auth ?? "none");
  const [key, setKey] = useState("");
  const [id, setId] = useState<string | null>(initial?.id ?? null);
  const [secretSaved, setSecretSaved] = useState(initial?.hasSecret ?? false);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<ConnectionTest | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [model, setModel] = useState(initial?.defaultModel ?? "");
  const [query, setQuery] = useState("");
  const [ctx, setCtx] = useState(String(initial?.contextWindow ?? (initial ? DEFAULT_CONTEXT : 4096)));
  const [error, setError] = useState<string | null>(null);
  // Extra A: si cambia el host de una conexión con clave, hay que confirmarlo antes de guardar.
  const [pendingHost, setPendingHost] = useState<{ host: string; retry: () => Promise<void> } | null>(null);
  const ackHost = useRef<string | null>(null);

  const info = presetInfo(preset);
  const needsKey = auth !== "none";

  const pickPreset = (p: ConnectionPreset) => {
    const pi = presetInfo(p);
    setPreset(p);
    setName(pi.label);
    setBaseUrl(pi.baseUrl);
    setAuth(pi.auth);
    setCtx(String(p === "ollama" ? 4096 : DEFAULT_CONTEXT));
  };

  /** Crea (o actualiza) la conexión y guarda la clave si se escribió una. Devuelve el id, o null si algo falló. */
  const save = async (retry?: () => Promise<void>): Promise<string | null> => {
    setError(null);
    const newHost = hostOf(baseUrl);
    if (initial?.hasSecret && retry && newHost !== null && newHost !== hostOf(initial.baseUrl) && ackHost.current !== newHost) {
      setPendingHost({ host: newHost, retry });
      return null;
    }
    try {
      let cid = id;
      if (cid === null) {
        const created = await call<ConnectionView>("connection.create", { name: name.trim(), preset, baseUrl: baseUrl.trim(), auth });
        cid = created.id;
        setId(cid);
      } else {
        await call("connection.update", { id: cid, name: name.trim(), baseUrl: baseUrl.trim(), auth });
      }
      if (key !== "") {
        try {
          await secretSet(`conn:${cid}`, key);
        } catch (err) {
          setError(`No se pudo guardar la clave: ${tauriError(err)}`);
          return null;
        }
        setKey(""); // el valor escrito no se conserva en ningún sitio
        setSecretSaved(true);
      }
      return cid;
    } catch (err) {
      setError(errorMessage(err));
      return null;
    }
  };

  const validate = (): string | null => {
    if (name.trim() === "") return "Ponle un nombre a la conexión.";
    if (!/^https?:\/\/\S+$/i.test(baseUrl.trim())) return "La URL debe empezar por http:// o https://.";
    return null;
  };

  const runTest = async () => {
    const problem = validate();
    if (problem) return setError(problem);
    setTesting(true);
    setTest(null);
    const cid = await save(runTest);
    if (cid) {
      try {
        const res = await call<ConnectionTest>("connection.test", { id: cid, ...(model ? { model } : {}) });
        setTest(res);
        if (res.models?.length) setModels(res.models);
        void refresh();
      } catch (err) {
        setError(errorMessage(err));
      }
    }
    setTesting(false);
  };

  const next = async () => {
    if (step === 1) return setStep(2);
    const problem = validate();
    if (problem) return setError(problem);
    setBusy(true);
    const cid = await save(next);
    setBusy(false);
    if (cid) setStep(3);
  };

  // Paso 3: lista de modelos de la conexión.
  useEffect(() => {
    if (step !== 3 || id === null) return;
    let alive = true;
    call<string[]>("connection.models", { id })
      .then((list) => alive && Array.isArray(list) && setModels(list))
      .catch(() => undefined) // sin lista: se escribe el nombre a mano
      .finally(() => alive && setModelsLoaded(true));
    return () => {
      alive = false;
    };
  }, [step, id, call]);

  useEffect(() => {
    if (step === 3 && model === "" && models.length > 0) setModel(models[0]!);
  }, [step, model, models]);

  const finish = async () => {
    const n = Number(ctx);
    if (!Number.isInteger(n) || n < 512) return setError("La ventana de contexto debe ser un número entero de al menos 512.");
    if (id === null) return;
    setBusy(true);
    setError(null);
    try {
      await call("connection.update", { id, defaultModel: model.trim() || null, contextWindow: n });
      await refresh();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    // Una conexión creada a medias en esta sesión no se queda huérfana.
    if (!initial && id !== null) {
      setBusy(true);
      const err = await removeConnection(id, secretSaved);
      setBusy(false);
      if (err) return setError(err); // no se cierra: el usuario ve qué quedó sin borrar
    }
    onClose();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy && !testing) void cancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const q = query.trim().toLowerCase();
  const shown = models.filter((m) => q === "" || m.toLowerCase().includes(q));
  const options = model !== "" && !shown.includes(model) ? [model, ...shown] : shown;

  return (
    <section className="cx-form" aria-label={initial ? `Editar ${initial.name}` : "Nueva conexión"}>
      <h2>{initial ? `Editar ${initial.name}` : "Nueva conexión"}</h2>
      <ol className="cx-steps" aria-label="Pasos">
        {["Tipo", "Dirección y clave", "Modelo"].map((t, i) => (
          <li key={t} className={step === i + 1 ? "is-on" : step > i + 1 ? "is-done" : ""} aria-current={step === i + 1 ? "step" : undefined}>
            {i + 1}. {t}
          </li>
        ))}
      </ol>

      {step === 1 && (
        <fieldset className="cx-field">
          <legend>¿A qué IA te conectas?</legend>
          <div className="cx-grid" role="radiogroup" aria-label="Tipo de conexión">
            {PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={preset === p.id}
                className={`cx-preset${preset === p.id ? " is-on" : ""}`}
                onClick={() => pickPreset(p.id)}
              >
                <PresetIcon preset={p.id} />
                <strong>{p.label}</strong>
                <small>{p.note}</small>
              </button>
            ))}
          </div>
        </fieldset>
      )}

      {step === 2 && (
        <div className="cx-step">
          <div className="cx-field">
            <label htmlFor={`${uid}-name`}>Nombre</label>
            <input id={`${uid}-name`} value={name} maxLength={40} autoComplete="off" onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="cx-field">
            <label htmlFor={`${uid}-url`}>URL</label>
            <input id={`${uid}-url`} type="url" value={baseUrl} spellCheck={false} autoComplete="off" placeholder="https://…/v1" onChange={(e) => setBaseUrl(e.target.value)} />
          </div>
          {info.authEditable && (
            <div className="cx-field">
              <label htmlFor={`${uid}-auth`}>Autenticación</label>
              <select id={`${uid}-auth`} value={auth} onChange={(e) => setAuth(e.target.value as ConnectionAuth)}>
                {(Object.keys(AUTH_LABEL) as ConnectionAuth[]).map((a) => (
                  <option key={a} value={a}>
                    {AUTH_LABEL[a]}
                  </option>
                ))}
              </select>
            </div>
          )}
          {needsKey ? (
            <div className="cx-field">
              <label htmlFor={`${uid}-key`}>Clave</label>
              <input
                id={`${uid}-key`}
                type="password"
                value={key}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                data-1p-ignore
                placeholder={secretSaved ? "Hay una clave guardada; déjalo vacío para conservarla" : "Pega aquí la clave"}
                onChange={(e) => setKey(e.target.value)}
              />
              <p className="muted small">{secretSaved ? "Clave guardada en el llavero de tu sistema." : "Se guarda en el llavero de tu sistema, nunca en archivos."}</p>
            </div>
          ) : (
            <p className="muted small">Esta conexión no necesita clave.</p>
          )}

          <div className="row">
            <button type="button" className="btn" disabled={testing || busy} onClick={() => void runTest()}>
              {testing ? "Probando…" : "Probar"}
            </button>
          </div>
          {testing && (
            <p className="muted small" role="status">
              Probando modelos, chat y herramientas…
            </p>
          )}
          {test && (
            <div className="cx-test" aria-label="Resultado de la prueba">
              <ul className="plain">
                {test.steps.map((s) => (
                  <li key={s.name} className={s.ok ? "cx-ok" : "cx-bad"}>
                    <span aria-hidden="true">{s.ok ? "✓" : "✗"}</span> <strong>{STEP_LABEL[s.name]}</strong>
                    <span className="muted small">
                      {" "}
                      {s.ok ? "bien" : "falló"}: {s.detail}
                    </span>
                  </li>
                ))}
              </ul>
              <p className={test.ok ? "cx-ok" : "cx-bad"}>
                {test.ok ? "La conexión funciona" : "La conexión no funciona"}
                {test.toolQuality ? ` · ${toolQualityText(test.toolQuality)}` : ""}
                {test.latencyMs != null ? ` · ${test.latencyMs} ms` : ""}
              </p>
              {!test.ok && <p className="muted small">{test.detail}</p>}
            </div>
          )}
        </div>
      )}

      {step === 3 && (
        <div className="cx-step">
          <div className="cx-field">
            <label htmlFor={`${uid}-q`}>Buscar modelo</label>
            <input id={`${uid}-q`} type="search" value={query} placeholder="escribe para filtrar" onChange={(e) => setQuery(e.target.value)} />
          </div>
          {models.length > 0 ? (
            <div className="cx-field">
              <label htmlFor={`${uid}-model`}>Modelo por defecto</label>
              <select id={`${uid}-model`} value={model} onChange={(e) => setModel(e.target.value)}>
                {options.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
              {q !== "" && shown.length === 0 && <p className="muted small">Ningún modelo coincide con «{query}».</p>}
            </div>
          ) : (
            <div className="cx-field">
              <label htmlFor={`${uid}-model`}>Modelo por defecto</label>
              <input id={`${uid}-model`} value={model} spellCheck={false} placeholder="nombre del modelo" onChange={(e) => setModel(e.target.value)} />
              <p className="muted small">{modelsLoaded ? "No se pudo listar los modelos: escribe el nombre a mano." : "Cargando modelos…"}</p>
            </div>
          )}
          <div className="cx-field">
            <label htmlFor={`${uid}-ctx`}>Ventana de contexto (tokens)</label>
            <input id={`${uid}-ctx`} type="number" min={512} step={512} value={ctx} onChange={(e) => setCtx(e.target.value)} />
            {preset === "ollama" && <p className="cx-warn small">{OLLAMA_CONTEXT_WARNING}</p>}
          </div>
        </div>
      )}

      {pendingHost && (
        <div className="cx-warn" role="alertdialog" aria-label="Confirmar nuevo servidor">
          <p>
            <strong>Tu clave se enviará a {pendingHost.host}.</strong> Antes se enviaba a {hostOf(initial?.baseUrl ?? "") ?? "otro servidor"}. Confírmalo solo si confías en ese servidor.
          </p>
          <div className="row">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                ackHost.current = pendingHost.host;
                const retry = pendingHost.retry;
                setPendingHost(null);
                void retry();
              }}
            >
              Sí, enviar la clave a {pendingHost.host}
            </button>
            <button type="button" className="btn" onClick={() => setPendingHost(null)}>
              No, revisar la URL
            </button>
          </div>
        </div>
      )}

      {error && (
        <p className="cx-bad" role="alert">
          {error}
        </p>
      )}

      <div className="row cx-actions">
        <button type="button" className="btn btn-ghost" disabled={busy || testing} onClick={() => void cancel()}>
          Cancelar
        </button>
        {step > 1 && !(initial && step === 2) && (
          <button type="button" className="btn" disabled={busy || testing} onClick={() => setStep((s) => (s === 3 ? 2 : 1))}>
            Atrás
          </button>
        )}
        {step < 3 ? (
          <button type="button" className="btn btn-primary" disabled={busy || testing} onClick={() => void next()}>
            Siguiente
          </button>
        ) : (
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void finish()}>
            {busy ? "Guardando…" : "Guardar conexión"}
          </button>
        )}
      </div>
    </section>
  );
}
