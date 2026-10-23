// Saludo de la oficina: «¡Buenos días, Nombre!» o, sin nombre (ajuste `user_name` vacío o ausente), «¡Hola!».
import { useSetting } from "../../store/settings";

export function timeGreeting(hour: number): string {
  if (hour < 12) return "Buenos días";
  if (hour < 19) return "Buenas tardes";
  return "Buenas noches";
}

export function greeting(hour: number, name: string | undefined | null): string {
  const n = (name ?? "").trim();
  return n === "" ? "¡Hola!" : `¡${timeGreeting(hour)}, ${n}!`;
}

/** Saludo de ahora con el nombre del ajuste `user_name`. */
export function useGreeting(): string {
  const name = useSetting("user_name");
  return greeting(new Date().getHours(), name);
}
