// Utilidades de las pruebas del orquestador: adaptador falso, repo temporal con package.json y recolector de eventos.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AsyncQueue } from '../../src/adapters/queue.js';
import type { AgentAdapter, AgentEvent, RunSpec } from '../../src/adapters/types.js';
import { openDb } from '../../src/db/db.js';
import { createOrchestrator, type Orchestrator, type OrchestratorOptions } from '../../src/orchestrator/index.js';
import { git, makeRepo } from '../git/helpers.js';

/** Adaptador falso: el test empuja los eventos a mano y ve las respuestas de permisos. No llama a ninguna API. */
export class FakeAdapter implements AgentAdapter {
  readonly provider = 'claude' as const;
  spec: RunSpec | null = null;
  answers: Array<{ id: string; allow: boolean; reason?: string }> = [];
  stopped = false;
  private queue = new AsyncQueue<AgentEvent>();

  start(spec: RunSpec): AsyncIterable<AgentEvent> {
    this.spec = spec;
    return this.queue;
  }
  push(...events: AgentEvent[]): void {
    for (const e of events) this.queue.push(e);
  }
  end(): void {
    this.queue.end();
  }
  async send(): Promise<void> {}
  answerPermission(id: string, allow: boolean, reason?: string): void {
    this.answers.push({ id, allow, reason });
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.queue.end();
  }
}

/** Repo temporal con rama main, package.json con test que pasa, src/a.ts y src/other.ts. */
export function makeNodeRepo(): string {
  const dir = makeRepo();
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'node -e "process.exit(0)"' } }, null, 2));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(dir, 'src', 'other.ts'), 'export const other = 1;\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'node');
  return dir;
}

export type Emitted = { name: string; payload: any };

export interface Harness {
  orch: Orchestrator;
  emitted: Emitted[];
  adapters: FakeAdapter[];
  call: (method: string, params?: unknown) => Promise<any>;
  /** Estados del robot (agent.status) en orden, sin repetidos consecutivos, de un agente. */
  robot: (agentId: string) => string[];
  /** Espera a que se cumpla la condición (mira cada 10 ms). */
  waitFor: (cond: () => boolean, what: string, ms?: number) => Promise<void>;
}

export function makeHarness(
  opts: { testTimeoutMs?: number; dbPath?: string } & Pick<OrchestratorOptions, 'skillsDir' | 'metricsNotifyMs' | 'metricsWriteMs' | 'providerDeps'> = {},
): Harness {
  const emitted: Emitted[] = [];
  const adapters: FakeAdapter[] = [];
  const orch = createOrchestrator({
    db: openDb(opts.dbPath ?? ':memory:'),
    emit: (name, payload) => emitted.push({ name, payload: JSON.parse(JSON.stringify(payload)) }),
    adapterFactory: () => {
      const a = new FakeAdapter();
      adapters.push(a);
      return a;
    },
    testTimeoutMs: opts.testTimeoutMs,
    skillsDir: opts.skillsDir ?? '/nonexistent/kiji-skills', // nunca leer las skills reales de la persona que corre los tests
    metricsNotifyMs: opts.metricsNotifyMs,
    metricsWriteMs: opts.metricsWriteMs,
    // Sin red: Ollama "no responde" salvo que el test pase su propio fetch.
    providerDeps: opts.providerDeps ?? { fetch: (async () => { throw new Error('sin red en los tests'); }) as unknown as typeof fetch, env: {}, homeDir: '/nonexistent' },
  });
  const waitFor = async (cond: () => boolean, what: string, ms = 8000) => {
    const deadline = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > deadline) throw new Error(`timeout esperando: ${what}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  return {
    orch,
    emitted,
    adapters,
    call: async (method, params) => {
      const h = orch.handlers[method];
      if (!h) throw new Error(`método sin handler: ${method}`);
      return h(params);
    },
    robot: (agentId) =>
      emitted.filter((e) => e.name === 'agent.status' && e.payload.agent_id === agentId).map((e) => e.payload.status),
    waitFor,
  };
}
