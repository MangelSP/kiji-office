// Agentes: agent.list y agent.create (en 0.1 solo Claude; el jefe se crea solo al abrir el proyecto).
import type { AgentRow } from '../db/repos.js';
import { type Ctx, type Handler, asParams, requireProject, str } from './context.js';
import { getRobotStatus } from './status.js';

/** Fila de agente tal como viaja a la UI: columnas de la BD + `status` del robot. */
export function agentView(ctx: Ctx, a: AgentRow): AgentRow & { status: string } {
  return { ...a, status: getRobotStatus(ctx, a.id) };
}

/** Roles que se pueden elegir al crear un agente (el `jefe` se crea solo al abrir el proyecto). Mantener en sync con src/screens/CreateAgent/options.ts. */
export const AGENT_ROLES = ['programador', 'tester', 'explorador', 'modelador-2d', 'documentador', 'revisor-critico'] as const;
/** Paletas de los robots (las que entiende la escena: `paletteFor`). */
export const AGENT_COLORS = ['terracota', 'azul', 'verde', 'crema'] as const;
/** Alias de modelo permitidos para el proveedor `claude`. */
export const CLAUDE_MODELS = ['sonnet', 'opus', 'haiku'] as const;
export const AGENT_NAME_MAX = 24;

/** Elige de una lista cerrada; si el valor falta usa el valor por defecto y si no está en la lista lanza un error claro. */
function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string, fallback: T): T {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) return fallback;
  const v = typeof value === 'string' ? value.trim() : value;
  if (!(allowed as readonly unknown[]).includes(v)) {
    throw new Error(`agent.create: ${field} "${String(value)}" no válido (permitidos: ${allowed.join(', ')})`);
  }
  return v as T;
}

export function agentHandlers(ctx: Ctx): Record<string, Handler> {
  return {
    'agent.list': () => {
      if (!ctx.activeProject) return [];
      return ctx.repos.agents.list(ctx.activeProject.id).map((a) => agentView(ctx, a));
    },

    'agent.create': (params) => {
      const p = asParams(params, 'agent.create');
      const project = requireProject(ctx);
      const provider = str(p.provider, 'provider', 'agent.create');
      if (provider === 'codex') throw new Error('agent.create: el proveedor "codex" llega en el paso 15; por ahora solo "claude"');
      if (['api', 'ollama', 'gemini', 'openai'].includes(provider)) {
        throw new Error(`agent.create: el proveedor "${provider}" llega en el paso 16; por ahora solo "claude"`);
      }
      if (provider !== 'claude') throw new Error(`agent.create: proveedor desconocido "${provider}" (por ahora solo "claude")`);

      const name = str(p.name, 'name', 'agent.create').trim();
      if (name.length > AGENT_NAME_MAX) throw new Error(`agent.create: el nombre admite como máximo ${AGENT_NAME_MAX} caracteres`);
      if (/[\u0000-\u001f\u007f]/.test(name)) throw new Error('agent.create: el nombre no puede llevar saltos de línea ni caracteres de control');
      // Nombre único en el proyecto (sin distinguir mayúsculas), también frente al jefe.
      const taken = ctx.repos.agents.list(project.id).some((a) => a.name.trim().toLowerCase() === name.toLowerCase());
      if (taken) throw new Error(`agent.create: ya hay un agente llamado "${name}" en este proyecto; elige otro nombre`);

      if (typeof p.role === 'string' && p.role.trim() === 'jefe') {
        throw new Error('agent.create: el jefe se crea solo al abrir el proyecto y solo puede haber uno');
      }
      const role = oneOf(p.role, AGENT_ROLES, 'rol', 'programador');
      const model = oneOf(p.model, CLAUDE_MODELS, 'modelo', 'sonnet');
      const color = oneOf(p.color, AGENT_COLORS, 'color', 'terracota');
      return agentView(ctx, ctx.repos.agents.create({ projectId: project.id, name, provider: 'claude', model, role, color }));
    },
  };
}
