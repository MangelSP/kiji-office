// Pantalla de inicio: tres robots (Claude, Gemini, OpenAI) llegan andando hasta el núcleo de IA (sprite de
// Pixelorama, tools/sprites/ai-core) mientras el core reabre los proyectos. Dura al menos MIN_MS; un clic o
// cualquier tecla la saltan. Con «reducir movimiento» no hay caminata ni pulso.
import { useEffect, useState } from "react";
import aiCore from "../assets/sprites/ai-core.png";
import { useStore } from "../store";
import RobotAvatar from "./RobotAvatar";
import "./Splash.css";

const MIN_MS = 2800;
const ROBOTS = [
  { sheet: "terracota-jefe", name: "Claude" },
  { sheet: "azul", name: "Gemini" },
  { sheet: "verde", name: "OpenAI" },
];

export default function Splash() {
  const ready = useStore((s) => s.booted);
  const [minDone, setMinDone] = useState(false);
  const [skipped, setSkipped] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [gone, setGone] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setMinDone(true), MIN_MS);
    const skip = () => setSkipped(true);
    window.addEventListener("keydown", skip);
    return () => {
      clearTimeout(t);
      window.removeEventListener("keydown", skip);
    };
  }, []);

  const done = ready && (minDone || skipped);
  useEffect(() => {
    if (!done) return;
    setLeaving(true);
    const t = setTimeout(() => setGone(true), 400); // lo que dura el fundido en Splash.css
    return () => clearTimeout(t);
  }, [done]);

  if (gone) return null;
  return (
    <div className={`splash${leaving ? " splash-out" : ""}`} role="status" aria-live="polite" onClick={() => setSkipped(true)}>
      <div className="splash-stage" aria-hidden="true">
        <div className="splash-core" style={{ backgroundImage: `url(${aiCore})` }} />
        {ROBOTS.map((r, i) => (
          <div key={r.sheet} className={`splash-robot splash-robot-${i}`}>
            <RobotAvatar sheet={r.sheet} zoom={3} animate />
            <span className="splash-tag">{r.name}</span>
          </div>
        ))}
      </div>
      <p className="marca splash-marca">
        KIJI OFFICE <span className="beta">BETA</span>
      </p>
      <p className="splash-msg">{ready ? "¡Listos para trabajar!" : "Despertando a los robots…"}</p>
      <p className="splash-hint">Clic o cualquier tecla para saltar</p>
    </div>
  );
}
