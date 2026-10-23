// Solo en desarrollo (`?demo=1`): dos workspaces de ejemplo con datos de overview, para ver la interfaz sin core.
import type { ConnectionView, DiscoveredServer, ProjectListItem, ProviderStatus, WorkspaceOverview, WorkspaceSummary } from "../../shared/protocol";
import type { BoardColumn } from "../../shared/protocol";
import { columnOfTask, nextColumn } from "../scenes/boardLogic";
import { useStore } from ".";
import { pushBoardMove } from "./boardMoves";
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
  loadBoardDemo(DEMO_WEB);
  s.applyQueue({ projectId: DEMO_WEB, taskId: "dt2", queued: true, position: 1, blockedBy: "slots" });
  s.noteActivity(DEMO_WEB, "demo-1", "tool", { name: "Read", input: { file_path: "src/store/index.ts" } });
  s.noteActivity(DEMO_WEB, "demo-2", "permission", { decision: "pending" });
  s.noteActivity(DEMO_WEB, "demo-3", "status", { type: "done" });
  s.addApproval(DEMO_WEB, { id: "da1", agent_id: "demo-2", task_id: "dt1", tool: "Bash", input: { command: "npm test" }, risk: "medium" });
  s.noteActivity(DEMO_APP, "demo-5", "tool", { name: "Edit", input: { file_path: "lib/main.dart" } });
  loadManagerDemo();
  startBoardDemo();
  s.setBooted(true);
}

let boardDemoTimer: ReturnType<typeof setInterval> | null = null;
const BOARD_DEMO_MS = 6000;

/** Cada 6 s mueve una tarea de ejemplo a la siguiente columna (con `board.moved`) para ver la caminata del robot. */
function startBoardDemo() {
  if (boardDemoTimer) clearInterval(boardDemoTimer);
  let n = 0;
  boardDemoTimer = setInterval(() => {
    const { tasks } = useStore.getState().byProject[DEMO_WEB] ?? { tasks: [] };
    const movable = tasks.filter((t) => t.agent_id != null);
    if (movable.length === 0) return;
    const t = movable[n++ % movable.length];
    const from: BoardColumn = columnOfTask(t);
    const to = nextColumn(from);
    useStore.getState().upsertTask(DEMO_WEB, { ...t, board_column: to });
    pushBoardMove(DEMO_WEB, { projectId: DEMO_WEB, taskId: String(t.id), agentId: String(t.agent_id), from, to, auto: true });
  }, BOARD_DEMO_MS);
}

/** Ejemplos de 0.2d: tareas en revisión/aprobadas/integradas, objetivos, gerente, diario, memoria y avisos. */
function loadManagerDemo() {
  const s = useStore.getState();
  const m = (min: number) => now() - min * 60_000;
  s.upsertTask(DEMO_WEB, { id: "dt3", title: "Añadir validación al formulario", status: "review", agent_id: "demo-3", files: ["src/form.ts"], result: "Validación hecha; faltan casos de borde." });
  s.upsertTask(DEMO_WEB, { id: "dt4", title: "Cambiar el botón de pago", status: "approved", agent_id: "demo-2", files: ["src/pay.tsx"] });
  s.upsertTask(DEMO_WEB, { id: "dt5", title: "Pantalla de ajustes", status: "integrated", agent_id: "demo-3", files: ["src/settings.tsx"] });
  s.upsertTask(DEMO_WEB, { id: "dt6", title: "Ajustar el contraste", status: "changes", agent_id: "demo-2", files: ["src/theme.css"] });
  s.upsertTask(DEMO_WEB, { id: "dt7", title: "Subir imágenes a la nube", status: "blocked", agent_id: "demo-3", files: ["src/upload.ts"] });
  const integration = { id: "di1", projectId: DEMO_WEB, taskId: "dt5", beforeSha: "a1b2c3d", afterSha: "e4f5a6b", status: "applied" as const, detail: "", createdAt: m(50) };
  useStore.setState({
    objectives: {
      [DEMO_WEB]: [
        { id: "do1", projectId: DEMO_WEB, text: "Renovar el flujo de pago", status: "active", createdAt: m(120), tasksByStatus: { integrated: 1, approved: 1, review: 1, running: 1 } },
        { id: "do2", projectId: DEMO_WEB, text: "Pantalla de ajustes accesible", status: "done", createdAt: m(900), tasksByStatus: { integrated: 3 } },
        { id: "do3", projectId: DEMO_WEB, text: "Documentar la API", status: "planning", createdAt: m(5), tasksByStatus: {} },
      ],
    },
    integrations: { [DEMO_WEB]: [integration] },
    manager: {
      [DEMO_WEB]: {
        projectId: DEMO_WEB, halted: false, running: false, todayCostUsd: 2.35,
        lastTick: { id: "dk1", projectId: DEMO_WEB, trigger: "task.changed", summary: "Arrancó la validación y pidió revisión", costUsd: 0.08, startedAt: m(4), endedAt: m(3) },
        policy: {
          enabled: true, brain: { agentId: "demo-1" },
          levels: { plan: "auto", assign: "auto", start: "auto", retry: "auto", relay: "notify", integrate: "ask", spend: "ask" },
          spendAskUsd: 5, dayBudgetUsd: 15, maxTickMinutes: 5, maxTicksPerHour: 20, quietHours: { from: "23:00", to: "08:00" }, askTimeoutMinutes: 60,
        },
      },
    },
    diary: {
      [DEMO_WEB]: [
        {
          id: "dk1", projectId: DEMO_WEB, trigger: "task.changed", summary: "Arrancó la validación y pidió revisión", costUsd: 0.08, startedAt: m(4), endedAt: m(3),
          actions: [
            { id: 1, tickId: "dk1", projectId: DEMO_WEB, tool: "start_task", input: "{}", result: "Tarea dt3 en marcha", level: "auto", decidedBy: "policy", createdAt: m(4) },
            { id: 2, tickId: "dk1", projectId: DEMO_WEB, tool: "request_integration", input: "{}", result: "Esperando tu respuesta", level: "ask", decidedBy: null, createdAt: m(3) },
          ],
        },
        {
          id: "dk0", projectId: DEMO_WEB, trigger: "objective.created", summary: "Planificó «Renovar el flujo de pago» en 4 tareas", costUsd: 0.21, startedAt: m(118), endedAt: m(116),
          actions: [
            { id: 3, tickId: "dk0", projectId: DEMO_WEB, tool: "create_tasks", input: "{}", result: "4 tareas creadas", level: "auto", decidedBy: "policy", createdAt: m(117) },
            { id: 4, tickId: "dk0", projectId: DEMO_WEB, tool: "switch_model", input: "{}", result: "Ana pasa a Haiku", level: "notify", decidedBy: "policy", createdAt: m(117) },
            { id: 5, tickId: "dk0", projectId: DEMO_WEB, tool: "continue_spending", input: "{}", result: "Sin respuesta: se dio por NO", level: "ask", decidedBy: "timeout", createdAt: m(60) },
            { id: 6, tickId: "dk0", projectId: DEMO_WEB, tool: "request_integration", input: "{}", result: "Integrada", level: "ask", decidedBy: "user", createdAt: m(55) },
          ],
        },
      ],
    },
    memory: {
      [DEMO_WEB]: [
        { id: 1, projectId: DEMO_WEB, kind: "fact", text: "El proyecto usa React 19 y vitest.", source: "manager", archived: false, createdAt: m(300) },
        { id: 2, projectId: DEMO_WEB, kind: "decision", text: "Los pagos van con Stripe, no con PayPal.", source: "user", archived: false, createdAt: m(200) },
        { id: 3, projectId: DEMO_WEB, kind: "preference", text: "Textos de la interfaz siempre en español.", source: "user", archived: false, createdAt: m(150) },
        { id: 4, projectId: DEMO_WEB, kind: "todo", text: "Revisar los estilos del botón de pago.", source: "manager", archived: false, createdAt: m(30) },
      ],
    },
    notifications: [
      { id: 3, projectId: DEMO_WEB, level: "ask", title: "El gerente pregunta", body: "¿Integro «Cambiar el botón de pago»?", approvalId: "da2", readAt: null, createdAt: m(3) },
      { id: 2, projectId: DEMO_APP, level: "warn", title: "Tope del día casi alcanzado", body: "Llevas 12,40 $ de 15 $.", approvalId: null, readAt: null, createdAt: m(40) },
      { id: 1, projectId: DEMO_WEB, level: "info", title: "Tarea integrada", body: "«Pantalla de ajustes» ya está en main.", approvalId: null, readAt: m(30), createdAt: m(50) },
    ],
  });
  s.addApproval(DEMO_WEB, { id: "da2", task_id: "dt4", tool: "manager:request_integration", kind: "integrate", input: { question: "¿Integro «Cambiar el botón de pago» en main?" } });
  s.addApproval(DEMO_WEB, { id: "da3", tool: "manager:ask", kind: "question", input: { question: "El gasto de hoy pasó de 5 $. ¿Sigo con las tareas pendientes?", options: ["Sí, seguir hoy", "No, parar hasta mañana"] } });
}

/** Tareas repartidas por las 10 columnas de la pizarra. */
function loadBoardDemo(pid: string) {
  const s = useStore.getState();
  const rows: [string, string, string, string, string | null, 0 | 1, Record<string, unknown>?][] = [
    ["b1", "Idea: modo claro", "todo", "refinement", null, 0],
    ["b2", "Página de ajustes", "assigned", "refined", "demo-3", 0],
    ["b3", "Arreglar el login", "running", "doing_dev", "demo-2", 0, { model: "sonnet", cost_usd: 0.42 }],
    ["b4", "Migrar estilos", "review", "committed", "demo-3", 0, { model: "haiku", cost_usd: 0.08 }],
    ["b5", "Revisar rutas", "running", "doing_qa", "demo-1", 1, { model: "opus", cost_usd: 1.2 }],
    ["b6", "Tests rotos en cart", "changes", "bug", "demo-2", 0, { model: "sonnet", cost_usd: 0.3 }],
    ["b7", "Corregir el carrito", "running", "fix", "demo-2", 0, { model: "sonnet", cost_usd: 0.55 }],
    ["b8", "Nuevo selector de fecha", "approved", "functional", "demo-3", 0, { model: "haiku", cost_usd: 0.12 }],
    ["b9", "Cabecera responsive", "integrated", "done", "demo-2", 0, { model: "sonnet", cost_usd: 0.9 }],
    ["b10", "Logo nuevo", "integrated", "done_prod", "demo-3", 1, { model: "haiku", cost_usd: 0.05 }],
    ["b11", "Subir imágenes", "blocked", "refined", "demo-2", 0],
    ["b12", "Exportar CSV", "failed", "doing_dev", "demo-3", 0, { model: "haiku", cost_usd: 0.2 }],
    ["b13", "Notificaciones push", "paused_limit", "doing_dev", "demo-2", 0, { model: "sonnet", cost_usd: 0.6 }],
  ];
  for (const [id, title, status, board_column, agent, manual, extra] of rows) {
    const board_flag = status === "blocked" || status === "failed" || status === "paused_limit" ? status : null;
    s.upsertTask(pid, { id, title, status, agent_id: agent, board_column, board_manual: manual, board_flag, ...extra } as never);
  }
}
