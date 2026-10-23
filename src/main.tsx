import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import Splash from "./components/Splash";
import { invoke, isTauri } from "@tauri-apps/api/core";

// Solo desarrollo dentro de Tauri: errores de la UI al log de `tauri dev` (la consola del webview no se ve).
if (import.meta.env.DEV && isTauri()) {
  const send = (msg: string) => void invoke("ui_log", { msg }).catch(() => {});
  const orig = console.error;
  console.error = (...a: unknown[]) => {
    send(a.map((x) => (x instanceof Error ? `${x.message}\n${x.stack}` : String(x))).join(" "));
    orig(...a);
  };
  window.addEventListener("error", (e) => send(`error: ${e.message}`));
  window.addEventListener("unhandledrejection", (e) => send(`promesa rechazada: ${String(e.reason)}`));
  (window as unknown as { __kijiLog: typeof send }).__kijiLog = send;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
    <Splash />
  </React.StrictMode>,
);
