// MCP y skills de Claude Code del usuario (`extensions.list` / `extensions.remove`): listar y desinstalar.
// Son los de Claude Code, no los de los robots de Kiji. En `?demo=1` todo queda en memoria.
import { create } from "zustand";
import { core, CoreError } from "../core/client";
import type { ExtensionsList, ExtensionsRemoveParams, ExtensionsRemoveResult, McpEntry, SkillEntry } from "../../shared/protocol";
import { errorMessage, stripMethodPrefix } from "./core";
import { useStore } from ".";
import { useSettings } from "./settings";

export type ExtensionsState = {
  data: ExtensionsList | null;
  loading: boolean;
  /** Por qué no hay datos (core sin el método, caído...). */
  error: string | null;
  load: () => Promise<void>;
  /** Quita una entrada: devuelve el resultado o el texto del error. */
  remove: (p: ExtensionsRemoveParams) => Promise<{ error: string } | { result: ExtensionsRemoveResult }>;
};

const keyOf = (p: { kind: string; scope: string; name: string; projectId?: string | null }) => `${p.kind}|${p.scope}|${p.projectId ?? ""}|${p.name}`;

export const useExtensions = create<ExtensionsState>()((set, get) => ({
  data: null,
  loading: false,
  error: null,

  load: async () => {
    if (useSettings.getState().demo) {
      if (!get().data) set({ data: demoExtensions(), error: null });
      return;
    }
    set({ loading: true });
    try {
      const data = await useStore.getState().call<ExtensionsList>("extensions.list");
      set({ data: { mcp: data?.mcp ?? [], skills: data?.skills ?? [], warnings: data?.warnings ?? [] }, error: null, loading: false });
    } catch (err) {
      const aun = err instanceof CoreError && err.code === "unknown_method";
      set({ loading: false, error: aun ? "extensions.list: aún no disponible en el core" : errorMessage(err) });
    }
  },

  remove: async (p) => {
    if (useSettings.getState().demo) {
      const d = get().data;
      if (d) {
        const gone = (e: McpEntry | SkillEntry, kind: string) => keyOf({ kind, scope: e.scope, projectId: e.projectId, name: e.name }) === keyOf({ ...p, projectId: p.projectId ?? null });
        set({ data: { ...d, mcp: d.mcp.filter((e) => !gone(e, "mcp")), skills: d.skills.filter((e) => !gone(e, "skill")) } });
      }
      return p.kind === "mcp"
        ? { result: { removed: true, file: "(demo)", backup: "/Users/alexis/.claude.json.kiji-backup-2026-01-01T00-00-00-000Z" } }
        : { result: { removed: true, file: "(demo)", trashPath: "/Users/alexis/.Trash/" + p.name + "-2026-01-01T00-00-00-000Z" } };
    }
    try {
      const result = await useStore.getState().call<ExtensionsRemoveResult>("extensions.remove", p);
      void get().load();
      return { result };
    } catch (err) {
      return { error: stripMethodPrefix("extensions.remove", errorMessage(err)) };
    }
  },
}));

/** Escucha `extensions.changed` del core (otro cliente o Claude Code mismo). Devuelve la baja. */
export function connectExtensions(): () => void {
  return core.onEvent("extensions.changed", () => void useExtensions.getState().load());
}

function demoExtensions(): ExtensionsList {
  const open = useStore.getState().projects.filter((p) => p.open);
  const home = "/Users/alexis";
  const mcp: McpEntry[] = [
    { name: "playwright", scope: "user", projectId: null, transport: "stdio", command: "npx", envNames: [], headerNames: [], source: `${home}/.claude.json` },
    { name: "coolify", scope: "user", projectId: null, transport: "http", url: "https://coolify.example.com/mcp", envNames: [], headerNames: ["Authorization"], source: `${home}/.claude.json` },
    { name: "stripe", scope: "plugin", projectId: null, transport: "http", url: "https://mcp.stripe.com", envNames: [], headerNames: [], source: `${home}/.claude/plugins/cache/stripe/.mcp.json`, managedBy: "plugin:stripe" },
  ];
  const skills: SkillEntry[] = [
    { name: "frontend-design", description: "Diseño de interfaces cuidadas y distintivas.", scope: "user", projectId: null, path: `${home}/.claude/skills/frontend-design`, isSymlink: false },
    { name: "game-feel", description: "Animaciones y sensación de juego para los robots.", scope: "user", projectId: null, path: `${home}/.claude/skills/game-feel`, isSymlink: true, target: `${home}/.agents/skills/game-feel` },
    { name: "superpowers", description: "Flujos de trabajo de ingeniería.", scope: "plugin", projectId: null, path: `${home}/.claude/plugins/cache/superpowers/skills/superpowers`, isSymlink: false, managedBy: "plugin:superpowers" },
  ];
  for (const p of open) {
    mcp.push({ name: "postgres", scope: "project", projectId: p.projectId, transport: "stdio", command: "npx", envNames: ["DATABASE_URL"], headerNames: [], source: `${p.path}/.mcp.json` });
    mcp.push({ name: "figma", scope: "local", projectId: p.projectId, transport: "sse", url: "https://mcp.figma.com/sse", envNames: [], headerNames: [], source: `${home}/.claude.json` });
    skills.push({ name: `guia-${p.name}`, description: `Convenciones propias de ${p.name}.`, scope: "project", projectId: p.projectId, path: `${p.path}/.claude/skills/guia-${p.name}`, isSymlink: false });
  }
  return { mcp, skills, warnings: [] };
}
