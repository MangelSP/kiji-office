import { useEffect, useState } from "react";
import CloseGuard from "./components/CloseGuard";
import { UpdateAutoCheck } from "./components/UpdateDialog";
import { HaltedBanner } from "./components/StopAllButton";
import NoticeBar from "./components/NoticeBar";
import AboutScreen from "./screens/About/AboutScreen";
import ConnectionsScreen from "./screens/Connections/ConnectionsScreen";
import SettingsScreen from "./screens/Settings/SettingsScreen";
import Home from "./screens/Home/Home";
import OfficeV0 from "./screens/Office/OfficeV0";
import Wizard from "./screens/Wizard/Wizard";
import { readWizardDone } from "./screens/Wizard/wizardState";
import WorkspaceTabs from "./screens/Workspaces/WorkspaceTabs";
import { useWorkspaceShortcuts } from "./screens/Workspaces/shortcuts";
import { connectStore, useStore } from "./store";
import { loadDemo } from "./store/demo";
import { connectSettings, useSetting, useSettings } from "./store/settings";
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsStatus = useSettings((s) => s.status);
  const loadSettings = useSettings((s) => s.load);
  const startView = useSetting("start_view");

  useEffect(() => connectStore(), []);
  useWorkspaceShortcuts();
  // Cambiar de pestaña (también con atajos) saca de la pantalla Conexiones.
  useEffect(() => setConnectionsOpen(false), [active, setConnectionsOpen]);
  // Acerca de se cierra al cambiar de pestaña o al abrir Conexiones.
  useEffect(() => setAboutOpen(false), [active, connectionsOpen]);
  // Ajustes se cierra al cambiar de pestaña o al abrir Conexiones / Acerca de.
  useEffect(() => setSettingsOpen(false), [active, connectionsOpen]);
  useEffect(() => connectSettings(), []);
  // Ajustes del core (nombre del saludo, vista al abrir...) en cuanto el arranque termina.
  useEffect(() => {
    if (booted && settingsStatus === "idle") void loadSettings();
  }, [booted, settingsStatus, loadSettings]);
  // «Vista al abrir: último workspace»: una sola vez, al arrancar, si no hay pestaña elegida.
  const [startApplied, setStartApplied] = useState(false);
  useEffect(() => {
    if (startApplied || !booted || startView === undefined) return;
    setStartApplied(true);
    const s = useStore.getState();
    if (startView === "last" && s.activeProjectId === null && s.tabs.length > 0) {
      const open = s.projects.filter((p) => p.open).sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0));
      s.setActiveProject(open[0]?.projectId ?? s.tabs[s.tabs.length - 1]!);
    }
  }, [booted, startView, startApplied]);
  // Cmd/Ctrl+, abre y cierra Ajustes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key === ",") {
        e.preventDefault();
        setAboutOpen(false);
        setConnectionsOpen(false);
        setSettingsOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setConnectionsOpen]);

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
      {(settingsStatus === "ready" || settingsStatus === "unavailable") && <UpdateAutoCheck />}
      <WorkspaceTabs onWizard={() => setWizard(true)} onAbout={() => {
          setSettingsOpen(false);
          setAboutOpen((v) => !v);
        }}
        aboutOpen={aboutOpen}
        onSettings={() => {
          setAboutOpen(false);
          setConnectionsOpen(false);
          setSettingsOpen((v) => !v);
        }}
        settingsOpen={settingsOpen}
      />
      <HaltedBanner />
      <NoticeBar />
      {/* Una sola oficina montada (una sola `Application` de PixiJS): al cambiar de pestaña se re-sincroniza. */}
      {settingsOpen ? (
        <SettingsScreen
          onClose={() => setSettingsOpen(false)}
          onWizard={() => setWizard(true)}
          onAbout={() => setAboutOpen(true)}
        />
      ) : aboutOpen ? <AboutScreen onClose={() => setAboutOpen(false)} /> : connectionsOpen ? <ConnectionsScreen /> : active ? <OfficeV0 projectId={active} /> : <Home />}
    </>
  );
}

export default App;
