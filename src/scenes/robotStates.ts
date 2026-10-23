// Tabla estado del agente → animación del robot. Sin PixiJS: se puede testear en vitest.

export const ROBOT_STATES = ["idle", "thinking", "writing", "needs_you", "error", "done"] as const;
export type RobotState = (typeof ROBOT_STATES)[number];

export type StateDef = {
  /** Nombre de la animación en el spritesheet (coincide con el estado). */
  anim: RobotState;
  loop: boolean;
  /** `animationSpeed` de PixiJS (fotogramas por tick a 60 fps). */
  speed: number;
  /** Si existe, pasado `ms` el robot vuelve solo a `estado`. */
  volverA?: { estado: RobotState; ms: number };
  /** Texto corto de la etiqueta (interfaz en español). */
  label: string;
  /** Color del puntito de estado. */
  dot: number;
};

export const DONE_RETURN_MS = 4000;

export const ROBOT_STATE_TABLE: Record<RobotState, StateDef> = {
  idle: { anim: "idle", loop: true, speed: 0.05, label: "libre", dot: 0x8a8f98 },
  thinking: { anim: "thinking", loop: true, speed: 0.08, label: "pensando", dot: 0xf4c542 },
  writing: { anim: "writing", loop: true, speed: 0.15, label: "escribiendo", dot: 0x5aa9f0 },
  needs_you: { anim: "needs_you", loop: true, speed: 0.12, label: "te necesita", dot: 0xff7a45 },
  error: { anim: "error", loop: true, speed: 0.06, label: "error", dot: 0xe5484d },
  done: {
    anim: "done",
    loop: false,
    speed: 0.08,
    volverA: { estado: "idle", ms: DONE_RETURN_MS },
    label: "listo",
    dot: 0x4cc38a,
  },
};

/** Cualquier cadena desconocida (o ausente) se trata como `idle`. */
export function normalizeStatus(status: unknown): RobotState {
  return typeof status === "string" && (ROBOT_STATES as readonly string[]).includes(status)
    ? (status as RobotState)
    : "idle";
}
