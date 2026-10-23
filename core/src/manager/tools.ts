// Herramientas del gerente (PLAN-0.2b, D21–D23). Cada una se define UNA vez (esquema zod + validación + ejecución)
// y se convierte a (a) `createSdkMcpServer({name:'kiji'})` para Claude nativo (llegan como `mcp__kiji__<tool>`) y
// (b) `ExtraTool` (tools de OpenAI) para el api-loop. Las dos entradas pasan por `invokeTool`, el ÚNICO camino de ejecución:
//   parsea -> rechaza projectId ajeno -> valida ids contra el proyecto del tick -> aplica la política (auto|notify|ask)
//   -> ejecuta llamando a los mismos handlers que usa la persona -> deja la línea en `manager_actions`.
// Fuera por diseño: approval.answer, integration.revert, project.*, connection.*, settings.*, secrets.* (no existen aquí).
import { existsSync } from 'node:fs';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { ExtraTool } from '../adapters/types.js';
import type { TaskRow } from '../db/repos.js';
import { diff } from '../git/worktree.js';
import type { Ctx } from '../orchestrator/context.js';
import { integrateTask } from '../orchestrator/integration.js';
import { addMemory, recallMemory } from '../orchestrator/memory.js';
import { notify } from '../orchestrator/notifications.js';
import { forkPoint } from '../orchestrator/ownership.js';
import { dequeue, queuePosition, requestStart } from '../orchestrator/queue.js';
import { checkStartable, stopTask } from '../orchestrator/runs.js';
import { switchTask } from '../orchestrator/relay.js';
import { normalizeTaskPath, recordFinding, reviewTask, taskHandlers } from '../orchestrator/tasks.js';
import {
  type LevelKey, findPendingAsk, managerCostToday, projectSpendToday, readPolicy, recordAction, requestApproval, stricter,
} from './policy.js';
import type { AutonomyLevel } from '../../../shared/protocol.js';

export const MAX_RETRIES = 2;
const OUTPUT_MAX = 8000;

/** Estado de un tick que comparten sus herramientas. `projectId` lo fija el core: el modelo no lo elige. */
export interface ToolEnv {
  ctx: Ctx;
  projectId: string;
  tickId: string;
  /** Tras `done` (o al acabar el tick) las herramientas se rechazan. */
  closed: boolean;
  summary: string | null;
}
export const newToolEnv = (ctx: Ctx, projectId: string, tickId: string): ToolEnv => ({ ctx, projectId, tickId, closed: false, summary: null });

/** Error esperable de una herramienta: el mensaje vuelve al modelo. */
export class ToolError extends Error {}

interface Prepared {
  /** Frase corta para el diario, el aviso y la pregunta. */
  summary: string;
  taskId?: string;
  run: () => Promise<unknown>;
}
interface ToolDef {
  name: string;
  description: string;
  shape: z.ZodRawShape;
  /** Categoría de la política; sin ella la herramienta es siempre `auto`. */
  category?: Exclude<LevelKey, 'spend'>;
  /** Arranca runs: cuenta para el tope del día y para `spend`. */
  spends?: boolean;
  /** Siempre pregunta a la persona (ask_user). */
  alwaysAsk?: boolean;
  /** Clave para no preguntar dos veces lo mismo. */
  keyOf?: (args: any) => string;
  prepare: (env: ToolEnv, args: any) => Prepared | Promise<Prepared>;
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const idStr = z.string().min(1).max(100);

// ---------------------------------------------------------------------------
// Validación de ids contra el proyecto del tick
// ---------------------------------------------------------------------------

const projectOfTaskRow = (ctx: Ctx, t: TaskRow): string | undefined => ctx.repos.objectives.get(t.objective_id)?.project_id;

function taskOf(env: ToolEnv, id: string): TaskRow {
  const t = env.ctx.repos.tasks.get(id);
  if (!t || projectOfTaskRow(env.ctx, t) !== env.projectId) throw new ToolError(`la tarea ${id} no existe en este proyecto`);
  return t;
}
function agentOf(env: ToolEnv, id: string) {
  const a = env.ctx.repos.agents.get(id);
  if (!a || a.project_id !== env.projectId) throw new ToolError(`el robot ${id} no existe en este proyecto`);
  return a;
}
function objectiveOf(env: ToolEnv, id: string) {
  const o = env.ctx.repos.objectives.get(id);
  if (!o || o.project_id !== env.projectId) throw new ToolError(`el objetivo ${id} no existe en este proyecto`);
  return o;
}

const roleOfTask = (t: TaskRow): string | null => {
  try {
    const r = (JSON.parse(t.acceptance ?? 'null') as { role?: unknown } | null)?.role;
    return typeof r === 'string' ? r : null;
  } catch {
    return null;
  }
};

/** Reintentos ya hechos por el gerente en la tarea (acciones `retry_task` con resultado ok). */
export function retriesUsed(ctx: Ctx, projectId: string, taskId: string): number {
  const rows = ctx.db.prepare("SELECT input, result FROM manager_actions WHERE project_id = ? AND tool = 'retry_task'").all(projectId) as Array<{ input: string; result: string }>;
  let n = 0;
  for (const r of rows) {
    try {
      if ((JSON.parse(r.input) as { taskId?: string }).taskId === taskId && (JSON.parse(r.result) as { ok?: boolean }).ok === true) n++;
    } catch { /* línea ilegible: no cuenta */ }
  }
  return n;
}

// ---------------------------------------------------------------------------
// get_state
// ---------------------------------------------------------------------------

/** Estado que ve el gerente (lo usa `get_state` y el prompt del tick). Acotado en tamaño. */
export function buildState(ctx: Ctx, projectId: string): Record<string, unknown> {
  const project = ctx.projects.get(projectId) ?? ctx.repos.projects.get(projectId);
  const policy = readPolicy(ctx, projectId);
  const busy = new Map<string, string>();
  for (const l of ctx.live.values()) if (l.projectId === projectId) busy.set(l.agentId, l.taskId);
  const objectives = ctx.repos.objectives.list(projectId);
  const tasks = ctx.repos.tasks.listByProject(projectId);
  const shown = tasks.filter((t) => t.status !== 'integrated').concat(tasks.filter((t) => t.status === 'integrated').slice(-10)).slice(-60);
  return {
    project: { name: project?.name, baseBranch: project?.base_branch, testCommand: project?.test_command },
    halted: ctx.halted,
    objectives: objectives.slice(-15).map((o) => {
      const by: Record<string, number> = {};
      for (const t of tasks) if (t.objective_id === o.id) by[t.status] = (by[t.status] ?? 0) + 1;
      return { id: o.id, text: clip(o.text, 300), status: o.status, tasksByStatus: by };
    }),
    tasks: shown.map((t) => ({
      id: t.id, objectiveId: t.objective_id, title: clip(t.title, 120), status: t.status, column: t.board_column, agentId: t.agent_id,
      role: roleOfTask(t), files: ctx.repos.taskFiles.list(t.id, true).map((f) => f.path).slice(0, 12),
      readOnly: ctx.repos.taskFiles.list(t.id).length === 0, queuePosition: queuePosition(ctx, t.id),
      retriesUsed: retriesUsed(ctx, projectId, t.id), costUsd: Number(ctx.repos.runs.costByTask(t.id).toFixed(4)),
      runningFor: ctx.live.get(t.id) ? Math.round((Date.now() - (ctx.repos.runs.get(ctx.live.get(t.id)!.runId)?.started_at ?? Date.now())) / 60000) : null,
    })),
    agents: ctx.repos.agents.list(projectId).map((a) => ({
      id: a.id, name: a.name, role: a.role, model: a.model, isBoss: a.is_boss === 1, busyWithTask: busy.get(a.id) ?? null,
    })),
    queue: ctx.queue.filter((e) => e.projectId === projectId).map((e, i) => ({ taskId: e.taskId, position: i + 1, blockedBy: e.blockedBy })),
    pendingQuestions: [...ctx.managerAsks.values()].filter((a) => a.projectId === projectId).map((a) => ({ approvalId: a.approvalId, summary: a.summary })),
    spend: {
      projectTodayUsd: Number(projectSpendToday(ctx, projectId).toFixed(4)),
      managerTodayUsd: Number(managerCostToday(ctx, projectId).toFixed(4)),
      dayBudgetUsd: policy?.dayBudgetUsd ?? null, spendAskUsd: policy?.spendAskUsd ?? null,
    },
    levels: policy?.levels ?? null,
  };
}

// ---------------------------------------------------------------------------
// Definiciones
// ---------------------------------------------------------------------------

const findingsSchema = z.array(z.string().min(1).max(2000)).max(20);

function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

const DEFS: ToolDef[] = [
  {
    name: 'get_state',
    description: 'Estado actual del proyecto: objetivos, tareas (con reintentos usados), robots, cola, gasto de hoy y política.',
    shape: {},
    prepare: (env) => ({ summary: 'leer el estado', run: async () => ({ ok: true, ...buildState(env.ctx, env.projectId) }) }),
  },
  {
    name: 'create_tasks',
    description:
      'Crea las tareas de un plan. Cada tarea: título, descripción, archivos que podrá modificar (sin archivos = consulta de solo lectura) y rol (opcional). ' +
      'Los archivos de una tarea no pueden solaparse con los de otra del plan ni con los de tareas vivas. Las tareas nacen sin robot: usa assign_task.',
    shape: {
      objectiveId: idStr.optional().describe('Objetivo al que pertenecen; por defecto el último abierto'),
      tasks: z.array(z.object({
        title: z.string().min(1).max(200),
        description: z.string().max(4000).optional(),
        files: z.array(z.string().min(1).max(300)).max(50).optional(),
        role: z.string().min(1).max(60).optional(),
      })).min(1).max(20),
    },
    category: 'plan',
    prepare: (env, args: { objectiveId?: string; tasks: Array<{ title: string; description?: string; files?: string[]; role?: string }> }) => {
      const { ctx } = env;
      const objectiveId = args.objectiveId
        ? objectiveOf(env, args.objectiveId).id
        : ctx.repos.objectives.list(env.projectId).filter((o) => o.status !== 'done').at(-1)?.id;
      const roles = new Set(ctx.repos.agents.list(env.projectId).filter((a) => a.is_boss === 0 && a.role).map((a) => a.role!));
      const live = (ctx.db.prepare('SELECT path, task_id FROM task_files WHERE project_id = ? AND active = 1').all(env.projectId) as Array<{ path: string; task_id: string }>);
      const seen = new Set<string>();
      const owners: Array<{ path: string; index: number }> = [];
      const plan = args.tasks.map((t, index) => {
        const title = t.title.trim();
        if (title === '') throw new ToolError(`la tarea ${index + 1} no tiene título`);
        if (seen.has(title.toLowerCase())) throw new ToolError(`título repetido en el plan: «${title}»`);
        seen.add(title.toLowerCase());
        if (t.role !== undefined && !roles.has(t.role)) {
          throw new ToolError(`el rol «${t.role}» no existe en el equipo (hay: ${[...roles].join(', ') || 'ninguno'})`);
        }
        let files: string[];
        try {
          files = [...new Set((t.files ?? []).map(normalizeTaskPath))];
        } catch (e) {
          throw new ToolError(`tarea «${title}»: ${msg(e)}`);
        }
        for (const f of files) {
          const other = owners.find((o) => o.index !== index && overlaps(o.path, f));
          if (other) throw new ToolError(`«${f}» se solapa con «${other.path}» de la tarea «${args.tasks[other.index]!.title}» del mismo plan: cada archivo, una sola tarea`);
          const busy = live.find((l) => overlaps(l.path, f));
          if (busy) throw new ToolError(`«${f}» ya pertenece a la tarea viva «${ctx.repos.tasks.get(busy.task_id)?.title ?? busy.task_id}»`);
          owners.push({ path: f, index });
        }
        return { title, description: t.description ?? '', files, role: t.role };
      });
      return {
        summary: `crear ${plan.length} tarea(s): ${plan.map((p) => `«${clip(p.title, 40)}»`).join(', ')}`,
        run: async () => {
          const create = taskHandlers(ctx)['task.create']!;
          const created: Array<{ id: string; title: string; role: string | null }> = [];
          for (const p of plan) {
            const v = (await create({ projectId: env.projectId, title: p.title, description: p.description, files: p.files, ...(objectiveId ? { objectiveId } : {}) })) as { id: string };
            if (p.role) ctx.repos.tasks.update(v.id, { acceptance: JSON.stringify({ role: p.role }) });
            created.push({ id: v.id, title: p.title, role: p.role ?? null });
          }
          return { ok: true, created };
        },
      };
    },
  },
  {
    name: 'assign_task',
    description: 'Asigna un robot a una tarea. Sin agentId se elige uno libre del rol de la tarea.',
    shape: { taskId: idStr, agentId: idStr.optional() },
    category: 'assign',
    keyOf: (a) => `assign_task:${a.taskId}:${a.agentId ?? ''}`,
    prepare: (env, args: { taskId: string; agentId?: string }) => {
      const { ctx } = env;
      const task = taskOf(env, args.taskId);
      if (!['todo', 'assigned', 'changes', 'blocked', 'failed', 'paused_limit'].includes(task.status) || ctx.live.has(task.id)) {
        throw new ToolError(`no se puede asignar una tarea en estado ${task.status}`);
      }
      let agentId = args.agentId;
      if (agentId) agentOf(env, agentId);
      else {
        const role = roleOfTask(task);
        const busyIds = new Set([...ctx.live.values()].map((l) => l.agentId));
        const load = (id: string) => ctx.repos.tasks.listByProject(env.projectId).filter((t) => t.agent_id === id && !['integrated', 'failed'].includes(t.status)).length;
        const pick = ctx.repos.agents.list(env.projectId)
          .filter((a) => a.is_boss === 0 && (role === null || a.role === role))
          .sort((a, b) => Number(busyIds.has(a.id)) - Number(busyIds.has(b.id)) || load(a.id) - load(b.id))[0];
        if (!pick) throw new ToolError(role ? `no hay ningún robot con el rol «${role}»` : 'no hay robots trabajadores en el equipo');
        agentId = pick.id;
      }
      const name = ctx.repos.agents.get(agentId)!.name;
      return {
        summary: `asignar «${clip(task.title, 50)}» a ${name}`, taskId: task.id,
        run: async () => {
          const v = (await taskHandlers(ctx)['task.assign']!({ id: task.id, projectId: env.projectId, agent_id: agentId })) as TaskRow;
          return { ok: true, taskId: task.id, agentId, status: v.status };
        },
      };
    },
  },
  {
    name: 'start_task',
    description: 'Arranca una tarea asignada (o la deja en la cola global si no hay hueco o presupuesto).',
    shape: { taskId: idStr },
    category: 'start',
    spends: true,
    keyOf: (a) => `start_task:${a.taskId}`,
    prepare: (env, args: { taskId: string }) => {
      const task = taskOf(env, args.taskId);
      try {
        checkStartable(env.ctx, task.id);
      } catch (e) {
        throw new ToolError(msg(e));
      }
      return {
        summary: `arrancar «${clip(task.title, 60)}»`, taskId: task.id,
        run: async () => {
          const v = await requestStart(env.ctx, task.id, { startedBy: 'manager' });
          return { ok: true, taskId: task.id, status: v.status, queued: v.queued };
        },
      };
    },
  },
  {
    name: 'stop_task',
    description: 'Para el run de una tarea (o la saca de la cola). La tarea vuelve a «assigned».',
    shape: { taskId: idStr },
    prepare: (env, args: { taskId: string }) => {
      const task = taskOf(env, args.taskId);
      const queued = env.ctx.queue.some((e) => e.taskId === task.id);
      if (!env.ctx.live.has(task.id) && !queued) throw new ToolError('la tarea no tiene un run en curso ni está en la cola');
      return {
        summary: `parar «${clip(task.title, 60)}»`, taskId: task.id,
        run: async () => {
          if (!env.ctx.live.has(task.id) && dequeue(env.ctx, task.id)) return { ok: true, taskId: task.id, status: 'queued-removed' };
          const v = await stopTask(env.ctx, task.id, 'detenida por el gerente');
          return { ok: true, taskId: task.id, status: v.status };
        },
      };
    },
  },
  {
    name: 'retry_task',
    description: `Reintenta una tarea «failed» o «changes» con hallazgos concretos para el robot. Máximo ${MAX_RETRIES} reintentos por tarea.`,
    shape: { taskId: idStr, findings: findingsSchema.min(1) },
    category: 'retry',
    spends: true,
    keyOf: (a) => `retry_task:${a.taskId}`,
    prepare: (env, args: { taskId: string; findings: string[] }) => {
      const task = taskOf(env, args.taskId);
      if (task.status !== 'failed' && task.status !== 'changes') throw new ToolError(`solo se reintentan tareas failed o changes (esta está en ${task.status})`);
      const used = retriesUsed(env.ctx, env.projectId, task.id);
      if (used >= MAX_RETRIES) throw new ToolError(`la tarea ya se reintentó ${used} veces (máximo ${MAX_RETRIES}): avisa a la persona con notify_user o ask_user`);
      try {
        checkStartable(env.ctx, task.id);
      } catch (e) {
        throw new ToolError(msg(e));
      }
      return {
        summary: `reintentar «${clip(task.title, 50)}» (${used + 1}/${MAX_RETRIES})`, taskId: task.id,
        run: async () => {
          const findings = args.findings.map((f) => f.trim()).filter(Boolean);
          recordFinding(env.ctx, task, 'manager', findings.length === 1 ? findings[0]! : findings.map((f) => `- ${f}`).join('\n'));
          const v = await requestStart(env.ctx, task.id, { startedBy: 'manager' });
          return { ok: true, taskId: task.id, status: v.status, queued: v.queued, retry: used + 1 };
        },
      };
    },
  },
  {
    name: 'switch_task',
    description: 'Cambia el modelo (opus|sonnet|haiku) o el robot (agentId) de una tarea en marcha o pausada por límite.',
    shape: { taskId: idStr, model: z.string().min(1).max(60).optional(), agentId: idStr.optional() },
    category: 'relay',
    spends: true,
    keyOf: (a) => `switch_task:${a.taskId}:${a.model ?? ''}:${a.agentId ?? ''}`,
    prepare: (env, args: { taskId: string; model?: string; agentId?: string }) => {
      const task = taskOf(env, args.taskId);
      if (args.model === undefined && args.agentId === undefined) throw new ToolError('indica model y/o agentId');
      if (args.agentId) agentOf(env, args.agentId);
      return {
        summary: `cambiar ${args.model ? `a ${args.model}` : 'de robot'} la tarea «${clip(task.title, 50)}»`, taskId: task.id,
        run: async () => {
          const v = (await switchTask(env.ctx, { taskId: task.id, projectId: env.projectId, ...(args.model ? { model: args.model } : {}), ...(args.agentId ? { agentId: args.agentId } : {}) })) as TaskRow;
          return { ok: true, taskId: task.id, status: v.status };
        },
      };
    },
  },
  {
    name: 'review_task',
    description: 'Revisa una tarea en «review»: approve (pasa a aprobada; una consulta de solo lectura queda integrada) o changes (con hallazgos).',
    shape: { taskId: idStr, verdict: z.enum(['approve', 'changes']), findings: findingsSchema.optional() },
    prepare: (env, args: { taskId: string; verdict: 'approve' | 'changes'; findings?: string[] }) => {
      const task = taskOf(env, args.taskId);
      if (task.status !== 'review') throw new ToolError(`solo se revisan tareas en review (esta está en ${task.status})`);
      if (args.verdict === 'changes' && (args.findings ?? []).filter((f) => f.trim()).length === 0) throw new ToolError('para pedir cambios indica al menos un hallazgo');
      return {
        summary: `${args.verdict === 'approve' ? 'aprobar' : 'pedir cambios en'} «${clip(task.title, 60)}»`, taskId: task.id,
        run: async () => {
          const v = reviewTask(env.ctx, task.id, args.verdict, args.findings ?? []);
          return { ok: true, taskId: task.id, status: v.status };
        },
      };
    },
  },
  {
    name: 'get_diff',
    description: 'Diff de la tarea respecto a la rama base (recortado).',
    shape: { taskId: idStr },
    prepare: (env, args: { taskId: string }) => {
      const task = taskOf(env, args.taskId);
      const project = env.ctx.repos.projects.get(env.projectId)!;
      if (!task.worktree_path || !existsSync(task.worktree_path)) throw new ToolError('la tarea no tiene worktree (consulta de solo lectura, sin iniciar o ya integrada)');
      return {
        summary: `leer el diff de «${clip(task.title, 60)}»`, taskId: task.id,
        run: async () => {
          const base = await forkPoint(task.worktree_path!, project.base_branch);
          return { ok: true, diff: clip(await diff(task.worktree_path!, base), 12_000) };
        },
      };
    },
  },
  {
    name: 'get_test_output',
    description: 'Última salida de los tests de la tarea.',
    shape: { taskId: idStr },
    prepare: (env, args: { taskId: string }) => {
      const task = taskOf(env, args.taskId);
      return {
        summary: `leer los tests de «${clip(task.title, 60)}»`, taskId: task.id,
        run: async () => {
          const t = env.ctx.repos.testRuns.latestByTask(task.id);
          return t ? { ok: true, command: t.command, exitCode: t.exit_code, output: t.output.slice(-4000) } : { ok: true, output: null, message: 'sin tests registrados' };
        },
      };
    },
  },
  {
    name: 'request_integration',
    description: 'Pide integrar en la rama base una tarea aprobada (rebase, tests y merge). Según la política puede quedar a la espera de la persona.',
    shape: { taskId: idStr },
    category: 'integrate',
    keyOf: (a) => `request_integration:${a.taskId}`,
    prepare: (env, args: { taskId: string }) => {
      const task = taskOf(env, args.taskId);
      if (task.status !== 'approved') throw new ToolError(`solo se integran tareas aprobadas (esta está en ${task.status})`);
      if (env.ctx.repos.taskFiles.list(task.id).length === 0) throw new ToolError('es una consulta de solo lectura: no hay nada que integrar');
      return {
        summary: `integrar «${clip(task.title, 60)}» en la rama base`, taskId: task.id,
        run: async () => {
          const v = await integrateTask(env.ctx, task.id);
          return { ok: v.status === 'applied', taskId: task.id, integration: v.status, detail: clip(v.detail, 500) };
        },
      };
    },
  },
  {
    name: 'remember',
    description: 'Guarda en la memoria del proyecto un dato útil para futuros despertares (fact | decision | preference | todo).',
    shape: { kind: z.enum(['fact', 'decision', 'preference', 'todo']), text: z.string().min(1).max(2000) },
    prepare: (env, args: { kind: string; text: string }) => ({
      summary: 'guardar en la memoria',
      run: async () => ({ ok: true, id: addMemory(env.ctx, env.projectId, args.kind, args.text, 'manager').id }),
    }),
  },
  {
    name: 'recall',
    description: 'Busca en la memoria del proyecto (texto libre).',
    shape: { query: z.string().min(1).max(200) },
    prepare: (env, args: { query: string }) => ({
      summary: 'buscar en la memoria',
      run: async () => ({ ok: true, memories: recallMemory(env.ctx, env.projectId, args.query, 10).map((m) => ({ id: m.id, kind: m.kind, text: m.text })) }),
    }),
  },
  {
    name: 'notify_user',
    description: 'Avisa a la persona (notificación). Texto breve, sin rutas absolutas ni código.',
    shape: { text: z.string().min(1).max(500), level: z.enum(['info', 'warn']).optional() },
    prepare: (env, args: { text: string; level?: 'info' | 'warn' }) => ({
      summary: 'avisar a la persona',
      run: async () => {
        notify(env.ctx, { projectId: env.projectId, level: args.level ?? 'info', title: 'Aviso del gerente', body: args.text });
        return { ok: true };
      },
    }),
  },
  {
    name: 'ask_user',
    description: 'Hace una pregunta a la persona y espera su respuesta (sí/no, o una de las opciones). Sin respuesta a tiempo cuenta como NO. Recibirás la respuesta en tu próximo despertar; no sigas como si ya hubiera dicho que sí.',
    shape: { question: z.string().min(1).max(500), options: z.array(z.string().min(1).max(80)).max(4).optional() },
    alwaysAsk: true,
    keyOf: (a) => `ask_user:${a.question}`,
    prepare: (_env, args: { question: string; options?: string[] }) => ({
      summary: clip(args.question, 120),
      run: async () => ({ ok: true, answer: 'sí' }),
    }),
  },
  {
    name: 'done',
    description: 'Termina este despertar con un resumen breve de lo decidido y lo pendiente. Llámala siempre al final.',
    shape: { summary: z.string().min(1).max(1500) },
    prepare: (env, args: { summary: string }) => ({
      summary: 'cerrar el despertar',
      run: async () => {
        env.summary = args.summary.trim();
        addMemory(env.ctx, env.projectId, 'decision', env.summary, 'manager');
        return { ok: true };
      },
    }),
  },
];

export const TOOL_NAMES: readonly string[] = DEFS.map((d) => d.name);

// ---------------------------------------------------------------------------
// Ejecución
// ---------------------------------------------------------------------------

export type ToolOutput = { output: string; isError: boolean };
const out = (v: unknown, isError = false): ToolOutput => ({ output: clip(JSON.stringify(v), OUTPUT_MAX), isError });

/** El único camino por el que una llamada del modelo llega a Kiji. Nunca lanza. */
export async function invokeTool(env: ToolEnv, name: string, raw: unknown): Promise<ToolOutput> {
  const { ctx, projectId, tickId } = env;
  const def = DEFS.find((d) => d.name === name);
  const log = (tool: string, level: AutonomyLevel, result: unknown, decidedBy: 'policy' | 'user' | 'timeout' | null = 'policy', input: unknown = raw): void => {
    recordAction(ctx, { tickId, projectId, tool, input: input ?? {}, result, level, decidedBy });
  };
  const fail = (error: string, input: unknown = raw): ToolOutput => {
    log(def?.name ?? name, 'auto', { ok: false, error }, 'policy', input);
    return out({ ok: false, error }, true);
  };

  if (!def) return fail(`herramienta desconocida: ${name}. Las únicas disponibles son: ${TOOL_NAMES.join(', ')}.`);
  if (env.closed) return fail('este despertar ya terminó: no se admiten más llamadas.');
  const input = raw === undefined || raw === null ? {} : raw;
  if (typeof input !== 'object' || Array.isArray(input)) return fail('los argumentos deben ser un objeto');
  // El proyecto lo fija el core: un projectId distinto del del tick es un intento de salirse de él.
  const given = (input as Record<string, unknown>).projectId;
  if (given !== undefined && given !== projectId) return fail('projectId lo fija Kiji y no coincide con el proyecto de este despertar: no se puede cambiar');
  const parsed = z.object(def.shape).safeParse(input);
  if (!parsed.success) return fail(`argumentos no válidos: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(raíz)'}: ${i.message}`).join('; ')}`);
  const args = parsed.data;

  if (ctx.halted) return fail('Parada global activa: no se hace nada hasta que la persona pulse «Reanudar».', args);
  const policy = readPolicy(ctx, projectId);
  if (!policy?.enabled) return fail('el gerente está apagado en este proyecto', args);

  let prepared: Prepared;
  try {
    prepared = await def.prepare(env, args);
  } catch (e) {
    return fail(msg(e), args);
  }

  let level: AutonomyLevel = def.alwaysAsk ? 'ask' : def.category ? policy.levels[def.category] : 'auto';
  if (def.spends) {
    if (managerCostToday(ctx, projectId) >= policy.dayBudgetUsd) {
      return fail(`tope del día alcanzado (${policy.dayBudgetUsd} USD entre el gerente y los robots que arrancó): no se gasta más hoy`, args);
    }
    if (projectSpendToday(ctx, projectId) >= policy.spendAskUsd) level = stricter(level, policy.levels.spend);
  }

  if (level === 'ask') {
    const key = def.keyOf ? def.keyOf(args) : `${def.name}:${JSON.stringify(args)}`;
    if (findPendingAsk(ctx, projectId, key)) {
      log(def.name, 'ask', { ok: false, pending: true, message: 'ya hay una pregunta igual esperando' }, 'policy', args);
      return out({ ok: false, pending: true, message: 'Ya hay una pregunta igual esperando respuesta de la persona; no la repitas.' });
    }
    requestApproval(ctx, {
      projectId, tickId, tool: def.name, args, summary: prepared.summary, taskId: prepared.taskId ?? null,
      kind: def.name === 'request_integration' ? 'integrate' : 'manager', key,
      ...(def.name === 'ask_user' ? { question: (args as { question: string }).question, options: (args as { options?: string[] }).options } : {}),
      // Al aprobar se revalida (el estado pudo cambiar) y se ejecuta con un entorno nuevo, ajeno al tick ya cerrado.
      execute: async () => (await def.prepare({ ...env, closed: false }, args)).run(),
    });
    return out({ ok: false, pending: true, message: 'Se preguntó a la persona; la acción NO se ha hecho. Seguirá cuando conteste (o se da por NO si no contesta a tiempo).' });
  }

  ctx.manager?.acting(projectId, 1);
  try {
    const result = await prepared.run();
    log(def.name, level, result, 'policy', args);
    if (level === 'notify') notify(ctx, { projectId, level: 'info', title: 'El gerente ha actuado', body: prepared.summary });
    if (def.name === 'done') env.closed = true;
    return out(result);
  } catch (e) {
    return fail(msg(e), args);
  } finally {
    ctx.manager?.acting(projectId, -1);
  }
}

// ---------------------------------------------------------------------------
// Conversión a los dos formatos
// ---------------------------------------------------------------------------

/** (a) Servidor MCP del SDK para Claude nativo: las herramientas llegan como `mcp__kiji__<tool>`. */
export function toSdkServer(env: ToolEnv) {
  return createSdkMcpServer({
    name: 'kiji',
    tools: DEFS.map((d) =>
      tool(d.name, d.description, d.shape as any, async (args: unknown) => {
        const r = await invokeTool(env, d.name, args);
        return { content: [{ type: 'text' as const, text: r.output }], ...(r.isError ? { isError: true } : {}) };
      }),
    ),
  });
}

const stripSchemaNoise = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(stripSchemaNoise);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).filter(([k]) => k !== '$schema' && k !== 'additionalProperties').map(([k, x]) => [k, stripSchemaNoise(x)]));
  }
  return v;
};

/** (b) Tools para el api-loop (OpenAI-compat). */
export function toExtraTools(env: ToolEnv): ExtraTool[] {
  return DEFS.map((d) => ({
    name: d.name,
    description: d.description,
    parameters: stripSchemaNoise(z.toJSONSchema(z.object(d.shape))) as Record<string, unknown>,
    execute: (args: unknown) => invokeTool(env, d.name, args),
  }));
}
