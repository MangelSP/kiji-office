// Subpestaña "Registro": eventos del agente en frases legibles, los más nuevos arriba.
import { useMemo } from "react";
import type { Agent } from "../../store/agents";
import { describeEntry, entryAgentId } from "./eventText";
import { useAgentsStore } from "./useAgentsStore";

const MAX_SHOWN = 200;

export default function AgentLog({ agent }: { agent: Agent }) {
  const events = useAgentsStore((s) => s.events);
  const tasks = useAgentsStore((s) => s.tasks);
  const lines = useMemo(() => {
    const title = (id: string) => tasks.find((t) => String(t.id) === id)?.title;
    const out: { seq: number; at: number; text: string }[] = [];
    for (let i = events.length - 1; i >= 0 && out.length < MAX_SHOWN; i--) {
      const e = events[i];
      if (entryAgentId(e) !== String(agent.id)) continue;
      const text = describeEntry(e, title);
      if (text) out.push({ seq: e.seq, at: e.at, text });
    }
    return out;
  }, [events, tasks, agent.id]);

  if (lines.length === 0) return <p className="muted">Sin actividad de {agent.name} todavía.</p>;
  return (
    <ul className="plain ag-log" aria-label={`Registro de ${agent.name}`}>
      {lines.map((l) => (
        <li key={l.seq}>
          <time className="muted" dateTime={new Date(l.at).toISOString()}>
            {new Date(l.at).toLocaleTimeString("es")}
          </time>{" "}
          {l.text}
        </li>
      ))}
    </ul>
  );
}
