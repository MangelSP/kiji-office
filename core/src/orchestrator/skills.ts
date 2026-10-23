// Skills del usuario (PLAN-0.2a, D12): `skills.list` lee ~/.claude/skills/*/SKILL.md y devuelve SOLO el `name` y la
// `description` del frontmatter (nunca el contenido). Se ignoran los enlaces simbólicos que salen de la carpeta de
// skills y se toleran los archivos rotos. El resultado se cachea 60 s.
import { closeSync, openSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import type { SkillInfo } from '../../../shared/protocol.js';
import { type Ctx, type Handler } from './context.js';

export const SKILLS_CACHE_MS = 60_000;
const MAX_HEAD_BYTES = 16 * 1024;
const MAX_DESCRIPTION = 600;
const MAX_SKILLS = 500;
/** Nombres que se pueden usar como enlace del plugin temporal y como id de skill. */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const defaultSkillsDir = (): string => join(homedir(), '.claude', 'skills');

export interface SkillEntry extends SkillInfo {
  /** Carpeta real de la skill (ya resuelta y comprobada dentro de la carpeta de skills). */
  dir: string;
}

/** Lee solo el principio del archivo (el frontmatter está al principio). */
function readHead(file: string): string {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(MAX_HEAD_BYTES);
    const n = readSync(fd, buf, 0, MAX_HEAD_BYTES, 0);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

const unquote = (v: string): string => {
  const t = v.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1).replace(/\\"/g, '"').replace(/''/g, "'");
  }
  return t;
};

/** Frontmatter YAML mínimo: solo `name` y `description` (texto simple, entre comillas, o bloque `>` / `|`). */
export function parseFrontmatter(text: string): { name?: string; description?: string } {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return {};
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  const fm = end === -1 ? lines.slice(1) : lines.slice(1, end);
  const out: Record<string, string> = {};
  for (let i = 0; i < fm.length; i++) {
    const m = /^(name|description)\s*:\s*(.*)$/.exec(fm[i]!);
    if (!m) continue;
    const key = m[1]!;
    const first = m[2]!.trim();
    // continuación: líneas con sangría (o vacías dentro de un bloque) que siguen
    const cont: string[] = [];
    let j = i + 1;
    while (j < fm.length && (/^\s+\S/.test(fm[j]!) || (fm[j]!.trim() === '' && cont.length > 0))) {
      cont.push(fm[j]!.trim());
      j++;
    }
    i = j - 1;
    let value: string;
    if (/^[>|][+-]?$/.test(first)) value = cont.filter((l) => l !== '').join(first.startsWith('>') ? ' ' : '\n');
    else if (first.startsWith('"') || first.startsWith("'")) {
      const q = first[0]!;
      const joined = [first, ...cont].join(' ');
      value = unquote(joined.endsWith(q) && joined.length > 1 ? joined : first);
    } else value = [first, ...cont].filter((l) => l !== '').join(' ');
    out[key] = value.replace(/\s+/g, ' ').trim();
  }
  return out;
}

const inside = (root: string, p: string): boolean => p !== root && p.startsWith(root + sep);

/** Recorre la carpeta de skills sin cachear. */
export function scanSkills(skillsDir: string): SkillEntry[] {
  let root: string;
  try {
    root = realpathSync(skillsDir);
  } catch {
    return []; // la carpeta no existe: no hay skills
  }
  let names: string[];
  try {
    names = readdirSync(root).sort();
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const out: SkillEntry[] = [];
  for (const entry of names) {
    if (entry.startsWith('.') || out.length >= MAX_SKILLS) continue;
    try {
      const dir = realpathSync(join(root, entry)); // resuelve enlaces simbólicos
      if (!inside(root, dir) || !statSync(dir).isDirectory()) continue; // enlaces que salen de la carpeta: fuera
      const file = realpathSync(join(dir, 'SKILL.md'));
      if (!inside(root, file) || !statSync(file).isFile()) continue;
      const fm = parseFrontmatter(readHead(file));
      const name = fm.name && NAME_RE.test(fm.name) ? fm.name : NAME_RE.test(entry) ? entry : '';
      if (name === '' || seen.has(name)) continue;
      seen.add(name);
      out.push({ name, description: (fm.description ?? '').slice(0, MAX_DESCRIPTION), dir });
    } catch {
      /* archivo roto, sin permisos o enlace colgante: se salta esa skill */
    }
  }
  return out.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.name.localeCompare(b.name));
}

const caches = new WeakMap<Ctx, { dir: string; at: number; list: SkillEntry[] }>();

/** Skills disponibles (cache de 60 s por carpeta; `force` vuelve a leer). */
export function loadSkills(ctx: Ctx, force = false): SkillEntry[] {
  const cache = caches.get(ctx);
  if (!force && cache && cache.dir === ctx.skillsDir && Date.now() - cache.at < SKILLS_CACHE_MS) return cache.list;
  const list = scanSkills(ctx.skillsDir);
  caches.set(ctx, { dir: ctx.skillsDir, at: Date.now(), list });
  return list;
}

/** Las skills pedidas por nombre, releyendo el disco (una skill borrada desde entonces se omite). */
export function resolveSkills(ctx: Ctx, names: string[]): SkillEntry[] {
  const wanted = new Set(names);
  return loadSkills(ctx, true).filter((s) => wanted.has(s.name));
}

export function skillHandlers(ctx: Ctx): Record<string, Handler> {
  return {
    'skills.list': (): SkillInfo[] => loadSkills(ctx).map(({ name, description }) => ({ name, description })),
  };
}
