// Comandos de Tauri que usa el asistente. Fuera de la app de escritorio (navegador) `invoke` falla: quien llama lo captura.
// OJO: `secretSet` es el único sitio por el que pasa el valor de una clave; nunca se registra ni se devuelve.
import { invoke } from "@tauri-apps/api/core";

export type CliInfo = { name: string; found: boolean; path?: string | null; version?: string | null };
export type SecretUser = "anthropic" | "openai" | "gemini";

export const detectClis = () => invoke<CliInfo[]>("detect_clis");
export const secretSet = (user: SecretUser, value: string) => invoke<void>("secret_set", { user, value });
/** Solo devuelve la clave enmascarada ("…abcd") o null. */
export const secretGet = (user: SecretUser) => invoke<string | null>("secret_get", { user });
export const secretDelete = (user: SecretUser) => invoke<void>("secret_delete", { user });
export const coreRestart = () => invoke<void>("core_restart");

/** Mensaje legible de un fallo de `invoke` (Tauri rechaza con un texto; fuera de Tauri, con un TypeError). */
export function tauriError(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  if (/__TAURI|invoke|undefined|not a function/i.test(text)) return "solo disponible en la app de escritorio";
  return text;
}
