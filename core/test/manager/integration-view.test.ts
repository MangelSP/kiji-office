// Campos nuevos de la integración para la UI: fases, motivo del fallo y código `dirty`.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { removeRepo } from '../git/helpers.js';
import { makeManagerHarness, type MgrHarness } from './helpers.js';

let m: MgrHarness;
afterEach(async () => {
  await m.h.orch.shutdown();
  removeRepo(m.repo);
});

const phases = () => m.h.emitted.filter((e) => e.name === 'integration.changed').map((e) => e.payload.phase);

describe('integration.apply para la UI', () => {
  it('éxito: fases rebase → tests → merge → done', async () => {
    m = await makeManagerHarness();
    const id = await m.toReview('ok', 'src/a.ts', 'export const a = 2;\n');
    await m.h.call('task.review', { id, verdict: 'approve' });
    const v = await m.h.call('integration.apply', { id });
    expect(v.status).toBe('applied');
    expect(phases()).toEqual(['rebase', 'tests', 'merge', 'done']);
  });

  it('tests que fallan: status failed con reason tests_failed y output', async () => {
    m = await makeManagerHarness();
    const id = await m.toReview('malo', 'src/a.ts', 'export const a = 3;\n');
    await m.h.call('task.review', { id, verdict: 'approve' });
    m.repos.projects.update(m.project.id, { testCommand: 'node -e "console.log(\'rojo\');process.exit(1)"' });
    m.ctx.projects.set(m.project.id, m.repos.projects.get(m.project.id)!);
    const v = await m.h.call('integration.apply', { id });
    expect(v).toMatchObject({ status: 'failed', reason: 'tests_failed' });
    expect(v.output).toContain('rojo');
    expect(phases().at(-1)).toBe('failed');
  });

  it('repo principal sucio: lanza con code dirty', async () => {
    m = await makeManagerHarness();
    const id = await m.toReview('sucio', 'src/a.ts', 'export const a = 4;\n');
    await m.h.call('task.review', { id, verdict: 'approve' });
    writeFileSync(join(m.repo, 'src', 'other.ts'), 'export const other = 99;\n');
    const err = await m.h.call('integration.apply', { id }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as any).code).toBe('dirty');
    expect(m.repos.tasks.get(id)!.status).toBe('approved');
  });
});
