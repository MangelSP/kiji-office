// "conn:<id>/<modelo>" -> "<nombre de la conexión> · <modelo>". Lo demás (alias de Claude, modelos sueltos) no cambia.
import type { ConnectionView } from "../../shared/protocol";

const CONN_RE = /^conn:([^/]+)\/(.+)$/;

export function modelLabel(model: string, connections: readonly Pick<ConnectionView, "id" | "name">[]): string {
  const hit = CONN_RE.exec(model);
  if (!hit) return model;
  const name = connections.find((c) => c.id === hit[1])?.name ?? "conexión borrada";
  return `${name} · ${hit[2]}`;
}
