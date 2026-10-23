// Pedido de la persona -> campos de `task.create`.

/** Máximo de caracteres del título de la tarea. */
export const TITLE_MAX = 80;

/** El título es la primera línea no vacía (máx. 80 caracteres); la descripción, el texto completo. */
export function parseRequest(text: string): { title: string; description: string } {
  const description = text.trim();
  const firstLine = description.split(/\r?\n/, 1)[0]?.trim() ?? "";
  return { title: firstLine.slice(0, TITLE_MAX).trim(), description };
}

/** "a.ts, b.ts" -> ["a.ts", "b.ts"]; vacío -> [] (tarea de solo lectura). */
export function parseFiles(raw: string): string[] {
  return raw.split(",").map((f) => f.trim()).filter(Boolean);
}
