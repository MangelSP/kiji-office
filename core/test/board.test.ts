import { describe, expect, it } from 'vitest';
import { boardColumnFor, boardFlagFor, findingIsFailure, type BoardContext, type BoardTaskInput } from '../src/board.js';

const ctx = (o: Partial<BoardContext> = {}): BoardContext => ({
  agentRole: 'programador', hasFiles: true, from: null, current: null, hasFindings: false, lastFindingIsFailure: false, ...o,
});
const task = (status: string, o: Partial<BoardTaskInput> = {}): BoardTaskInput => ({ status, agent_id: 'a', acceptance: null, branch: null, ...o });
const col = (status: string, c: Partial<BoardContext> = {}, t: Partial<BoardTaskInput> = {}) => boardColumnFor(task(status, t), ctx(c));

describe('boardColumnFor', () => {
  it('refinement: sin agente, o sin archivos ni criterio; refined: con agente y alcance', () => {
    expect(col('todo', {}, { agent_id: null })).toBe('refinement');
    expect(col('assigned', { hasFiles: false })).toBe('refinement');
    expect(col('assigned', { hasFiles: false }, { acceptance: '{"role":"tester"}' })).toBe('refinement'); // solo el rol
    expect(col('assigned', { hasFiles: false }, { acceptance: '["pasa el login"]' })).toBe('refined');
    expect(col('assigned')).toBe('refined');
  });

  it('doing_dev vs doing_qa por el rol del agente', () => {
    expect(col('running')).toBe('doing_dev');
    expect(col('needs_you')).toBe('doing_dev');
    expect(col('running', { agentRole: 'tester' })).toBe('doing_qa');
    expect(col('running', { agentRole: 'revisor-critico' })).toBe('doing_qa');
  });

  it('committed, functional, done y doing_qa durante los tests de integración', () => {
    expect(col('review')).toBe('committed');
    expect(col('approved')).toBe('functional');
    expect(col('approved', { integrationTests: true })).toBe('doing_qa');
    expect(col('integrated')).toBe('done');
    expect(col('integrated', { current: 'done_prod' })).toBe('done_prod'); // done_prod nunca es automático, pero no se pisa
    expect(col('review', { current: 'done' })).not.toBe('done_prod');
  });

  it('bug: changes con hallazgo de fallo; sin fallo vuelve a committed', () => {
    expect(col('changes', { hasFindings: true, lastFindingIsFailure: true })).toBe('bug');
    expect(col('changes', { hasFindings: true, lastFindingIsFailure: false })).toBe('committed');
    expect(col('changes')).toBe('committed');
  });

  it('fix: running tras changes/bug/failed con hallazgos; sin hallazgos es doing_dev', () => {
    expect(col('running', { from: 'changes', hasFindings: true })).toBe('fix');
    expect(col('running', { from: 'failed', hasFindings: true })).toBe('fix');
    expect(col('running', { from: 'needs_you', current: 'bug', hasFindings: true })).toBe('fix');
    expect(col('running', { from: 'needs_you', current: 'fix', hasFindings: true })).toBe('fix');
    expect(col('running', { from: 'changes' })).toBe('doing_dev');
    expect(col('running', { from: 'assigned', hasFindings: true })).toBe('doing_dev');
  });

  it('blocked / failed / paused_limit se quedan en su columna y llevan marca', () => {
    for (const s of ['blocked', 'failed', 'paused_limit']) {
      expect(col(s, { current: 'doing_dev' })).toBe('doing_dev');
      expect(boardFlagFor(s)).toBe(s);
    }
    expect(boardFlagFor('running')).toBeNull();
  });

  it('findingIsFailure', () => {
    expect(findingIsFailure({ finding: 'tests_failed' })).toBe(true);
    expect(findingIsFailure({ finding: 'review', failure: true })).toBe(true);
    expect(findingIsFailure({ finding: 'review', message: 'el login falla con clave vacía' })).toBe(true);
    expect(findingIsFailure({ finding: 'review', message: 'renombra a2' })).toBe(false);
    expect(findingIsFailure({ finding: 'rebase_conflict', message: 'conflicto' })).toBe(false);
  });
});
