// Opciones del formulario "Crear agente". Los roles, colores y modelos deben coincidir con la lista blanca
// de core/src/orchestrator/agents.ts (el core es quien manda; esto solo evita ofrecer valores que rechazaría).

export type ProviderOption = { id: string; label: string; enabled: boolean; note?: string };

export const PROVIDERS: ProviderOption[] = [
  { id: "claude", label: "Claude", enabled: true },
  { id: "openai", label: "OpenAI / Codex", enabled: false, note: "llega en 0.1 paso 15/16" },
  { id: "gemini", label: "Gemini", enabled: false, note: "llega en 0.1 paso 15/16" },
  { id: "ollama", label: "Ollama", enabled: false, note: "llega en 0.1 paso 15/16" },
];

export const CLAUDE_MODELS = [
  { id: "sonnet", label: "sonnet", note: "equilibrado: el de siempre" },
  { id: "opus", label: "opus", note: "el más capaz, más lento y caro" },
  { id: "haiku", label: "haiku", note: "rápido y barato" },
] as const;

/** Roles del kit (sin `jefe`: solo hay uno y se crea al abrir el proyecto). Los prompts completos llegan en el paso 12a. */
export const ROLES = [
  { id: "programador", label: "Programador", desc: "Escribe y modifica código en su propio worktree." },
  { id: "tester", label: "Tester", desc: "Escribe y ejecuta pruebas e informa de lo que falla." },
  { id: "explorador", label: "Explorador", desc: "Lee el proyecto y resume su estructura sin editar nada." },
  { id: "modelador-2d", label: "Modelador 2D", desc: "Genera sprites y arte pixel art para el juego." },
  { id: "documentador", label: "Documentador", desc: "Redacta y mantiene la documentación del proyecto." },
  { id: "revisor-critico", label: "Revisor crítico", desc: "Revisa los cambios buscando fallos y riesgos de seguridad." },
] as const;

/** Paletas que entiende la escena (`paletteFor`). `hex` es el color de la muestra. */
export const COLORS = [
  { id: "terracota", label: "Terracota", hex: "#c8643c" },
  { id: "azul", label: "Azul", hex: "#4a7fc8" },
  { id: "verde", label: "Verde", hex: "#4fa370" },
  { id: "crema", label: "Crema", hex: "#e6d5b0" },
] as const;

export const NAME_MAX = 24;

/** Valida el nombre; devuelve el mensaje de error o null si vale. `existing` = nombres ya usados en el proyecto. */
export function validateName(raw: string, existing: readonly string[]): string | null {
  const name = raw.trim();
  if (name === "") return "Ponle un nombre al robot.";
  if (name.length > NAME_MAX) return `El nombre admite como máximo ${NAME_MAX} caracteres.`;
  if (existing.some((n) => n.trim().toLowerCase() === name.toLowerCase())) {
    return `Ya hay un robot llamado "${name}" en este proyecto. Elige otro nombre.`;
  }
  return null;
}
