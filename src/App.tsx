import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./App.css";

const NOMBRE = "Alexis";

function saludo(hora: number) {
  if (hora < 12) return "Buenos días";
  if (hora < 19) return "Buenas tardes";
  return "Buenas noches";
}

// Indicador de estado del core: ping por core_send y espera el pong por core:line.
function useCoreStatus() {
  const [estado, setEstado] = useState("conectando…");
  useEffect(() => {
    let cancelado = false;
    let unlisten: (() => void) | undefined;
    const ping = () =>
      invoke("core_send", { line: JSON.stringify({ id: "ui-ping", type: "req", method: "ping" }) }).catch(() =>
        setEstado("sin conexión"),
      );
    listen<string>("core:line", (e) => {
      try {
        const m = JSON.parse(e.payload);
        if (m.type === "res" && m.id === "ui-ping") setEstado(m.result === "pong" ? "pong" : "error");
        else if (m.type === "event" && m.name === "core.ready") void ping(); // también tras un reinicio
        else if (m.type === "event" && m.name === "core.crashed") setEstado("caído");
      } catch {
        // línea que no es JSON: se ignora
      }
    })
      .then((un) => {
        if (cancelado) un();
        else {
          unlisten = un;
          void ping();
        }
      })
      .catch(() => setEstado("sin conexión")); // fuera de Tauri no hay eventos
    return () => {
      cancelado = true;
      unlisten?.();
    };
  }, []);
  return estado;
}

function App() {
  const coreEstado = useCoreStatus();
  return (
    <main className="container">
      <p className="marca">KIJI OFFICE</p>
      <h1>
        ¡{saludo(new Date().getHours())}, {NOMBRE}!
      </h1>
      <p className="sub">Tu oficina de robots está lista para empezar.</p>
      <p style={{ margin: 0, fontSize: 12, opacity: 0.6 }}>core: {coreEstado}</p>
    </main>
  );
}

export default App;
