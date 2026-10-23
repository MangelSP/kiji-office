// Aprobaciones: permission_request -> fila en `approvals` + `approval.requested`; approval.answer -> adaptador.
import type { AgentEvent } from '../adapters/types.js';
import { type Ctx, type Handler, type LiveRun, asParams, str } from './context.js';
import { logEvent, sanitize } from './events.js';
import { setRobotStatus } from './status.js';
import { getTask, transition } from './tasks.js';

/** El adaptador pide permiso: guarda la aprobación, avisa a la UI y deja la tarea y el robot en `needs_you`. */
export function onPermissionRequest(ctx: Ctx, live: LiveRun, ev: Extract<AgentEvent, { type: 'permission_request' }>): void {
  const input = sanitize(ev.input);
  const row = ctx.repos.approvals.create({ tool: ev.tool, risk: ev.risk, input, runId: live.runId, taskId: live.taskId });
  live.pending.set(row.id, ev.id);
  ctx.approvalIndex.set(row.id, live);
  logEvent(ctx, {
    projectId: live.projectId,
    kind: 'permission',
    taskId: live.taskId,
    agentId: live.agentId,
    runId: live.runId,
    payload: { approval_id: row.id, tool: ev.tool, input, risk: ev.risk, decision: 'pending' },
  });
  if (getTask(ctx, live.taskId).status === 'running') transition(ctx, live.taskId, 'needs_you', `permiso: ${ev.tool}`);
  setRobotStatus(ctx, live.agentId, 'needs_you');
  ctx.emit('approval.requested', {
    projectId: live.projectId,
    id: row.id,
    tool: ev.tool,
    input,
    risk: ev.risk,
    agent_id: live.agentId,
    task_id: live.taskId,
  });
}

/** Marca como `denied` las aprobaciones que quedaron sin contestar al terminar el run. */
export function denyPending(ctx: Ctx, live: LiveRun, reason: string): void {
  for (const id of [...live.pending.keys()]) {
    ctx.repos.approvals.decide(id, 'denied');
    ctx.approvalIndex.delete(id);
    logEvent(ctx, {
      projectId: live.projectId,
      kind: 'permission',
      taskId: live.taskId,
      agentId: live.agentId,
      runId: live.runId,
      payload: { approval_id: id, decision: 'denied', reason },
    });
  }
  live.pending.clear();
}

export function approvalHandlers(ctx: Ctx): Record<string, Handler> {
  return {
    'approval.answer': (params) => {
      const p = asParams(params, 'approval.answer');
      const id = str(p.id, 'id', 'approval.answer');
      if (typeof p.allow !== 'boolean') throw new Error('approval.answer: falta "allow" (true/false)');
      const allow = p.allow;

      const live = ctx.approvalIndex.get(id);
      if (!live) {
        const row = ctx.repos.approvals.get(id);
        throw new Error(row ? `la aprobación ya está resuelta (${row.status})` : `aprobación desconocida: ${id}`);
      }
      if (!ctx.repos.approvals.decide(id, allow ? 'approved' : 'denied')) throw new Error('la aprobación ya está resuelta');
      const adapterId = live.pending.get(id)!;
      live.pending.delete(id);
      ctx.approvalIndex.delete(id);

      logEvent(ctx, {
        projectId: live.projectId,
        kind: 'permission',
        taskId: live.taskId,
        agentId: live.agentId,
        runId: live.runId,
        payload: { approval_id: id, decision: allow ? 'approved' : 'denied' },
      });
      live.adapter.answerPermission(adapterId, allow, allow ? undefined : 'El usuario denegó esta acción.');

      // Con la última pendiente contestada el agente sigue trabajando.
      if (live.pending.size === 0 && getTask(ctx, live.taskId).status === 'needs_you') {
        transition(ctx, live.taskId, 'running', allow ? 'permiso concedido' : 'permiso denegado');
        setRobotStatus(ctx, live.agentId, 'thinking');
      }
      return { ok: true, status: allow ? 'approved' : 'denied' };
    },
  };
}
