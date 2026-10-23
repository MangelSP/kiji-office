// extensions.list / extensions.remove: MCP y skills de Claude Code del usuario, con HOME y repos temporales.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { removeRepo } from '../git/helpers.js';
import { makeHarness, makeNodeRepo, type Harness } from './helpers.js';

let h: Harness;
let home: string;
let repo: string;
let pid: string;
beforeEach(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'kiji-home-')));
  vi.stubEnv('HOME', home);
  vi.stubEnv('XDG_DATA_HOME', join(home, '.local', 'share'));
  vi.stubEnv('APPDATA', join(home, 'AppData'));
  h = makeHarness();
  repo = realpathSync(makeNodeRepo());
  pid = (await h.call('project.open', { path: repo })).id;
});
afterEach(async () => {
  await h.orch.shutdown();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
  removeRepo(repo);
});
const put = (file: string, text: string) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, text); };
const skill = (dir: string, name: string, desc: string) => put(join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${desc}\n---\ncuerpo\n`);

const CJ = {
  numStartups: 3,
  mcpServers: {
    pg: { type: 'stdio', command: 'npx', args: ['-y', 'pg', 'postgres://u:SECRET@h/db'], env: { DB_PASS: 'SECRET' } },
    web: { type: 'http', url: 'https://user:SECRET@api.test/mcp?token=SECRET', headers: { Authorization: 'Bearer SECRET' } },
  },
  projects: { '': {}, } as Record<string, unknown>,
};

describe('extensions.list', () => {
  it('lista MCP global/local/proyecto sin credenciales, y avisa de JSON rotos', async () => {
    CJ.projects[repo] = { mcpServers: { loc: { command: 'node' } }, otra: 1 };
    put(join(home, '.claude.json'), JSON.stringify(CJ, null, 2));
    put(join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { proj: { type: 'sse', url: 'http://x.test/sse' } } }));
    const r = await h.call('extensions.list', { projectId: pid });
    const by = Object.fromEntries(r.mcp.map((m: any) => [m.name, m]));
    expect(by.pg).toMatchObject({ scope: 'user', projectId: null, transport: 'stdio', command: 'npx', envNames: ['DB_PASS'], source: join(home, '.claude.json') });
    expect(by.web).toMatchObject({ transport: 'http', url: 'https://api.test/mcp', headerNames: ['Authorization'] });
    expect(by.loc).toMatchObject({ scope: 'local', projectId: pid });
    expect(by.proj).toMatchObject({ scope: 'project', transport: 'sse', source: join(repo, '.mcp.json') });
    expect(JSON.stringify(r)).not.toContain('SECRET');
    put(join(repo, '.mcp.json'), '{rota');
    const r2 = await h.call('extensions.list');
    expect(r2.warnings).toHaveLength(1);
    expect(r2.warnings[0].file).toBe(join(repo, '.mcp.json'));
  });

  it('sin archivos no lanza; lista skills (enlaces, proyecto) y las de plugins como solo lectura', async () => {
    expect(await h.call('extensions.list', {})).toEqual({ mcp: [], skills: [], warnings: [] });
    skill(join(home, 'ext'), 'linked', 'enlazada');
    skill(join(home, '.claude', 'skills'), 'real', 'una real');
    symlinkSync(join(home, 'ext', 'linked'), join(home, '.claude', 'skills', 'linked'));
    skill(join(repo, '.claude', 'skills'), 'delrepo', 'del repo');
    const plug = join(home, '.claude', 'plugins', 'cache', 'p', '1');
    skill(join(plug, 'skills'), 'pskill', 'de plugin');
    put(join(plug, '.mcp.json'), JSON.stringify({ pmcp: { command: 'x' } }));
    put(join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'demo@mk': [{ installPath: plug }] } }));
    const r = await h.call('extensions.list', { projectId: pid });
    const by = Object.fromEntries(r.skills.map((s: any) => [s.name, s]));
    expect(by.real).toMatchObject({ scope: 'user', isSymlink: false, description: 'una real' });
    expect(by.linked).toMatchObject({ isSymlink: true, target: join(home, 'ext', 'linked') });
    expect(by.delrepo).toMatchObject({ scope: 'project', projectId: pid });
    expect(by.pskill).toMatchObject({ scope: 'plugin', managedBy: 'plugin:demo' });
    expect(r.mcp[0]).toMatchObject({ name: 'pmcp', managedBy: 'plugin:demo' });
    await expect(h.call('extensions.remove', { kind: 'mcp', scope: 'plugin', name: 'pmcp' })).rejects.toThrow(/plugin/);
  });
});

describe('extensions.remove', () => {
  it('MCP: quita solo esa clave, deja copia, conserva el resto y emite el evento', async () => {
    CJ.projects[repo] = { mcpServers: { loc: { command: 'node' }, keep: { command: 'k' } }, otra: 1 };
    put(join(home, '.claude.json'), JSON.stringify(CJ, null, 2));
    const before = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));
    const g = await h.call('extensions.remove', { kind: 'mcp', scope: 'user', name: 'web' });
    expect(g.removed).toBe(true);
    expect(JSON.parse(readFileSync(g.backup, 'utf8'))).toEqual(before);
    const after = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));
    expect(Object.keys(after.mcpServers)).toEqual(['pg']);
    expect(after.numStartups).toBe(3);
    expect(readdirSync(home).filter((f) => f.includes('kiji-tmp'))).toEqual([]);
    expect(h.emitted.at(-1)).toMatchObject({ name: 'extensions.changed', payload: { kind: 'mcp', scope: 'user', name: 'web' } });
    await h.call('extensions.remove', { kind: 'mcp', scope: 'local', name: 'loc', projectId: pid });
    const a2 = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));
    expect(a2.projects[repo]).toEqual({ mcpServers: { keep: { command: 'k' } }, otra: 1 });
    await expect(h.call('extensions.remove', { kind: 'mcp', scope: 'user', name: 'web' })).rejects.toThrow(/no existe/);
    await expect(h.call('extensions.remove', { kind: 'mcp', scope: 'local', name: 'keep' })).rejects.toThrow(/projectId/);
  });

  it('MCP de proyecto: edita <repo>/.mcp.json', async () => {
    put(join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { a: { command: 'a' }, b: { command: 'b' } } }, null, 2) + '\n');
    await h.call('extensions.remove', { kind: 'mcp', scope: 'project', name: 'a', projectId: pid });
    expect(readFileSync(join(repo, '.mcp.json'), 'utf8')).toBe(JSON.stringify({ mcpServers: { b: { command: 'b' } } }, null, 2) + '\n');
  });

  it('skills: enlace -> solo el enlace; carpeta -> papelera; valida el nombre', async () => {
    skill(join(home, 'ext'), 'linked', 'x');
    skill(join(home, '.claude', 'skills'), 'real', 'r');
    symlinkSync(join(home, 'ext', 'linked'), join(home, '.claude', 'skills', 'linked'));
    await h.call('extensions.remove', { kind: 'skill', scope: 'user', name: 'linked' });
    expect(() => lstatSync(join(home, '.claude', 'skills', 'linked'))).toThrow();
    expect(existsSync(join(home, 'ext', 'linked', 'SKILL.md'))).toBe(true);
    const r = await h.call('extensions.remove', { kind: 'skill', scope: 'user', name: 'real' });
    expect(existsSync(join(home, '.claude', 'skills', 'real'))).toBe(false);
    expect(r.trashPath.startsWith(home)).toBe(true);
    expect(existsSync(join(r.trashPath, 'SKILL.md'))).toBe(true);
    for (const name of ['../x', 'a/b', '..', '', '.oculta', 'a\\b']) {
      await expect(h.call('extensions.remove', { kind: 'skill', scope: 'user', name })).rejects.toThrow(/no válido/);
    }
    skill(join(repo, '.claude', 'skills'), 'delrepo', 'd');
    const p = await h.call('extensions.remove', { kind: 'skill', scope: 'project', name: 'delrepo', projectId: pid });
    expect(existsSync(join(p.trashPath, 'SKILL.md'))).toBe(true);
    await expect(h.call('extensions.remove', { kind: 'skill', scope: 'plugin', name: 'x' })).rejects.toThrow(/plugins/);
  });
});
