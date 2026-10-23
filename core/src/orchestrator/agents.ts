// Agentes: agent.list, agent.create y agent.update (en 0.1 solo Claude; el jefe se crea solo al abrir el proyecto).
import type { AgentRow, ConnectionRow } from '../db/repos.js';
import { type Ctx, type Handler, asParams, assertSameProject, optionalProject, projectIdOf, requireProject, str } from './context.js';
import { notifyConnections, parseConnTarget } from './connections.js';
import { modelFamily } from './quota.js';
import { autoRelayDefault, defaultModelTarget } from './settings.js';
import { loadSkills } from './skills.js';
import { getRobotStatus } from './status.js';
import { scheduleWorkspacesNotify } from './workspaces.js';

export type AgentView = Omit<AgentRow, 'skills' | 'relay_order'> & {
  /** Proyecto del agente (0.2c). */
  projectId: string;
  status: string;
  skills: string[];
  relay_order: string[];
  /** Modelo en uso ahora: el del run vivo (puede ser un relevo) o el preferido del agente. */
  current_model: string;
};

const stringArray = (raw: string | null): string[] | null => {
  if (raw === null) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null;
  } catch {
    return null;
  }
};

/** Orden de relevo por defecto: opus, sonnet, haiku sin el modelo propio (que va primero, D10). */
export const defaultRelayOrder = (own: string | null): string[] =>
  ['opus', 'sonnet', 'haiku'].filter((m) => modelFamily(m) !== modelFamily(own ?? 'sonnet'));

/** Orden de relevo efectivo de un agente (el guardado o el de por defecto). */
export const relayOrderOf = (a: Pick<AgentRow, 'relay_order' | 'model'> & { connection_id?: string | null }): string[] =>
  stringArray(a.relay_order) ?? (a.connection_id ? [] : defaultRelayOrder(a.model));

/** Fila de agente tal como viaja a la UI: columnas de la BD (JSON ya parseado) + `status` del robot y `current_model`. */
export function agentView(ctx: Ctx, a: AgentRow): AgentView {
  const live = [...ctx.live.values()].find((l) => l.agentId === a.id);
  return {
    ...a,
    projectId: a.project_id,
    skills: stringArray(a.skills) ?? [],
    relay_order: relayOrderOf(a),
    status: getRobotStatus(ctx, a.id),
    current_model: live?.model ?? a.model ?? 'sonnet',
  };
}

/** Roles que se pueden elegir al crear un agente (el `jefe` se crea solo al abrir el proyecto). Mantener en sync con src/screens/CreateAgent/options.ts. */
export const AGENT_ROLES = ['programador', 'tester', 'explorador', 'modelador-2d', 'documentador', 'revisor-critico'] as const;
/** Paletas de los robots (las que entiende la escena: `paletteFor`). */
export const AGENT_COLORS = ['terracota', 'azul', 'verde', 'crema'] as const;
/** Alias de modelo permitidos para el proveedor `claude`. */
export const CLAUDE_MODELS = ['sonnet', 'opus', 'haiku'] as const;
export const AGENT_NAME_MAX = 24;
export const PERSONA_MAX = 4000;
export const SKILLS_MAX = 30;

/** Elige de una lista cerrada; si el valor falta usa el valor por defecto y si no está en la lista lanza un error claro. */
function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string, fallback: T): T {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) return fallback;
  const v = typeof value === 'string' ? value.trim() : value;
  if (!(allowed as readonly unknown[]).includes(v)) {
    throw new Error(`agent.create: ${field} "${String(value)}" no válido (permitidos: ${allowed.join(', ')})`);
  }
  return v as T;
}

const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const MODEL_MAX = 200;

/** Modelo libre de un agente con conexión: el dado o el de la conexión; se valida contra `connection.models` si responde. */
async function connectionModel(ctx: Ctx, conn: ConnectionRow, raw: unknown, method: string): Promise<{ model: string; warning?: string }> {
  let model: string;
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    if (!conn.default_model) throw new Error(`${method}: indica "model": la conexión «${conn.name}» no tiene modelo por defecto`);
    model = conn.default_model;
  } else {
    if (typeof raw !== 'string') throw new Error(`${method}: "model" debe ser texto`);
    model = raw.trim();
  }
  if (model.length > MODEL_MAX || CONTROL_RE.test(model)) throw new Error(`${method}: nombre de modelo no válido`);
  try {
    const warning = (await ctx.conn?.checkModel(conn, model)) ?? undefined;
    return warning ? { model, warning } : { model };
  } catch (e) {
    throw new Error(`${method}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Elemento de `relay_order`: alias de Claude o `conn:<uuid>/<modelo>` de una conexión que existe. */
export function validateRelayTarget(ctx: Ctx, m: unknown): string {
  if (typeof m === 'string' && (CLAUDE_MODELS as readonly string[]).includes(m)) return m;
  const t = typeof m === 'string' ? parseConnTarget(m) : null;
  if (!t || t.model.length > MODEL_MAX || CONTROL_RE.test(t.model)) {
    throw new Error(`agent.update: modelo de relevo "${String(m)}" no válido (permitidos: ${CLAUDE_MODELS.join(', ')} o conn:<id>/<modelo>)`);
  }
  if (!ctx.repos.connections.get(t.connectionId)) throw new Error(`agent.update: la conexión de "${String(m)}" no existe`);
  return m as string;
}

export function agentHandlers(ctx: Ctx): Record<string, Handler> {
  return {
    /** `{projectId?}` */
    'agent.list': (params) => {
      const project = optionalProject(ctx, projectIdOf(params == null ? {} : asParams(params, 'agent.list')));
      if (!project) return [];
      return ctx.repos.agents.list(project.id).map((a) => agentView(ctx, a));
    },

    'agent.create': async (params) => {
      const p = asParams(params, 'agent.create');
      const project = requireProject(ctx, projectIdOf(p));
      const provider = str(p.provider, 'provider', 'agent.create');
      if (provider === 'codex') throw new Error('agent.create: el proveedor "codex" llega en el paso 15; por ahora solo "claude" o una conexión');
      // 0.2b: con `connectionId` el agente usa esa conexión (provider "api"); sin ella, Claude.
      const connectionId = typeof p.connectionId === 'string' && p.connectionId !== '' ? p.connectionId : null;
      if (p.connectionId !== undefined && p.connectionId !== null && connectionId === null) throw new Error('agent.create: "connectionId" debe ser un texto');
      if (connectionId === null) {
        if (['api', 'ollama', 'gemini', 'openai'].includes(provider)) throw new Error(`agent.create: con el proveedor "${provider}" indica "connectionId" (crea una conexión en Conexiones)`);
        if (provider !== 'claude') throw new Error(`agent.create: proveedor desconocido "${provider}" (claude o una conexión)`);
      }
      // 0.4b: sin modelo explícito, el ajuste `default_model` (alias de Claude o una conexión existente).
      const noModel = p.model === undefined || p.model === null || (typeof p.model === 'string' && p.model.trim() === '');
      const defTarget = defaultModelTarget(ctx);
      let modelInput: unknown = p.model;
      if (noModel && connectionId !== null && 'connectionId' in defTarget && defTarget.connectionId === connectionId) modelInput = defTarget.model;
      const conn = connectionId === null ? null : ctx.repos.connections.get(connectionId);
      if (connectionId !== null && !conn) throw new Error('agent.create: la conexión no existe');

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
      let model: string;
      let warning: string | undefined;
      if (conn) {
        ({ model, warning } = await connectionModel(ctx, conn, modelInput, 'agent.create'));
      } else {
        model = oneOf(p.model, CLAUDE_MODELS, 'modelo', 'alias' in defTarget ? (defTarget.alias as (typeof CLAUDE_MODELS)[number]) : 'sonnet');
      }
      const color = oneOf(p.color, AGENT_COLORS, 'color', 'terracota');
      if (p.autoRelay !== undefined && typeof p.autoRelay !== 'boolean') throw new Error('agent.create: "autoRelay" debe ser true o false');
      const autoRelay = typeof p.autoRelay === 'boolean' ? p.autoRelay : autoRelayDefault(ctx);
      const row = ctx.repos.agents.create({ projectId: project.id, name, provider: conn ? 'api' : 'claude', model, role, color, connectionId: conn?.id ?? null, autoRelay });
      const view = agentView(ctx, row);
      scheduleWorkspacesNotify(ctx);
      return warning ? { ...view, warning } : view;
    },

    /** `{agentId, name?, model?, color?, persona?, skills?, relayOrder?, autoRelay?}`: perfil del agente (D12). */
    'agent.update': async (params) => {
      const p = asParams(params, 'agent.update');
      const agent = ctx.repos.agents.get(str(p.agentId, 'agentId', 'agent.update'));
      if (!agent) throw new Error('agent.update: agente inexistente en este proyecto');
      assertSameProject(p, agent.project_id, 'agent.update');
      if (!ctx.projects.has(agent.project_id)) throw new Error('agent.update: el proyecto del agente no está abierto');
      const patch: Partial<Pick<AgentRow, 'name' | 'model' | 'color' | 'persona' | 'skills' | 'relay_order' | 'auto_relay' | 'provider' | 'connection_id'>> = {};
      let warning: string | undefined;

      if (p.name !== undefined) {
        if (typeof p.name !== 'string' || p.name.trim() === '') throw new Error('agent.update: "name" debe ser un texto no vacío');
        const name = p.name.trim();
        if (name.length > AGENT_NAME_MAX) throw new Error(`agent.update: el nombre admite como máximo ${AGENT_NAME_MAX} caracteres`);
        if (/[\u0000-\u001f\u007f]/.test(name)) throw new Error('agent.update: el nombre no puede llevar saltos de línea ni caracteres de control');
        const taken = ctx.repos.agents.list(agent.project_id).some((a) => a.id !== agent.id && a.name.trim().toLowerCase() === name.toLowerCase());
        if (taken) throw new Error(`agent.update: ya hay un agente llamado "${name}" en este proyecto; elige otro nombre`);
        patch.name = name;
      }
      // 0.2b: conexión del agente (null = Claude nativo). Con conexión, `model` es libre.
      let conn: ConnectionRow | undefined = agent.connection_id ? ctx.repos.connections.get(agent.connection_id) : undefined;
      if (p.connectionId !== undefined) {
        if (p.connectionId !== null && typeof p.connectionId !== 'string') throw new Error('agent.update: "connectionId" debe ser un texto o null');
        const nextId = p.connectionId === '' ? null : p.connectionId;
        if (nextId !== agent.connection_id) {
          if ([...ctx.live.values()].some((l) => l.agentId === agent.id)) throw new Error('agent.update: el agente está en marcha; cambia su IA cuando termine');
          if (agent.is_boss === 1) throw new Error('agent.update: el jefe siempre usa Claude');
          if (nextId === null) {
            conn = undefined;
            Object.assign(patch, { provider: 'claude', connection_id: null });
            if (p.model === undefined) patch.model = 'sonnet'; // el modelo de la conexión no vale para Claude
          } else {
            conn = ctx.repos.connections.get(nextId);
            if (!conn) throw new Error('agent.update: la conexión no existe');
            Object.assign(patch, { provider: 'api', connection_id: nextId });
            if (p.model === undefined) {
              ({ model: patch.model, warning } = await connectionModel(ctx, conn, undefined, 'agent.update'));
            }
          }
        }
      }
      if (p.model !== undefined) {
        if (conn) {
          const r = await connectionModel(ctx, conn, p.model, 'agent.update');
          patch.model = r.model;
          warning = r.warning;
        } else {
          if (typeof p.model !== 'string' || !(CLAUDE_MODELS as readonly string[]).includes(p.model)) {
            throw new Error(`agent.update: modelo "${String(p.model)}" no válido (permitidos: ${CLAUDE_MODELS.join(', ')})`);
          }
          patch.model = p.model;
        }
      }
      if (p.color !== undefined) {
        if (typeof p.color !== 'string' || !(AGENT_COLORS as readonly string[]).includes(p.color)) {
          throw new Error(`agent.update: color "${String(p.color)}" no válido (permitidos: ${AGENT_COLORS.join(', ')})`);
        }
        patch.color = p.color;
      }
      if (p.persona !== undefined) {
        if (typeof p.persona !== 'string') throw new Error('agent.update: "persona" debe ser texto');
        if (p.persona.length > PERSONA_MAX) throw new Error(`agent.update: la personalidad admite como máximo ${PERSONA_MAX} caracteres`);
        if (p.persona.includes('\0')) throw new Error('agent.update: la personalidad no puede llevar caracteres nulos');
        patch.persona = p.persona;
      }
      if (p.skills !== undefined) {
        if (!Array.isArray(p.skills) || p.skills.some((x) => typeof x !== 'string')) throw new Error('agent.update: "skills" debe ser una lista de nombres');
        const names = [...new Set(p.skills as string[])];
        if (names.length > SKILLS_MAX) throw new Error(`agent.update: se admiten como máximo ${SKILLS_MAX} skills`);
        if (names.length > 0) {
          let known = new Set(loadSkills(ctx).map((s) => s.name));
          if (names.some((n) => !known.has(n))) known = new Set(loadSkills(ctx, true).map((s) => s.name)); // pudo instalarse una hace poco
          const missing = names.filter((n) => !known.has(n));
          if (missing.length > 0) throw new Error(`agent.update: skills inexistentes: ${missing.join(', ')} (mira skills.list)`);
        }
        patch.skills = JSON.stringify(names);
      }
      if (p.relayOrder !== undefined) {
        if (!Array.isArray(p.relayOrder)) throw new Error('agent.update: "relayOrder" debe ser una lista de modelos');
        const order = p.relayOrder as unknown[];
        for (const m of order) validateRelayTarget(ctx, m);
        if (new Set(order).size !== order.length) throw new Error('agent.update: "relayOrder" no admite modelos repetidos');
        patch.relay_order = JSON.stringify(order);
      }
      if (p.autoRelay !== undefined) {
        if (typeof p.autoRelay !== 'boolean') throw new Error('agent.update: "autoRelay" debe ser true o false');
        patch.auto_relay = p.autoRelay ? 1 : 0;
      }
      if (Object.keys(patch).length === 0) throw new Error('agent.update: indica al menos un campo que cambiar');

      const view = agentView(ctx, ctx.repos.agents.update(agent.id, patch)!);
      ctx.emit('agent.changed', view);
      scheduleWorkspacesNotify(ctx);
      if (patch.connection_id !== undefined) notifyConnections(ctx); // cambian los "agentes que la usan"
      return warning ? { ...view, warning } : view;
    },
  };
}
