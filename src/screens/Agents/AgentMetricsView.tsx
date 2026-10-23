// Subpestaña "Métricas": modelo, tokens, contexto, coste y runs recientes, en vivo con `liveRuns`.
import type { AgentMetrics, RunMetrics } from "../../store/metrics";
import type { Agent } from "../../store/agents";
import { contextSegments, fmtTokens, fmtUsd, pct } from "./format";
import { useAgentsStore } from "./useAgentsStore";

export function ContextBar({ used, total, label = "Contexto" }: { used: number; total: number; label?: string }) {
  const p = pct(used, total);
  const { level } = contextSegments(used, total);
  return (
    <div className="ag-ctx">
      <div
        className={`ag-ctx-bar is-${level}`}
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={p}
        aria-valuetext={`${p} % (${fmtTokens(used)} de ${fmtTokens(total)})`}
      >
        <span style={{ width: `${p}%` }} />
      </div>
      <span className="muted small">
        {fmtTokens(used)} / {fmtTokens(total)} · {p} %
      </span>
    </div>
  );
}

/** Métricas del agente con el run vivo (si lo hay) por encima de lo que dijo el último `agent.metrics`. */
export function useAgentMetrics(agentId: string): { metrics?: AgentMetrics; runs: RunMetrics[] } {
  const metrics = useAgentsStore((s) => s.metricsByAgent[agentId]);
  const liveRuns = useAgentsStore((s) => s.liveRuns);
  const live = Object.values(liveRuns).filter((r) => String(r.agentId) === agentId);
  const recent = (metrics?.recent ?? []).map((r) => liveRuns[r.runId] ?? r);
  const extra = live.filter((r) => !recent.some((x) => x.runId === r.runId));
  return { metrics, runs: [...extra, ...recent] };
}

export default function AgentMetricsView({ agent }: { agent: Agent }) {
  const id = String(agent.id);
  const { metrics, runs } = useAgentMetrics(id);
  const unavailable = useAgentsStore((s) => s.unavailable["agent.metrics"]);

  if (!metrics) {
    return (
      <p className="muted">
        {unavailable ? "Aún no disponible: el core no implementa agent.metrics." : "Sin métricas todavía."}
      </p>
    );
  }
  const liveNow = runs.find((r) => r.live);
  const model = liveNow?.model ?? metrics.model ?? agent.current_model ?? agent.model;
  return (
    <div className="ag-metrics">
      <dl className="ag-kv">
        <div>
          <dt>Modelo en uso</dt>
          <dd>
            <span className="ag-chip">{model ?? "—"}</span> {liveNow && <span className="muted small">en vivo</span>}
          </dd>
        </div>
        <div>
          <dt>Coste total</dt>
          <dd>{fmtUsd(metrics.costUsd)}</dd>
        </div>
        <div>
          <dt>Runs</dt>
          <dd>{metrics.runs}</dd>
        </div>
        <div>
          <dt>Entrada</dt>
          <dd>{fmtTokens(metrics.input)}</dd>
        </div>
        <div>
          <dt>Salida</dt>
          <dd>{fmtTokens(metrics.output)}</dd>
        </div>
        <div>
          <dt>Caché leída</dt>
          <dd>{fmtTokens(metrics.cacheRead)}</dd>
        </div>
        <div>
          <dt>Caché escrita</dt>
          <dd>{fmtTokens(metrics.cacheWrite)}</dd>
        </div>
      </dl>

      <h4 className="ag-sec">Contexto usado</h4>
      <ContextBar
        used={liveNow?.contextTokens ?? metrics.lastContextTokens}
        total={liveNow?.contextWindow ?? metrics.lastContextWindow}
      />

      <h4 className="ag-sec">Runs recientes</h4>
      {runs.length === 0 ? (
        <p className="muted small">Todavía no hay runs.</p>
      ) : (
        <div className="ag-table-wrap">
          <table className="ag-table">
            <thead>
              <tr>
                <th scope="col">Run</th>
                <th scope="col">Modelo</th>
                <th scope="col">Entrada</th>
                <th scope="col">Salida</th>
                <th scope="col">Caché</th>
                <th scope="col">Contexto</th>
                <th scope="col">Coste</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.runId} className={r.live ? "is-live" : undefined}>
                  <th scope="row">
                    {r.runId.slice(0, 6)}
                    {r.live && <span className="ag-live"> en vivo</span>}
                  </th>
                  <td>{r.model}</td>
                  <td>{fmtTokens(r.input)}</td>
                  <td>{fmtTokens(r.output)}</td>
                  <td>{fmtTokens(r.cacheRead + r.cacheWrite)}</td>
                  <td>{pct(r.contextTokens, r.contextWindow)} %</td>
                  <td>{fmtUsd(r.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
