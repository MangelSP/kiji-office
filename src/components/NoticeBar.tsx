// Avisos globales bajo la barra de pestañas: errores/avisos del core y el aviso de tope de gasto diario.
import { useStore } from "../store";
import "./NoticeBar.css";

export default function NoticeBar() {
  const notice = useStore((s) => s.notice);
  const budget = useStore((s) => s.budgetNotice);
  const setNotice = useStore((s) => s.setNotice);
  const setBudgetNotice = useStore((s) => s.setBudgetNotice);
  const setActive = useStore((s) => s.setActiveProject);
  if (!notice && !budget) return null;
  return (
    <div className="nb-wrap">
      {budget && (
        <div className="nb nb-budget" role="alert">
          <span>
            ⚡ {budget.message} (hoy ${budget.costTodayUsd.toFixed(2)} de ${budget.dailyBudgetUsd.toFixed(2)})
          </span>
          <button type="button" className="nb-btn" onClick={() => setActive(null)}>
            Ver topes
          </button>
          <button type="button" className="nb-btn" onClick={() => setBudgetNotice(null)}>
            Cerrar
          </button>
        </div>
      )}
      {notice && (
        <div className="nb" role="status">
          <span>{notice}</span>
          <button type="button" className="nb-btn" onClick={() => setNotice(null)}>
            Cerrar
          </button>
        </div>
      )}
    </div>
  );
}
