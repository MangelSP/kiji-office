// D2: herramientas del gerente × niveles de la política, validación de ids, candados y conversión a los dos formatos.
import { afterEach, describe, expect, it } from 'vitest';
import { removeRepo } from '../git/helpers.js';
import { TOOL_NAMES, toExtraTools, toSdkServer, MAX_RETRIES } from '../../src/manager/tools.js';
import { makeManagerHarness, type MgrHarness } from './helpers.js';

let m: MgrHarness;
afterEach(async () => {
  await m.h.orch.shutdown();
  removeRepo(m.repo);
});

const actions = (tool?: string) => m.repos.managerActions.listByProject(m.project.id, 500).filter((a) => !tool || a.tool === tool);
const notices = () => m.h.emitted.filter((e) => e.name === 'notify').map((e) => e.payload);

type Scenario = { tool: string; setup: () => Promise<Record<string, unknown>>; done: (args: Record<string, unknown>) => boolean };

function scenarios(): Scenario[] {
  return [
    {
      tool: 'create_tasks',
      setup: async () => ({ tasks: [{ title: 'Tarea nueva', files: ['src/a.ts'] }] }),
      done: () => m.repos.tasks.listByProject(m.project.id).some((t) => t.title === 'Tarea nueva'),
    },
    {
      tool: 'assign_task',
      setup: async () => {
        const t = await m.h.call('task.create', { projectId: m.project.id, title: 'sin robot', files: ['src/a.ts'] });
        return { taskId: t.id, agentId: m.worker.id };
      },
      done: (a) => m.repos.tasks.get(a.taskId as string)!.agent_id === m.worker.id,
    },
    {
      tool: 'start_task',
      setup: async () => ({ taskId: (await m.task('para arrancar')).id }),
      done: (a) => m.repos.tasks.get(a.taskId as string)!.status === 'running',
    },
    {
      tool: 'retry_task',
      setup: async () => {
        const t = await m.task('fallida', 'src/a.ts', true);
        m.h.adapters.at(-1)!.push({ type: 'error', message: 'boom', retryable: false });
        await m.h.waitFor(() => m.repos.tasks.get(t.id)!.status === 'failed', 'failed');
        return { taskId: t.id, findings: ['usa otro enfoque'] };
      },
      done: (a) => m.repos.tasks.get(a.taskId as string)!.status === 'running',
    },
    {
      tool: 'switch_task',
      setup: async () => {
        const t = await m.task('en marcha', 'src/a.ts', true);
        return { taskId: t.id, model: 'haiku' };
      },
      done: () => m.h.adapters.length >= 2 && m.h.adapters.at(-1)!.spec?.model === 'haiku',
    },
    {
      tool: 'request_integration',
      setup: async () => {
        const id = await m.toReview('para integrar', 'src/a.ts', 'export const a = 5;\n');
        await m.h.call('task.review', { id, verdict: 'approve' });
        return { taskId: id };
      },
      done: (a) => m.repos.tasks.get(a.taskId as string)!.status === 'integrated',
    },
  ];
}

describe('herramienta × nivel', () => {
  for (const level of ['auto', 'notify', 'ask'] as const) {
    for (const sc of scenarios()) {
      it(`${sc.tool} con nivel ${level}`, async () => {
        m = await makeManagerHarness();
        const key = { create_tasks: 'plan', assign_task: 'assign', start_task: 'start', retry_task: 'retry', switch_task: 'relay', request_integration: 'integrate' }[sc.tool]!;
        await m.enable({ levels: { [key]: level } });
        const args = await sc.setup();
        const before = notices().length;
        const r = await m.invoke(sc.tool, args);
        const row = actions(sc.tool).at(0)!;
        expect(row.level).toBe(level);
        if (level === 'ask') {
          expect(r.pending).toBe(true);
          expect(sc.done(args)).toBe(false); // NO ejecuta
          expect(row.decided_by).toBeNull();
          const ap = m.repos.approvals.listPending().filter((a) => a.tool === `manager:${sc.tool}`);
          expect(ap).toHaveLength(1);
          expect(notices().slice(before).some((n) => n.level === 'ask' && n.approvalId === ap[0]!.id)).toBe(true);
          // se puede aprobar: entonces se ejecuta y queda decided_by 'user'
          await m.h.call('approval.answer', { id: ap[0]!.id, allow: true });
          expect(sc.done(args)).toBe(true);
          expect(m.repos.managerActions.get(row.id)!.decided_by).toBe('user');
        } else {
          expect(r.isError).toBe(false);
          expect(sc.done(args)).toBe(true);
          expect(row.decided_by).toBe('policy');
          const info = notices().slice(before).filter((n) => n.title === 'El gerente ha actuado');
          expect(info).toHaveLength(level === 'notify' ? 1 : 0);
        }
      });
    }
  }

  it('si la persona dice NO no se ejecuta y queda en el diario', async () => {
    m = await makeManagerHarness();
    await m.enable({ levels: { start: 'ask' } });
    const t = await m.task('x');
    await m.invoke('start_task', { taskId: t.id });
    const ap = m.repos.approvals.listPending()[0]!;
    await m.h.call('approval.answer', { id: ap.id, allow: false });
    expect(m.repos.tasks.get(t.id)!.status).toBe('assigned');
    expect(actions('start_task')[0]).toMatchObject({ decided_by: 'user' });
    await expect(m.h.call('approval.answer', { id: ap.id, allow: true })).rejects.toThrow(/resuelta/);
  });

  it('no pregunta dos veces lo mismo mientras sigue pendiente', async () => {
    m = await makeManagerHarness();
    await m.enable({ levels: { start: 'ask' } });
    const t = await m.task('x');
    await m.invoke('start_task', { taskId: t.id });
    const again = await m.invoke('start_task', { taskId: t.id });
    expect(again.pending).toBe(true);
    expect(m.repos.approvals.listPending()).toHaveLength(1);
  });

  it('spend: pasado spendAskUsd, arrancar usa el nivel spend (ask) aunque start sea auto; y el tope del día lo impide', async () => {
    m = await makeManagerHarness();
    await m.enable({ spendAskUsd: 1, dayBudgetUsd: 10, levels: { start: 'auto', spend: 'ask' } });
    const t = await m.task('x');
    const tick = m.repos.managerTicks.create({ projectId: m.project.id, trigger: 't' });
    m.repos.managerTicks.end(tick.id, { costUsd: 0 });
    // gasto del día del proyecto: un run antiguo de hoy con coste
    const old = await m.task('vieja', 'src/other.ts');
    const run = m.repos.runs.create({ taskId: old.id, agentId: m.worker.id, model: 'sonnet' });
    m.repos.runs.update(run.id, { cost_usd: 2, status: 'done', ended_at: Date.now() });
    const r = await m.invoke('start_task', { taskId: t.id });
    expect(r.pending).toBe(true);
    expect(actions('start_task')[0]!.level).toBe('ask');
    // tope duro: el coste del gerente en el día lo supera -> error, sin pregunta
    const tk = m.repos.managerTicks.create({ projectId: m.project.id, trigger: 't2' });
    m.repos.managerTicks.end(tk.id, { costUsd: 11 });
    const r2 = await m.invoke('retry_task', { taskId: t.id, findings: ['x'] });
    expect(r2.isError).toBe(true);
    const r3 = await m.invoke('start_task', { taskId: old.id });
    expect(r3.error).toMatch(/tope del día/);
  });
});

describe('candados y validación', () => {
  it('no existen approval.answer, integration.revert, project.*, connection.*, settings.* ni secrets.*', async () => {
    m = await makeManagerHarness();
    await m.enable();
    expect(TOOL_NAMES).toEqual([
      'get_state', 'create_tasks', 'assign_task', 'start_task', 'stop_task', 'retry_task', 'switch_task', 'review_task',
      'get_diff', 'get_test_output', 'request_integration', 'remember', 'recall', 'notify_user', 'ask_user', 'done',
    ]);
    const env = m.env();
    const names = [...toExtraTools(env).map((t) => t.name), ...((toSdkServer(env) as any).instance ? TOOL_NAMES : [])];
    expect(names.some((n) => /approval|revert|project|connection|settings|secrets/.test(n))).toBe(false);
    for (const bad of ['approval.answer', 'approval_answer', 'integration.revert', 'project.close', 'connection.delete', 'settings.set', 'secrets.put']) {
      const r = await m.invoke(bad, { id: 'x', allow: true });
      expect(r).toMatchObject({ ok: false, isError: true });
      expect(r.error).toMatch(/desconocida/);
    }
    expect(actions('approval.answer')).toHaveLength(1); // el intento queda en el diario
  });

  it('el approval.answer de una pregunta del gerente no lo puede contestar el propio gerente: ninguna herramienta lo hace', async () => {
    m = await makeManagerHarness();
    await m.enable({ levels: { start: 'ask' } });
    const t = await m.task('x');
    await m.invoke('start_task', { taskId: t.id });
    const ap = m.repos.approvals.listPending()[0]!;
    for (const tool of toExtraTools(m.env())) {
      if (tool.name === 'get_state') continue;
      const r = await m.invoke(tool.name, { id: ap.id, approvalId: ap.id, allow: true });
      expect(r.pending).not.toBe(false);
    }
    expect(m.repos.approvals.get(ap.id)!.status).toBe('pending');
  });

  it('projectId de otro proyecto se rechaza; el propio se ignora; ids ajenos (tarea, robot, objetivo) no existen', async () => {
    m = await makeManagerHarness();
    await m.enable();
    const other = m.repos.projects.create({ path: '/otro', name: 'otro' });
    const obj = m.repos.objectives.create({ projectId: other.id, text: 'ajeno' });
    const foreignTask = m.repos.tasks.create({ objectiveId: obj.id, title: 'ajena' });
    const foreignAgent = m.repos.agents.create({ projectId: other.id, name: 'X', provider: 'claude', model: 'sonnet', role: 'programador' });
    const mine = await m.task('mía');

    expect(await m.invoke('get_state', { projectId: other.id })).toMatchObject({ isError: true, error: expect.stringMatching(/projectId lo fija Kiji/) });
    expect((await m.invoke('get_state', { projectId: m.project.id })).isError).toBe(false);
    expect((await m.invoke('start_task', { taskId: foreignTask.id })).error).toMatch(/no existe en este proyecto/);
    expect((await m.invoke('stop_task', { taskId: foreignTask.id })).error).toMatch(/no existe en este proyecto/);
    expect((await m.invoke('assign_task', { taskId: mine.id, agentId: foreignAgent.id })).error).toMatch(/no existe en este proyecto/);
    expect((await m.invoke('create_tasks', { objectiveId: obj.id, tasks: [{ title: 'x' }] })).error).toMatch(/no existe en este proyecto/);
    expect((await m.invoke('review_task', { taskId: foreignTask.id, verdict: 'approve' })).error).toMatch(/no existe/);
    expect((await m.invoke('get_diff', { taskId: foreignTask.id })).error).toMatch(/no existe/);
    expect((await m.invoke('switch_task', { taskId: foreignTask.id, model: 'haiku' })).error).toMatch(/no existe/);
    expect(m.repos.tasks.get(foreignTask.id)!.status).toBe('todo');
    // el estado que ve el gerente no incluye nada del otro proyecto
    expect(JSON.stringify(await m.invoke('get_state'))).not.toContain('ajena');
  });

  it('create_tasks valida títulos, rol y solapes de archivos (entre tareas del plan y con tareas vivas)', async () => {
    m = await makeManagerHarness();
    await m.enable();
    await m.task('viva', 'src/a.ts');
    const err = async (tasks: unknown[]) => (await m.invoke('create_tasks', { tasks })).error as string;
    expect(await err([{ title: 'x', files: ['src/a.ts'] }])).toMatch(/ya pertenece a la tarea viva/);
    expect(await err([{ title: 'x', files: ['src/n'] }, { title: 'y', files: ['src/n/z.ts'] }])).toMatch(/se solapa/);
    expect(await err([{ title: 'x' }, { title: 'X' }])).toMatch(/repetido/);
    expect(await err([{ title: 'x', role: 'astronauta' }])).toMatch(/rol/);
    expect(await err([{ title: 'x', files: ['../fuera'] }])).toMatch(/ruta/);
    expect(await err([{ title: '   ' }])).toMatch(/argumentos no válidos|título/);
    expect(m.repos.tasks.listByProject(m.project.id)).toHaveLength(1); // nada se creó a medias
    const ok = await m.invoke('create_tasks', { tasks: [{ title: 'a1', files: ['src/other.ts'], role: 'programador' }, { title: 'consulta' }] });
    expect(ok.created).toHaveLength(2);
    // asignación automática por rol
    const assigned = await m.invoke('assign_task', { taskId: ok.created[0].id });
    expect(assigned).toMatchObject({ ok: true, agentId: m.worker.id });
  });

  it('retry_task: máximo 2 reintentos por tarea', async () => {
    m = await makeManagerHarness();
    await m.enable();
    const t = await m.task('terca', 'src/a.ts', true);
    for (let i = 1; i <= MAX_RETRIES + 1; i++) {
      m.h.adapters.at(-1)!.push({ type: 'error', message: `fallo ${i}`, retryable: false });
      await m.h.waitFor(() => m.repos.tasks.get(t.id)!.status === 'failed', `failed ${i}`);
      const r = await m.invoke('retry_task', { taskId: t.id, findings: ['prueba otra vez'] });
      if (i <= MAX_RETRIES) {
        expect(r).toMatchObject({ ok: true, retry: i });
        await m.h.waitFor(() => m.repos.tasks.get(t.id)!.status === 'running', 'running');
      } else {
        expect(r.isError).toBe(true);
        expect(r.error).toMatch(/máximo 2/);
      }
    }
    // el hallazgo del gerente viaja en el prompt del siguiente run
    expect(m.h.adapters[1]!.spec!.prompt).toContain('prueba otra vez');
    const st = await m.invoke('get_state');
    expect(st.tasks.find((x: any) => x.id === t.id).retriesUsed).toBe(2);
  });

  it('review_task: una consulta de solo lectura aprobada queda integrada sin fila de integrations', async () => {
    m = await makeManagerHarness();
    await m.enable();
    const t = await m.task('pregunta', '', true);
    m.h.adapters.at(-1)!.push({ type: 'done', text: 'respuesta' });
    await m.h.waitFor(() => m.repos.tasks.get(t.id)!.status === 'review', 'review');
    expect((await m.invoke('review_task', { taskId: t.id, verdict: 'changes' })).error).toMatch(/hallazgo/);
    const r = await m.invoke('review_task', { taskId: t.id, verdict: 'approve' });
    expect(r.status).toBe('integrated');
    expect(m.repos.integrations.getByTask(t.id)).toBeUndefined();
    expect((await m.invoke('request_integration', { taskId: t.id })).error).toMatch(/aprobadas/);
  });

  it('get_diff, get_test_output, remember, recall, notify_user y ask_user', async () => {
    m = await makeManagerHarness();
    await m.enable();
    const id = await m.toReview('con diff', 'src/a.ts', 'export const a = 77;\n');
    expect((await m.invoke('get_diff', { taskId: id })).diff).toContain('a = 77');
    expect(await m.invoke('get_test_output', { taskId: id })).toMatchObject({ ok: true, exitCode: 0 });
    await m.invoke('remember', { kind: 'preference', text: 'Siempre pnpm, nunca npm' });
    expect((await m.invoke('recall', { query: 'pnpm' })).memories[0].text).toContain('pnpm');
    expect(m.repos.memory.recent(m.project.id)[0]).toMatchObject({ source: 'manager', kind: 'preference' });
    await m.invoke('notify_user', { text: 'Mira en /Users/x/repo/secret.ts', level: 'warn' });
    const n = m.h.emitted.filter((e) => e.name === 'notify').at(-1)!.payload;
    expect(n).toMatchObject({ level: 'warn' });
    expect(n.body).not.toContain('/Users');
    // ask_user: siempre pregunta, con opciones; solo vale una de ellas
    const q = await m.invoke('ask_user', { question: '¿Qué base de datos?', options: ['sqlite', 'postgres'] });
    expect(q.pending).toBe(true);
    const ap = m.repos.approvals.listPending().find((a) => a.tool === 'manager:ask_user')!;
    expect(JSON.parse(ap.input)).toMatchObject({ question: '¿Qué base de datos?', options: ['sqlite', 'postgres'] });
    await expect(m.h.call('approval.answer', { id: ap.id, allow: true, option: 'mongo' })).rejects.toThrow(/option/);
    await expect(m.h.call('approval.answer', { id: ap.id, allow: false, option: 'sqlite' })).rejects.toThrow(/allow:true/);
    expect(await m.h.call('approval.answer', { id: ap.id, allow: true, option: 'postgres' })).toMatchObject({ status: 'approved', option: 'postgres' });
    expect(JSON.parse(actions('ask_user')[0]!.result)).toMatchObject({ ok: true, option: 'postgres' });
    expect(actions('ask_user')[0]!.decided_by).toBe('user');
  });
});

describe('conversión a los dos formatos', () => {
  it('Claude: servidor sdk «kiji»; api-loop: tools con esquema JSON sin $schema', async () => {
    m = await makeManagerHarness();
    const env = m.env();
    const server = toSdkServer(env) as any;
    expect(server).toMatchObject({ type: 'sdk', name: 'kiji' });
    const tools = toExtraTools(env);
    expect(tools.map((t) => t.name)).toEqual([...TOOL_NAMES]);
    const create = tools.find((t) => t.name === 'create_tasks')!;
    expect(create.parameters).toMatchObject({ type: 'object', required: ['tasks'] });
    expect(JSON.stringify(create.parameters)).not.toContain('$schema');
  });
});
