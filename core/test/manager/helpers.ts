// Utilidades de las pruebas del gerente: cerebro de guion (llama a las herramientas como lo haría el modelo) y arnés.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ManagerPolicy } from '../../../shared/protocol.js';
import type { AgentAdapter, AgentEvent, RunSpec } from '../../src/adapters/types.js';
import type { ManagerOptions } from '../../src/manager/loop.js';
import { defaultPolicy } from '../../src/manager/policy.js';
import { newToolEnv, invokeTool, type ToolEnv } from '../../src/manager/tools.js';
import { makeHarness, makeNodeRepo, type Harness } from '../orchestrator/helpers.js';

export interface BrainApi {
  spec: RunSpec;
  /** Llama a una herramienta por el camino de las tools de OpenAI (el mismo `invokeTool`) y devuelve el JSON parseado. */
  call: (name: string, args?: unknown) => Promise<any>;
  /** Se resuelve cuando el core para el tick (maxTickMinutes / parada global). */
  untilStopped: () => Promise<void>;
  answers: Array<{ id: string; allow: boolean }>;
}
export type BrainScript = (api: BrainApi) => Promise<void>;

/** Adaptador del cerebro: ejecuta un guion de llamadas a herramientas y termina con `done`. */
export class ScriptedBrain implements AgentAdapter {
  readonly provider = 'claude' as const;
  stopped = false;
  answers: Array<{ id: string; allow: boolean }> = [];
  private stop$!: () => void;
  private stopPromise = new Promise<void>((r) => (this.stop$ = r));
  constructor(private readonly script: BrainScript, private readonly cost = 0.01, private readonly extraEvents: AgentEvent[] = []) {}

  start(spec: RunSpec): AsyncIterable<AgentEvent> {
    const self = this;
    return (async function* () {
      for (const e of self.extraEvents) yield e;
      const api: BrainApi = {
        spec,
        answers: self.answers,
        untilStopped: () => self.stopPromise,
        call: async (name, args = {}) => {
          const tool = spec.extraTools!.find((t) => t.name === name);
          if (!tool) throw new Error(`el cerebro no tiene la herramienta ${name}`);
          return JSON.parse((await tool.execute(args)).output);
        },
      };
      await self.script(api);
      if (!self.stopped) yield { type: 'done', text: 'fin del guion', costUsd: self.cost };
    })();
  }
  async send(): Promise<void> {}
  answerPermission(id: string, allow: boolean): void {
    this.answers.push({ id, allow });
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.stop$();
  }
}

export interface MgrHarness {
  h: Harness;
  /** Guiones de los próximos ticks (uno por tick, en orden). Sin guion: el cerebro solo llama a `done`. */
  scripts: BrainScript[];
  /** RunSpec de cada tick que llegó al cerebro. */
  specs: RunSpec[];
  brains: ScriptedBrain[];
  repo: string;
  project: any;
  boss: any;
  worker: any;
  repos: Harness['orch']['ctx']['repos'];
  ctx: Harness['orch']['ctx'];
  /** Activa el gerente con la política dada (parcial sobre la de por defecto). */
  enable: (patch?: Partial<ManagerPolicy> & { levels?: Partial<ManagerPolicy['levels']> }) => Promise<ManagerPolicy>;
  env: () => ToolEnv;
  invoke: (name: string, args?: unknown) => Promise<{ ok?: boolean; error?: string; pending?: boolean; [k: string]: any } & { isError: boolean }>;
  /** Tarea sobre `file` asignada al trabajador. */
  task: (title: string, file?: string, start?: boolean) => Promise<any>;
  /** Tarea con el trabajador ya terminado: queda en `review`. */
  toReview: (title: string, file: string, content: string) => Promise<string>;
  ticksEnded: () => number;
}

export async function makeManagerHarness(opts: { manager?: ManagerOptions; dbPath?: string; repo?: string } = {}): Promise<MgrHarness> {
  const scripts: BrainScript[] = [];
  const specs: RunSpec[] = [];
  const brains: ScriptedBrain[] = [];
  const repo = opts.repo ?? makeNodeRepo();
  const h = makeHarness({
    dbPath: opts.dbPath,
    manager: { minTickGapMs: 0, settleMs: 5, timerMs: 3_600_000, ...opts.manager },
    adapterFactory: (agent, fake) => {
      if (agent.is_boss !== 1) return fake();
      const script = scripts.shift() ?? (async () => undefined);
      const b = new ScriptedBrain(async (api) => {
        specs.push(api.spec);
        await script(api);
      });
      brains.push(b);
      return b;
    },
  });
  const project = await h.call('project.open', { path: repo });
  const agents = await h.call('agent.list', { projectId: project.id });
  const boss = agents.find((a: any) => a.is_boss === 1);
  const worker = agents.find((a: any) => a.is_boss === 0);
  const ctx = h.orch.ctx;
  const tick = () => ctx.repos.managerTicks.create({ projectId: project.id, trigger: 'test' });
  const m: MgrHarness = {
    h, scripts, specs, brains, repo, project, boss, worker, ctx, repos: ctx.repos,
    enable: async (patch = {}) => {
      const base = defaultPolicy(boss.id);
      const policy = { ...base, ...patch, levels: { ...base.levels, ...(patch.levels ?? {}) } } as ManagerPolicy;
      await h.call('manager.set', { projectId: project.id, policy });
      return policy;
    },
    env: () => newToolEnv(ctx, project.id, tick().id),
    invoke: async (name, args = {}) => {
      const r = await invokeTool(newToolEnv(ctx, project.id, tick().id), name, args);
      return { ...JSON.parse(r.output), isError: r.isError };
    },
    task: async (title, file = 'src/a.ts', start = false) => {
      const t = await h.call('task.create', { projectId: project.id, title, files: file ? [file] : [], agent_id: worker.id });
      if (start) await h.call('task.start', { id: t.id, projectId: project.id });
      return t;
    },
    toReview: async (title, file, content) => {
      const t = await m.task(title, file, true);
      const adapter = h.adapters.at(-1)!;
      writeFileSync(join(adapter.spec!.cwd, file), content);
      adapter.push({ type: 'done', text: 'listo' });
      // con el gerente activo puede revisarla antes de que la prueba la vea en `review`
      await h.waitFor(() => !['running', 'needs_you'].includes(ctx.repos.tasks.get(t.id)!.status), `${title} terminada`, 30_000);
      return t.id as string;
    },
    ticksEnded: () => h.emitted.filter((e) => e.name === 'manager.tick' && e.payload.phase === 'ended').length,
  };
  return m;
}
