// Convierte una entrada del registro (`events` del store) en una frase legible, o `null` si no aporta.
import type { LogEntry } from "../../store/events";
import { STATE_LABEL } from "./format";

type Parsed = { agentId?: string; taskId?: string; kind?: string; payload: Record<string, unknown> };

const str = (re: RegExp, text: string) => re.exec(text)?.[1];

/** El resumen del store es JSON recortado a 240 caracteres: si no se puede parsear entero, se rescatan los campos clave. */
function parse(summary: string): Parsed {
  try {
    const o = JSON.parse(summary) as Record<string, unknown>;
    if (o && typeof o === "object") {
      const payload = o.payload && typeof o.payload === "object" ? (o.payload as Record<string, unknown>) : o;
      return {
        agentId: o.agent_id == null ? undefined : String(o.agent_id),
        taskId: o.task_id == null ? undefined : String(o.task_id),
        kind: typeof o.kind === "string" ? o.kind : undefined,
        payload,
      };
    }
  } catch {
    /* recortado: se sigue con expresiones regulares */
  }
  const payload: Record<string, unknown> = {};
  for (const k of ["name", "status", "message", "type", "to", "from", "tool"]) {
    const v = str(new RegExp(`"${k}":"([^"]*)"`), summary);
    if (v !== undefined) payload[k] = v;
  }
  return {
    agentId: str(/"agent_id":"?([^",}]+)"?/, summary),
    taskId: str(/"task_id":"?([^",}]+)"?/, summary),
    kind: str(/"kind":"([^"]+)"/, summary),
    payload,
  };
}

const s = (v: unknown) => (typeof v === "string" ? v : "");
const cut = (t: string, n = 120) => (t.length > n ? `${t.slice(0, n)}…` : t);

/** Id del agente al que pertenece la entrada (para filtrar), si lo trae. */
export function entryAgentId(e: LogEntry): string | undefined {
  return parse(e.summary).agentId;
}

/** Frase en español para la entrada; `null` para el ruido (texto parcial, "pensando", métricas). */
export function describeEntry(e: LogEntry, taskTitle?: (id: string) => string | undefined): string | null {
  const p = parse(e.summary);
  const title = p.taskId ? taskTitle?.(p.taskId) : undefined;
  const task = title ? ` «${cut(title, 60)}»` : "";
  const pl = p.payload;

  if (e.name === "agent.status") return `Cambió de estado a «${s(pl.status)}»`;
  if (e.name === "task.changed") return null;
  if (e.name === "agent.changed") return "Se actualizó su perfil";
  if (e.name === "approval.requested") return `Pide permiso para usar ${s(pl.tool) || "una herramienta"}`;
  if (e.name !== "event.appended") return null;

  switch (p.kind) {
    case "tool": {
      const name = s(pl.name) || "una herramienta";
      return s(pl.status) === "end" ? `Terminó de usar ${name}` : `Usa ${name}`;
    }
    case "permission":
      return `Pide permiso para usar ${s(pl.tool) || "una herramienta"}`;
    case "status": {
      if (s(pl.type) === "done") return `Terminó su respuesta${task}`;
      if (s(pl.type) === "stopped") return `Se detuvo la tarea${task}`;
      if (s(pl.to)) {
        const to = STATE_LABEL[s(pl.to)] ?? s(pl.to);
        return `La tarea${task} pasó a «${to}»`;
      }
      return s(pl.reason) ? `Aviso: ${cut(s(pl.reason))}` : null;
    }
    case "limit":
      return `Llegó a un límite de uso${s(pl.message) ? `: ${cut(s(pl.message))}` : ""}`;
    case "error":
      return `Error: ${cut(s(pl.message) || "algo falló")}`;
    case "git":
      return s(pl.message) ? `Git: ${cut(s(pl.message))}` : "Actividad de git";
    case "test":
      return "Se ejecutaron las pruebas";
    default:
      return null;
  }
}
