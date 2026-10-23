// Prueba real y barata con Claude haiku (opcional): un tick que llama a get_state y done por el servidor MCP del SDK.
// Usa la autenticación de `claude` que ya exista en la máquina; no lee ni imprime claves. Solo corre con KIJI_REAL_CLAUDE=1.
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeAdapter } from '../../src/adapters/claude.js';
import { removeRepo } from '../git/helpers.js';
import { makeManagerHarness, type MgrHarness } from './helpers.js';

let m: MgrHarness;
afterEach(async () => {
  await m?.h.orch.shutdown();
  if (m) removeRepo(m.repo);
});

describe.skipIf(process.env.KIJI_REAL_CLAUDE !== '1')('tick real con Claude haiku', () => {
  it('llama a mcp__kiji__get_state y mcp__kiji__done', async () => {
    m = await makeManagerHarness({ manager: { tickBudgetUsd: 0.05 } });
    m.h.orch.ctx.adapterFactory = () => new ClaudeAdapter();
    m.repos.agents.update(m.boss.id, { model: 'haiku' });
    await m.enable({ dayBudgetUsd: 1 });
    await m.h.call('manager.tick', { projectId: m.project.id, message: 'Prueba: llama a get_state una vez y luego a done con un resumen de una frase. No hagas nada más.' });
    await m.h.waitFor(() => m.ticksEnded() >= 1, 'tick real', 150_000);
    const tick = m.repos.managerTicks.latest(m.project.id)!;
    const tools = m.repos.managerActions.listByTick(tick.id).map((a) => a.tool);
    expect(tools).toContain('get_state');
    expect(tools).toContain('done');
    expect(tick.summary).not.toBe('');
    expect(tick.cost_usd).toBeLessThanOrEqual(0.06);
  }, 170_000);
});
