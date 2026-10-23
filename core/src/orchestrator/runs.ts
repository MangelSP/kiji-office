// Runs: task.start / task.stop / task.diff. Arranca el adaptador, persiste sus eventos y cierra el run
// (red de seguridad de propiedad, commit, tests) según cómo termine.
import { existsSync } from 'node:fs';
import type { AgentEvent, RunSpec } from '../adapters/types.js';
import type { TaskRow } from '../db/repos.js';
import { commitAll, runTests } from '../git/integrate.js';
import { createWorktree, branchName, changedFiles, diff } from '../git/worktree.js';
import { denyPending, onPermissionRequest } from './approvals.js';
import { type Ctx, type Handler, type LiveRun, asParams, str } from './context.js';
import { logEvent } from './events.js';
import { forkPoint, foreignFiles, revertFiles } from './ownership.js';
import { robotStatusFor, setRobotStatus } from './status.js';
import { getTask, projectOfTask, taskView, transition } from './tasks.js';

/** Una línea por rol; los prompts completos del kit llegan en el paso 12a. */
const ROLE_PROMPTS: Record<string, string> = {
  programador: 'Eres un programador: implementas exactamente la tarea asignada con cambios mínimos y claros, y añades o ajustas los tests que hagan falta.',
  tester: 'Eres un tester: escribes y ejecutas pruebas que demuestren que el código funciona y señalas fallos con precisión.',
  explorador: 'Eres un explorador: investigas el código y respondes con hechos verificables, sin modificar nada salvo lo asignado.',
  'modelador-2d': 'Eres un modelador 2D: produces los sprites y recursos gráficos pedidos, con el formato y tamaño indicados.',
  documentador: 'Eres un documentador: escribes documentación clara y exacta sobre lo que el código hace realmente.',
  'revisor-critico': 'Eres un revisor crítico: buscas fallos de seguridad, de lógica y de calidad, y los reportas con evidencia.',
  jefe: 'Eres el jefe del equipo: planeas y revisas el trabajo de los demás.',
};
const DEFAULT_ROLE_PROMPT = 'Eres un agente del equipo: haces exactamente la tarea asignada.';

const STARTABLE = new Set(['assigned', 'changes', 'paused_limit', 'blocked', 'failed']);
const STOP_WAIT_MS = 5000;

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function budgetUsd(ctx: Ctx): number {
  const v = Number.parseFloat(ctx.repos.settings.get('default_budget_usd') ?? '');
  return Number.isFinite(v) && v > 0 ? v : 2;
}

/** Espera a que el adaptador pare, sin quedarse colgado si no responde. */
async function stopAdapter(live: LiveRun): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      live.adapter.stop(),
      new Promise<void>((r) => {
        timer = setTimeout(r, STOP_WAIT_MS);
        timer.unref();
      }),
    ]);
  } catch {
    /* un adaptador que falla al parar no debe tumbar al orquestador */
  } finally {
    clearTimeout(timer);
  }
}

function buildPrompt(ctx: Ctx, task: TaskRow, files: string[], resuming: boolean): string {
  const parts: string[] = [];
  if (resuming) {
    parts.push('Continúa donde lo dejaste: la tarea se interrumpió por un límite de uso.');
  }
  parts.push(`Tarea: ${task.title}`);
  if (task.description.trim() !== '') parts.push(task.description.trim());
  parts.push(
    `Archivos que puedes modificar (solo estos):\n${files.map((f) => `- ${f}`).join('\n')}`,
    'Trabaja en el directorio actual. No hagas commit: el core guarda tu trabajo cuando termines.',
  );
  if (task.status === 'changes') {
    // Hallazgo más reciente de la red de seguridad de propiedad.
    const finding = ctx.repos.events
      .tail(projectOfTask(ctx, task).id, { kind: 'git', limit: 50 })
      .reverse()
      .map((e) => JSON.parse(e.payload) as { finding?: string; task_id?: string; message?: string })
      .find((p) => p.finding && p.task_id === task.id);
    if (finding?.message) parts.push(`Hallazgo de la revisión anterior: ${finding.message}`);
  }
  return parts.join('\n\n');
}

export function runHandlers(ctx: Ctx): Record<string, Handler> {
  return {
    'task.start': async (params) => {
      const p = asParams(params, 'task.start');
      return startTask(ctx, str(p.id, 'id', 'task.start'));
    },
    'task.stop': async (params) => {
      const p = asParams(params, 'task.stop');
      return stopTask(ctx, str(p.id, 'id', 'task.stop'));
    },
    'task.diff': async (params) => {
      const p = asParams(params, 'task.diff');
      const task = getTask(ctx, str(p.id, 'id', 'task.diff'));
      const project = projectOfTask(ctx, task);
      if (!task.worktree_path || !existsSync(task.worktree_path)) {
        throw new Error('la tarea no tiene worktree (aún no se ha iniciado o ya se integró)');
      }
      const base = await forkPoint(task.worktree_path, project.base_branch);
      return {
        diff: await diff(task.worktree_path, base),
        files: await changedFiles(task.worktree_path, base),
        base_sha: base,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------------

export async function startTask(ctx: Ctx, taskId: string) {
  const task = getTask(ctx, taskId);
  if (ctx.live.has(taskId)) throw new Error('la tarea ya tiene un run en curso');
  if (!STARTABLE.has(task.status)) {
    throw new Error(
      task.status === 'todo' ? 'la tarea no tiene agente: asígnale uno antes de iniciarla' : `no se puede iniciar una tarea en estado ${task.status}`,
    );
  }
  if (!task.agent_id) throw new Error('la tarea no tiene agente: asígnale uno antes de iniciarla');
  const agent = ctx.repos.agents.get(task.agent_id);
  if (!agent) throw new Error(`el agente de la tarea ya no existe: ${task.agent_id}`);
  for (const l of ctx.live.values()) {
    if (l.agentId === agent.id) throw new Error(`${agent.name} ya está ocupado con otra tarea; espera a que termine o páralo`);
  }
  const adapter = ctx.adapterFactory(agent); // falla antes de tocar nada si el proveedor no está soportado
  const project = projectOfTask(ctx, task);
  const files = ctx.repos.taskFiles.list(task.id).map((f) => f.path);
  const resumeHint = readResumeHint(ctx, task);

  // Reserva el hueco ya: dos `task.start` seguidos no pueden crear dos runs.
  const live: LiveRun = {
    taskId, runId: '', agentId: agent.id, projectId: project.id, adapter, worktree: '',
    pending: new Map(), stopping: false, ended: false, finishing: false, finished: Promise.resolve(),
  };
  ctx.live.set(taskId, live);
  let running = false; // la tarea ya pasó a `running`
  try {
    // Una tarea `failed` liberó sus archivos: se vuelven a reservar (falla si otra tarea los tomó entretanto).
    if (task.status === 'failed') ctx.repos.taskFiles.claim(taskId, files);

    let worktree = task.worktree_path;
    if (!worktree || !existsSync(worktree)) {
      worktree = await createWorktree(project.path, task.id, project.base_branch);
    }
    live.worktree = worktree;
    const run = ctx.repos.runs.create({ taskId, agentId: agent.id });
    live.runId = run.id;
    transition(ctx, taskId, 'running', 'task.start', { branch: branchName(task.id), worktree_path: worktree });
    running = true;
    setRobotStatus(ctx, agent.id, 'thinking');

    const resumeSessionId = task.status === 'paused_limit' ? resumeHint?.sessionId : undefined;
    const spec: RunSpec = {
      runId: run.id,
      cwd: worktree,
      model: agent.model ?? 'sonnet',
      systemPrompt: `${ROLE_PROMPTS[agent.role ?? ''] ?? DEFAULT_ROLE_PROMPT}\nTe llamas ${agent.name}.`,
      prompt: buildPrompt(ctx, task, files, resumeSessionId !== undefined),
      allowedPaths: files,
      budgetUsd: budgetUsd(ctx),
      ...(resumeSessionId ? { resumeSessionId } : {}),
    };
    const stream = adapter.start(spec);
    live.finished = consume(ctx, live, stream);
  } catch (err) {
    // Fallo al arrancar: si ya había run/transición se cierra como `failed`; si no, no se ha tocado nada.
    ctx.live.delete(taskId);
    if (running) await failRun(ctx, live, `no se pudo iniciar el run: ${msg(err)}`);
    else if (live.runId) closeRun(ctx, live, 'failed');
    throw err;
  }
  return taskView(ctx, getTask(ctx, taskId)); // `task.changed` ya se emitió en la transición
}

function readResumeHint(ctx: Ctx, task: TaskRow): { sessionId?: string } | undefined {
  if (task.status !== 'paused_limit') return undefined;
  const raw = ctx.repos.runs.latestByTask(task.id)?.resume_hint;
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as { sessionId?: string };
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Bucle de eventos
// ---------------------------------------------------------------------------

async function consume(ctx: Ctx, live: LiveRun, stream: AsyncIterable<AgentEvent>): Promise<void> {
  try {
    for await (const ev of stream) {
      if (live.ended) break;
      const terminal = await handleEvent(ctx, live, ev);
      if (terminal) break;
    }
    if (!live.ended) await failRun(ctx, live, 'el agente terminó sin dar un resultado');
  } catch (err) {
    // Un fallo inesperado nunca debe dejar la tarea en `running` para siempre.
    await failRun(ctx, live, msg(err)).catch((e) => process.stderr.write(`orquestador: no se pudo marcar la tarea como fallida: ${msg(e)}\n`));
  } finally {
    live.ended = true;
    ctx.live.delete(live.taskId);
  }
}

/** Procesa un evento del adaptador. Devuelve true si era terminal. */
async function handleEvent(ctx: Ctx, live: LiveRun, ev: AgentEvent): Promise<boolean> {
  const base = { projectId: live.projectId, taskId: live.taskId, agentId: live.agentId, runId: live.runId };

  switch (ev.type) {
    case 'thinking':
      logEvent(ctx, { ...base, kind: 'thinking', payload: {} });
      break;
    case 'text':
      logEvent(ctx, { ...base, kind: 'text', payload: { delta: ev.delta } });
      break;
    case 'tool':
      logEvent(ctx, { ...base, kind: 'tool', payload: { name: ev.name, status: ev.status, input: ev.input, output: ev.output } });
      break;
    case 'permission_request':
      onPermissionRequest(ctx, live, ev);
      return false; // onPermissionRequest ya fija el estado del robot
    case 'done':
      await onDone(ctx, live, ev);
      return true;
    case 'error':
      await failRun(ctx, live, ev.message, ev);
      return true;
    case 'limit':
      await onLimit(ctx, live, ev);
      return true;
  }
  const robot = robotStatusFor(ev);
  // Mientras haya un permiso sin contestar el robot sigue pidiendo ayuda.
  if (robot && live.pending.size === 0) setRobotStatus(ctx, live.agentId, robot);
  return false;
}

/** Cierra el run: estado, coste, sesión y aprobaciones sin contestar. Una sola vez por run. */
function closeRun(
  ctx: Ctx,
  live: LiveRun,
  status: 'done' | 'failed' | 'cancelled' | 'paused_limit',
  extra: { costUsd?: number; usage?: { input: number; output: number }; sessionId?: string; resumeHint?: unknown } = {},
): void {
  live.ended = true;
  denyPending(ctx, live, 'el run terminó con la aprobación sin contestar');
  ctx.repos.runs.update(live.runId, {
    status,
    ended_at: Date.now(),
    ...(extra.costUsd !== undefined ? { cost_usd: extra.costUsd } : {}),
    ...(extra.usage ? { input_tokens: extra.usage.input, output_tokens: extra.usage.output } : {}),
    ...(extra.sessionId ? { provider_session_id: extra.sessionId } : {}),
    ...(extra.resumeHint !== undefined ? { resume_hint: JSON.stringify(extra.resumeHint) } : {}),
  });
}

async function failRun(ctx: Ctx, live: LiveRun, message: string, ev?: Extract<AgentEvent, { type: 'error' }>): Promise<void> {
  if (live.runId && !live.ended) closeRun(ctx, live, 'failed', { sessionId: ev?.sessionId });
  live.ended = true;
  await stopAdapter(live);
  logEvent(ctx, {
    projectId: live.projectId, taskId: live.taskId, agentId: live.agentId, runId: live.runId || null,
    kind: 'error', payload: { message, retryable: ev?.retryable ?? false },
  });
  const status = getTask(ctx, live.taskId).status;
  if (status === 'running' || status === 'needs_you') transition(ctx, live.taskId, 'failed', message);
  setRobotStatus(ctx, live.agentId, 'error');
}

async function onLimit(ctx: Ctx, live: LiveRun, ev: Extract<AgentEvent, { type: 'limit' }>): Promise<void> {
  const task = getTask(ctx, live.taskId);
  const hint = {
    worktree: live.worktree,
    branch: task.branch,
    files: ctx.repos.taskFiles.list(task.id).map((f) => f.path),
    sessionId: ev.sessionId ?? null,
    kind: ev.kind,
    resetsAt: ev.resetsAt ?? null,
  };
  closeRun(ctx, live, 'paused_limit', { sessionId: ev.sessionId, resumeHint: hint });
  await stopAdapter(live);
  logEvent(ctx, {
    projectId: live.projectId, taskId: live.taskId, agentId: live.agentId, runId: live.runId,
    kind: 'limit', payload: { kind: ev.kind, resetsAt: ev.resetsAt ?? null, message: ev.message },
  });
  transition(ctx, live.taskId, 'paused_limit', ev.message);
  setRobotStatus(ctx, live.agentId, 'idle');
}

/** `done`: red de seguridad de propiedad -> commit -> tests -> `review`. */
async function onDone(ctx: Ctx, live: LiveRun, ev: Extract<AgentEvent, { type: 'done' }>): Promise<void> {
  live.finishing = true;
  closeRun(ctx, live, 'done', { costUsd: ev.costUsd, usage: ev.usage, sessionId: ev.sessionId });
  await stopAdapter(live);
  const base = { projectId: live.projectId, taskId: live.taskId, agentId: live.agentId, runId: live.runId };
  logEvent(ctx, {
    ...base, kind: 'status',
    payload: { type: 'done', text: ev.text, cost_usd: ev.costUsd ?? null, usage: ev.usage ?? null, session_id: ev.sessionId ?? null },
  });
  // Sin aprobaciones pendientes la tarea vuelve a `running` antes de seguir (pudo quedarse en `needs_you`).
  if (getTask(ctx, live.taskId).status === 'needs_you') transition(ctx, live.taskId, 'running', 'run terminado');
  setRobotStatus(ctx, live.agentId, 'done');

  try {
    const task = getTask(ctx, live.taskId);
    const project = projectOfTask(ctx, task);
    const worktree = live.worktree;
    const baseSha = await forkPoint(worktree, project.base_branch);

    // 1) Propiedad: lo que esté fuera de la lista se revierte y la tarea vuelve a `changes`.
    const files = ctx.repos.taskFiles.list(task.id).map((f) => f.path);
    const foreign = await foreignFiles(worktree, baseSha, files);
    if (foreign.length > 0) {
      await revertFiles(worktree, baseSha, foreign);
      const message = `tocó archivos ajenos: ${foreign.join(', ')}`;
      logEvent(ctx, { ...base, kind: 'git', payload: { finding: 'foreign_files', task_id: task.id, files: foreign, message } });
      transition(ctx, task.id, 'changes', message);
      return;
    }

    // 2) Commit del trabajo en la rama de la tarea.
    const sha = await commitAll(worktree, `${task.title}\n\nTarea Kiji ${task.id}`);
    logEvent(ctx, { ...base, kind: 'git', payload: { commit: sha, message: sha ? 'commit creado' : 'sin cambios que guardar' } });

    // 3) Tests del proyecto en el worktree.
    if (project.test_command && project.test_command.trim() !== '') {
      let exitCode: number;
      let output: string;
      let timedOut = false;
      try {
        const r = await runTests(worktree, project.test_command, ctx.testTimeoutMs);
        ({ exitCode, output, timedOut } = r);
      } catch (err) {
        exitCode = 127; // el comando no se pudo lanzar (p. ej. operadores de shell no admitidos)
        output = msg(err);
      }
      ctx.repos.testRuns.create({ taskId: task.id, command: project.test_command, exitCode, output });
      logEvent(ctx, { ...base, kind: 'test', payload: { command: project.test_command, exit_code: exitCode, timed_out: timedOut } });
    }

    // 4) A revisión. El jefe revisará en el paso 12; por ahora se queda aquí.
    transition(ctx, task.id, 'review', 'listo para revisar');
  } catch (err) {
    logEvent(ctx, { ...base, kind: 'error', payload: { message: `falló el cierre del run: ${msg(err)}` } });
    if (getTask(ctx, live.taskId).status === 'running') transition(ctx, live.taskId, 'failed', msg(err));
    setRobotStatus(ctx, live.agentId, 'error');
  }
}

// ---------------------------------------------------------------------------
// Parada
// ---------------------------------------------------------------------------

export async function stopTask(ctx: Ctx, taskId: string) {
  const live = ctx.live.get(taskId);
  if (!live) throw new Error('la tarea no tiene un run en curso');
  if (live.finishing) throw new Error('el run ya terminó y se está guardando el trabajo; espera unos segundos');
  live.stopping = true;
  closeRun(ctx, live, 'cancelled');
  await stopAdapter(live);
  logEvent(ctx, {
    projectId: live.projectId, taskId, agentId: live.agentId, runId: live.runId, kind: 'status', payload: { type: 'stopped' },
  });
  ctx.live.delete(taskId);
  setRobotStatus(ctx, live.agentId, 'idle');
  return transition(ctx, taskId, 'assigned', 'detenida por el usuario');
}

/** Para todos los runs (apagado del core). Las tareas quedan `running`: el próximo `project.open` las pasa a `blocked`. */
export async function stopAll(ctx: Ctx): Promise<void> {
  await Promise.allSettled([...ctx.live.values()].map((l) => stopAdapter(l)));
}

/** Espera a que acaben los runs en curso (pruebas). */
export async function whenIdle(ctx: Ctx): Promise<void> {
  while (ctx.live.size > 0) await Promise.allSettled([...ctx.live.values()].map((l) => l.finished));
}
