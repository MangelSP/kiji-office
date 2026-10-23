import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));

import { query } from '@anthropic-ai/claude-agent-sdk';
import {
  CLAUDE_NOT_FOUND_MESSAGE,
  ClaudeAdapter,
  claudePathFromEnv,
  claudeVersionWarning,
  compareVersions,
  friendlyClaudeError,
  MIN_CLAUDE_VERSION,
} from '../../src/adapters/claude.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(query).mockReset();
});

describe('claude: ruta y versión mínima', () => {
  it('MIN_CLAUDE_VERSION coincide con el CLI emparejado con el SDK instalado', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../../node_modules/@anthropic-ai/claude-agent-sdk/package.json', import.meta.url), 'utf8'));
    expect(MIN_CLAUDE_VERSION).toBe(pkg.claudeCodeVersion);
  });

  it('compareVersions', () => {
    expect(compareVersions('2.1.296 (Claude Code)', '2.1.308')).toBe(-1);
    expect(compareVersions('2.1.308', '2.1.308')).toBe(0);
    expect(compareVersions('2.2.0', '2.1.308')).toBe(1);
    expect(compareVersions('nada', '2.1.308')).toBeNull();
  });

  it('claudePathFromEnv ignora vacío', () => {
    expect(claudePathFromEnv({ KIJI_CLAUDE_PATH: ' /a/claude ' })).toBe('/a/claude');
    expect(claudePathFromEnv({ KIJI_CLAUDE_PATH: '' })).toBeUndefined();
    expect(claudePathFromEnv({})).toBeUndefined();
  });

  it('friendlyClaudeError traduce solo la falta de binario', () => {
    expect(friendlyClaudeError('Native CLI binary for darwin-arm64 not found')).toBe(CLAUDE_NOT_FOUND_MESSAGE);
    expect(friendlyClaudeError('401 invalid key')).toBe('401 invalid key');
  });

  it('claudeVersionWarning: antigua avisa, actual o ilegible no', async () => {
    const mk = (out: string | Error): any => (_f: string, _a: string[], _o: unknown, cb: any) => (out instanceof Error ? cb(out, '', '') : cb(null, out, ''));
    expect(await claudeVersionWarning('/c', mk('2.0.0 (Claude Code)'))).toMatch(/2\.0\.0.*claude update/);
    expect(await claudeVersionWarning('/c', mk(`${MIN_CLAUDE_VERSION} (Claude Code)`))).toBeNull();
    expect(await claudeVersionWarning('/c', mk(new Error('boom')))).toBeNull();
  });

  it('el adaptador usa KIJI_CLAUDE_PATH y mapea el fallo de binario', async () => {
    vi.stubEnv('KIJI_CLAUDE_PATH', '/opt/claude');
    let seen: any;
    vi.mocked(query).mockImplementation(((p: any) => {
      seen = p.options;
      throw new Error('Native CLI binary for linux-x64 not found');
    }) as any);
    const a = new ClaudeAdapter();
    const events = [];
    for await (const e of a.start({ runId: 'r', cwd: '/w', model: 'haiku', systemPrompt: 's', prompt: 'p', allowedPaths: [], budgetUsd: 0.01 } as any)) events.push(e);
    expect(seen.pathToClaudeCodeExecutable).toBe('/opt/claude');
    expect(events[0]).toMatchObject({ type: 'error', message: CLAUDE_NOT_FOUND_MESSAGE });
  });
});
