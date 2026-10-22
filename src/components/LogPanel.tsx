import { useStore } from "../store";
import "./components.css";

// Registro en vivo de lo que emite el core (el más nuevo arriba).
export default function LogPanel() {
  const events = useStore((s) => s.events);
  const clearEvents = useStore((s) => s.clearEvents);
  const reversed = [...events].reverse();
  return (
    <section className="panel" aria-labelledby="log-title">
      <div className="panel-head">
        <h2 id="log-title">Registro en vivo</h2>
        <button type="button" className="btn btn-ghost" onClick={clearEvents} disabled={events.length === 0}>
          Limpiar
        </button>
      </div>
      {reversed.length === 0 ? (
        <p className="muted">Sin eventos todavía.</p>
      ) : (
        <ul className="log" aria-live="off">
          {reversed.map((e) => (
            <li key={e.seq}>
              <time dateTime={new Date(e.at).toISOString()}>{new Date(e.at).toLocaleTimeString("es")}</time>{" "}
              <strong>{e.name}</strong> <span className="muted">{e.summary}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
