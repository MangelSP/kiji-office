// Estado del robot (`agent.status`): thinking / writing / needs_you / error / done / idle.
import type { AgentEvent } from '../adapters/types.js';
import type { Ctx } from './context.js';

export type RobotStatus = 'idle' | 'thinking' | 'writing' | 'needs_you' | 'error' | 'done';

// Herramientas que escriben o ejecutan: el robot "teclea".
const WRITING_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Bash']);

/** Estado del robot que provoca un evento del adaptador (null = no cambia). */
export function robotStatusFor(ev: AgentEvent): RobotStatus | null {
  switch (ev.type) {
    case 'thinking':
    case 'text':
      return 'thinking';
    case 'tool':
      // Al terminar una herramienta el agente vuelve a pensar.
      return ev.status === 'start' && WRITING_TOOLS.has(ev.name) ? 'writing' : 'thinking';
    case 'permission_request':
      return 'needs_you';
    default:
      return null;
  }
}

export function getRobotStatus(ctx: Ctx, agentId: string): RobotStatus {
  return (ctx.agentStatus.get(agentId) as RobotStatus | undefined) ?? 'idle';
}

/** Cambia el estado del robot y avisa a la UI; no repite el mismo estado. */
export function setRobotStatus(ctx: Ctx, agentId: string, status: RobotStatus): void {
  if (getRobotStatus(ctx, agentId) === status) return;
  ctx.agentStatus.set(agentId, status);
  ctx.emit('agent.status', { agent_id: agentId, status });
}
