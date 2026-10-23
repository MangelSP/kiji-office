// Home · «Tus IAs»: una tarjeta por proveedor (Claude y cada conexión) con estado, cupo, robots y gasto de hoy.
import type { ProviderStatus } from "../../../shared/protocol";
import { STATE_LABEL, percent, windowLabel } from "../../components/ProvidersPanel";
import { useStore } from "../../store";
import { fmtUsd } from "../Agents/format";
import "./HomeAis.css";

const LED: Record<ProviderStatus["state"], string> = { ok: "ok", warning: "warn", limited: "bad", off: "off", unknown: "off" };

function QuotaBar({ type, utilization }: { type: string; utilization: number | null }) {
  const p = percent(utilization);
  if (p === null) return null;
  const level = p >= 100 ? "high" : p >= 80 ? "warn" : "ok";
  return (
    <div className="ai-quota">
      <span className="ai-quota-label">{type}</span>
      <div className={`hm-meter is-${level}`} role="progressbar" aria-label={`Cupo ${type}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={p}>
        <span style={{ width: `${p}%` }} />
      </div>
      <span className="ai-quota-pct">{p}%</span>
    </div>
  );
}

export function robotsOf(p: ProviderStatus): number {
  return new Set(p.models.flatMap((m) => m.agents)).size;
}

export default function YourAIs() {
  const providers = useStore((s) => s.providers);
  const setConnectionsOpen = useStore((s) => s.setConnectionsOpen);
  const list = providers.filter((p) => p.id === "claude" || p.id.startsWith("conn:"));

  return (
    <section aria-labelledby="hm-ais-title">
      <h2 id="hm-ais-title" className="hm-section">
        Tus IAs
      </h2>
      {list.length === 0 ? (
        <p className="hm-muted ai-empty">Todavía no hay datos de tus IAs. Cuando el core las detecte aparecerán aquí.</p>
      ) : (
        <ul className="ai-grid">
          {list.map((p) => {
            const robots = robotsOf(p);
            const cost = p.models.reduce((n, m) => n + m.costTodayUsd, 0);
            const five = p.windows.find((w) => w.type === "five_hour");
            const seven = p.windows.find((w) => w.type === "seven_day");
            return (
              <li key={p.id} className="ai-card" aria-label={p.label}>
                <div className="ai-head">
                  <span className={`ai-led ai-led-${LED[p.state]}`} role="img" aria-label={STATE_LABEL[p.state]} title={STATE_LABEL[p.state]} />
                  <h3>{p.label}</h3>
                  <span className="ai-state">{STATE_LABEL[p.state]}</span>
                </div>
                {(five || seven) && (
                  <div className="ai-quotas">
                    {five && <QuotaBar type={windowLabel("five_hour")} utilization={five.utilization} />}
                    {seven && <QuotaBar type={windowLabel("seven_day")} utilization={seven.utilization} />}
                  </div>
                )}
                <p className="ai-meta">
                  <span>{robots === 1 ? "1 robot" : `${robots} robots`}</span>
                  <span>Hoy {fmtUsd(cost)}</span>
                </p>
                <button type="button" className="hm-btn" aria-label={`Gestionar ${p.label}`} onClick={() => setConnectionsOpen(true)}>
                  Gestionar
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
