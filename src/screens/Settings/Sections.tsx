// Cuerpos de cada sección de Ajustes. Cada campo guarda con su propio `settings.set`.
import { open as pickFolder } from "@tauri-apps/plugin-dialog";
import { useEffect, useId, useState } from "react";
import UpdateDialog, { checkForUpdate, errText, type UpdateInfo } from "../../components/UpdateDialog";
import { useStore } from "../../store";
import { useSettings, useSetting } from "../../store/settings";
import { claudeProblem } from "../Wizard/claudeInstall";
import KeyField from "../Wizard/KeyField";
import { detectClis, tauriError, type CliInfo } from "../Wizard/tauri";
import "../Wizard/Wizard.css";
import Extensions from "./Extensions";
import SettingField, { FieldFrame, useSettingSave } from "./SettingField";

export type SectionProps = { onClose: () => void; onWizard?: () => void; onAbout?: () => void };

/** JSON de un ajuste; si está roto o no es del tipo esperado, `fallback`. */
export function parseJson<T>(raw: string | undefined, fallback: T, ok: (v: unknown) => v is T): T {
  try {
    const v: unknown = JSON.parse(raw ?? "");
    return ok(v) ? v : fallback;
  } catch {
    return fallback;
  }
}
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

export function General() {
  return (
    <>
      <SettingField k="user_name" label="Tu nombre" hint="Es el que sale en el saludo de la oficina. Vacío: «¡Hola!»." kind="text" placeholder="Tu nombre" />
      <SettingField
        k="start_view"
        label="Vista al abrir"
        kind="select"
        options={[
          { value: "home", label: "Home" },
          { value: "last", label: "Último workspace" },
        ]}
      />
    </>
  );
}

export function Trabajo() {
  const connections = useStore((s) => s.connections);
  const models = [
    { value: "sonnet", label: "Claude · sonnet" },
    { value: "opus", label: "Claude · opus" },
    { value: "haiku", label: "Claude · haiku" },
    ...connections.filter((c) => c.defaultModel).map((c) => ({ value: `conn:${c.id}/${c.defaultModel}`, label: `${c.name} · ${c.defaultModel}` })),
  ];
  return (
    <>
      <SettingField k="max_concurrent_runs" label="Robots a la vez" hint="Cuántos runs pueden estar en marcha a la vez (1–32)." kind="number" min={1} max={32} step={1} />
      <SettingField k="daily_budget_usd" label="Tope de gasto diario" kind="number" min={0.01} step="any" suffix="USD" />
      <SettingField k="default_budget_usd" label="Tope por tarea" kind="number" min={0.01} step="any" suffix="USD" />
      <SettingField k="default_model" label="Modelo por defecto de robots nuevos" kind="select" options={models} />
      <SettingField k="auto_relay_default" label="Relevo automático por defecto" hint="Si un robot nuevo cambia de IA solo cuando la suya llega al límite." kind="bool" />
      <SettingField k="test_timeout_min" label="Máximo de los tests al integrar" kind="number" min={1} max={120} step={1} suffix="min" />
    </>
  );
}

function ClaudeStatus({ refreshKey }: { refreshKey: number }) {
  const [info, setInfo] = useState<CliInfo | null | "loading">("loading");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setInfo("loading");
    detectClis()
      .then((l) => alive && (setInfo(l.find((c) => c.name === "claude") ?? null), setError(null)))
      .catch((e) => alive && (setInfo(null), setError(tauriError(e))));
    return () => {
      alive = false;
    };
  }, [refreshKey]);
  if (info === "loading") return <p className="st-hint">Buscando Claude Code…</p>;
  if (error) return <p className="st-hint">No se pudo detectar: {error}.</p>;
  if (!info || !info.found) return <p className="st-error">Claude Code no está instalado (o no se encuentra). Indica la ruta abajo o instálalo desde el asistente.</p>;
  const problem = claudeProblem(true, info.version);
  return (
    <p className={problem ? "st-error" : "st-ok"}>
      Claude Code {info.version ?? ""} · <code>{info.path}</code>
      {problem === "tooOld" && " · versión antigua: actualízalo con «claude update»."}
    </p>
  );
}

export function IAs({ onClose }: SectionProps) {
  const setConnectionsOpen = useStore((s) => s.setConnectionsOpen);
  const save = useSettings((s) => s.save);
  const [tick, setTick] = useState(0);
  const claudePath = useSetting("claude_path");
  return (
    <>
      <div className="st-field">
        <span className="st-label">Conexiones a otras IAs</span>
        <p className="st-hint">OpenAI, Gemini, LM Studio, OpenRouter… se gestionan en su propia pantalla.</p>
        <button
          type="button"
          className="st-btn"
          onClick={() => {
            onClose();
            setConnectionsOpen(true);
          }}
        >
          Ir a Conexiones
        </button>
      </div>
      <div className="st-field">
        <span className="st-label">Claude Code</span>
        <ClaudeStatus refreshKey={tick} />
      </div>
      <SettingField k="claude_path" label="Ruta manual de claude" hint="Vacío: se autodetecta." kind="text" placeholder="/usr/local/bin/claude" />
      <div className="st-field">
        <button
          type="button"
          className="st-btn"
          disabled={!claudePath}
          onClick={() => void save("claude_path", "").then(() => setTick((t) => t + 1))}
        >
          Autodetectar
        </button>
      </div>
      <div className="st-field st-key">
        <KeyField user="anthropic" label="Clave de Anthropic" hint="Se guarda en el llavero del sistema; aquí solo ves la máscara." />
      </div>
      <SettingField k="ollama_url" label="URL de Ollama" kind="text" placeholder="http://localhost:11434/v1" />
    </>
  );
}

function SkillRoots() {
  const id = useId();
  const raw = useSetting("extra_skill_roots");
  const roots = parseJson(raw, [] as string[], isStrings);
  const f = useSettingSave("extra_skill_roots");
  const [path, setPath] = useState("");
  const [pickError, setPickError] = useState<string | null>(null);
  const write = (list: string[]) => f.save(JSON.stringify(list));
  const add = async (p: string) => {
    const v = p.trim();
    if (!v || roots.includes(v)) return;
    if (await write([...roots, v])) setPath("");
  };
  const choose = async () => {
    setPickError(null);
    try {
      const p = await pickFolder({ directory: true, multiple: false, title: "Carpeta de skills de confianza" });
      if (typeof p === "string") await add(p);
    } catch {
      setPickError("El selector de carpetas solo está disponible en la app de escritorio; escribe la ruta.");
    }
  };
  return (
    <FieldFrame
      k="extra_skill_roots"
      label="Carpetas extra de confianza"
      hint="Solo se aceptan carpetas dentro de tu usuario. Sus skills se suman a las de ~/.claude/skills."
      error={f.error ?? pickError}
      saved={f.saved}
      busy={f.busy}
      onReset={() => void f.reset()}
      errorId={`${id}-err`}
    >
      <div className="st-stack">
        {roots.length === 0 && <p className="st-hint">Ninguna carpeta extra.</p>}
        <ul className="st-list" aria-label="Carpetas extra">
          {roots.map((r) => (
            <li key={r}>
              <code>{r}</code>
              <button type="button" className="st-btn" disabled={f.busy} aria-label={`Quitar ${r}`} onClick={() => void write(roots.filter((x) => x !== r))}>
                Quitar
              </button>
            </li>
          ))}
        </ul>
        <div className="st-controls">
          <input type="text" aria-label="Ruta de la carpeta" value={path} placeholder="/Users/tú/.agents/skills" spellCheck={false} onChange={(e) => setPath(e.target.value)} />
          <button type="button" className="st-btn st-btn-primary" disabled={f.busy || path.trim() === ""} onClick={() => void add(path)}>
            Añadir
          </button>
          <button type="button" className="st-btn" onClick={() => void choose()}>
            Elegir carpeta…
          </button>
        </div>
      </div>
    </FieldFrame>
  );
}

export function Skills() {
  return (
    <>
      <Extensions />
      <SkillRoots />
    </>
  );
}

export function Gerente({ onClose }: SectionProps) {
  return (
    <div className="st-field">
      <p>El gerente se configura por workspace, no aquí.</p>
      <p className="st-hint">Se configura por workspace en la pestaña del Jefe.</p>
      <button type="button" className="st-btn" onClick={onClose}>
        Ir a mis workspaces
      </button>
    </div>
  );
}

const LEVELS = [
  { id: "info", label: "Información" },
  { id: "warn", label: "Avisos" },
  { id: "ask", label: "Preguntas" },
];

function NotifyLevels() {
  const id = useId();
  const levels = parseJson(useSetting("notify_levels"), [] as string[], isStrings);
  const f = useSettingSave("notify_levels");
  const toggle = (lvl: string) => void f.save(JSON.stringify(LEVELS.map((l) => l.id).filter((x) => (x === lvl ? !levels.includes(x) : levels.includes(x)))));
  return (
    <FieldFrame k="notify_levels" label="Qué avisa" hint="Niveles que salen como notificación del sistema." error={f.error} saved={f.saved} busy={f.busy} onReset={() => void f.reset()} errorId={`${id}-err`}>
      {LEVELS.map((l) => (
        <label key={l.id} className="st-check">
          <input type="checkbox" checked={levels.includes(l.id)} disabled={f.busy} onChange={() => toggle(l.id)} />
          <span>{l.label}</span>
        </label>
      ))}
    </FieldFrame>
  );
}

type Quiet = { from: string; to: string };
const isQuiet = (v: unknown): v is Quiet => !!v && typeof v === "object" && typeof (v as Quiet).from === "string" && typeof (v as Quiet).to === "string";

function QuietHours() {
  const id = useId();
  const raw = useSetting("quiet_hours");
  const quiet = parseJson<Quiet | null>(raw, null, (v): v is Quiet | null => v === null || isQuiet(v));
  const f = useSettingSave("quiet_hours");
  const [on, setOn] = useState(quiet !== null);
  const [from, setFrom] = useState(quiet?.from ?? "22:00");
  const [to, setTo] = useState(quiet?.to ?? "08:00");
  useEffect(() => {
    setOn(quiet !== null);
    if (quiet) {
      setFrom(quiet.from);
      setTo(quiet.to);
    }
  }, [raw]); // eslint-disable-line react-hooks/exhaustive-deps
  const value = on ? JSON.stringify({ from, to }) : "";
  return (
    <FieldFrame k="quiet_hours" label="Horas de silencio" hint="Sin notificaciones del sistema entre estas horas." error={f.error} saved={f.saved} busy={f.busy} onReset={() => void f.reset()} errorId={`${id}-err`}>
      <label className="st-check">
        <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} />
        <span>Activar</span>
      </label>
      <label className="st-inline">
        De <input type="time" aria-label="Silencio desde" value={from} disabled={!on} onChange={(e) => setFrom(e.target.value)} />
      </label>
      <label className="st-inline">
        a <input type="time" aria-label="Silencio hasta" value={to} disabled={!on} onChange={(e) => setTo(e.target.value)} />
      </label>
      <button type="button" className="st-btn st-btn-primary" disabled={f.busy || value === (raw ?? "")} onClick={() => void f.save(value)} aria-label="Guardar horas de silencio">
        Guardar
      </button>
    </FieldFrame>
  );
}

export function Avisos() {
  return (
    <>
      <SettingField k="notify_system" label="Notificaciones del sistema" kind="bool" />
      <NotifyLevels />
      <QuietHours />
    </>
  );
}

export function Datos({ onWizard, onClose }: SectionProps) {
  return (
    <>
      <SettingField k="events_retention_days" label="Días de retención del registro" hint="0 = sin límite; si no, se borran los eventos de registro más antiguos." kind="number" min={0} step={1} suffix="días" />
      <div className="st-field">
        <span className="st-label">Ubicación de los datos</span>
        <p className="st-hint">Viven en la carpeta de datos de la aplicación de tu sistema. La app aún no puede mostrar la ruta exacta.</p>
      </div>
      <div className="st-field">
        <button
          type="button"
          className="st-btn"
          disabled={!onWizard}
          onClick={() => {
            onClose();
            onWizard?.();
          }}
        >
          Abrir el asistente de primera vez
        </button>
      </div>
    </>
  );
}

export function Actualizaciones() {
  const [checking, setChecking] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const check = async () => {
    setChecking(true);
    setMsg(null);
    try {
      const u = await checkForUpdate();
      if (u) setUpdate(u);
      else setMsg("Ya tienes la última versión.");
    } catch (e) {
      setMsg(tauriError(e) === errText(e) ? errText(e) : tauriError(e));
    } finally {
      setChecking(false);
    }
  };
  return (
    <>
      <SettingField k="update_auto_check" label="Comprobar automáticamente" hint="Al arrancar, como mucho una vez al día." kind="bool" />
      <div className="st-field">
        <button type="button" className="st-btn" disabled={checking} onClick={() => void check()}>
          {checking ? "Buscando…" : "Buscar actualizaciones"}
        </button>
        {msg && (
          <p className="st-hint" role="status">
            {msg}
          </p>
        )}
      </div>
      {update && <UpdateDialog update={update} onClose={() => setUpdate(null)} />}
    </>
  );
}

export function AcercaDe({ onAbout, onClose }: SectionProps) {
  return (
    <div className="st-field">
      <p className="st-hint">Versión, registro de cambios, licencia y datos.</p>
      <button
        type="button"
        className="st-btn"
        onClick={() => {
          onClose();
          onAbout?.();
        }}
      >
        Abrir «Acerca de»
      </button>
    </div>
  );
}
