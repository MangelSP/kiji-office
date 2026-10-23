// Avisos (0.2d, D24): bandeja de la UI (campana) y notificación del sistema. `notify` guarda la fila, limpia el texto
// (sale en la pantalla de bloqueo) y emite el evento `notify`, que Rust convierte en notificación de escritorio.
import type { NotificationLevel, NotificationRow, NotifyEvent } from '../../../shared/protocol.js';
import type { NotificationDbRow } from '../db/repos.js';
import { type Ctx, type Handler, asParams, projectIdOf } from './context.js';
import { settingValue } from './settings.js';

export const NOTIFY_BODY_MAX = 120;
const TITLE_MAX = 80;

// Ruta absoluta POSIX: empieza en "/" tras inicio de texto o separador, con al menos un segmento.
const POSIX_PATH = /(^|[\s"'`(\[=])((?:\/[^\s"'`()\[\]<>:,;]+)+)/g;
// Ruta de Windows (C:\dir\a.ts o C:/dir/a.ts) y UNC (\\host\share\a.ts).
const WIN_PATH = /(?:[A-Za-z]:[\\/]|\\\\)[^\s"'`<>|*?:,;()\[\]]*/g;

const baseName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? '';

/** Sustituye las rutas absolutas por el nombre del archivo. */
export function stripAbsolutePaths(text: string): string {
  return text.replace(WIN_PATH, (m) => baseName(m)).replace(POSIX_PATH, (_m, pre: string, path: string) => pre + baseName(path));
}

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const clean = (s: string, max: number): string => clip(stripAbsolutePaths(s).replace(/\s+/g, ' ').trim(), max);

export function notificationView(r: NotificationDbRow): NotificationRow {
  return {
    id: r.id, projectId: r.project_id, level: r.level, title: r.title, body: r.body,
    approvalId: r.approval_id, readAt: r.read_at, createdAt: r.created_at,
  };
}

export interface NotifyInput {
  projectId: string;
  level: NotificationLevel;
  title: string;
  body: string;
  approvalId?: string;
}

/** ¿`now` (hora local) cae en las horas de silencio `{from,to}` (HH:MM)? Admite tramos que cruzan la medianoche. */
export function inQuietHours(raw: string, now = new Date()): boolean {
  if (raw.trim() === '') return false;
  try {
    const q = JSON.parse(raw) as { from?: string; to?: string };
    const mins = (hm: string | undefined): number => {
      const m = /^(\d{2}):(\d{2})$/.exec(hm ?? '');
      if (!m) throw new Error('hora');
      return Number(m[1]) * 60 + Number(m[2]);
    };
    const from = mins(q.from);
    const to = mins(q.to);
    const t = now.getHours() * 60 + now.getMinutes();
    if (from === to) return false;
    return from < to ? t >= from && t < to : t >= from || t < to;
  } catch {
    return false;
  }
}

/** ¿Este aviso debe salir también como notificación del sistema? (La fila de la campana se guarda siempre.) */
export function shouldNotifySystem(ctx: Ctx, level: NotificationLevel, now = new Date()): boolean {
  if (settingValue(ctx, 'notify_system') !== '1') return false;
  let levels: unknown;
  try {
    levels = JSON.parse(settingValue(ctx, 'notify_levels'));
  } catch {
    levels = [];
  }
  if (!Array.isArray(levels) || !levels.includes(level)) return false;
  return !inQuietHours(settingValue(ctx, 'quiet_hours'), now);
}

/** `NotifyEvent` con `system`: false = solo campana, Rust no debe mostrar notificación del sistema. */
export type NotifyEventWithSystem = NotifyEvent & { system: boolean };

/** Guarda el aviso (título ≤80, cuerpo ≤120, sin rutas absolutas) y emite `notify`. Nunca lanza por culpa del emisor. */
export function notify(ctx: Ctx, n: NotifyInput): NotificationRow {
  const row = ctx.repos.notifications.create({
    projectId: n.projectId, level: n.level, title: clean(n.title, TITLE_MAX), body: clean(n.body, NOTIFY_BODY_MAX),
    approvalId: n.approvalId ?? null,
  });
  const event: NotifyEventWithSystem = {
    projectId: row.project_id, id: row.id, level: row.level, title: row.title, body: row.body,
    system: shouldNotifySystem(ctx, row.level),
    ...(row.approval_id ? { approvalId: row.approval_id } : {}),
  };
  ctx.emit('notify', event);
  return notificationView(row);
}

export function notificationHandlers(ctx: Ctx): Record<string, Handler> {
  return {
    /** `{projectId?, unreadOnly?, limit?}`: sin `projectId` devuelve los de todos los proyectos. La más nueva primero. */
    'notifications.list': (params) => {
      const p = params == null ? {} : asParams(params, 'notifications.list');
      const pid = projectIdOf(p);
      const limit = typeof p.limit === 'number' && p.limit >= 1 ? Math.min(Math.floor(p.limit), 500) : 100;
      return ctx.repos.notifications
        .list({ ...(pid !== undefined ? { projectId: pid } : {}), unreadOnly: p.unreadOnly === true, limit })
        .map(notificationView);
    },
    /** `{ids: number[] | 'all', projectId?}` -> `{marked}`. */
    'notifications.markRead': (params) => {
      const p = asParams(params, 'notifications.markRead');
      const pid = projectIdOf(p);
      const ids = p.ids === 'all' || p.all === true ? 'all' : p.ids;
      if (ids !== 'all' && (!Array.isArray(ids) || !ids.every((i) => Number.isInteger(i)))) {
        throw new Error('notifications.markRead: "ids" debe ser una lista de números o "all"');
      }
      return { marked: ctx.repos.notifications.markRead(ids as number[] | 'all', pid) };
    },
  };
}
