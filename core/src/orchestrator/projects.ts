// Proyectos: project.open / project.get. Abrir un proyecto lo crea o recupera, limpia lo que dejó una sesión anterior
// y deja listos al jefe y a un trabajador por defecto.
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { ProjectRow } from '../db/repos.js';
import { runGitRaw } from '../git/run.js';
import { pruneWorktrees } from '../git/worktree.js';
import { type Ctx, type Handler, asParams, str } from './context.js';
import { logEvent } from './events.js';
import { setRobotStatus } from './status.js';
import { transition } from './tasks.js';

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
  for (const task of ctx.repos.tasks.listByProject(project.id)) {
    if (ctx.live.has(task.id)) continue; // run de esta sesión
    const stale = ctx.repos.runs.listByTask(task.id).filter((r) => r.status === 'running');
    for (const run of stale) ctx.repos.runs.update(run.id, { status: 'cancelled', ended_at: Date.now() });
    for (const a of ctx.repos.approvals.listPending()) {
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

export function projectHandlers(ctx: Ctx): Record<string, Handler> {
  return {
    'project.open': async (params) => {
      const p = asParams(params, 'project.open');
      const root = await repoRoot(str(p.path, 'path', 'project.open'));

      let project = ctx.repos.projects.getByPath(root);
      if (!project) {
        project = ctx.repos.projects.create({
          path: root,
          name: basename(root),
          baseBranch: await currentBranch(root),
          testCommand: existsSync(join(root, 'package.json')) ? 'npm test' : null,
        });
      }

      try {
        await pruneWorktrees(root);
      } catch (err) {
        process.stderr.write(`project.open: no se pudo limpiar worktrees: ${err instanceof Error ? err.message : err}\n`);
      }
      recoverStaleRuns(ctx, project);

      // El jefe y, para H1, un trabajador por defecto.
      if (!ctx.repos.agents.getBoss(project.id)) {
        ctx.repos.agents.create({ projectId: project.id, name: 'Jefe', provider: 'claude', model: 'opus', role: 'jefe', color: 'terracota', isBoss: true });
      }
      if (!ctx.repos.agents.list(project.id).some((a) => a.is_boss === 0)) {
        ctx.repos.agents.create({ projectId: project.id, name: 'Clau', provider: 'claude', model: 'sonnet', role: 'programador', color: 'terracota' });
      }

      ctx.activeProject = project;
      return project;
    },

    'project.get': () => ctx.activeProject,
  };
}
