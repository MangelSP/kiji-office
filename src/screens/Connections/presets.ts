// Presets de conexión (espejo de la tabla de core/src/orchestrator/connections.ts, PLAN-0.2b D17), textos de la
// calidad de herramientas y el LED. Los iconos son glifos neutros: ningún logo oficial.
import type { ConnectionAuth, ConnectionPreset, ConnectionView, ToolQuality } from "../../../shared/protocol";

export type PresetInfo = {
  id: ConnectionPreset;
  label: string;
  /** Glifo neutro del icono. */
  glyph: string;
  /** Color de fondo del icono. */
  hue: string;
  local: boolean;
  baseUrl: string;
  auth: ConnectionAuth;
  /** El usuario puede cambiar la autenticación (litellm y personalizada). */
  authEditable?: boolean;
  note: string;
};

export const PRESETS: PresetInfo[] = [
  { id: "ollama", label: "Ollama", glyph: "🦙", hue: "#4a7fc8", local: true, baseUrl: "http://localhost:11434/v1", auth: "none", note: "modelos en tu equipo" },
  { id: "lmstudio", label: "LM Studio", glyph: "🖥", hue: "#7a5cc8", local: true, baseUrl: "http://localhost:1234/v1", auth: "none", note: "modelos en tu equipo" },
  { id: "llamacpp", label: "llama.cpp", glyph: "⚙", hue: "#6b7280", local: true, baseUrl: "http://localhost:8080/v1", auth: "none", note: "servidor local" },
  { id: "vllm", label: "vLLM", glyph: "⚡", hue: "#c8a43c", local: true, baseUrl: "http://localhost:8000/v1", auth: "none", note: "servidor local" },
  { id: "openai", label: "OpenAI", glyph: "◎", hue: "#2f8f6f", local: false, baseUrl: "https://api.openai.com/v1", auth: "bearer", note: "nube, con clave" },
  { id: "groq", label: "Groq", glyph: "➤", hue: "#c8643c", local: false, baseUrl: "https://api.groq.com/openai/v1", auth: "bearer", note: "nube, con clave" },
  { id: "together", label: "Together", glyph: "∞", hue: "#3c8fc8", local: false, baseUrl: "https://api.together.xyz/v1", auth: "bearer", note: "nube, con clave" },
  { id: "deepseek", label: "DeepSeek", glyph: "🐋", hue: "#3c5fc8", local: false, baseUrl: "https://api.deepseek.com/v1", auth: "bearer", note: "nube, con clave" },
  { id: "mistral", label: "Mistral", glyph: "≋", hue: "#c87a3c", local: false, baseUrl: "https://api.mistral.ai/v1", auth: "bearer", note: "nube, con clave" },
  { id: "gemini", label: "Gemini", glyph: "✦", hue: "#5c8fe0", local: false, baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", auth: "bearer", note: "nube, con clave" },
  { id: "openrouter", label: "OpenRouter", glyph: "⇄", hue: "#8a5cc8", local: false, baseUrl: "https://openrouter.ai/api/v1", auth: "bearer", note: "muchos modelos, con clave" },
  { id: "litellm", label: "LiteLLM", glyph: "🚅", hue: "#4fa370", local: true, baseUrl: "http://localhost:4000/v1", auth: "bearer", authEditable: true, note: "pasarela propia" },
  { id: "custom", label: "Personalizada", glyph: "＋", hue: "#4a4f6d", local: false, baseUrl: "", auth: "bearer", authEditable: true, note: "cualquier URL compatible" },
];

export function presetInfo(id: ConnectionPreset): PresetInfo {
  return PRESETS.find((p) => p.id === id) ?? PRESETS[PRESETS.length - 1]!;
}

export const AUTH_LABEL: Record<ConnectionAuth, string> = {
  none: "Sin clave",
  bearer: "Clave (Authorization: Bearer)",
  "x-api-key": "Clave (cabecera x-api-key)",
};

/** Calidad de herramientas en palabras. */
export function toolQualityText(q: ToolQuality): string {
  switch (q) {
    case "ok":
      return "usa herramientas bien";
    case "weak":
      return "a medias: puede fallar al editar";
    case "none":
      return "solo responde consultas";
    default:
      return "herramientas sin probar";
  }
}

export type Led = "ok" | "warn" | "off";

/** Verde: probada y bien. Ámbar: a medias o sin probar. Gris: la última prueba falló. */
export function connectionLed(c: Pick<ConnectionView, "lastTestOk" | "toolQuality">): Led {
  if (c.lastTestOk === false) return "off";
  if (c.lastTestOk === true && c.toolQuality === "ok") return "ok";
  return "warn";
}

export const LED_TEXT: Record<Led, string> = { ok: "funciona", warn: "sin probar o a medias", off: "sin respuesta" };

export const OLLAMA_CONTEXT_WARNING = "Ollama usa 4096 por defecto; súbelo con OLLAMA_CONTEXT_LENGTH.";
