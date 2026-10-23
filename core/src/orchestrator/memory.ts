// Memoria del proyecto (0.2d, D24): hechos, decisiones y preferencias que el gerente y la persona recuerdan.
// Búsqueda con FTS5 (tabla `memory_fts`); la consulta se escapa en el repo.
import type { MemoryKind, MemoryRow } from '../../../shared/protocol.js';
import type { MemoryDbRow } from '../db/repos.js';
import { type Ctx, type Handler, asParams, optionalProject, projectIdOf, requireProject, str } from './context.js';

export const MEMORY_TEXT_MAX = 2000;
const KINDS: readonly MemoryKind[] = ['fact', 'decision', 'preference', 'todo'];

export function memoryView(r: MemoryDbRow): MemoryRow {
  return { id: r.id, projectId: r.project_id, kind: r.kind, text: r.text, source: r.source, archived: r.archived === 1, createdAt: r.created_at };
}

/** Añade una entrada (lo usa `memory.add` con source 'user' y el gerente con 'manager'). Valida tipo y longitud. */
export function addMemory(ctx: Ctx, projectId: string, kind: unknown, text: unknown, source: 'manager' | 'user'): MemoryRow {
  if (typeof kind !== 'string' || !KINDS.includes(kind as MemoryKind)) throw new Error(`memory.add: "kind" debe ser ${KINDS.join(' | ')}`);
  const t = str(text, 'text', 'memory.add').trim();
  if (t.length > MEMORY_TEXT_MAX) throw new Error(`memory.add: el texto supera ${MEMORY_TEXT_MAX} caracteres`);
  return memoryView(ctx.repos.memory.create({ projectId, kind: kind as MemoryKind, text: t, source }));
}

/** Búsqueda (FTS5) o lo más reciente si no hay `query`. Para el gerente: `recallMemory(ctx, projectId, 'worktree')`. */
export function recallMemory(ctx: Ctx, projectId: string, query: string | undefined, limit = 50, includeArchived = false): MemoryRow[] {
  const rows = query && query.trim() !== ''
    ? ctx.repos.memory.search(projectId, query, limit, includeArchived)
    : ctx.repos.memory.recent(projectId, limit, includeArchived);
  return rows.map(memoryView);
}

export function memoryHandlers(ctx: Ctx): Record<string, Handler> {
  return {
    /** `{projectId?, query?, includeArchived?, limit?}` */
    'memory.list': (params) => {
      const p = params == null ? {} : asParams(params, 'memory.list');
      const project = optionalProject(ctx, projectIdOf(p));
      if (!project) return [];
      const limit = typeof p.limit === 'number' && p.limit >= 1 ? Math.min(Math.floor(p.limit), 500) : 100;
      return recallMemory(ctx, project.id, typeof p.query === 'string' ? p.query : undefined, limit, p.includeArchived === true);
    },
    /** `{projectId?, kind, text}` (source 'user', máx. 2000 caracteres) */
    'memory.add': (params) => {
      const p = asParams(params, 'memory.add');
      return addMemory(ctx, requireProject(ctx, projectIdOf(p)).id, p.kind, p.text, 'user');
    },
    /** `{id, projectId?}`: archiva (no borra). */
    'memory.archive': (params) => {
      const p = asParams(params, 'memory.archive');
      const id = Number(p.id);
      const row = Number.isInteger(id) ? ctx.repos.memory.get(id) : undefined;
      if (!row) throw new Error(`memory.archive: entrada inexistente: ${String(p.id)}`);
      const given = projectIdOf(p);
      if (given !== undefined && given !== row.project_id) throw new Error(`memory.archive: la entrada no pertenece al proyecto ${given}`);
      ctx.repos.memory.setArchived(id, true);
      return memoryView(ctx.repos.memory.get(id)!);
    },
  };
}
