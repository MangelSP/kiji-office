// Icono propio de un preset: glifo neutro sobre un cuadrado de color (sin logos oficiales).
import type { ConnectionPreset } from "../../../shared/protocol";
import { presetInfo } from "./presets";

export default function PresetIcon({ preset }: { preset: ConnectionPreset }) {
  const p = presetInfo(preset);
  return (
    <span className="cx-icon" style={{ background: p.hue }} aria-hidden="true">
      {p.glyph}
    </span>
  );
}
