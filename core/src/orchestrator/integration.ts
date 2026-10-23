// Integración (0.2d, hito 3; pasos 13/14 de PLAN-0.1): tarea `approved` -> commit pendiente, rebase sobre la rama base,
// tests del proyecto, merge ff-only en el repo principal, fila en `integrations` y limpieza del worktree.
// Una integración a la vez por proyecto (`ctx.integrationLocks`). Los fallos "esperables" (conflicto, tests, merge) NO
// lanzan: devuelven la `IntegrationView` con status 'failed' y dejan la tarea en `blocked` / `changes` / `approved`.
// Lo que impide siquiera empezar (tarea no aprobada, repo principal sucio o en otra rama) sí lanza, sin tocar nada.
import { existsSync } from 'node:fs';
import type { IntegrationChangedEvent, IntegrationFailReason, IntegrationPhase, IntegrationView } from '../../../shared/protocol.js';
import type { IntegrationRow, ProjectRow, TaskRow } from '../db/repos.js';
import { commitAll, mergeFfOnly, rebaseOnto, revertRange, runTests } from '../git/integrate.js';
import { runGitRaw } from '../git/run.js';
import { branchName, removeWorktree } from '../git/worktree.js';
import { type Ctx, type Handler, asParams, assertSameProject, optionalProject, projectIdOf, str } from './context.js';
import { markIntegrationTests, refreshBoard } from './board.js';
import { logEvent } from './events.js';
import { notify } from './notifications.js';
import { getTask, isReadOnlyTask, projectOfTask, publishTask, recordFinding, transition } from './tasks.js';

const DETAIL_MAX = 2000;
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const tail = (s: string, max: number): string => (s.length > max ? `…${s.slice(-(max - 1))}` : s);

export function integrationView(r: IntegrationRow): IntegrationView {
  return {
    id: String(r.id), projectId: r.project_id, taskId: r.task_id, beforeSha: r.before_sha, afterSha: r.after_sha,
    status: r.status, detail: r.detail, createdAt: r.created_at,
  };
}

function publishIntegration(ctx: Ctx, id: number, extra: Pick<IntegrationView, 'reason' | 'files' | 'output'> = {}): IntegrationView {
  const view: IntegrationView = { ...integrationView(ctx.repos.integrations.get(id)!), ...extra };
  const phase: IntegrationPhase = view.status === 'failed' ? 'failed' : 'done';
  ctx.emit('integration.changed', { ...view, phase } satisfies IntegrationChangedEvent);
  return view;
}

/** Fase intermedia (rebase | tests | merge) para la barra de progreso de la UI. */
function phase(ctx: Ctx, projectId: string, taskId: string, p: IntegrationPhase): void {
  ctx.emit('integration.changed', { projectId, taskId, phase: p } satisfies IntegrationChangedEvent);
}

/** Error con código para la UI (`dirty`: repo principal sucio o en otra rama). */
export class IntegrationError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
  }
}

/** Ejecuta `fn` cuando terminen las integraciones/reversiones anteriores del mismo proyecto. */
function withLock<T>(ctx: Ctx, projectId: string, fn: () => Promise<T>): Promise<T> {
  const prev = ctx.integrationLocks.get(projectId) ?? Promise.resolve();
  const run = prev.then(fn);
  const settled = run.then(() => undefined, () => undefined);
  ctx.integrationLocks.set(projectId, settled);
  void settled.then(() => {
    if (ctx.integrationLocks.get(projectId) === settled) ctx.integrationLocks.delete(projectId);
  });
  return run;
}

/** El repo principal debe estar en la rama base y sin cambios sin guardar en archivos rastreados (no se pisa nada). */
async function assertMainRepoClean(project: ProjectRow, action: string): Promise<void> {
  const head = await runGitRaw(project.path, ['symbolic-ref', '--short', '-q', 'HEAD']);
  const current = head.stdout.trim();
  if (head.exitCode !== 0 || current === '') {
    throw new IntegrationError(`No se puede ${action}: el repositorio principal está en HEAD desacoplado; vuelve a la rama «${project.base_branch}».`, 'dirty');
  }
  if (current !== project.base_branch) {
    throw new IntegrationError(`No se puede ${action}: el repositorio principal está en la rama «${current}» y debería estar en «${project.base_branch}».`, 'dirty');
  }
  const dirty = await runGitRaw(project.path, ['status', '--porcelain', '--untracked-files=no']);
  if (dirty.exitCode !== 0) throw new Error(`No se puede ${action}: git status falló: ${dirty.stderr.trim()}`);
  if (dirty.stdout.trim() !== '') {
    const files = dirty.stdout.split('\n').filter(Boolean).slice(0, 5).map((l) => l.slice(3)).join(', ');
    throw new IntegrationError(`No se puede ${action}: el repositorio principal tiene cambios sin guardar (${files}); guárdalos o descártalos antes.`, 'dirty');
  }
}

/** Registra un intento fallido: fila `failed`, evento `integration.changed` y aviso. */
function fail(ctx: Ctx, project: ProjectRow, task: TaskRow, title: string, detail: string, extra: { reason: IntegrationFailReason; files?: string[]; output?: string }): IntegrationView {
  const row = ctx.repos.integrations.create({ projectId: project.id, taskId: task.id, status: 'failed', detail: detail.slice(0, DETAIL_MAX) });
  refreshBoard(ctx, task.id); // si los tests dejaron la tarea en Doing (QA) y sigue aprobada, vuelve a Prueba funcional
  notify(ctx, { projectId: project.id, level: 'warn', title: `No se pudo integrar «${task.title}»`, body: title });
  return publishIntegration(ctx, row.id, extra);
}

/**
 * Integra una tarea `approved`. Para el gerente: `integrateTask(ctx, taskId)`; devuelve la vista (status 'applied' o 'failed')
 * y lanza solo si la tarea/el repo no están en condiciones de empezar.
 */
export async function integrateTask(ctx: Ctx, taskId: string): Promise<IntegrationView> {
  const first = getTask(ctx, taskId);
  const project = projectOfTask(ctx, first);
  if (!ctx.projects.has(project.id)) throw new Error(`el proyecto «${project.name}» no está abierto`);
  return withLock(ctx, project.id, async () => {
    const task = getTask(ctx, taskId);
    if (task.status !== 'approved') throw new Error(`integration.apply: la tarea está en ${task.status}; solo se integran las aprobadas`);
    if (ctx.live.has(taskId)) throw new Error('integration.apply: la tarea tiene un run en curso');
    if (ctx.halted) return fail(ctx, project, task, 'Parada global activa: no se integra.', 'Parada global activa: reanuda y vuelve a integrar.', { reason: 'halted' });
    if (isReadOnlyTask(ctx, taskId)) throw new Error('integration.apply: es una consulta de solo lectura, no hay nada que integrar');
    const worktree = task.worktree_path;
    if (!worktree || !existsSync(worktree)) throw new Error('integration.apply: la tarea no tiene worktree');
    await assertMainRepoClean(project, 'integrar');

    const base = { projectId: project.id, taskId, agentId: task.agent_id };
    try {
      // 1) Trabajo pendiente en el worktree.
      phase(ctx, project.id, taskId, 'rebase');
      await commitAll(worktree, `${task.title}\n\nTarea Kiji ${task.id}`);

      // 2) Rebase sobre la rama base: un conflicto bloquea la tarea con la lista de archivos.
      const rebase = await rebaseOnto(worktree, project.base_branch);
      if (!rebase.ok) {
        const files = rebase.conflicts.join(', ');
        const message = `conflicto al integrar con «${project.base_branch}» en: ${files}`;
        logEvent(ctx, { ...base, kind: 'git', payload: { finding: 'rebase_conflict', task_id: taskId, files: rebase.conflicts, message } });
        transition(ctx, taskId, 'blocked', message);
        return fail(ctx, project, task, `Conflicto en ${rebase.conflicts.length} archivo(s): ${files}`, message, { reason: 'conflict', files: rebase.conflicts });
      }

      // 3) Tests del proyecto sobre el resultado del rebase.
      const command = project.test_command?.trim() ?? '';
      if (command !== '') {
        phase(ctx, project.id, taskId, 'tests');
        markIntegrationTests(ctx, taskId);
        let exitCode: number;
        let output: string;
        let timedOut = false;
        try {
          ({ exitCode, output, timedOut } = await runTests(worktree, command, ctx.testTimeoutMs));
        } catch (err) {
          exitCode = 127;
          output = msg(err);
        }
        ctx.repos.testRuns.create({ taskId, command, exitCode, output });
        logEvent(ctx, { ...base, kind: 'test', payload: { command, exit_code: exitCode, timed_out: timedOut, phase: 'integration' } });
        if (exitCode !== 0) {
          const message = `fallaron los tests al integrar (${command}, código ${exitCode}${timedOut ? ', tiempo agotado' : ''}):\n${tail(output.trim(), 1500)}`;
          recordFinding(ctx, task, 'tests_failed', message);
          transition(ctx, taskId, 'changes', `tests fallidos al integrar (código ${exitCode})`);
          return fail(ctx, project, task, `Fallaron los tests (código ${exitCode}).`, message, { reason: 'tests_failed', output: tail(output.trim(), 1500) });
        }
      }

      // 4) Merge ff-only en el repo principal (vuelve a exigir rama base y árbol limpio). Una parada global durante
      // el rebase/los tests lo impide: la tarea sigue `approved`.
      if (ctx.halted) return fail(ctx, project, task, 'Parada global activa: no se integra.', 'Parada global activa: reanuda y vuelve a integrar.', { reason: 'halted' });
      phase(ctx, project.id, taskId, 'merge');
      let merged;
      try {
        merged = await mergeFfOnly(project.path, task.branch ?? branchName(taskId), { expectedBase: project.base_branch });
      } catch (err) {
        logEvent(ctx, { ...base, kind: 'git', payload: { finding: 'merge_failed', task_id: taskId, message: msg(err) } });
        return fail(ctx, project, task, msg(err), msg(err), { reason: 'merge' }); // la tarea sigue `approved`: se puede reintentar
      }

      // 5) Hecho: fila, tarea `integrated` (libera archivos) y limpieza del worktree y su rama (ya está en la base).
      const row = ctx.repos.integrations.create({ projectId: project.id, taskId, beforeSha: merged.beforeSha, afterSha: merged.afterSha, status: 'applied' });
      let patch: { worktree_path: null } | undefined;
      try {
        await removeWorktree(project.path, taskId, { deleteBranch: true });
        patch = { worktree_path: null };
      } catch (err) {
        logEvent(ctx, { ...base, kind: 'git', payload: { finding: 'worktree_cleanup', task_id: taskId, message: `no se pudo eliminar el worktree: ${msg(err)}` } });
      }
      logEvent(ctx, { ...base, kind: 'git', payload: { integrated: true, before: merged.beforeSha, after: merged.afterSha } });
      transition(ctx, taskId, 'integrated', 'integrada', patch);
      notify(ctx, {
        projectId: project.id, level: 'info', title: `Integrado: «${task.title}»`,
        body: `«${project.base_branch}» avanzó a ${merged.afterSha.slice(0, 7)}.`,
      });
      return publishIntegration(ctx, row.id);
    } catch (err) {
      // Error inesperado de git (rebase sin conflicto, etc.): la tarea sigue aprobada y queda constancia.
      logEvent(ctx, { ...base, kind: 'error', payload: { message: `falló la integración: ${msg(err)}` } });
      return fail(ctx, project, task, msg(err), msg(err), { reason: 'merge' });
    }
  });
}

/** Deshace una integración `applied` (git revert del rango) y la marca `reverted`. La tarea sigue `integrated`. */
export async function revertIntegration(ctx: Ctx, integrationId: number): Promise<IntegrationView> {
  const first = ctx.repos.integrations.get(integrationId);
  if (!first) throw new Error(`integration.revert: integración inexistente: ${integrationId}`);
  const project = ctx.projects.get(first.project_id);
  if (!project) throw new Error('integration.revert: el proyecto no está abierto');
  return withLock(ctx, project.id, async () => {
    const row = ctx.repos.integrations.get(integrationId)!;
    if (row.status !== 'applied') throw new Error(`integration.revert: la integración está ${row.status}; solo se revierten las aplicadas`);
    await assertMainRepoClean(project, 'revertir');
    const head = await revertRange(project.path, row.before_sha, row.after_sha, { expectedBase: project.base_branch });
    ctx.repos.integrations.setStatus(row.id, 'reverted', `revertida; HEAD ${head.slice(0, 7)}`);
    const task = ctx.repos.tasks.get(row.task_id);
    if (task) {
      logEvent(ctx, { projectId: project.id, taskId: task.id, agentId: task.agent_id, kind: 'git', payload: { reverted: true, before: row.before_sha, after: row.after_sha, head } });
      publishTask(ctx, task.id);
    }
    notify(ctx, { projectId: project.id, level: 'info', title: `Integración revertida${task ? `: «${task.title}»` : ''}`, body: `«${project.base_branch}» volvió a ${head.slice(0, 7)}.` });
    return publishIntegration(ctx, row.id);
  });
}

export function integrationHandlers(ctx: Ctx): Record<string, Handler> {
  return {
    /** `{id: taskId, projectId?}` -> IntegrationView */
    'integration.apply': (params) => {
      const p = asParams(params, 'integration.apply');
      const task = getTask(ctx, str(p.id, 'id', 'integration.apply'));
      const project = projectOfTask(ctx, task);
      assertSameProject(p, project.id, 'integration.apply');
      if (!ctx.projects.has(project.id)) throw new Error(`el proyecto «${project.name}» no está abierto`);
      if (task.status !== 'approved') throw new Error(`integration.apply: la tarea está en ${task.status}; solo se integran las aprobadas`);
      // Responde ya: rebase+tests+merge pueden tardar minutos y el router atiende una petición a la vez.
      // El resultado llega por `integration.changed` (phase done | failed). El lock por proyecto las serializa.
      void integrateTask(ctx, task.id).catch((err) => {
        try {
          const dirty = err instanceof IntegrationError ? err.code === 'dirty' : false;
          const t = getTask(ctx, task.id);
          fail(ctx, project, t, msg(err), msg(err), { reason: dirty ? 'dirty' : 'merge' });
        } catch (e) {
          process.stderr.write(`kiji-core: integration.apply falló: ${msg(e)}\n`);
        }
      });
      return { phase: 'started', taskId: task.id };
    },
    /** `{integrationId, projectId?}` -> IntegrationView */
    'integration.revert': (params) => {
      const p = asParams(params, 'integration.revert');
      const id = Number(p.integrationId);
      const row = Number.isInteger(id) ? ctx.repos.integrations.get(id) : undefined;
      if (!row) throw new Error(`integration.revert: integración inexistente: ${String(p.integrationId)}`);
      assertSameProject(p, row.project_id, 'integration.revert');
      return revertIntegration(ctx, row.id);
    },
    /** `{projectId?}` -> IntegrationView[] (la más nueva primero) */
    'integration.list': (params) => {
      const p = params == null ? {} : asParams(params, 'integration.list');
      const project = optionalProject(ctx, projectIdOf(p));
      return project ? ctx.repos.integrations.list(project.id).map(integrationView) : [];
    },
  };
}
