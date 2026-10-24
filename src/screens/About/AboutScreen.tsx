// Pantalla «Acerca de»: versión, registro de cambios, licencia y política de datos.
import { isTauri } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import pkg from "../../../package.json";
import changelog from "../../../CHANGELOG.md?raw";
import Markdown from "../../components/Markdown";
import UpdateDialog, { checkForUpdate, errText, type UpdateInfo } from "../../components/UpdateDialog";
import "./About.css";

export const TELEMETRY_TEXT =
  "Kiji no envía datos de uso. Tus claves viven en el llavero del sistema; tus proyectos no salen de tu equipo salvo lo que envíes a las IAs que conectes.";

/** Dentro de Tauri, la versión de la app; en el navegador (desarrollo), la de package.json. */
async function appVersion(): Promise<string> {
  if (!isTauri()) return pkg.version;
  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    return await getVersion();
  } catch {
    return pkg.version;
  }
}

export default function AboutScreen({ onClose }: { onClose?: () => void }) {
  const [version, setVersion] = useState(pkg.version);
  const [showLog, setShowLog] = useState(false);
  const [checking, setChecking] = useState(false);
  const [updateMsg, setUpdateMsg] = useState<string | null>(null);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);

  const checkUpdates = async () => {
    setChecking(true);
    setUpdateMsg(null);
    try {
      const u = await checkForUpdate();
      if (u) setUpdate(u);
      else setUpdateMsg("Ya tienes la última versión.");
    } catch (e) {
      setUpdateMsg(errText(e));
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    let alive = true;
    void appVersion().then((v) => alive && setVersion(v));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <main className="ab-screen" aria-label="Acerca de Kiji Office">
      <header className="ab-head">
        <div>
          <p className="marca">KIJI OFFICE <span className="beta">BETA</span></p>
          <h1>Acerca de</h1>
        </div>
        {onClose && (
          <button type="button" className="ws-btn" onClick={onClose}>
            Cerrar
          </button>
        )}
      </header>

      <p className="ab-version">
        Versión <strong data-testid="ab-version">{version}</strong>
      </p>
      <p>Oficina de agentes de IA en pixel art.</p>

      <div className="ab-row">
        <button type="button" className="ws-btn" aria-expanded={showLog} onClick={() => setShowLog((v) => !v)}>
          {showLog ? "Ocultar registro de cambios" : "Ver registro de cambios"}
        </button>
        <button type="button" className="ws-btn" disabled={!isTauri() || checking} onClick={() => void checkUpdates()}
          title={isTauri() ? undefined : "Solo disponible en la aplicación de escritorio"}>
          {checking ? "Buscando…" : "Buscar actualizaciones"}
        </button>
      </div>
      {updateMsg && <p role="status" className="ab-muted">{updateMsg}</p>}
      {update && <UpdateDialog update={update} onClose={() => setUpdate(null)} />}
      {showLog && <Markdown text={changelog} label="Registro de cambios" />}

      <section>
        <h2>Licencia</h2>
        <p>Creado por Miguel Ángel Sánchez Peralta.</p>
        <p>Código: licencia MIT.</p>
        <p className="ab-muted">
          Los assets (sprites, pixel art, la oficina, el icono y el logo) tienen todos los derechos reservados: no se
          pueden usar en otros proyectos sin permiso.
        </p>
        <p className="ab-muted">Los componentes de terceros que usa Kiji se listan en THIRD-PARTY.md.</p>
      </section>

      <section>
        <h2>Datos y telemetría</h2>
        <p>{TELEMETRY_TEXT}</p>
      </section>
    </main>
  );
}
