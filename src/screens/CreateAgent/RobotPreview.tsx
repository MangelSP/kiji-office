// Vista previa grande del robot: el `idle` animado de la paleta elegida, con sus accesorios, en un canvas 2D
// (RobotAvatar). No usa PixiJS a propósito: una segunda `Application` rompía el renderizador de la oficina.
import RobotAvatar from "../../components/RobotAvatar";

export { idleFrames } from "../../components/robotSheets";

export default function RobotPreview({ palette, accessories }: { palette: string; accessories?: readonly string[] }) {
  return (
    <div className="ca-preview" role="img" aria-label={`Vista previa del robot, paleta ${palette}`}>
      <RobotAvatar sheet={palette} zoom={6} animate accessories={accessories} />
    </div>
  );
}
