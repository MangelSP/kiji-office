import { useState } from "react";
import OfficeV0 from "./screens/Office/OfficeV0";
import Wizard from "./screens/Wizard/Wizard";
import { readWizardDone } from "./screens/Wizard/wizardState";
import { useStore } from "./store";
import "./App.css";

function App() {
  const hasProject = useStore((s) => s.project !== null);
  // El asistente se muestra la primera vez y, mientras no haya proyecto abierto, hasta que se salte;
  // desde la oficina se reabre con el botón «Asistente».
  const [wizard, setWizard] = useState(() => !readWizardDone());
  const [skipped, setSkipped] = useState(false);

  if (wizard || (!hasProject && !skipped)) {
    return (
      <Wizard
        onClose={() => {
          setWizard(false);
          setSkipped(true);
        }}
      />
    );
  }

  return (
    <>
      <div className="app-bar">
        <button type="button" className="app-bar-btn" onClick={() => setWizard(true)}>
          Asistente
        </button>
      </div>
      <OfficeV0 />
    </>
  );
}

export default App;
