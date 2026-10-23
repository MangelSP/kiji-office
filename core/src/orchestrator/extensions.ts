// Extensiones de Claude Code del usuario (no las de los robots de Kiji, que corren aislados): `extensions.list` enseña
// los MCP y las skills instalados (global, por proyecto y de plugins) y `extensions.remove` quita uno. Los JSON de MCP
// se editan quitando SOLO esa clave (copia de seguridad + escritura atómica); las skills en directorio van a la
// papelera del sistema (nunca se borran) y las que son enlaces simbólicos pierden solo el enlace.
import {
  closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, readSync,
  realpathSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import type {
  ExtensionScope, ExtensionsList, ExtensionsRemoveParams, ExtensionsRemoveResult, ExtensionsWarning, McpEntry, SkillEntry,
} from '../../../shared/protocol.js';
import { type Ctx, type Handler, asParams, projectIdOf } from './context.js';
import { parseFrontmatter } from './skills.js';

const MAX_DESCRIPTION = 600;
const MAX_ENTRIES = 500;
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

const claudeJson = (): string => join(homedir(), '.claude.json');
const userSkillsDir = (): string => join(homedir(), '.claude', 'skills');
const stamp = (): string => new Date().toISOString().replace(/[:.]/g, '-');

interface Repo { id: string | null; path: string }

function repos(ctx: Ctx, projectId?: string): Repo[] {
  if (projectId !== undefined) {
    const p = ctx.repos.projects.get(projectId);
    if (!p) throw new Error(`extensions: el proyecto ${projectId} no existe`);
    return [{ id: p.id, path: p.path }];
  }
  return [...ctx.projects.values()].map((p) => ({ id: p.id, path: p.path }));
}

function readJson(file: string, warnings: ExtensionsWarning[]): Record<string, unknown> | null {
  if (!existsSync(file)) return null;
  try {
    const v: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (isObj(v)) return v;
    warnings.push({ file, message: 'El archivo no contiene un objeto JSON.' });
  } catch (e) {
    warnings.push({ file, message: `No se pudo leer el JSON (${e instanceof Error ? e.message : String(e)}).` });
  }
  return null;
}

/** URL sin usuario, contraseña, query ni fragmento (pueden llevar credenciales). */
function cleanUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.username = '';
    u.password = '';
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return raw.replace(/\/\/[^/@\s]*@/, '//').replace(/[?#].*$/, '');
  }
}

function mcpFrom(servers: unknown, base: Pick<McpEntry, 'scope' | 'projectId' | 'source' | 'managedBy'>): McpEntry[] {
  if (!isObj(servers)) return [];
  const out: McpEntry[] = [];
  for (const [name, cfg] of Object.entries(servers)) {
    if (out.length >= MAX_ENTRIES) break;
    const c = isObj(cfg) ? cfg : {};
    const url = typeof c.url === 'string' ? c.url : undefined;
    const transport = c.type === 'http' || c.type === 'sse' ? c.type : url && c.type !== 'stdio' ? 'http' : 'stdio';
    const e: McpEntry = {
      name, ...base, transport,
      envNames: isObj(c.env) ? Object.keys(c.env) : [],
      headerNames: isObj(c.headers) ? Object.keys(c.headers) : [],
    };
    if (transport === 'stdio') { if (typeof c.command === 'string') e.command = c.command; }
    else if (url) e.url = cleanUrl(url);
    if (!base.managedBy) delete e.managedBy;
    out.push(e);
  }
  return out;
}

interface PluginInfo { name: string; dir: string }
function installedPlugins(warnings: ExtensionsWarning[]): PluginInfo[] {
  const file = join(homedir(), '.claude', 'plugins', 'installed_plugins.json');
  const j = readJson(file, warnings);
  if (!j || !isObj(j.plugins)) return [];
  const seen = new Set<string>();
  const out: PluginInfo[] = [];
  for (const [key, installs] of Object.entries(j.plugins)) {
    const name = key.split('@')[0]!;
    const first = Array.isArray(installs) ? installs.find((i) => isObj(i) && typeof i.installPath === 'string') : undefined;
    if (!first || seen.has(key)) continue;
    seen.add(key);
    out.push({ name, dir: (first as { installPath: string }).installPath });
  }
  return out;
}

function readHead(file: string): string {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(16 * 1024);
    return buf.subarray(0, readSync(fd, buf, 0, buf.length, 0)).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function scanSkillDir(root: string, base: Pick<SkillEntry, 'scope' | 'projectId' | 'managedBy'>): SkillEntry[] {
  let names: string[];
  try { names = readdirSync(root).sort(); } catch { return []; }
  const out: SkillEntry[] = [];
  for (const name of names) {
    if (name.startsWith('.') || out.length >= MAX_ENTRIES) continue;
    const path = join(root, name);
    try {
      const isSymlink = lstatSync(path).isSymbolicLink();
      const e: SkillEntry = { name, description: '', ...base, path, isSymlink };
      if (!base.managedBy) delete e.managedBy;
      if (isSymlink) e.target = readlinkSync(path);
      try {
        if (!statSync(path).isDirectory()) continue;
        e.description = (parseFrontmatter(readHead(join(path, 'SKILL.md'))).description ?? '').slice(0, MAX_DESCRIPTION);
      } catch {
        if (!isSymlink) continue; // directorio sin SKILL.md: no es una skill
      }
      out.push(e);
    } catch { /* ilegible: se salta */ }
  }
  return out;
}

export function listExtensions(ctx: Ctx, projectId?: string): ExtensionsList {
  const warnings: ExtensionsWarning[] = [];
  const mcp: McpEntry[] = [];
  const skills: SkillEntry[] = [];
  const cj = claudeJson();
  const root = readJson(cj, warnings);
  mcp.push(...mcpFrom(root?.mcpServers, { scope: 'user', projectId: null, source: cj }));
  skills.push(...scanSkillDir(userSkillsDir(), { scope: 'user', projectId: null }));
  for (const r of repos(ctx, projectId)) {
    const projects = isObj(root?.projects) ? root.projects : {};
    const mine = projects[r.path] ?? projects[safeReal(r.path)];
    if (isObj(mine)) mcp.push(...mcpFrom(mine.mcpServers, { scope: 'local', projectId: r.id, source: cj }));
    const mj = join(r.path, '.mcp.json');
    mcp.push(...mcpFrom(readJson(mj, warnings)?.mcpServers, { scope: 'project', projectId: r.id, source: mj }));
    skills.push(...scanSkillDir(join(r.path, '.claude', 'skills'), { scope: 'project', projectId: r.id }));
  }
  for (const p of installedPlugins(warnings)) {
    const managedBy = `plugin:${p.name}`;
    const mj = join(p.dir, '.mcp.json');
    const j = readJson(mj, warnings);
    // formato con o sin la clave `mcpServers`
    if (j) mcp.push(...mcpFrom(isObj(j.mcpServers) ? j.mcpServers : j, { scope: 'plugin', projectId: null, source: mj, managedBy }));
    skills.push(...scanSkillDir(join(p.dir, 'skills'), { scope: 'plugin', projectId: null, managedBy }));
  }
  return { mcp, skills, warnings };
}

function safeReal(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

// --- Quitar --------------------------------------------------------------------------------------------------------

function repoOf(ctx: Ctx, p: ExtensionsRemoveParams): Repo {
  if (!p.projectId) throw new Error(`extensions.remove: el ámbito «${p.scope}» necesita projectId`);
  return repos(ctx, p.projectId)[0]!;
}

/** Quita solo `servers[name]` del JSON (el resto del archivo queda igual), con copia de seguridad y escritura atómica. */
function removeMcpKey(file: string, name: string, pick: (root: Record<string, unknown>) => Record<string, unknown> | null): string {
  if (!existsSync(file)) throw new Error(`extensions.remove: no existe ${file}`);
  const text = readFileSync(file, 'utf8');
  let root: unknown;
  try { root = JSON.parse(text); } catch { throw new Error(`extensions.remove: ${file} no es un JSON válido; no se toca`); }
  const servers = isObj(root) ? pick(root) : null;
  if (!servers || !Object.prototype.hasOwnProperty.call(servers, name)) throw new Error(`extensions.remove: «${name}» no existe en ${file}`);
  const backup = `${file}.kiji-backup-${stamp()}`;
  copyFileSync(file, backup);
  delete servers[name];
  const tmp = `${file}.kiji-tmp-${process.pid}`;
  const mode = statSync(file).mode & 0o777;
  writeFileSync(tmp, JSON.stringify(root, null, 2) + (text.endsWith('\n') ? '\n' : ''), { mode });
  renameSync(tmp, file);
  return backup;
}

function trashDir(): { files: string; info?: string } {
  const os = platform();
  if (os === 'darwin') return { files: join(homedir(), '.Trash') };
  if (os === 'win32') return { files: join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'KijiOffice', 'papelera') };
  const base = join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'Trash');
  return { files: join(base, 'files'), info: join(base, 'info') };
}

function moveToTrash(path: string, name: string): string {
  const t = trashDir();
  mkdirSync(t.files, { recursive: true });
  let dest = join(t.files, `${name}-${stamp()}`);
  for (let i = 2; existsSync(dest); i++) dest = join(t.files, `${name}-${stamp()}-${i}`);
  try {
    renameSync(path, dest);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EXDEV') throw new Error('extensions.remove: la skill está en otro disco que la papelera; muévela a mano a la papelera');
    throw e;
  }
  if (t.info) {
    mkdirSync(t.info, { recursive: true });
    const base = dest.slice(t.files.length + 1);
    writeFileSync(join(t.info, `${base}.trashinfo`), `[Trash Info]\nPath=${path}\nDeletionDate=${new Date().toISOString().slice(0, 19)}\n`);
  }
  return dest;
}

function removeSkill(ctx: Ctx, p: ExtensionsRemoveParams): ExtensionsRemoveResult {
  if (p.scope !== 'user' && p.scope !== 'project') throw new Error('extensions.remove: las skills de plugins no se pueden quitar individualmente');
  const name = p.name;
  if (!name || name.includes('/') || name.includes('\\') || name.includes('..') || name.startsWith('.') || name.includes('\0')) {
    throw new Error('extensions.remove: nombre de skill no válido');
  }
  const rootPath = p.scope === 'user' ? userSkillsDir() : join(repoOf(ctx, p).path, '.claude', 'skills');
  const root = realpathSync(rootPath); // la raíz sí puede estar enlazada; la entrada se mira sin seguir enlaces
  const entry = join(root, name);
  if (dirname(resolve(entry)) !== root || !isAbsolute(entry) || !entry.startsWith(root + sep)) throw new Error('extensions.remove: la ruta sale de la carpeta de skills');
  let st;
  try { st = lstatSync(entry); } catch { throw new Error(`extensions.remove: la skill «${name}» no existe en ${root}`); }
  if (st.isSymbolicLink()) {
    unlinkSync(entry); // solo el enlace; el destino no se toca
    return { removed: true, file: entry };
  }
  if (!st.isDirectory()) throw new Error(`extensions.remove: «${entry}» no es una carpeta de skill`);
  return { removed: true, file: entry, trashPath: moveToTrash(entry, name) };
}

function removeMcp(ctx: Ctx, p: ExtensionsRemoveParams): ExtensionsRemoveResult {
  const field = (r: Record<string, unknown>): Record<string, unknown> | null => (isObj(r.mcpServers) ? r.mcpServers : null);
  if (p.scope === 'plugin') throw new Error('extensions.remove: los MCP de plugins los gestiona el plugin; desinstala el plugin desde Claude Code');
  if (p.scope === 'user') {
    const file = claudeJson();
    return { removed: true, file, backup: removeMcpKey(file, p.name, field) };
  }
  const repo = repoOf(ctx, p);
  if (p.scope === 'project') {
    const file = join(repo.path, '.mcp.json');
    return { removed: true, file, backup: removeMcpKey(file, p.name, field) };
  }
  const file = claudeJson();
  const backup = removeMcpKey(file, p.name, (r) => {
    const projects = isObj(r.projects) ? r.projects : {};
    const mine = projects[repo.path] ?? projects[safeReal(repo.path)];
    return isObj(mine) ? field(mine) : null;
  });
  return { removed: true, file, backup };
}

export function extensionHandlers(ctx: Ctx): Record<string, Handler> {
  return {
    'extensions.list': (params): ExtensionsList => listExtensions(ctx, projectIdOf(asParams(params ?? {}, 'extensions.list'))),
    'extensions.remove': (params): ExtensionsRemoveResult => {
      const o = asParams(params, 'extensions.remove');
      const kind = o.kind;
      const scope = o.scope as ExtensionScope;
      if ((kind !== 'mcp' && kind !== 'skill') || !['user', 'local', 'project', 'plugin'].includes(scope) || typeof o.name !== 'string') {
        throw new Error('extensions.remove: se esperaba {kind: mcp|skill, scope, name}');
      }
      const p: ExtensionsRemoveParams = { kind, scope, name: o.name, projectId: projectIdOf(o) };
      const res = kind === 'mcp' ? removeMcp(ctx, p) : removeSkill(ctx, p);
      ctx.emit('extensions.changed', { kind, scope, name: p.name, projectId: p.projectId ?? null });
      return res;
    },
  };
}
