// Perfil del agente (D12): agent.update, skills.list y su paso al run (persona en el system prompt, skills en el spec).
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseFrontmatter, scanSkills } from '../../src/orchestrator/skills.js';
import { removeRepo } from '../git/helpers.js';
import { makeHarness, makeNodeRepo, type Harness } from './helpers.js';

let repo: string;
let root: string; // carpeta que hace de ~/.claude
let skills: string;
let outside: string;
let h: Harness;

function skill(name: string, frontmatter: string, body = 'contenido SECRETO de la skill') {
  mkdirSync(join(skills, name), { recursive: true });
  writeFileSync(join(skills, name, 'SKILL.md'), `---\n${frontmatter}\n---\n${body}\n`);
}

beforeEach(async () => {
  repo = makeNodeRepo();
  root = mkdtempSync(join(tmpdir(), 'kiji-claude-'));
  skills = join(root, 'skills');
  outside = join(root, 'fuera');
  mkdirSync(skills);
  mkdirSync(join(outside, 'ajena'), { recursive: true });
  writeFileSync(join(outside, 'ajena', 'SKILL.md'), '---\nname: ajena\ndescription: no debe verse\n---\n');
  skill('zeta', 'name: zeta\ndescription: Última en orden');
  skill('alfa', 'name: alfa\ndescription: "Primera, con comillas"');
  skill('multi', 'name: multi\ndescription: >\n  Descripción larga\n  en varias líneas');
  h = makeHarness({ skillsDir: skills });
  await h.call('project.open', { path: repo });
});
afterEach(async () => {
  await h.orch.shutdown();
  removeRepo(repo);
  rmSync(root, { recursive: true, force: true });
});

const worker = async () => (await h.call('agent.list')).find((a: any) => a.is_boss === 0);
const boss = async () => (await h.call('agent.list')).find((a: any) => a.is_boss === 1);

describe('skills.list', () => {
  it('solo name y description, en orden alfabético, nunca el contenido', async () => {
    const list = await h.call('skills.list');
    expect(list).toEqual([
      { name: 'alfa', description: 'Primera, con comillas' },
      { name: 'multi', description: 'Descripción larga en varias líneas' },
      { name: 'zeta', description: 'Última en orden' },
    ]);
    expect(JSON.stringify(list)).not.toContain('SECRETO');
  });

  it('ignora enlaces simbólicos que salen de la carpeta, acepta los que quedan dentro y tolera archivos rotos', async () => {
    symlinkSync(join(outside, 'ajena'), join(skills, 'enlace-fuera'), 'dir');
    symlinkSync(join(skills, 'alfa'), join(skills, 'enlace-dentro'), 'dir');
    symlinkSync(join(skills, 'no-existe'), join(skills, 'colgante'), 'dir');
    mkdirSync(join(skills, 'sin-skill-md'));
    mkdirSync(join(skills, 'skillmd-enlace-fuera'));
    symlinkSync(join(outside, 'ajena', 'SKILL.md'), join(skills, 'skillmd-enlace-fuera', 'SKILL.md'));
    mkdirSync(join(skills, 'binaria'));
    writeFileSync(join(skills, 'binaria', 'SKILL.md'), Buffer.from([0, 255, 254, 0, 1, 2, 3]));
    mkdirSync(join(skills, 'skill-md-es-carpeta', 'SKILL.md'), { recursive: true });
    writeFileSync(join(skills, 'suelto.txt'), 'no es carpeta');
    mkdirSync(join(skills, '.oculta'));
    writeFileSync(join(skills, '.oculta', 'SKILL.md'), '---\nname: oculta\n---\n');
    skill('nombre-raro', 'name: ../../etc/passwd\ndescription: nombre peligroso');

    const names = (await h.call('skills.list')).map((s: any) => s.name);
    expect(names).not.toContain('ajena');
    expect(names).not.toContain('oculta');
    expect(names).not.toContain('sin-skill-md');
    expect(names).not.toContain('skill-md-es-carpeta');
    expect(names).not.toContain('../../etc/passwd');
    expect(names).toContain('binaria'); // sin frontmatter válido: se usa el nombre de la carpeta
    expect(names).toContain('nombre-raro'); // nombre del frontmatter no válido: se usa la carpeta
    expect(names).toContain('alfa');
    expect(names.filter((n: string) => n === 'alfa')).toHaveLength(1); // el enlace interno es la misma skill
  });

  it('carpeta inexistente: lista vacía; se cachea 60 s', async () => {
    const h2 = makeHarness({ skillsDir: join(root, 'nada') });
    expect(await h2.call('skills.list')).toEqual([]);
    await h2.orch.shutdown();

    expect((await h.call('skills.list')).map((s: any) => s.name)).toContain('alfa');
    skill('nueva', 'name: nueva\ndescription: aparece tras la caché');
    expect((await h.call('skills.list')).map((s: any) => s.name)).not.toContain('nueva'); // caché
    expect(scanSkills(skills).map((s) => s.name)).toContain('nueva'); // el escaneo directo sí la ve
  });

  it('parseFrontmatter: comillas, bloques | y >, texto en varias líneas y sin frontmatter', () => {
    expect(parseFrontmatter('---\nname: a\ndescription: x y\n  z\n---\n')).toEqual({ name: 'a', description: 'x y z' });
    expect(parseFrontmatter("---\nname: 'b'\ndescription: |\n  uno\n  dos\n---\n")).toEqual({ name: 'b', description: 'uno\ndos'.replace('\n', ' ') });
    expect(parseFrontmatter('sin frontmatter')).toEqual({});
    expect(parseFrontmatter('---\nname: c\n')).toEqual({ name: 'c' }); // sin cierre
    expect(parseFrontmatter('---\nother: 1\nname: d\n---')).toEqual({ name: 'd' });
  });
});

describe('agent.update', () => {
  it('actualiza todos los campos, devuelve la fila con arrays ya parseados y notifica agent.changed', async () => {
    const w = await worker();
    const out = await h.call('agent.update', {
      agentId: w.id, name: '  Pixel ', model: 'opus', color: 'azul', persona: 'Hablo claro.\nSin rodeos.',
      skills: ['zeta', 'alfa'], relayOrder: ['haiku', 'sonnet'], autoRelay: false,
    });
    expect(out).toMatchObject({
      id: w.id, name: 'Pixel', model: 'opus', color: 'azul', persona: 'Hablo claro.\nSin rodeos.',
      skills: ['zeta', 'alfa'], relay_order: ['haiku', 'sonnet'], auto_relay: 0, current_model: 'opus', status: 'idle', role: 'programador',
    });
    const changed = h.emitted.filter((e) => e.name === 'agent.changed');
    expect(changed).toHaveLength(1);
    expect(changed[0]!.payload).toEqual(JSON.parse(JSON.stringify(out)));
    expect(await worker()).toMatchObject({ name: 'Pixel', skills: ['zeta', 'alfa'], relay_order: ['haiku', 'sonnet'], auto_relay: 0 });
  });

  it('agent.list trae los campos nuevos con valores por defecto: relay_order sin el modelo propio', async () => {
    expect(await worker()).toMatchObject({ persona: '', skills: [], relay_order: ['opus', 'haiku'], auto_relay: 1, current_model: 'sonnet' });
    expect(await boss()).toMatchObject({ relay_order: ['sonnet', 'haiku'], current_model: 'opus' });
    await h.call('agent.update', { agentId: (await worker()).id, model: 'haiku' });
    expect((await worker()).relay_order).toEqual(['opus', 'sonnet']);
  });

  it('los campos no enviados no cambian; sin ningún campo es un error', async () => {
    const w = await worker();
    await h.call('agent.update', { agentId: w.id, persona: 'x' });
    expect(await worker()).toMatchObject({ name: 'Clau', model: 'sonnet', persona: 'x' });
    await expect(h.call('agent.update', { agentId: w.id })).rejects.toThrow(/al menos un campo/);
    await expect(h.call('agent.update', {})).rejects.toThrow(/agentId/);
    await expect(h.call('agent.update', { agentId: 'nope', name: 'x' })).rejects.toThrow(/inexistente/);
  });

  it('nombre: único sin mayúsculas (salvo el propio), máx 24, sin caracteres de control', async () => {
    const w = await worker();
    await expect(h.call('agent.update', { agentId: w.id, name: 'JEFE' })).rejects.toThrow(/ya hay un agente/);
    await expect(h.call('agent.update', { agentId: w.id, name: 'a'.repeat(25) })).rejects.toThrow(/24/);
    await expect(h.call('agent.update', { agentId: w.id, name: 'a\nb' })).rejects.toThrow(/control/);
    await expect(h.call('agent.update', { agentId: w.id, name: '   ' })).rejects.toThrow(/name/);
    await expect(h.call('agent.update', { agentId: w.id, name: 7 })).rejects.toThrow(/name/);
    await expect(h.call('agent.update', { agentId: w.id, name: 'a'.repeat(24) })).resolves.toMatchObject({ name: 'a'.repeat(24) });
    await expect(h.call('agent.update', { agentId: w.id, name: 'CLAU' })).resolves.toMatchObject({ name: 'CLAU' }); // su propio nombre otra vez
  });

  it('modelo, color, persona, autoRelay y relayOrder se validan', async () => {
    const w = await worker();
    const bad = (p: object, re: RegExp) => expect(h.call('agent.update', { agentId: w.id, ...p })).rejects.toThrow(re);
    await bad({ model: 'gpt-4o' }, /modelo/);
    await bad({ model: 'opus[1m]' }, /modelo/);
    await bad({ color: 'morado' }, /color/);
    await bad({ persona: 'x'.repeat(4001) }, /4000/);
    await bad({ persona: 5 }, /persona/);
    await bad({ autoRelay: 'si' }, /autoRelay/);
    await bad({ relayOrder: 'opus' }, /relayOrder/);
    await bad({ relayOrder: ['opus', 'gpt'] }, /gpt/);
    await bad({ relayOrder: ['opus', 'opus'] }, /repetidos/);
    await expect(h.call('agent.update', { agentId: w.id, persona: 'x'.repeat(4000), relayOrder: [], color: 'crema' })).resolves.toMatchObject({ relay_order: [], color: 'crema' });
  });

  it('skills: solo nombres de skills.list, sin repetir, máx 30', async () => {
    const w = await worker();
    const bad = (skillsArg: unknown, re: RegExp) => expect(h.call('agent.update', { agentId: w.id, skills: skillsArg })).rejects.toThrow(re);
    await bad(['alfa', 'no-existe'], /no-existe/);
    await bad('alfa', /lista/);
    await bad([1], /lista/);
    await expect(h.call('agent.update', { agentId: w.id, skills: ['alfa', 'alfa'] })).resolves.toMatchObject({ skills: ['alfa'] });
    await expect(h.call('agent.update', { agentId: w.id, skills: [] })).resolves.toMatchObject({ skills: [] });
    for (let i = 0; i < 31; i++) skill(`s${i}`, `name: s${i}\ndescription: d`);
    await bad(Array.from({ length: 31 }, (_, i) => `s${i}`), /30/);
    await expect(h.call('agent.update', { agentId: w.id, skills: Array.from({ length: 30 }, (_, i) => `s${i}`) })).resolves.toBeTruthy(); // una instalada hace poco se reconoce
  });

  it('el jefe se puede editar (modelo, persona...) y su rol no cambia', async () => {
    const b = await boss();
    const out = await h.call('agent.update', { agentId: b.id, model: 'sonnet', persona: 'Estratega.', role: 'programador' });
    expect(out).toMatchObject({ model: 'sonnet', persona: 'Estratega.', role: 'jefe', is_boss: 1 });
  });
});

describe('perfil en el run', () => {
  async function startWith(update: object) {
    const w = await worker();
    await h.call('agent.update', { agentId: w.id, ...update });
    const t = await h.call('task.create', { title: 'x', files: ['src/a.ts'], agent_id: w.id });
    await h.call('task.start', { id: t.id });
    return h.adapters.at(-1)!.spec!;
  }

  it('la persona se añade al system prompt tras el rol', async () => {
    const spec = await startWith({ persona: 'Responde siempre en verso.' });
    expect(spec.systemPrompt).toMatch(/^Eres un programador:.*\nTe llamas Clau\.\n\nPersonalidad e instrucciones propias de Clau:\nResponde siempre en verso\.$/s);
  });

  it('sin persona el system prompt es el de siempre', async () => {
    const spec = await startWith({ model: 'haiku' });
    expect(spec.systemPrompt.endsWith('Te llamas Clau.')).toBe(true);
    expect(spec.model).toBe('haiku');
    expect(spec.skills).toBeUndefined();
  });

  it('las skills elegidas llegan al spec con su carpeta real; una borrada desde entonces se omite', async () => {
    const w = await worker();
    await h.call('agent.update', { agentId: w.id, skills: ['alfa', 'zeta'] });
    rmSync(join(skills, 'zeta'), { recursive: true });
    const t = await h.call('task.create', { title: 'x', files: ['src/a.ts'], agent_id: w.id });
    await h.call('task.start', { id: t.id });
    const spec = h.adapters.at(-1)!.spec!;
    expect(spec.skills).toHaveLength(1);
    expect(spec.skills![0]).toMatchObject({ name: 'alfa', description: 'Primera, con comillas' });
    expect(spec.skills![0]!.dir.endsWith(join('skills', 'alfa'))).toBe(true);
  });
});
