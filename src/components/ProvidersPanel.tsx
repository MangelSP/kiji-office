// Panel "IAs en vivo": una tarjeta por proveedor con su cupo, modelos y gasto de hoy;
// historial de relevos y "Cambiar IA ahora" para las tareas que corren.
import { useEffect, useState } from "react";
import type { ConnectionView, LimitWindow, ProviderStatus } from "../../shared/protocol";
import Led from "../screens/Connections/Led";
import { presetInfo } from "../screens/Connections/presets";
import "../screens/Connections/Connections.css";
import { useScoped } from "../store/scoped";
import type { Agent } from "../store/agents";
import { relayLine } from "../store/providers";
import type { Task } from "../store/tasks";
import { isBusy } from "./OfficeComposer";
import "./components.css";
import "./ProvidersPanel.css";

/** Cada cuánto se refrescan las cuentas atrás. */
export const COUNTDOWN_REFRESH_MS = 30_000;

export const STATE_LABEL: Record<ProviderStatus["state"], string> = {
  ok: "Disponible",
  warning: "Cerca del límite",
  limited: "Limitado",
  off: "Apagado",
  unknown: "Sin datos",
};

const WINDOW_LABEL: Record<LimitWindow["type"], string> = {
  five_hour: "5 horas",
  seven_day: "7 días",
  seven_day_opus: "7 días Opus",
  seven_day_sonnet: "7 días Sonnet",
  other: "Otro límite",
};
const WINDOW_ORDER: LimitWindow["type"][] = ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet", "other"];

export const SWITCH_MODELS = ["sonnet", "opus", "haiku"] as const;

export const windowLabel = (t: LimitWindow["type"]) => WINDOW_LABEL[t] ?? WINDOW_LABEL.other;

/** 0..1 -> entero 0..100; `null` si no se conoce. */
export function percent(utilization: number | null): number | null {
  if (utilization == null || !Number.isFinite(utilization)) return null;
  return Math.max(0, Math.min(100, Math.round(utilization * 100)));
}

/** "2 h 15 min", "3 d 4 h", "menos de 1 min" o "ya se renovó". */
export function formatCountdown(resetsAt: number, now: number): string {
  const ms = resetsAt - now;
  if (ms <= 0) return "ya se renovó";
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "menos de 1 min";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 === 0 ? `${h} h` : `${h} h ${min % 60} min`;
  const d = Math.floor(h / 24);
  return h % 24 === 0 ? `${d} d` : `${d} d ${h % 24} h`;
}

const usd = (n: number) => `$${n.toFixed(2)}`;

/** Se vuelve a renderizar cada `ms` con la hora actual (para las cuentas atrás). */
function useNow(ms = COUNTDOWN_REFRESH_MS): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

function WindowBar({ w, now }: { w: LimitWindow; now: number }) {
  const pct = percent(w.utilization);
  const rejected = w.status === "rejected";
  const level = rejected || (pct ?? 0) >= 90 ? "high" : w.status === "allowed_warning" || (pct ?? 0) >= 70 ? "mid" : "low";
  const label = windowLabel(w.type);
  return (
    <li className="win">
      <div className="win-top">
        <span>{label}</span>
        <span>
          {pct == null ? "—" : `${pct} %`}
          {rejected ? " · agotado" : ""}
        </span>
      </div>
      <div
        className="bar"
        role="progressbar"
        aria-label={`Uso de la ventana de ${label}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct ?? undefined}
      >
        <div className={`bar-fill bar-${level}`} style={{ width: `${pct ?? 0}%` }} />
      </div>
      {w.resetsAt != null && <div className="win-reset muted small">se renueva en {formatCountdown(w.resetsAt, now)}</div>}
    </li>
  );
}

function ProviderCard({ p, agents, now, conn }: { p: ProviderStatus; agents: Agent[]; now: number; conn?: ConnectionView }) {
  const windows = [...p.windows].sort((a, b) => WINDOW_ORDER.indexOf(a.type) - WINDOW_ORDER.indexOf(b.type));
  const agentName = (id: string) => agents.find((a) => String(a.id) === id)?.name ?? id;
  const today = p.models.reduce((sum, m) => sum + m.costTodayUsd, 0);
  const live = p.models.reduce((sum, m) => sum + m.liveRuns, 0);
  // Conexión local sin gasto: "gratis" (en vez de $0.00).
  const isConn = p.id.startsWith("conn:");
  const free = isConn && conn !== undefined && presetInfo(conn.preset).local;
  const money = (n: number) => (n === 0 && free ? "gratis" : usd(n));
  return (
    <li className="prov card" data-state={p.state} data-conn={isConn ? "" : undefined}>
      <div className="prov-head">
        {conn ? <Led conn={conn} /> : <span className={`light light-${p.state}`} aria-hidden="true" />}
        <strong>{p.label}</strong>
        <span className="tag">{p.configured ? STATE_LABEL[p.state] : "No configurado"}</span>
        <span className="prov-total muted small">
          {live > 0 ? `${live} ${live === 1 ? "run vivo" : "runs vivos"} · ` : ""}hoy {money(today)}
        </span>
      </div>

      {windows.length === 0 ? (
        <p className="muted small">sin datos de cupo</p>
      ) : (
        <ul className="plain wins">
          {windows.map((w) => (
            <WindowBar key={w.type} w={w} now={now} />
          ))}
        </ul>
      )}

      {p.models.length > 0 && (
        <ul className="plain models">
          {p.models.map((m) => (
            <li key={m.model}>
              <strong>{m.model}</strong>
              <span className="muted small">
                {" "}
                {m.agents.length > 0 ? m.agents.map(agentName).join(", ") : "sin agentes"}
                {m.liveRuns > 0 ? ` · ${m.liveRuns} ${m.liveRuns === 1 ? "run vivo" : "runs vivos"}` : ""}
                {` · hoy ${money(m.costTodayUsd)}`}
                {m.limitedUntil != null && m.limitedUntil > now ? ` · limitado ${formatCountdown(m.limitedUntil, now)}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

type TaskWithModel = Task & { model?: string };
type Choice = { kind: "model"; value: string } | { kind: "agent"; value: string };

const parseChoice = (raw: string): Choice | null => {
  const [kind, ...rest] = raw.split(":");
  const value = rest.join(":");
  return value && (kind === "model" || kind === "agent") ? { kind, value } : null;
};

function SwitchBlock() {
  const tasks = useScoped((s) => s.tasks);
  const agents = useScoped((s) => s.agents);
  const unavailable = useScoped((s) => s.unavailable["task.switch"]);
  const switchTask = useScoped((s) => s.switchTask);
  const setNotice = useScoped((s) => s.setNotice);
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const running = (tasks as TaskWithModel[]).filter((t) => t.status === "running" || t.status === "paused_limit");
  if (running.length === 0) return null;

  const nameOf = (id?: string | number | null) => agents.find((a) => String(a.id) === String(id))?.name;
  const choiceLabel = (c: Choice) => (c.kind === "model" ? c.value : (nameOf(c.value) ?? c.value));

  const confirm = async (t: TaskWithModel, c: Choice) => {
    setBusy(true);
    const ok = await switchTask(c.kind === "model" ? { taskId: String(t.id), model: c.value } : { taskId: String(t.id), agentId: c.value });
    setBusy(false);
    setConfirming(null);
    if (ok) {
      setPicked((p) => ({ ...p, [String(t.id)]: "" }));
      setNotice(`«${t.title}» ahora usa ${choiceLabel(c)}.`);
    }
  };

  return (
    <div className="switch">
      <h3>Cambiar IA ahora</h3>
      {unavailable && <p className="muted small">Aún no disponible: el core no implementa task.switch.</p>}
      <ul className="plain">
        {running.map((t) => {
          const id = String(t.id);
          const free = agents.filter((a) => !a.is_boss && String(a.id) !== String(t.agent_id) && !isBusy(a, tasks));
          const choice = parseChoice(picked[id] ?? "");
          return (
            <li key={id} className="card switch-task">
              <p className="card-title">{t.title}</p>
              <p className="muted small">
                {nameOf(t.agent_id) ?? "sin asignar"}
                {t.model ? ` · ${t.model}` : ""}
                {t.status === "paused_limit" ? " · pausada por límite" : ""}
              </p>
              <div className="row">
                <select
                  aria-label={`Cambiar la IA de «${t.title}»`}
                  value={picked[id] ?? ""}
                  onChange={(e) => {
                    setPicked((p) => ({ ...p, [id]: e.target.value }));
                    setConfirming(null);
                  }}
                >
                  <option value="">Elegir…</option>
                  <optgroup label="Otro modelo">
                    {SWITCH_MODELS.filter((m) => m !== t.model).map((m) => (
                      <option key={m} value={`model:${m}`}>
                        {m}
                      </option>
                    ))}
                  </optgroup>
                  {free.length > 0 && (
                    <optgroup label="Otro agente libre">
                      {free.map((a) => (
                        <option key={String(a.id)} value={`agent:${a.id}`}>
                          {a.name}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
                <button type="button" className="btn" disabled={!choice || busy} onClick={() => setConfirming(id)}>
                  Cambiar
                </button>
              </div>
              {confirming === id && choice && (
                <div className="confirm" role="alertdialog" aria-label="Confirmar el cambio">
                  <p>
                    ¿Pasar «{t.title}» a <strong>{choiceLabel(choice)}</strong>?{" "}
                    {choice.kind === "agent"
                      ? "Se creará un nuevo run con un resumen del trabajo hecho."
                      : "Continuará la misma conversación con otro modelo."}
                  </p>
                  <div className="row">
                    <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void confirm(t, choice)}>
                      Sí, cambiar
                    </button>
                    <button type="button" className="btn btn-ghost" onClick={() => setConfirming(null)}>
                      Cancelar
                    </button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default function ProvidersPanel() {
  const providers = useScoped((s) => s.providers);
  const relays = useScoped((s) => s.relays);
  const agents = useScoped((s) => s.agents);
  const unavailable = useScoped((s) => s.unavailable["providers.status"]);
  const connections = useScoped((s) => s.connections);
  const now = useNow();

  return (
    <section className="panel" aria-labelledby="prov-title">
      <h2 id="prov-title">IAs en vivo</h2>
      {providers.length === 0 ? (
        <p className="muted">
          {unavailable ? "Aún no disponible: el core no implementa providers.status." : "Sin datos de IAs todavía."}
        </p>
      ) : (
        <ul className="plain">
          {providers.map((p) => (
            <ProviderCard key={p.id} p={p} agents={agents} now={now} conn={connections.find((c) => `conn:${c.id}` === p.id)} />
          ))}
        </ul>
      )}

      <h3>Relevos</h3>
      {relays.length === 0 ? (
        <p className="muted small">Ningún relevo todavía.</p>
      ) : (
        <ul className="plain relays" aria-label="Historial de relevos">
          {relays.slice(0, 8).map((r) => (
            <li key={r.id} className="small">
              {relayLine(r, agents)}
            </li>
          ))}
        </ul>
      )}

      <SwitchBlock />
    </section>
  );
}
