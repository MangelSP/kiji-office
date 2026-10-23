// Pantalla Ajustes (global): navegación lateral por secciones y un formulario por sección.
import { useEffect, useState, type ComponentType } from "react";
import { useSettings } from "../../store/settings";
import { AcercaDe, Actualizaciones, Avisos, Datos, General, Gerente, IAs, Skills, Trabajo, type SectionProps } from "./Sections";
import "./Settings.css";

export const SECTIONS: { id: string; label: string; Body: ComponentType<SectionProps> }[] = [
  { id: "general", label: "General", Body: General },
  { id: "trabajo", label: "Trabajo", Body: Trabajo },
  { id: "ias", label: "IAs", Body: IAs },
  { id: "skills", label: "Skills", Body: Skills },
  { id: "gerente", label: "Gerente", Body: Gerente },
  { id: "avisos", label: "Avisos", Body: Avisos },
  { id: "datos", label: "Datos", Body: Datos },
  { id: "actualizaciones", label: "Actualizaciones", Body: Actualizaciones },
  { id: "acerca", label: "Acerca de", Body: AcercaDe },
];

export default function SettingsScreen(props: SectionProps) {
  const [current, setCurrent] = useState(SECTIONS[0]!.id);
  const status = useSettings((s) => s.status);
  const reason = useSettings((s) => s.reason);
  const load = useSettings((s) => s.load);
  useEffect(() => {
    if (status === "idle" || status === "unavailable") void load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const section = SECTIONS.find((s) => s.id === current) ?? SECTIONS[0]!;
  // Estas secciones no dependen (solo) de los ajustes del core: se enseñan aunque no estén disponibles.
  const blocked = status === "unavailable" && !["gerente", "acerca", "skills", "ias"].includes(section.id);

  return (
    <main className="st-screen">
      <header className="st-head">
        <p className="marca">KIJI OFFICE <span className="beta">BETA</span></p>
        <h1>Ajustes</h1>
        <button type="button" className="st-btn" onClick={props.onClose}>
          Cerrar
        </button>
      </header>
      <div className="st-layout">
        <nav className="st-nav" aria-label="Secciones de ajustes">
          {SECTIONS.map((s) => (
            <button key={s.id} type="button" className={`st-nav-item${s.id === section.id ? " is-active" : ""}`} aria-current={s.id === section.id ? "page" : undefined} onClick={() => setCurrent(s.id)}>
              {s.label}
            </button>
          ))}
        </nav>
        <section className="st-body" aria-labelledby="st-section-title">
          <h2 id="st-section-title">{section.label}</h2>
          {status === "loading" && <p className="st-hint">Cargando ajustes…</p>}
          {status === "unavailable" && (
            <p className="st-banner" role="status">
              {reason ?? "Los ajustes aún no están disponibles."}
            </p>
          )}
          {!blocked && status !== "loading" && <section.Body {...props} />}
        </section>
      </div>
    </main>
  );
}
