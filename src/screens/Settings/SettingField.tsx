// Campo de un ajuste: etiqueta, control, error de validación del core junto al campo y «Restablecer» al defecto.
// Cada campo se guarda solo, con su propio `settings.set`.
import { useEffect, useId, useState, type ReactNode } from "react";
import type { SettingKey } from "../../../shared/protocol";
import { settingValue, useSettings } from "../../store/settings";

/** Guardar/restablecer un ajuste con su estado (error, ocupado, «Guardado»). */
export function useSettingSave(k: SettingKey) {
  const save = useSettings((s) => s.save);
  const reset = useSettings((s) => s.reset);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const run = async (p: Promise<string | null>) => {
    setBusy(true);
    setSaved(false);
    const err = await p;
    setBusy(false);
    setError(err);
    setSaved(err === null);
    return err === null;
  };
  return {
    error,
    busy,
    saved,
    save: (value: string) => run(save(k, value)),
    reset: () => run(reset(k)),
    clearError: () => setError(null),
  };
}

type FrameProps = {
  k: SettingKey;
  label: string;
  hint?: string;
  htmlFor?: string;
  error: string | null;
  saved?: boolean;
  busy?: boolean;
  onReset: () => void;
  children: ReactNode;
  errorId: string;
};

export function FieldFrame({ k, label, hint, htmlFor, error, saved, busy, onReset, children, errorId }: FrameProps) {
  const spec = useSettings((s) => s.specs[k]);
  const current = settingValue({ [k]: spec }, k);
  const isDefault = !spec || current === spec.default;
  return (
    <div className="st-field" data-setting={k}>
      <div className="st-field-head">
        {htmlFor ? <label htmlFor={htmlFor}>{label}</label> : <span className="st-label">{label}</span>}
        <button type="button" className="st-reset" disabled={busy || isDefault} onClick={onReset} aria-label={`Restablecer ${label}`}>
          Restablecer
        </button>
      </div>
      {hint && <p className="st-hint">{hint}</p>}
      {!spec && <p className="st-hint">El core no conoce este ajuste todavía.</p>}
      <div className="st-controls">{children}</div>
      {error && (
        <p className="st-error" id={errorId} role="alert">
          {error}
        </p>
      )}
      {saved && !error && (
        <p className="st-saved" role="status">
          Guardado
        </p>
      )}
    </div>
  );
}

type Option = { value: string; label: string };
type Props = {
  k: SettingKey;
  label: string;
  hint?: string;
  kind: "text" | "number" | "select" | "bool";
  options?: Option[];
  min?: number;
  max?: number;
  step?: number | "any";
  placeholder?: string;
  suffix?: string;
};

export default function SettingField({ k, label, hint, kind, options, min, max, step, placeholder, suffix }: Props) {
  const id = useId();
  const spec = useSettings((s) => s.specs[k]);
  const current = spec ? (spec.value ?? spec.default) : "";
  const [draft, setDraft] = useState(current);
  const f = useSettingSave(k);
  // Cambios que llegan de fuera (settings.changed, restablecer) se reflejan en el campo.
  useEffect(() => setDraft(current), [current]);
  const errorId = `${id}-err`;
  const disabled = !spec || f.busy;

  let control: ReactNode;
  if (kind === "bool") {
    control = (
      <label className="st-check">
        <input
          id={id}
          type="checkbox"
          checked={current === "1"}
          disabled={disabled}
          aria-describedby={f.error ? errorId : undefined}
          onChange={(e) => void f.save(e.target.checked ? "1" : "0")}
        />
        <span>{current === "1" ? "Sí" : "No"}</span>
      </label>
    );
  } else if (kind === "select") {
    const opts = options ?? [];
    const all = opts.some((o) => o.value === current) || current === "" ? opts : [...opts, { value: current, label: current }];
    control = (
      <select id={id} value={current} disabled={disabled} aria-invalid={!!f.error} aria-describedby={f.error ? errorId : undefined} onChange={(e) => void f.save(e.target.value)}>
        {all.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  } else {
    control = (
      <>
        <input
          id={id}
          type={kind === "number" ? "number" : "text"}
          value={draft}
          min={min}
          max={max}
          step={step}
          placeholder={placeholder}
          disabled={disabled}
          aria-invalid={!!f.error}
          aria-describedby={f.error ? errorId : undefined}
          spellCheck={false}
          onChange={(e) => {
            setDraft(e.target.value);
            f.clearError();
          }}
          onKeyDown={(e) => e.key === "Enter" && draft !== current && void f.save(draft)}
        />
        {suffix && <span className="st-suffix">{suffix}</span>}
        <button type="button" className="st-btn st-btn-primary" disabled={disabled || draft === current} onClick={() => void f.save(draft)} aria-label={`Guardar ${label}`}>
          Guardar
        </button>
      </>
    );
  }

  return (
    <FieldFrame k={k} label={label} hint={hint} htmlFor={id} error={f.error} saved={f.saved} busy={f.busy} onReset={() => void f.reset()} errorId={errorId}>
      {control}
    </FieldFrame>
  );
}
