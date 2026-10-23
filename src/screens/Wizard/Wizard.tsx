// Asistente de primera vez: barra lateral de pasos + contenido (PLAN-0.1, paso 10).
// 1 inteligencias detectadas · 2 claves · 3 probar conexión · 4 proyecto.
import { useCallback, useEffect, useState } from "react";
import { connectStore } from "../../store";
import StepDetect from "./StepDetect";
import StepKeys from "./StepKeys";
import StepProject from "./StepProject";
import StepTest from "./StepTest";
import { nodeProblem } from "./nodeVersion";
import { detectClis, tauriError, type CliInfo } from "./tauri";
import { markWizardDone } from "./wizardState";
import "./Wizard.css";

const STEPS = ["Inteligencias", "Claves", "Probar conexión", "Proyecto"] as const;

type Props = {
  /** Se llama al terminar («Abrir la oficina») o al saltar el asistente. */
  onClose: (completed: boolean) => void;
};

export default function Wizard({ onClose }: Props) {
  const [step, setStep] = useState(0);
  const [clis, setClis] = useState<CliInfo[] | null>(null);
  const [detectError, setDetectError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // El asistente puede mostrarse antes que la oficina: conecta el store con el core.
  useEffect(() => connectStore(), []);

  const detect = useCallback(async () => {
    setLoading(true);
    setDetectError(null);
    try {
      setClis(await detectClis());
    } catch (err) {
      setClis(null);
      setDetectError(tauriError(err));
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void detect();
  }, [detect]);

  const node = clis?.find((c) => c.name === "node");
  const blocked = node ? nodeProblem(node.found, node.version) : null;
  const lastStep = STEPS.length - 1;

  const finish = () => {
    markWizardDone();
    onClose(true);
  };

  return (
    <div className="wz">
      <aside className="wz-side">
        <p className="marca">KIJI OFFICE <span className="beta">BETA</span></p>
        <p className="wz-muted wz-small">Asistente de primera vez</p>
        <ol className="wz-steps" aria-label="Pasos del asistente">
          {STEPS.map((name, i) => {
            const locked = blocked !== null && i > 0;
            return (
              <li key={name}>
                <button
                  type="button"
                  className={`wz-step ${i === step ? "wz-step-on" : ""} ${i < step ? "wz-step-done" : ""}`}
                  aria-current={i === step ? "step" : undefined}
                  disabled={locked}
                  onClick={() => setStep(i)}
                >
                  <span className="wz-num" aria-hidden="true">
                    {i < step ? "✓" : i + 1}
                  </span>
                  {name}
                </button>
              </li>
            );
          })}
        </ol>
        <button type="button" className="wz-link" onClick={() => onClose(false)}>
          Saltar por ahora
        </button>
      </aside>

      <main className="wz-content">
        {step === 0 && <StepDetect clis={clis} error={detectError} loading={loading} onRefresh={() => void detect()} />}
        {step === 1 && <StepKeys />}
        {step === 2 && <StepTest />}
        {step === 3 && <StepProject onFinish={finish} blocked={blocked} />}

        <div className="wz-nav">
          <button type="button" className="wz-btn" disabled={step === 0} onClick={() => setStep(step - 1)}>
            Atrás
          </button>
          {step < lastStep && (
            <button type="button" className="wz-btn wz-btn-primary" disabled={blocked !== null} onClick={() => setStep(step + 1)}>
              Siguiente
            </button>
          )}
        </div>
      </main>
    </div>
  );
}
