// Home · «Modelos más usados»: `stats.models` por rango, con barra proporcional a las tareas (runs).
import { useEffect, useState } from "react";
import type { ModelUsage, StatsRange } from "../../../shared/protocol";
import { useStore } from "../../store";
import { modelLabel } from "../../store/modelLabel";
import { fetchModelUsage } from "../../store/settings";
import { fmtTokens, fmtUsd } from "../Agents/format";
import "./HomeAis.css";

export const RANGES: { id: StatsRange; label: string }[] = [
  { id: "today", label: "Hoy" },
  { id: "7d", label: "7 días" },
  { id: "30d", label: "30 días" },
  { id: "all", label: "Siempre" },
];

type View = { kind: "loading" } | { kind: "ok"; models: ModelUsage[] } | { kind: "error"; reason: string };

export default function ModelsUsed() {
  const [range, setRange] = useState<StatsRange>("7d");
  const [view, setView] = useState<View>({ kind: "loading" });
  const connections = useStore((s) => s.connections);
  const providers = useStore((s) => s.providers);

  useEffect(() => {
    let alive = true;
    setView({ kind: "loading" });
    void fetchModelUsage(range).then((r) => alive && setView(r.ok ? { kind: "ok", models: r.models } : { kind: "error", reason: r.reason }));
    return () => {
      alive = false;
    };
  }, [range]);

  const providerName = (id: string) =>
    id === "claude" ? "Claude" : (connections.find((c) => c.id === id)?.name ?? providers.find((p) => p.id === `conn:${id}`)?.label ?? id);
  const models = view.kind === "ok" ? view.models : [];
  const maxRuns = Math.max(1, ...models.map((m) => m.runs));

  return (
    <section aria-labelledby="hm-models-title">
      <div className="ai-models-head">
        <h2 id="hm-models-title" className="hm-section">
          Modelos más usados
        </h2>
        <div className="ai-ranges" role="group" aria-label="Rango de tiempo">
          {RANGES.map((r) => (
            <button key={r.id} type="button" className="ai-range" aria-pressed={range === r.id} onClick={() => setRange(r.id)}>
              {r.label}
            </button>
          ))}
        </div>
      </div>
      {view.kind === "loading" && <p className="hm-muted ai-empty">Cargando…</p>}
      {view.kind === "error" && <p className="hm-muted ai-empty">{view.reason}</p>}
      {view.kind === "ok" && models.length === 0 && (
        <p className="hm-muted ai-empty">Aún no hay uso de modelos en este periodo. Cuando tus robots trabajen, verás aquí cuáles usan más.</p>
      )}
      {models.length > 0 && (
        <table className="ai-table">
          <thead>
            <tr>
              <th>Modelo</th>
              <th>Proveedor</th>
              <th className="ai-num">Tareas</th>
              <th className="ai-num">Entrada</th>
              <th className="ai-num">Salida</th>
              <th className="ai-num">Coste</th>
              <th>Robots</th>
            </tr>
          </thead>
          <tbody>
            {models.map((m) => (
              <tr key={`${m.provider}/${m.model}`}>
                <td className="ai-model">
                  <span className="ai-model-name" title={m.model}>
                    {modelLabel(m.model, connections)}
                  </span>
                  <span
                    className="ai-bar"
                    role="progressbar"
                    aria-label={`Tareas de ${modelLabel(m.model, connections)}`}
                    aria-valuemin={0}
                    aria-valuemax={maxRuns}
                    aria-valuenow={m.runs}
                  >
                    <span style={{ width: `${Math.round((m.runs / maxRuns) * 100)}%` }} />
                  </span>
                </td>
                <td>{providerName(m.provider)}</td>
                <td className="ai-num">{m.runs}</td>
                <td className="ai-num">{fmtTokens(m.input)}</td>
                <td className="ai-num">{fmtTokens(m.output)}</td>
                <td className="ai-num">{fmtUsd(m.costUsd)}</td>
                <td className="ai-robots">{m.agents.length > 0 ? m.agents.join(", ") : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
