// Pantalla "Conexiones" (global, no de un workspace): lo descubierto en este equipo y las conexiones guardadas.
import { useEffect, useState } from "react";
import type { ConnectionTest, ConnectionView, DiscoveredServer } from "../../../shared/protocol";
import { useStore } from "../../store";
import { secretDelete } from "../Wizard/tauri";
import ConnectionForm from "./ConnectionForm";
import Led from "./Led";
import PresetIcon from "./PresetIcon";
import { presetInfo, toolQualityText } from "./presets";
import "./Connections.css";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function DiscoveredCard({ server, busy, onConnect }: { server: DiscoveredServer; busy: boolean; onConnect: () => void }) {
  const label = presetInfo(server.preset).label;
  if (server.installedNotRunning) {
    return (
      <li className="card cx-found cx-found-off">
        <PresetIcon preset={server.preset} />
        <p>
          {label} está instalado pero no en marcha: ejecuta <code>{server.preset === "ollama" ? "ollama serve" : label}</code>
        </p>
      </li>
    );
  }
  return (
    <li className="card cx-found">
      <PresetIcon preset={server.preset} />
      <p>
        Encontrado: <strong>{label}</strong> · {plural(server.models.length, "modelo", "modelos")}
        {server.alreadyConnected && <span className="muted"> · ya conectado</span>}
      </p>
      {!server.alreadyConnected && (
        <button type="button" className="btn btn-primary" disabled={busy} onClick={onConnect} aria-label={`Conectar ${label}`}>
          {busy ? "Conectando…" : "Conectar"}
        </button>
      )}
    </li>
  );
}

function ConnectionCard({ conn, onEdit }: { conn: ConnectionView; onEdit: () => void }) {
  const testConnection = useStore((s) => s.testConnection);
  const deleteConnection = useStore((s) => s.deleteConnection);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<ConnectionTest | null>(null);
  const [confirming, setConfirming] = useState(false);
  const used = conn.agents.length > 0;

  const probe = async () => {
    setTesting(true);
    setResult(null);
    const res = await testConnection(conn.id);
    setResult(res ?? null);
    setTesting(false);
  };

  const remove = async () => {
    const ok = await deleteConnection(conn.id);
    setConfirming(false);
    if (ok && conn.hasSecret) await secretDelete(`conn:${conn.id}`).catch(() => undefined);
  };

  return (
    <li className="card cx-card" aria-label={conn.name}>
      <div className="cx-card-head">
        <Led conn={conn} />
        <PresetIcon preset={conn.preset} />
        <div className="cx-card-title">
          <strong>{conn.name}</strong>
          <span className="muted small">
            {presetInfo(conn.preset).label} · {conn.defaultModel ?? "sin modelo por defecto"}
          </span>
        </div>
      </div>
      <p className="small">
        Herramientas: <strong>{toolQualityText(conn.toolQuality)}</strong>
      </p>
      <p className="muted small">{used ? `La usan: ${conn.agents.join(", ")}` : "Ningún robot la usa todavía."}</p>

      {result && (
        <ul className="plain cx-mini" aria-label={`Prueba de ${conn.name}`}>
          {result.steps.map((s) => (
            <li key={s.name} className={s.ok ? "cx-ok" : "cx-bad"}>
              {s.ok ? "✓" : "✗"} {s.name}: <span className="muted">{s.detail}</span>
            </li>
          ))}
        </ul>
      )}

      {confirming ? (
        <div className="cx-confirm" role="alertdialog" aria-label={`Borrar ${conn.name}`}>
          <p>¿Borrar la conexión «{conn.name}»? También se borra su clave del llavero.</p>
          <div className="row">
            <button type="button" className="btn btn-primary" onClick={() => void remove()}>
              Sí, borrar
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setConfirming(false)}>
              Cancelar
            </button>
          </div>
        </div>
      ) : (
        <div className="row">
          <button type="button" className="btn" disabled={testing} onClick={() => void probe()} aria-label={`Probar ${conn.name}`}>
            {testing ? "Probando…" : "Probar"}
          </button>
          <button type="button" className="btn" onClick={onEdit} aria-label={`Editar ${conn.name}`}>
            Editar
          </button>
          <button type="button" className="btn btn-ghost" disabled={used} onClick={() => setConfirming(true)} aria-label={`Borrar ${conn.name}`}>
            Borrar
          </button>
        </div>
      )}
      {used && !confirming && (
        <p className="muted small">
          No se puede borrar mientras la usen robots: reasígnalos a otra IA (pestaña Perfil de cada robot) y vuelve aquí.
        </p>
      )}
    </li>
  );
}

type Mode = { kind: "list" } | { kind: "new" } | { kind: "edit"; conn: ConnectionView };

export default function ConnectionsScreen() {
  const connections = useStore((s) => s.connections);
  const discovered = useStore((s) => s.discovered);
  const discovering = useStore((s) => s.discovering);
  const unavailable = useStore((s) => s.unavailable);
  const refreshConnections = useStore((s) => s.refreshConnections);
  const discover = useStore((s) => s.discover);
  const connectDiscovered = useStore((s) => s.connectDiscovered);
  const setOpen = useStore((s) => s.setConnectionsOpen);
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  const [connecting, setConnecting] = useState<string | null>(null);

  useEffect(() => {
    void refreshConnections();
    void discover();
  }, [refreshConnections, discover]);

  const connect = async (server: DiscoveredServer) => {
    setConnecting(server.baseUrl);
    await connectDiscovered(server);
    setConnecting(null);
  };

  if (mode.kind !== "list") {
    return (
      <main className="cx-screen">
        <ConnectionForm initial={mode.kind === "edit" ? mode.conn : undefined} onClose={() => setMode({ kind: "list" })} />
      </main>
    );
  }

  return (
    <main className="cx-screen">
      <header className="cx-head">
        <h1>Conexiones</h1>
        <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>
          Volver
        </button>
      </header>

      <section className="panel" aria-labelledby="cx-local-title">
        <div className="panel-head">
          <h2 id="cx-local-title">En este equipo</h2>
          <button type="button" className="btn" disabled={discovering || unavailable["connections.discover"]} onClick={() => void discover()}>
            {discovering ? "Buscando…" : "Buscar en este equipo"}
          </button>
        </div>
        {unavailable["connections.discover"] ? (
          <p className="muted small">Aún no disponible: el core no implementa connections.discover.</p>
        ) : discovered.length === 0 ? (
          <p className="muted small">{discovering ? "Buscando servidores locales…" : "No se encontró ninguna IA local en marcha (Ollama, LM Studio, llama.cpp, vLLM)."}</p>
        ) : (
          <ul className="plain">
            {discovered.map((d) => (
              <DiscoveredCard key={`${d.preset}-${d.baseUrl}`} server={d} busy={connecting === d.baseUrl} onConnect={() => void connect(d)} />
            ))}
          </ul>
        )}
      </section>

      <section className="panel" aria-labelledby="cx-list-title">
        <div className="panel-head">
          <h2 id="cx-list-title">Tus conexiones</h2>
          <button type="button" className="btn btn-primary" onClick={() => setMode({ kind: "new" })}>
            + Nueva conexión
          </button>
        </div>
        {unavailable["connection.list"] ? (
          <p className="muted small">Aún no disponible: el core no implementa connection.list.</p>
        ) : connections.length === 0 ? (
          <p className="muted small">Todavía no hay conexiones. Conecta una IA local o crea una nueva.</p>
        ) : (
          <ul className="plain cx-cards">
            {connections.map((c) => (
              <ConnectionCard key={c.id} conn={c} onEdit={() => setMode({ kind: "edit", conn: c })} />
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
