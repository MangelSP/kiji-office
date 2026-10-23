// agent.create: validación de nombre (obligatorio, 1–24, único), color, modelo, rol y proveedor.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeRepo } from '../git/helpers.js';
import { makeHarness, makeNodeRepo, type Harness } from './helpers.js';

let repo: string;
let h: Harness;
beforeEach(async () => {
  repo = makeNodeRepo();
  h = makeHarness();
  await h.call('project.open', { path: repo });
});
afterEach(async () => {
  await h.orch.shutdown();
  removeRepo(repo);
});

const base = { provider: 'claude', model: 'sonnet', role: 'programador', color: 'terracota' };
const create = (over: Record<string, unknown>) => h.call('agent.create', { ...base, ...over });

describe('agent.create — nombre', () => {
  it('crea con los valores recibidos y recorta espacios', async () => {
    const a = await create({ name: '  Pixel  ', model: 'haiku', role: 'tester', color: 'azul' });
    expect(a).toMatchObject({ name: 'Pixel', provider: 'claude', model: 'haiku', role: 'tester', color: 'azul', is_boss: 0 });
    expect((await h.call('agent.list')).map((x: any) => x.name)).toContain('Pixel');
  });

  it('rechaza nombre vacío, solo espacios, ausente o con saltos de línea', async () => {
    await expect(create({ name: '' })).rejects.toThrow(/name/);
    await expect(create({ name: '   ' })).rejects.toThrow(/name/);
    await expect(h.call('agent.create', { provider: 'claude' })).rejects.toThrow(/name/);
    await expect(create({ name: 'Ana\nLópez' })).rejects.toThrow(/control/);
  });

  it('acepta 24 caracteres y rechaza 25', async () => {
    await expect(create({ name: 'a'.repeat(24) })).resolves.toMatchObject({ name: 'a'.repeat(24) });
    await expect(create({ name: 'b'.repeat(25) })).rejects.toThrow(/24/);
  });

  it('el nombre es único en el proyecto, sin distinguir mayúsculas, también frente al jefe y a Clau', async () => {
    await create({ name: 'Pixel' });
    await expect(create({ name: 'Pixel' })).rejects.toThrow(/ya hay un agente llamado "Pixel"/);
    await expect(create({ name: 'pixel ' })).rejects.toThrow(/ya hay un agente/);
    await expect(create({ name: 'Jefe' })).rejects.toThrow(/ya hay un agente/);
    await expect(create({ name: 'CLAU' })).rejects.toThrow(/ya hay un agente/);
    expect(await h.call('agent.list')).toHaveLength(3); // jefe + Clau + Pixel
  });
});

describe('agent.create — color, modelo, rol y proveedor', () => {
  it('color: solo las 4 paletas; sin color usa terracota', async () => {
    for (const color of ['terracota', 'azul', 'verde', 'crema']) {
      await expect(create({ name: `c-${color}`, color })).resolves.toMatchObject({ color });
    }
    await expect(create({ name: 'x1', color: 'morado' })).rejects.toThrow(/color "morado" no válido/);
    await expect(create({ name: 'x2', color: '#ff0000' })).rejects.toThrow(/color/);
    await expect(create({ name: 'x3', color: 'claude' })).rejects.toThrow(/color/);
    await expect(h.call('agent.create', { name: 'x4', provider: 'claude' })).resolves.toMatchObject({ color: 'terracota' });
  });

  it('modelo: alias sonnet/opus/haiku; sin modelo usa sonnet; rechaza ids largos y otros', async () => {
    for (const model of ['sonnet', 'opus', 'haiku']) {
      await expect(create({ name: `m-${model}`, model })).resolves.toMatchObject({ model });
    }
    await expect(create({ name: 'y1', model: 'gpt-4o' })).rejects.toThrow(/modelo "gpt-4o" no válido/);
    await expect(create({ name: 'y2', model: 'claude-sonnet-4' })).rejects.toThrow(/modelo/);
    await expect(h.call('agent.create', { name: 'y3', provider: 'claude' })).resolves.toMatchObject({ model: 'sonnet' });
  });

  it('rol: solo los del kit; sin rol usa programador; el jefe no se puede crear', async () => {
    for (const role of ['programador', 'tester', 'explorador', 'modelador-2d', 'documentador', 'revisor-critico']) {
      await expect(create({ name: `r-${role}`, role })).resolves.toMatchObject({ role, is_boss: 0 });
    }
    await expect(create({ name: 'z1', role: 'hacker' })).rejects.toThrow(/rol "hacker" no válido/);
    await expect(create({ name: 'z2', role: 'jefe' })).rejects.toThrow(/jefe/);
    await expect(create({ name: 'z3', role: ' jefe ' })).rejects.toThrow(/jefe/);
    await expect(h.call('agent.create', { name: 'z4', provider: 'claude' })).resolves.toMatchObject({ role: 'programador' });
  });

  it('proveedor: solo claude; los demás dan un error que pide connectionId (0.2b)', async () => {
    await expect(create({ name: 'p1', provider: 'codex' })).rejects.toThrow(/paso 15/);
    await expect(create({ name: 'p2', provider: 'gemini' })).rejects.toThrow(/connectionId/);
    await expect(create({ name: 'p3', provider: 'ollama' })).rejects.toThrow(/connectionId/);
    await expect(create({ name: 'p4', provider: 'openai' })).rejects.toThrow(/connectionId/);
    await expect(create({ name: 'p5', provider: 'foo' })).rejects.toThrow(/desconocido/);
    expect(await h.call('agent.list')).toHaveLength(2); // nada se guardó
  });
});

describe('agent.create — sin proyecto', () => {
  it('falla con un mensaje claro', async () => {
    const h2 = makeHarness();
    await expect(h2.call('agent.create', { name: 'A', provider: 'claude' })).rejects.toThrow(/project\.open/);
    await h2.orch.shutdown();
  });
});
