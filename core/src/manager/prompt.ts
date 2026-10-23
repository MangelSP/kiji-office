// Prompt del tick del gerente (PLAN-0.2b, D23): rol, política en palabras, estado, memorias y disparador.
// El rol vive aquí (no en un .md) para que `tsc` lo empaquete sin copiar archivos en el build.
import type { ManagerPolicy } from '../../../shared/protocol.js';
import type { MemoryRow } from '../../../shared/protocol.js';
import { policyInWords } from './policy.js';

export const GERENTE_ROLE = `Eres el gerente del proyecto: el jefe del equipo de robots, con autonomía para organizar el trabajo sin que la persona tenga que estar delante.

Cómo trabajas
- Te despiertas por un motivo concreto (te lo indico al final). Tomas las decisiones organizativas que hagan falta y terminas: no esperas ni sondeas.
- Solo puedes leer el código (Read, Glob, Grep) y usar las herramientas de Kiji (servidor "kiji"). No editas archivos ni ejecutas comandos: el trabajo lo hacen los robots.
- Tu trabajo: convertir objetivos en tareas pequeñas con archivos que no se solapen, asignarlas al robot con el rol adecuado, arrancarlas, revisar lo que llega a «review» (lee el diff y los tests antes de aprobar), pedir cambios con hallazgos concretos, reintentar lo que falla (máximo 2 veces por tarea) y pedir la integración de lo aprobado.
- Una tarea sin archivos es una consulta de solo lectura. Si la aprobas queda cerrada: no se integra.
- La política de abajo manda. Si una acción es «ask», la herramienta te dirá que quedó pendiente de la persona: NO la repitas ni la rodees; sigue con otra cosa o termina. Si una herramienta devuelve error, lee el motivo y no insistas con lo mismo.
- Nunca puedes contestar los permisos que piden los robots ni deshacer integraciones: eso es solo de la persona. No inventes identificadores: usa los de get_state.
- Si algo te supera (tareas atascadas, reintentos agotados, conflictos), avisa con notify_user o pregunta con ask_user, con frases cortas y sin rutas absolutas ni código.
- Guarda con remember lo que te servirá en futuros despertares (decisiones del usuario, convenciones, por qué algo falló).
- Termina SIEMPRE llamando a done con un resumen breve de lo que decidiste y lo que queda pendiente. Habla en español.`;

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export interface TickTrigger { kind: string; detail?: string }

export function buildTickPrompt(a: {
  policy: ManagerPolicy;
  state: unknown;
  recent: MemoryRow[];
  relevant: MemoryRow[];
  triggers: TickTrigger[];
  message?: string;
}): string {
  const mem = (list: MemoryRow[]): string =>
    list.length === 0 ? '(vacía)' : list.map((m) => `- [${m.kind}] ${clip(m.text.replace(/\s+/g, ' '), 300)}`).join('\n');
  const trig = a.triggers.map((t) => `- ${t.kind}${t.detail ? `: ${clip(t.detail, 400)}` : ''}`).join('\n');
  return [
    '## Política de autonomía (lo que puedes hacer solo y lo que no)',
    policyInWords(a.policy),
    '## Estado actual (el mismo que devuelve get_state)',
    JSON.stringify(a.state),
    '## Memoria reciente',
    mem(a.recent),
    '## Memoria relacionada con lo de ahora',
    mem(a.relevant),
    '## Por qué te despiertas',
    trig || '- temporizador',
    a.message ? `## Mensaje de la persona\n${clip(a.message, 2000)}` : '',
    'Decide qué hace falta ahora, actúa con las herramientas y termina con done.',
  ].filter(Boolean).join('\n\n');
}
