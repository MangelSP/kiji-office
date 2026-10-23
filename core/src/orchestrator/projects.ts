// Proyectos (workspaces): project.open / reopen / close / list / get / update. Abrir un proyecto lo crea o recupera,
// limpia lo que dejó una sesión anterior y deja listos al jefe y a un trabajador por defecto. Se pueden tener varios
// abiertos a la vez (`ctx.projects`); abrir uno no cierra los demás.
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { ProjectRow } from '../db/repos.js';
import { assertSafeRef, runGitRaw } from '../git/run.js';
import { pruneWorktrees } from '../git/worktree.js';
import { dequeueProject, pumpQueue } from './queue.js';
import { clearProjectResumes, rescheduleResumes } from './relay.js';
import { type Ctx, type Handler, asParams, mostRecentOpen, projectIdOf, requireProject, str } from './context.js';
import { logEvent } from './events.js';
import { setRobotStatus } from './status.js';
import { stopTask } from './runs.js';
import { transition } from './tasks.js';
import { listProjects, projectItem, scheduleWorkspacesNotify } from './workspaces.js';

/** Raíz del repositorio git que contiene `path`; error claro si no es un repo. */
async function repoRoot(path: string): Promise<string> {
  if (!existsSync(path)) throw new Error(`la carpeta no existe: ${path}`);
  const r = await runGitRaw(path, ['rev-parse', '--show-toplevel']);
  const root = r.stdout.trim();
  if (r.exitCode !== 0 || root === '') throw new Error(`no es un repositorio git: ${path}`);
  return root;
}

async function currentBranch(root: string): Promise<string> {
  const head = await runGitRaw(root, ['rev-parse', '--verify', '-q', 'HEAD']);
  if (head.exitCode !== 0) throw new Error('el repositorio no tiene ningún commit: haz uno antes de abrirlo en Kiji');
  const branch = (await runGitRaw(root, ['symbolic-ref', '--short', '-q', 'HEAD'])).stdout.trim();
  if (branch === '') throw new Error('el repositorio está en HEAD desacoplado: cambia a una rama antes de abrirlo');
  return branch;
}

/**
 * Tras un reinicio no queda ningún run vivo: lo que figure como `running` es de una sesión anterior.
 * Su run pasa a `cancelled`, sus aprobaciones a `denied` y la tarea a `blocked` (el worktree se conserva).
 */
function recoverStaleRuns(ctx: Ctx, project: ProjectRow): void {
  const pending = ctx.repos.approvals.listPending();
  for (const task of ctx.repos.tasks.listByProject(project.id)) {
    if (ctx.live.has(task.id)) continue; // run de esta sesión
    const stale = ctx.repos.runs.listByTask(task.id).filter((r) => r.status === 'running');
    for (const run of stale) ctx.repos.runs.update(run.id, { status: 'cancelled', ended_at: Date.now() });
    for (const a of pending) {
      if (a.task_id === task.id) ctx.repos.approvals.decide(a.id, 'denied');
    }
    if (task.status === 'running' || task.status === 'needs_you') {
      transition(ctx, task.id, 'blocked', 'el core se reinició durante el run; el worktree se conserva');
      if (task.agent_id) setRobotStatus(ctx, task.agent_id, 'idle');
    } else if (stale.length > 0) {
      logEvent(ctx, { projectId: project.id, kind: 'status', taskId: task.id, agentId: task.agent_id, payload: { reason: 'run huérfano cancelado' } });
    }
  }
}

/**
 * Al arrancar el core: lo que quedó `running`/`needs_you`/pendiente tras un corte también en los proyectos cerrados
 * (que no se reabren y nunca pasarían por `recoverStaleRuns`). Solo toca estados de la BD: ni git ni worktrees.
 * Es la opción segura porque no cambia las consultas de contadores y deja la BD coherente para cualquier lector.
 */
export function recoverAllProjects(ctx: Ctx): void {
  for (const project of ctx.repos.projects.list()) {
    try {
      recoverStaleRuns(ctx, project);
    } catch (err) {
      process.stderr.write(`arranque: no se pudo sanear ${project.name}: ${err instanceof Error ? err.message : err}\n`);
    }
  }
}

const SCENES = ['oficina', 'casa'] as const;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/** Abre (o reabre) el repositorio en `root` como workspace y lo deja listo. `touch: false` conserva `last_opened_at`. */
async function openProject(ctx: Ctx, root: string, touch = true): Promise<ProjectRow> {
  let project = ctx.repos.projects.getByPath(root);
  if (!project) {
    project = ctx.repos.projects.create({
      path: root,
      name: basename(root),
      baseBranch: await currentBranch(root),
      testCommand: existsSync(join(root, 'package.json')) ? 'npm test' : null,
    });
  }
  const alreadyOpen = ctx.projects.has(project.id);

  try {
    await pruneWorktrees(root);
  } catch (err) {
    process.stderr.write(`project.open: no se pudo limpiar worktrees: ${err instanceof Error ? err.message : err}\n`);
  }
  if (!alreadyOpen) recoverStaleRuns(ctx, project); // solo al abrirlo en esta sesión: ahí no hay ningún run vivo suyo

  // El jefe y, para H1, un trabajador por defecto.
  if (!ctx.repos.agents.getBoss(project.id)) {
    ctx.repos.agents.create({ projectId: project.id, name: 'Jefe', provider: 'claude', model: 'opus', role: 'jefe', color: 'terracota', isBoss: true });
  }
  if (!ctx.repos.agents.list(project.id).some((a) => a.is_boss === 0)) {
    ctx.repos.agents.create({ projectId: project.id, name: 'Clau', provider: 'claude', model: 'sonnet', role: 'programador', color: 'terracota' });
  }

  project = ctx.repos.projects.setOpen(project.id, true, touch);
  ctx.projects.set(project.id, project);
  ctx.lastProjectId = project.id;
  ctx.manager?.syncProject(project.id); // temporizador del gerente si lo tiene activado
  rescheduleResumes(ctx, project); // tareas pausadas por límite: la reanudación al reset sobrevive al reinicio
  scheduleWorkspacesNotify(ctx);
  return project;
}

/** Cierra el workspace: para sus runs (solo con `force`), saca sus tareas de la cola y lo marca como cerrado. */
async function closeProject(ctx: Ctx, projectId: string, force: boolean) {
  const project = ctx.projects.get(projectId);
  if (!project) throw new Error(`project.close: el proyecto ${projectId} no está abierto`);
  const lives = [...ctx.live.values()].filter((l) => l.projectId === projectId);
  if (lives.length > 0 && !force) {
    throw new Error(`project.close: «${project.name}» tiene ${lives.length} run(s) en marcha; páralos o usa force para detenerlos`);
  }
  // Primero se cierra la puerta: sin el proyecto en `ctx.projects`, checkStartable (task.start, cola, reanudación al
  // reset) rechaza cualquier arranque nuevo mientras se paran los runs.
  ctx.projects.delete(projectId);
  ctx.repos.projects.setOpen(projectId, false);
  ctx.manager?.stopProject(projectId);
  if (ctx.lastProjectId === projectId) ctx.lastProjectId = mostRecentOpen(ctx);
  dequeueProject(ctx, projectId);
  clearProjectResumes(ctx, projectId);
  let stopped = 0;
  // Se repite hasta que no quede ningún run vivo del proyecto (uno que estaba arrancando puede aparecer tras parar otro).
  for (let pass = 0; pass < 20; pass++) {
    const remaining = [...ctx.live.values()].filter((l) => l.projectId === projectId);
    if (remaining.length === 0) break;
    for (const l of remaining) {
      l.onEnded = null; // un relevo pendiente no debe relanzar nada en un proyecto que se cierra
      if (l.finishing || l.ended) {
        await l.finished.catch(() => undefined); // ya terminó: solo está guardando el trabajo
        continue;
      }
      try {
        await stopTask(ctx, l.taskId, 'proyecto cerrado', { pump: false });
        stopped++;
      } catch (err) {
        process.stderr.write(`project.close: no se pudo parar ${l.taskId}: ${err instanceof Error ? err.message : err}\n`);
        await l.finished.catch(() => undefined);
      }
    }
  }
  scheduleWorkspacesNotify(ctx);
  void pumpQueue(ctx); // los huecos liberados son para los demás proyectos
  return { projectId, closed: true as const, stoppedRuns: stopped };
}

export function projectHandlers(ctx: Ctx): Record<string, Handler> {
  return {
    /** `{path}` -> fila del proyecto. No cierra los demás; pasa a ser el último abierto (`lastProjectId`). */
    'project.open': async (params) => {
      const p = asParams(params, 'project.open');
      return openProject(ctx, await repoRoot(str(p.path, 'path', 'project.open')));
    },

    /**
     * Sin params. Reabre los proyectos que estaban abiertos al cerrar el core (`is_open = 1`): la UI lo llama una vez
     * al recibir `core.ready` (el core no abre nada solo: abrir es asíncrono y toca git). Idempotente. Los que ya no se
     * pueden abrir (carpeta borrada...) quedan cerrados y se devuelven en `failed`.
     */
    'project.reopen': async () => {
      const failed: Array<{ projectId: string; path: string; error: string }> = [];
      const opened: ProjectRow[] = [];
      for (const prev of ctx.repos.projects.listOpen()) {
        try {
          opened.push(await openProject(ctx, await repoRoot(prev.path), false));
        } catch (err) {
          ctx.repos.projects.setOpen(prev.id, false);
          failed.push({ projectId: prev.id, path: prev.path, error: err instanceof Error ? err.message : String(err) });
        }
      }
      ctx.lastProjectId = mostRecentOpen(ctx);
      const items = opened.map((o) => projectItem(ctx, ctx.projects.get(o.id)!));
      return { opened: items, failed };
    },

    /** `{projectId?}` -> fila del proyecto abierto (sin `projectId`: el último abierto) o null. */
    'project.get': (params) => {
      const p = params == null ? {} : asParams(params, 'project.get');
      const id = projectIdOf(p);
      if (id !== undefined) return ctx.projects.get(id) ?? null;
      return ctx.lastProjectId ? (ctx.projects.get(ctx.lastProjectId) ?? null) : null;
    },

    /** Todos los proyectos conocidos con contadores: ProjectListItem[] (abiertos primero, luego por última apertura). */
    'project.list': () => listProjects(ctx),

    /** `{projectId, force?}`: falla si hay runs vivos salvo `force` (los para limpiamente). */
    'project.close': async (params) => {
      const p = asParams(params, 'project.close');
      return closeProject(ctx, str(p.projectId, 'projectId', 'project.close'), p.force === true);
    },

    /** `{projectId?, test_command?, base_branch?, scene?, color?}`. La rama base debe existir como rama local. */
    'project.update': async (params) => {
      const p = asParams(params, 'project.update');
      const project = requireProject(ctx, projectIdOf(p));
      const patch: { baseBranch?: string; testCommand?: string | null; scene?: 'oficina' | 'casa'; color?: string | null } = {};

      if (p.base_branch !== undefined) {
        const branch = str(p.base_branch, 'base_branch', 'project.update').trim();
        assertSafeRef(branch, 'base_branch');
        // show-ref solo acepta el nombre exacto de una rama local (rev-parse admitiría main~1, main@{0}…).
        const r = await runGitRaw(project.path, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
        if (r.exitCode !== 0) throw new Error(`project.update: la rama base "${branch}" no existe en ${project.path}`);
        patch.baseBranch = branch;
      }
      if (p.test_command !== undefined) {
        if (p.test_command !== null && typeof p.test_command !== 'string') throw new Error('project.update: "test_command" debe ser texto o null');
        const cmd = (p.test_command ?? '').trim();
        if (cmd.length > 1000 || /[\r\n\0]/.test(cmd)) throw new Error('project.update: "test_command" debe ser una sola línea de menos de 1000 caracteres');
        patch.testCommand = cmd === '' ? null : cmd;
      }
      if (p.scene !== undefined) {
        if (typeof p.scene !== 'string' || !(SCENES as readonly string[]).includes(p.scene)) {
          throw new Error(`project.update: scene "${String(p.scene)}" no válida (permitidas: ${SCENES.join(', ')})`);
        }
        patch.scene = p.scene as 'oficina' | 'casa';
      }
      if (p.color !== undefined) {
        if (p.color !== null && (typeof p.color !== 'string' || !COLOR_RE.test(p.color))) {
          throw new Error('project.update: "color" debe ser #rrggbb o null');
        }
        patch.color = p.color as string | null;
      }
      if (Object.keys(patch).length === 0) {
        throw new Error('project.update: indica "base_branch", "test_command", "scene" y/o "color"');
      }
      const updated = ctx.repos.projects.update(project.id, patch);
      ctx.projects.set(updated.id, updated);
      scheduleWorkspacesNotify(ctx);
      return updated;
    },
  };
}
