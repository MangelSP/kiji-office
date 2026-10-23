// Política del gerente: plantillas del deslizador, textos de cada categoría, candados fijos y elección del cerebro.
import type { AutonomyLevel, ConnectionView, ManagerLevels, ManagerPolicy, ManagerPreset } from "../../../shared/protocol";
import type { Agent } from "../../store/agents";

export const LEVEL_KEYS = ["plan", "assign", "start", "retry", "relay", "integrate", "spend"] as const;
export type LevelKey = (typeof LEVEL_KEYS)[number];

export const LEVEL_LABEL: Record<LevelKey, string> = {
  plan: "Planear un objetivo y crear tareas",
  assign: "Elegir qué robot hace cada tarea",
  start: "Arrancar tareas",
  retry: "Reintentar tareas con cambios pedidos o fallidas",
  relay: "Cambiar de IA si un robot se atasca",
  integrate: "Integrar a la rama principal",
  spend: "Seguir cuando el gasto del día supera el umbral",
};

export const AUTONOMY_LABEL: Record<AutonomyLevel, string> = { auto: "Auto", notify: "Avisa", ask: "Pregunta" };
export const AUTONOMY_ORDER: AutonomyLevel[] = ["auto", "notify", "ask"];

export const PRESET_ORDER: ManagerPreset[] = ["prudente", "equilibrado", "autonomo"];
export const PRESET_LABEL: Record<ManagerPreset, string> = { prudente: "Prudente", equilibrado: "Equilibrado", autonomo: "Autónomo" };
export const PRESET_HELP: Record<ManagerPreset, string> = {
  prudente: "Planea y te avisa; todo lo demás te lo pregunta.",
  equilibrado: "Planea, asigna, arranca y reintenta solo; te avisa de los cambios de IA y te pregunta antes de integrar o gastar de más.",
  autonomo: "Lo hace todo solo, salvo integrar y pasar del umbral de gasto, que te los pregunta.",
};

export const PRESETS: Record<ManagerPreset, ManagerLevels> = {
  prudente: { plan: "notify", assign: "ask", start: "ask", retry: "ask", relay: "ask", integrate: "ask", spend: "ask" },
  equilibrado: { plan: "auto", assign: "auto", start: "auto", retry: "auto", relay: "notify", integrate: "ask", spend: "ask" },
  autonomo: { plan: "auto", assign: "auto", start: "auto", retry: "auto", relay: "auto", integrate: "ask", spend: "ask" },
};

/** Plantilla cuyos niveles coinciden con `levels`, o null si es una configuración a mano. */
export function presetOf(levels: ManagerLevels): ManagerPreset | null {
  return PRESET_ORDER.find((p) => LEVEL_KEYS.every((k) => PRESETS[p][k] === levels[k])) ?? null;
}

/** Acciones con candado: no son configurables, siempre llegan a la persona. */
export const LOCKED_ACTIONS = [
  "Subir cambios a un remoto (git push)",
  "Borrar archivos fuera del espacio del robot",
  "Desplegar",
  "Pagar",
  "Instalar paquetes",
  "Tocar secretos o claves",
];

export function defaultPolicy(brainAgentId: string): ManagerPolicy {
  return {
    enabled: true,
    brain: { agentId: brainAgentId },
    levels: { ...PRESETS.equilibrado },
    spendAskUsd: 5,
    dayBudgetUsd: 15,
    maxTickMinutes: 5,
    maxTicksPerHour: 20,
    askTimeoutMinutes: 60,
  };
}

export type BrainInfo = { label: string; ok: boolean; note: string };

/** IA de un agente como cerebro: Claude o una conexión con `toolQuality` 'ok' son recomendables; el resto, con aviso. */
export function brainInfo(agent: Agent, connections: ConnectionView[]): BrainInfo {
  if (agent.connection_id) {
    const c = connections.find((x) => x.id === agent.connection_id);
    if (!c) return { label: "Conexión desconocida", ok: false, note: "No encuentro su conexión; no la recomiendo para decidir." };
    const model = agent.model ? ` · ${agent.model.replace(/^conn:[^/]+\//, "")}` : "";
    const label = `${c.name}${model}`;
    if (c.toolQuality === "ok") return { label, ok: true, note: "Maneja bien las herramientas." };
    const why: Record<string, string> = {
      weak: "usa herramientas con fallos",
      none: "no sabe usar herramientas",
      unknown: "aún no se ha probado con herramientas",
    };
    return { label, ok: false, note: `Poco recomendable: ${why[c.toolQuality] ?? "no se sabe si maneja herramientas"}. Prueba la conexión antes.` };
  }
  const provider = agent.provider ?? "claude";
  if (provider === "claude") return { label: `Claude${agent.model ? ` · ${agent.model}` : ""}`, ok: true, note: "Recomendado." };
  return { label: `${provider}${agent.model ? ` · ${agent.model}` : ""}`, ok: false, note: "Poco recomendable: no está probado para decidir con herramientas." };
}

/** Cerebro por defecto: el jefe si es recomendable; si no, el primer agente recomendable; si no, el jefe. */
export function pickBrain(agents: Agent[], connections: ConnectionView[]): string {
  const boss = agents.find((a) => a.is_boss === true || a.is_boss === 1);
  if (boss && brainInfo(boss, connections).ok) return String(boss.id);
  const ok = agents.find((a) => brainInfo(a, connections).ok);
  return String((ok ?? boss ?? agents[0])?.id ?? "");
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Mensajes de error de los límites (vacío = válido). */
export function validateLimits(p: ManagerPolicy): string[] {
  const out: string[] = [];
  if (!(p.spendAskUsd >= 0)) out.push("El gasto para preguntar no puede ser negativo.");
  if (!(p.dayBudgetUsd > 0)) out.push("El tope del día tiene que ser mayor que 0.");
  if (p.dayBudgetUsd > 0 && p.spendAskUsd > p.dayBudgetUsd) out.push("El gasto para preguntar no puede superar el tope del día.");
  if (!(p.askTimeoutMinutes >= 1)) out.push("Los minutos para dar una pregunta por NO tienen que ser al menos 1.");
  if (p.quietHours && !(HHMM.test(p.quietHours.from) && HHMM.test(p.quietHours.to))) out.push("Las horas de silencio tienen que ser HH:MM.");
  return out;
}
