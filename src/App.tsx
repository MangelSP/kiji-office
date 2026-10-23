import { useEffect, useState } from "react";
import CloseGuard from "./components/CloseGuard";
import { HaltedBanner } from "./components/StopAllButton";
import NoticeBar from "./components/NoticeBar";
import AboutScreen from "./screens/About/AboutScreen";
import ConnectionsScreen from "./screens/Connections/ConnectionsScreen";
import Home from "./screens/Home/Home";
import OfficeV0 from "./screens/Office/OfficeV0";
import Wizard from "./screens/Wizard/Wizard";
import { readWizardDone } from "./screens/Wizard/wizardState";
import WorkspaceTabs from "./screens/Workspaces/WorkspaceTabs";
import { useWorkspaceShortcuts } from "./screens/Workspaces/shortcuts";
import { connectStore, useStore } from "./store";
import { loadDemo } from "./store/demo";
import "./App.css";

function App() {
  const hasProject = useStore((s) => s.tabs.length > 0);
  const booted = useStore((s) => s.booted);
  const active = useStore((s) => s.activeProjectId);
  const connectionsOpen = useStore((s) => s.connectionsOpen);
  const setConnectionsOpen = useStore((s) => s.setConnectionsOpen);
  // El asistente se muestra la primera vez y, mientras no haya workspace abierto, hasta que se salte;
  // desde la barra de pestañas se reabre con el botón «Asistente».
  const [wizard, setWizard] = useState(() => !readWizardDone());
  const [skipped, setSkipped] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);

  useEffect(() => connectStore(), []);
  useWorkspaceShortcuts();
  // Cambiar de pestaña (también con atajos) saca de la pantalla Conexiones.
  useEffect(() => setConnectionsOpen(false), [active, setConnectionsOpen]);
  // Acerca de se cierra al cambiar de pestaña o al abrir Conexiones.
  useEffect(() => setAboutOpen(false), [active, connectionsOpen]);

  // Solo en desarrollo: `?demo=1` carga dos workspaces de ejemplo para ver la interfaz sin core.
  useEffect(() => {
    if (import.meta.env.DEV && new URLSearchParams(window.location.search).has("demo")) loadDemo();
  }, []);

  if (wizard || (booted && !hasProject && !skipped)) {
    return (
      <>
        <Wizard
          onClose={() => {
            setWizard(false);
            setSkipped(true);
          }}
        />
        <CloseGuard />
      </>
    );
  }

  // Hasta saber qué proyectos había abiertos no se enseña ni el asistente ni un Home vacío.
  if (!booted) return <p className="boot">Conectando con el core…</p>;

  return (
    <>
      <CloseGuard />
      <WorkspaceTabs onWizard={() => setWizard(true)} onAbout={() => setAboutOpen((v) => !v)} aboutOpen={aboutOpen} />
      <HaltedBanner />
      <NoticeBar />
      {/* Una sola oficina montada (una sola `Application` de PixiJS): al cambiar de pestaña se re-sincroniza. */}
      {aboutOpen ? <AboutScreen onClose={() => setAboutOpen(false)} /> : connectionsOpen ? <ConnectionsScreen /> : active ? <OfficeV0 projectId={active} /> : <Home />}
    </>
  );
}

export default App;
