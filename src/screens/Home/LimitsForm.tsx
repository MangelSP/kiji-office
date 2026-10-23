// Edita los topes globales: máximo de runs simultáneos y tope de gasto diario (settings del core).
import { useId, useState, type FormEvent } from "react";
import type { WorkspaceTotals } from "../../../shared/protocol";
import { useStore } from "../../store";

export default function LimitsForm({ totals, onDone }: { totals: WorkspaceTotals; onDone: () => void }) {
  const call = useStore((s) => s.callSafe);
  const refresh = useStore((s) => s.refreshWorkspaces);
  const uid = useId();
  const [runs, setRuns] = useState(String(totals.maxConcurrentRuns));
  const [budget, setBudget] = useState(String(totals.dailyBudgetUsd));
  const [busy, setBusy] = useState(false);

  const runsN = Number(runs);
  const budgetN = Number(budget);
  const valid = Number.isInteger(runsN) && runsN >= 1 && runsN <= 32 && Number.isFinite(budgetN) && budgetN > 0;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    const a = await call("settings.set", { key: "max_concurrent_runs", value: String(runsN) });
    const b = a === undefined ? undefined : await call("settings.set", { key: "daily_budget_usd", value: String(budgetN) });
    setBusy(false);
    if (b === undefined) return; // el aviso del error ya está puesto
    await refresh();
    onDone();
  };

  return (
    <form className="hm-limits" onSubmit={(e) => void save(e)} aria-label="Editar topes">
      <label htmlFor={`${uid}-runs`}>Máximo de runs simultáneos (1–32)</label>
      <input id={`${uid}-runs`} type="number" min={1} max={32} step={1} value={runs} onChange={(e) => setRuns(e.target.value)} />
      <label htmlFor={`${uid}-budget`}>Tope de gasto diario (USD)</label>
      <input id={`${uid}-budget`} type="number" min={0.01} step="any" value={budget} onChange={(e) => setBudget(e.target.value)} />
      <button type="submit" className="hm-btn hm-btn-primary" disabled={!valid || busy}>
        {busy ? "Guardando…" : "Guardar"}
      </button>
      <button type="button" className="hm-btn" onClick={onDone}>
        Cancelar
      </button>
    </form>
  );
}
