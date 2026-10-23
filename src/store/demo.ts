// Solo en desarrollo (`?demo=1`): dos workspaces de ejemplo con datos de overview, para ver la interfaz sin core.
import type { ConnectionView, DiscoveredServer, ProjectListItem, ProviderStatus, WorkspaceOverview, WorkspaceSummary } from "../../shared/protocol";
import { useStore } from ".";
import type { Agent } from "./agents";

const now = () => Date.now();

const AGENTS_WEB: Agent[] = [
  { id: "demo-1", name: "Jefe", provider: "claude", color: "terracota", is_boss: 1, status: "thinking" },
  { id: "demo-2", name: "Ana", provider: "openai", color: "azul", status: "needs_you" },
  { id: "demo-3", name: "Nico", provider: "gemini", color: "verde", status: "done" },
];
const AGENTS_APP: Agent[] = [
  { id: "demo-4", name: "Jefe", provider: "claude", color: "terracota", is_boss: 1, status: "idle" },
  { id: "demo-5", name: "Clau", provider: "claude", color: "terracota", status: "writing" },
];

const DEMO_PROVIDERS: ProviderStatus[] = [
  {
    id: "claude",
    label: "Claude",
    configured: true,
    state: "warning",
    windows: [
      { type: "five_hour", status: "allowed", utilization: 0.42, resetsAt: now() + 2.5 * 3_600_000, seenAt: now() },
      { type: "seven_day", status: "allowed_warning", utilization: 0.78, resetsAt: now() + 3 * 86_400_000, seenAt: now() },
      { type: "seven_day_sonnet", status: "rejected", utilization: 1, resetsAt: now() + 5 * 3_600_000, seenAt: now() },
    ],
    models: [{ model: "sonnet", agents: ["demo-2"], liveRuns: 1, costTodayUsd: 0.42, limitedUntil: null }],
  },
  { id: "ollama", label: "Ollama", configured: false, state: "off", windows: [], models: [] },
  {
    id: "conn:demo-conn-1", label: "LM Studio", configured: true, state: "ok", windows: [],
    models: [{ model: "qwen3-coder-30b", agents: ["demo-2"], liveRuns: 1, costTodayUsd: 0, limitedUntil: null }],
  },
  { id: "conn:demo-conn-2", label: "OpenRouter", configured: true, state: "ok", windows: [], models: [{ model: "meta-llama/llama-3.3-70b-instruct", agents: [], liveRuns: 0, costTodayUsd: 0.31, limitedUntil: null }] },
];

const DEMO_CONNECTIONS: ConnectionView[] = [
  {
    id: "demo-conn-1", name: "LM Studio", preset: "lmstudio", baseUrl: "http://localhost:1234/v1", auth: "none", hasSecret: false,
    defaultModel: "qwen3-coder-30b", contextWindow: 32768, toolQuality: "ok", lastTestAt: now() - 600_000, lastTestOk: true,
    agents: ["Ana"], prices: {},
  },
  {
    id: "demo-conn-2", name: "OpenRouter", preset: "openrouter", baseUrl: "https://openrouter.ai/api/v1", auth: "bearer", hasSecret: true,
    defaultModel: "meta-llama/llama-3.3-70b-instruct", contextWindow: 65536, toolQuality: "weak", lastTestAt: now() - 3_600_000, lastTestOk: true,
    agents: [], prices: {},
  },
  {
    id: "demo-conn-3", name: "Mi servidor", preset: "custom", baseUrl: "http://192.168.1.20:8000/v1", auth: "none", hasSecret: false,
    defaultModel: null, contextWindow: 8192, toolQuality: "none", lastTestAt: now() - 86_400_000, lastTestOk: false,
    agents: [], prices: {},
  },
];
const DEMO_DISCOVERED: DiscoveredServer[] = [
  { preset: "lmstudio", baseUrl: "http://localhost:1234/v1", models: ["qwen3-coder-30b", "gemma-3-12b", "llama-3.2-3b"], alreadyConnected: true },
  { preset: "llamacpp", baseUrl: "http://localhost:8080/v1", models: ["qwen2.5-coder-7b"], alreadyConnected: false },
  { preset: "ollama", baseUrl: "http://localhost:11434/v1", models: [], alreadyConnected: false, installedNotRunning: true },
];

export const DEMO_WEB = "demo-web";
export const DEMO_APP = "demo-app";

function overview(): WorkspaceOverview {
  const asAgents = (list: Agent[], model: string) =>
    list.map((a) => ({ id: String(a.id), name: a.name, model, status: a.status ?? "idle", color: a.color ?? null, isBoss: !!a.is_boss }));
  const workspaces: WorkspaceSummary[] = [
    {
      projectId: DEMO_WEB, name: "mi-web", path: "/Users/alexis/repos/mi-web", open: true, color: "#5aa9f0", scene: "oficina",
      agents: asAgents(AGENTS_WEB, "sonnet"), liveRuns: 2, queued: 1, needsYou: 1, approvalsPending: 1,
      tasksByStatus: { todo: 2, running: 2, needs_you: 1, review: 1, integrated: 4, assigned: 1 },
      costTodayUsd: 3.42, costTotalUsd: 18.7, tokensToday: { input: 412_000, output: 58_000, cacheRead: 2_100_000, cacheWrite: 130_000 },
      lastActivityAt: now() - 3 * 60_000,
      lastRelay: { id: 1, projectId: DEMO_WEB, taskId: "t1", fromAgentId: "demo-2", toAgentId: "demo-2", fromModel: "sonnet", toModel: "haiku", reason: "limit", detail: "", createdAt: now() - 3_600_000 },
    },
    {
      projectId: DEMO_APP, name: "app-movil", path: "/Users/alexis/repos/app-movil", open: true, color: "#4cc38a", scene: "oficina",
      agents: asAgents(AGENTS_APP, "opus"), liveRuns: 1, queued: 0, needsYou: 0, approvalsPending: 0,
      tasksByStatus: { running: 1, integrated: 7, failed: 1 },
      costTodayUsd: 1.1, costTotalUsd: 42.05, tokensToday: { input: 150_000, output: 21_000, cacheRead: 900_000, cacheWrite: 40_000 },
      lastActivityAt: now() - 40_000,
    },
    {
      projectId: "demo-old", name: "viejo-experimento", path: "/Users/alexis/repos/viejo-experimento", open: false, color: null, scene: "oficina",
      agents: [], liveRuns: 0, queued: 0, needsYou: 0, approvalsPending: 0, tasksByStatus: { integrated: 3 },
      costTodayUsd: 0, costTotalUsd: 5.3, tokensToday: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      lastActivityAt: now() - 5 * 86_400_000,
    },
  ];
  return { workspaces, totals: { costTodayUsd: 4.52, liveRuns: 3, queued: 1, maxConcurrentRuns: 3, dailyBudgetUsd: 10 } };
}

export function loadDemo() {
  const s = useStore.getState();
  const ov = overview();
  const projects: ProjectListItem[] = ov.workspaces.map((w) => ({
    projectId: w.projectId, name: w.name, path: w.path, baseBranch: "main", testCommand: null, createdAt: now() - 86_400_000,
    open: w.open, lastOpenedAt: w.lastActivityAt, color: w.color, scene: w.scene, liveRuns: w.liveRuns, queued: w.queued,
    needsYou: w.needsYou, approvalsPending: w.approvalsPending, tasksByStatus: w.tasksByStatus,
  }));
  s.applyProjects(projects);
  s.applyOverview(ov);
  s.applyLimits(DEMO_PROVIDERS);
  s.applyConnections(DEMO_CONNECTIONS);
  useStore.setState({ discovered: DEMO_DISCOVERED });
  s.setAgents(DEMO_WEB, AGENTS_WEB);
  s.setAgents(DEMO_APP, AGENTS_APP);
  s.upsertTask(DEMO_WEB, { id: "dt1", title: "Arreglar el login", status: "running", agent_id: "demo-2" });
  s.upsertTask(DEMO_WEB, { id: "dt2", title: "Migrar estilos", status: "assigned", agent_id: "demo-3", queued: true, queue_position: 1 });
  s.applyQueue({ projectId: DEMO_WEB, taskId: "dt2", queued: true, position: 1, blockedBy: "slots" });
  s.noteActivity(DEMO_WEB, "demo-1", "tool", { name: "Read", input: { file_path: "src/store/index.ts" } });
  s.noteActivity(DEMO_WEB, "demo-2", "permission", { decision: "pending" });
  s.noteActivity(DEMO_WEB, "demo-3", "status", { type: "done" });
  s.addApproval(DEMO_WEB, { id: "da1", agent_id: "demo-2", task_id: "dt1", tool: "Bash", input: { command: "npm test" }, risk: "medium" });
  s.noteActivity(DEMO_APP, "demo-5", "tool", { name: "Edit", input: { file_path: "lib/main.dart" } });
  s.setBooted(true);
}
