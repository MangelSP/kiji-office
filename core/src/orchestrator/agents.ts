// Agentes: agent.list y agent.create (en 0.1 solo Claude; el jefe se crea solo al abrir el proyecto).
import type { AgentRow } from '../db/repos.js';
import { type Ctx, type Handler, asParams, requireProject, str } from './context.js';
import { getRobotStatus } from './status.js';

/** Fila de agente tal como viaja a la UI: columnas de la BD + `status` del robot. */
export function agentView(ctx: Ctx, a: AgentRow): AgentRow & { status: string } {
  return { ...a, status: getRobotStatus(ctx, a.id) };
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
      const role = typeof p.role === 'string' && p.role.trim() !== '' ? p.role.trim() : 'programador';
      if (role === 'jefe') throw new Error('agent.create: el jefe se crea solo al abrir el proyecto y solo puede haber uno');
      const model = typeof p.model === 'string' && p.model.trim() !== '' ? p.model.trim() : 'sonnet';
      const color = typeof p.color === 'string' && p.color.trim() !== '' ? p.color.trim() : 'terracota';
      return agentView(ctx, ctx.repos.agents.create({ projectId: project.id, name, provider: 'claude', model, role, color }));
    },
  };
}
