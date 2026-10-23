// Subpestaña "Memoria" del jefe: lo que el gerente recuerda del proyecto, con buscador, alta a mano y archivado.
import { useEffect, useState } from "react";
import type { MemoryKind } from "../../../shared/protocol";
import { useStore } from "../../store";
import { NO_MEMORY } from "../../store/manager";
import "./Manager.css";

export const KIND_ORDER: MemoryKind[] = ["fact", "decision", "preference", "todo"];
export const KIND_LABEL: Record<MemoryKind, string> = { fact: "Hecho", decision: "Decisión", preference: "Preferencia", todo: "Pendiente" };
const KIND_GROUP: Record<MemoryKind, string> = { fact: "Hechos", decision: "Decisiones", preference: "Preferencias", todo: "Pendientes" };

export default function MemoryPanel({ projectId }: { projectId: string }) {
  const rows = useStore((s) => s.memory[projectId] ?? NO_MEMORY);
  const unavailable = useStore((s) => s.unavailable["memory.list"]);
  const refresh = useStore((s) => s.refreshMemory);
  const add = useStore((s) => s.addMemory);
  const archive = useStore((s) => s.archiveMemory);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<MemoryKind>("fact");
  const [text, setText] = useState("");

  // Busca al escribir (con una pausa corta para no pedir en cada tecla).
  useEffect(() => {
    const t = setTimeout(() => void refresh(projectId, query), query === "" ? 0 : 250);
    return () => clearTimeout(t);
  }, [projectId, query, refresh]);

  if (unavailable) return <p className="muted">Aún no disponible: el core no implementa la memoria.</p>;

  const submit = async () => {
    const value = text.trim();
    if (!value) return;
    if (await add(projectId, kind, value)) setText("");
  };

  return (
    <div className="mg">
      <input
        type="search"
        className="mg-search"
        aria-label="Buscar en la memoria"
        placeholder="Buscar en la memoria…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      {rows.length === 0 ? (
        <p className="muted">{query ? "No hay nada que coincida." : "El gerente aún no ha guardado nada."}</p>
      ) : (
        KIND_ORDER.map((k) => {
          const group = rows.filter((r) => r.kind === k);
          if (group.length === 0) return null;
          return (
            <section key={k} aria-label={KIND_GROUP[k]}>
              <h4 className="ag-sec">
                {KIND_GROUP[k]} ({group.length})
              </h4>
              <ul className="plain">
                {group.map((r) => (
                  <li key={r.id} className="card mg-mem">
                    <span>
                      {r.text} <span className="tag muted">{r.source === "user" ? "tú" : "gerente"}</span>
                    </span>
                    <button type="button" className="btn" aria-label={`Archivar: ${r.text}`} onClick={() => void archive(projectId, r.id)}>
                      Archivar
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          );
        })
      )}

      <form
        className="mg-add"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <select aria-label="Tipo de nota" value={kind} onChange={(e) => setKind(e.target.value as MemoryKind)}>
          {KIND_ORDER.map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </select>
        <input aria-label="Nueva nota" placeholder="Algo que el gerente debe recordar…" value={text} onChange={(e) => setText(e.target.value)} />
        <button type="submit" className="btn btn-primary" disabled={text.trim() === ""}>
          Añadir
        </button>
      </form>
    </div>
  );
}
