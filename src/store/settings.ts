// Ajustes del core (0.4b): `settings.all` / `settings.set` / evento `settings.changed`, y `stats.models` (Home).
// Store propio y pequeño: las llamadas pasan por `useStore.call`, así un core sin estos métodos marca "aún no disponible".
import { create } from "zustand";
import { core, CoreError } from "../core/client";
import type { ModelUsage, SettingKey, SettingSpec, SettingsAll, SkillInfo, StatsRange } from "../../shared/protocol";
import { errorMessage, stripMethodPrefix } from "./core";
import { useStore } from ".";

export type SettingsStatus = "idle" | "loading" | "ready" | "unavailable";

export type SettingsState = {
  specs: Partial<Record<SettingKey, SettingSpec>>;
  status: SettingsStatus;
  /** Por qué no hay ajustes (core sin `settings.all`, caído...). */
  reason: string | null;
  /** `?demo=1`: todo se queda en memoria. */
  demo: boolean;
  load: () => Promise<void>;
  /** Guarda un campo. Devuelve `null` si fue bien o el texto del error de validación del core. */
  save: (key: SettingKey, value: string) => Promise<string | null>;
  /** Restablece al defecto. */
  reset: (key: SettingKey) => Promise<string | null>;
  /** `settings.changed`: `{key,value}`, `{settings:[...]}`, una lista completa; si no se entiende se recarga. */
  applyChanged: (payload: unknown) => void;
};

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object";

function reasonOf(err: unknown): string {
  return err instanceof CoreError && err.code === "unknown_method" ? "Los ajustes aún no están disponibles en el core." : `No se pudieron cargar los ajustes (${errorMessage(err)}).`;
}

export const useSettings = create<SettingsState>()((set, get) => ({
  specs: {},
  status: "idle",
  reason: null,
  demo: false,

  load: async () => {
    if (get().demo) return;
    set({ status: "loading" });
    try {
      const list = await useStore.getState().call<SettingsAll>("settings.all");
      const specs: SettingsState["specs"] = {};
      for (const s of Array.isArray(list) ? list : []) specs[s.key] = s;
      set({ specs, status: "ready", reason: null });
    } catch (err) {
      set({ status: "unavailable", reason: reasonOf(err) });
    }
  },

  save: async (key, value) => {
    const put = (v: string) => set((s) => ({ specs: { ...s.specs, [key]: { ...(s.specs[key] ?? { key, default: "", section: "general" as const }), value: v } } }));
    if (get().demo) {
      put(value);
      return null;
    }
    try {
      const res = await useStore.getState().call<{ key?: string; value?: string } | null>("settings.set", { key, value });
      put(isObj(res) && typeof res.value === "string" ? res.value : value);
      return null;
    } catch (err) {
      if (err instanceof CoreError && err.code === "unknown_method") return "settings.set: aún no disponible en el core";
      return stripMethodPrefix("settings.set", errorMessage(err));
    }
  },

  reset: (key) => get().save(key, get().specs[key]?.default ?? ""),

  applyChanged: (payload) => {
    if (Array.isArray(payload)) {
      const specs: SettingsState["specs"] = { ...get().specs };
      for (const s of payload as SettingSpec[]) if (s && typeof s.key === "string") specs[s.key] = s;
      set({ specs });
    } else if (isObj(payload) && typeof payload.key === "string" && (typeof payload.value === "string" || payload.value === null)) {
      const key = payload.key as SettingKey;
      const value = payload.value as string | null;
      set((s) => ({ specs: { ...s.specs, [key]: { ...(s.specs[key] ?? { key, default: "", section: "general" as const }), value } } }));
    } else void get().load();
  },
}));

/** Valor efectivo (guardado o el defecto); `undefined` si el core no lo conoce. */
export function settingValue(specs: SettingsState["specs"], key: SettingKey): string | undefined {
  const s = specs[key];
  return s ? (s.value ?? s.default) : undefined;
}

export function useSetting(key: SettingKey): string | undefined {
  return useSettings((s) => settingValue(s.specs, key));
}

/** Escucha `settings.changed` del core. Devuelve la baja. */
export function connectSettings(): () => void {
  return core.onEvent("settings.changed", (e) => useSettings.getState().applyChanged(e.payload));
}

// --- Modelos más usados (Home) ---------------------------------------------------------------------------

export type ModelStatsResult = { ok: true; models: ModelUsage[] } | { ok: false; reason: string };

export async function fetchModelUsage(range: StatsRange): Promise<ModelStatsResult> {
  if (useSettings.getState().demo) return { ok: true, models: DEMO_USAGE[range] };
  try {
    const list = await useStore.getState().call<ModelUsage[]>("stats.models", { range, limit: 10 });
    return { ok: true, models: Array.isArray(list) ? list : [] };
  } catch (err) {
    const aun = err instanceof CoreError && err.code === "unknown_method";
    return { ok: false, reason: aun ? "Las estadísticas de modelos aún no están disponibles en el core." : `No se pudieron cargar (${errorMessage(err)}).` };
  }
}

export async function fetchSkills(): Promise<SkillInfo[] | string> {
  if (useSettings.getState().demo) return DEMO_SKILLS;
  try {
    const list = await useStore.getState().call<SkillInfo[]>("skills.list");
    return Array.isArray(list) ? list : [];
  } catch (err) {
    return err instanceof CoreError && err.code === "unknown_method" ? "skills.list: aún no disponible en el core" : errorMessage(err);
  }
}

// --- Datos de ejemplo (?demo=1) -------------------------------------------------------------------------

const mu = (model: string, provider: string, runs: number, input: number, output: number, costUsd: number, agents: string[]): ModelUsage => ({
  model, provider, runs, input, output, cacheRead: input * 3, costUsd, lastUsedAt: Date.now() - 600_000, agents,
});
const base = [
  mu("sonnet", "claude", 24, 1_240_000, 182_000, 9.8, ["Ana", "Clau"]),
  mu("conn:demo-conn-1/qwen3-coder-30b", "demo-conn-1", 15, 860_000, 96_000, 0, ["Ana"]),
  mu("opus", "claude", 6, 420_000, 61_000, 7.45, ["Jefe"]),
  mu("conn:demo-conn-2/meta-llama/llama-3.3-70b-instruct", "demo-conn-2", 4, 210_000, 33_000, 0.31, []),
  mu("haiku", "claude", 3, 95_000, 12_000, 0.12, ["Nico"]),
];
const scale = (k: number) => base.map((m) => ({ ...m, runs: Math.max(1, Math.round(m.runs * k)), input: Math.round(m.input * k), output: Math.round(m.output * k), costUsd: m.costUsd * k }));
export const DEMO_USAGE: Record<StatsRange, ModelUsage[]> = { today: scale(0.2), "7d": scale(1), "30d": scale(3.4), all: scale(6) };

export const DEMO_SKILLS: SkillInfo[] = [
  { name: "frontend-design", description: "Diseño de interfaces cuidadas y distintivas." },
  { name: "game-feel", description: "Animaciones y sensación de juego para los robots." },
  { name: "engineering:testing-strategy", description: "Estrategia y diseño de pruebas." },
];

const sp = (key: SettingKey, def: string, section: SettingSpec["section"], value: string | null = null): SettingSpec => ({ key, default: def, section, value });
export const DEMO_SETTINGS: SettingSpec[] = [
  sp("user_name", "Alexis", "general", "Alexis"), sp("start_view", "home", "general"),
  sp("max_concurrent_runs", "3", "trabajo"), sp("daily_budget_usd", "10", "trabajo"), sp("default_budget_usd", "2", "trabajo"),
  sp("default_model", "sonnet", "trabajo"), sp("auto_relay_default", "1", "trabajo"), sp("test_timeout_min", "10", "trabajo"),
  sp("ollama_url", "http://localhost:11434/v1", "ias"), sp("claude_path", "", "ias"),
  sp("extra_skill_roots", "[]", "skills", '["/Users/alexis/.agents/skills"]'),
  sp("notify_system", "1", "avisos"), sp("notify_levels", '["warn","ask"]', "avisos"), sp("quiet_hours", "", "avisos"),
  sp("events_retention_days", "30", "datos"), sp("update_auto_check", "1", "actualizaciones"),
];

export function loadSettingsDemo() {
  const specs: SettingsState["specs"] = {};
  for (const s of DEMO_SETTINGS) specs[s.key] = s;
  useSettings.setState({ specs, status: "ready", reason: null, demo: true });
}
