# Kiji Office — Entrega 0.2a: agentes a la vista

Pedido de Alexis (23-10-2026), tras probar el hito 2:

1. Una pestaña por agente con sus tareas bien estructuradas y la respuesta legible.
2. Métricas por agente: consumo, contexto, tokens y modelo en uso.
3. Ver y editar la personalidad y las skills de cada agente.
4. Ver cada IA en tiempo real: cuánto límite le queda, cuándo cambia sola de modelo (relevo) y poder cambiarla a mano.
5. El "¿Qué quieres que haga?" dentro de la oficina, como munderdiffl.in.

## Qué tomamos de munder-difflin (estudio del código, MIT)

Estudiado con la skill de ingeniería inversa: es código fuente completo, así que se leyó con herramientas normales.
Su arte (tileset "Modern Interiors") es de pago y no se copia nada.

**Lo que tomamos (ideas, no código):**

- **Panel lateral del agente seleccionado con pestañas.** Clic en el robot (en la escena o en su tarjeta) lo selecciona.
- **Tira inferior de tarjetas de robots.** Cada tarjeta lleva un medidor de contexto de 8 segmentos: color de acento normal, amarillo a partir de 6/8 y coral a partir de 7/8. Los números van en un tooltip.
- **Globos de pensamiento sobre los robots.** Salen de los eventos de herramientas ("usando Read", "esperando permiso") y no de raspar la terminal. Se limitan a 160 caracteres y se apilan sin taparse.
- **Caja de pedido dirigida al robot seleccionado.** Enter envía y Shift+Enter hace un salto de línea. Guarda un borrador por robot y, si el robot está ocupado, el mensaje queda en cola.
- **Cronología de herramientas.** Una barra por llamada, con ✓ o ✗ y su duración.
- **Editor de agente en tres secciones:** Identidad, Motor e Instrucciones. Plantillas de rol con un clic. El objetivo del agente se inyecta en cada run.

**Lo que NO tomamos:**

- **Manejar la terminal de Claude a escondidas para gastar la suscripción de claude.ai.** Choca con las condiciones de Anthropic. Kiji sigue con el Agent SDK.
- **Instalar CLIs con `curl | bash`.**

**Donde Kiji va por delante:** munder-difflin 0.4.6 no detecta el límite restante ni hace relevo automático; su código quitó ese "hold" por fallos. Kiji usa lo que ya da el SDK:

- **`rate_limit_event`**, que llega en cada respuesta con `status`, `utilization`, `resetsAt` y `rateLimitType`, este último de valor `five_hour`, `seven_day`, `seven_day_opus` o `seven_day_sonnet`.
- **`result.modelUsage[modelo]`**, con `inputTokens`, `outputTokens`, `cacheReadInputTokens`, `cacheCreationInputTokens`, `costUSD`, `contextWindow` y `maxOutputTokens`.
- **`message.usage` de cada mensaje `assistant`**, para el contexto en vivo: input + cache_read + cache_creation del último turno.

Con clave de API no hay `rate_limit_event`: el límite se ve como un 429 y la UI muestra "sin datos de cupo".

## Decisiones

- **D8. Métricas en vivo sin tabla nueva.**
  - El adaptador emite `usage` por cada mensaje `assistant`. El core actualiza la fila del run, con escrituras a la BD como mucho cada 2 s por run, y notifica `run.metrics` en cada mensaje.
  - Totales por agente = suma de sus runs.
  - Ventana de contexto: 200 000 por defecto, 1 000 000 si el id del modelo lleva `[1m]`. Se corrige con `modelUsage.contextWindow` al terminar.
- **D9. Estado de cupo en memoria + copia en `settings`.**
  - `ctx.limits` guarda el último `rate_limit_info` por `rateLimitType` y la hora en que se vio. Llega también con `status: allowed` y `allowed_warning`, no solo con `rejected`.
  - Se guarda en `settings.limits_snapshot` (JSON) para sobrevivir a reinicios, y se notifica `limits.changed`.
- **D10. Relevo, mismo proveedor.**
  - **Si el límite es de un modelo** (`seven_day_opus` o `seven_day_sonnet`): se pasa al siguiente modelo de `agents.relay_order` que no esté limitado. Así se continúa la misma conversación del SDK (`resume` del `session_id`) con otro `model`, sin perder el enfoque.
  - **Si es de toda la cuenta** (`five_hour` o `seven_day`), los demás modelos de Claude tampoco sirven:
    - la tarea queda `paused_limit` con `resetsAt`;
    - se programa una reanudación automática a esa hora;
    - si el agente tiene `auto_relay` y hay otro proveedor configurado, se usa ese (Ollama llega con el paso 16; hoy no está instalado).
  - **Límite `budget`** (el tope que pone Alexis): nunca hay relevo.
  - **Registro:** el modelo usado se guarda en `runs.model`, y el preferido del agente no cambia. Cada relevo queda en `relays`.
- **D11. Cambio manual = el mismo mecanismo.** `task.switch` para el run, si está corriendo, y lo reanuda con otro modelo o con otro agente.
  - **Con otro agente:** nuevo run con un prompt de traspaso. Lleva el pedido original, la última respuesta, los archivos tocados y el `git diff --stat` del worktree. El worktree es el mismo.
- **D12. Personalidad y skills.**
  - `agents.persona` (texto libre, máx. 4000) se añade al system prompt tras el rol.
  - `agents.skills` es un JSON con nombres de skills de `~/.claude/skills/*/SKILL.md`. `skills.list` lee solo el `name` y el `description` del frontmatter.
  - Para activarlas en el run, primero se prueba la opción `skills` del SDK. Si con `settingSources: []` no las descubre, se monta un plugin local temporal (`plugins: [{type:'local', path}]`) que enlaza solo las skills elegidas.
  - **Plan B** si nada de eso funciona: nombre, descripción y ruta en el system prompt, con la indicación "lee el SKILL.md con Read cuando aplique".
  - Hay que comprobarlo con una llamada real barata (haiku) antes de dar el paso por cerrado.
- **D13. Respuesta legible.** La respuesta se muestra como Markdown con `react-markdown` + `remark-gfm`, sin HTML crudo (`skipHtml`). Los enlaces se abren con el plugin opener.

## Contrato core ⇄ UI (se programa contra esto en paralelo)

### Migración 2 (`user_version` 2)

```sql
ALTER TABLE agents ADD COLUMN persona TEXT NOT NULL DEFAULT '';
ALTER TABLE agents ADD COLUMN skills TEXT NOT NULL DEFAULT '[]';      -- JSON string[]
ALTER TABLE agents ADD COLUMN auto_relay INTEGER NOT NULL DEFAULT 1;  -- relay_order ya existe: JSON string[] de modelos
ALTER TABLE runs ADD COLUMN model TEXT;
ALTER TABLE runs ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN context_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN context_window INTEGER NOT NULL DEFAULT 200000;
CREATE TABLE relays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  from_agent_id TEXT, to_agent_id TEXT,
  from_model TEXT, to_model TEXT,
  reason TEXT NOT NULL,          -- 'limit' | 'manual' | 'resume_after_reset'
  detail TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX relays_project ON relays(project_id, id);
```

Por defecto, `relay_order` es `["opus","sonnet","haiku"]` sin el modelo propio, que va primero.

### Tipos (en `shared/protocol.ts`)

```ts
export type RunMetrics = {
  runId: string; taskId: string; agentId: string; model: string;
  input: number; output: number; cacheRead: number; cacheWrite: number;
  contextTokens: number; contextWindow: number; costUsd: number; live: boolean;
};
export type AgentMetrics = {
  agentId: string; model: string;            // modelo en uso ahora (el del run vivo, o el preferido)
  runs: number; costUsd: number; input: number; output: number; cacheRead: number; cacheWrite: number;
  lastContextTokens: number; lastContextWindow: number;
  recent: RunMetrics[];                      // últimos 20 runs, el más nuevo primero
};
export type LimitWindow = {
  type: 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet' | 'other';
  status: 'allowed' | 'allowed_warning' | 'rejected';
  utilization: number | null;                // 0..1 tal como viene del SDK (la UI muestra %)
  resetsAt: number | null;                   // epoch ms
  seenAt: number;
};
export type ProviderStatus = {
  id: 'claude' | 'ollama' | 'openai' | 'gemini';
  label: string;
  configured: boolean;                       // claude: CLI o clave; ollama: responde; openai/gemini: hay clave
  state: 'ok' | 'warning' | 'limited' | 'off' | 'unknown';
  windows: LimitWindow[];                    // vacío = sin datos de cupo (p. ej. clave de API)
  models: { model: string; agents: string[]; liveRuns: number; costTodayUsd: number; limitedUntil: number | null }[];
};
export type RelayRow = {
  id: number; taskId: string | null; fromAgentId: string | null; toAgentId: string | null;
  fromModel: string | null; toModel: string | null; reason: 'limit' | 'manual' | 'resume_after_reset';
  detail: string; createdAt: number;
};
export type SkillInfo = { name: string; description: string };
export type ToolStep = { name: string; target: string; ok: boolean | null; startedAt: number; endedAt: number | null };
```

### Métodos nuevos o ampliados

| Método | Parámetros | Devuelve |
|---|---|---|
| `agent.update` | `{agentId, name?, model?, color?, persona?, skills?, relayOrder?, autoRelay?}` | fila de agente (con los campos nuevos y `skills`/`relay_order` ya parseados como arrays) |
| `agent.metrics` | `{agentId}` | `AgentMetrics` |
| `skills.list` | — | `SkillInfo[]` (orden alfabético; nunca el contenido del SKILL.md) |
| `providers.status` | — | `ProviderStatus[]` |
| `relays.list` | `{limit?}` | `RelayRow[]`, el más nuevo primero, del proyecto activo |
| `task.switch` | `{taskId, model?, agentId?}` (al menos uno) | vista de tarea |
| `task.steps` | `{taskId}` | `ToolStep[]` del último run (de los eventos `tool`) |

`agent.list` y `task.list` añaden campos:

- `agent.list`: `persona`, `skills: string[]`, `relay_order: string[]`, `auto_relay`, `current_model`.
- `task.list`: `model`, `cost_usd`, `context_pct`, `steps_count`.

### Notificaciones nuevas

- `run.metrics` → `RunMetrics`, como mucho una cada 500 ms por run.
- `limits.changed` → `ProviderStatus[]`.
- `relay.happened` → `RelayRow`.
- `agent.changed` → fila de agente (tras `agent.update`).

## Pasos y quién los hace

Cada programador toca solo sus archivos.

- **A: núcleo** (`core/**`, `shared/protocol.ts`).
  - Migración 2 y repos.
  - Eventos `usage` y `rate` en el adaptador de Claude.
  - Métricas, cupo, relevo automático y manual, y reanudación al reset.
  - Persona y skills en el run.
  - Métodos y notificaciones de arriba, con sus tests.
  - Una prueba real barata de skills (D12).
- **B: pestañas por agente** (`src/screens/Agents/**`, `src/components/AgentStrip*`, `src/components/Markdown*`, `src/store/agents.ts`, `src/store/metrics.ts`, `package.json` + lock: es el único que instala dependencias).
  - `AgentTabs`: una pestaña "Todos" más una por agente. Dentro de cada agente, las subpestañas son:
    - **Tareas:** tarjetas con Pedido, Estado, Pasos (plegados) y Respuesta en Markdown, y botones Empezar, Ver cambios y Cambiar IA.
    - **Métricas:** modelo, tokens de entrada, salida y caché, barra de contexto, coste y runs recientes.
    - **Perfil:** nombre, color, modelo, personalidad, skills (con buscador), orden de relevo y relevo automático; guarda con `agent.update`.
    - **Registro:** eventos en frases legibles, no JSON crudo.
  - `AgentStrip`: tira de tarjetas con medidor de contexto de 8 segmentos y coste.
- **C: oficina e IAs** (`src/scenes/**`, `src/screens/Office/**`, `src/components/ProvidersPanel*`, `src/components/OfficeComposer*`, `src/store/providers.ts`, `src/store/index.ts`, `src/store/core.ts`).
  - Caja de pedido superpuesta abajo en la escena, al estilo del chat de un juego:
    - chips con los robots para elegir destinatario (un clic en un robot de la escena también lo elige);
    - Enter envía, el borrador se guarda por robot;
    - un botón "Archivos" despliega el campo opcional.
  - Globos de pensamiento en Pixi sobre cada robot, sacados del último evento: "leyendo X", "editando Y", "ejecutando npm test", "¡te necesito!", "pensando…" o "¡listo!".
  - Panel "IAs en vivo":
    - una tarjeta por proveedor con su estado;
    - barras de 5 h y 7 días con cuenta atrás hasta el reset;
    - gasto de hoy y agentes por modelo;
    - historial de relevos;
    - "Cambiar IA" en las tareas que corren.
  - Conexión de las notificaciones nuevas en el store.
  - Montaje del layout: escena + caja de pedido arriba, `AgentStrip` debajo, `AgentTabs` + "IAs en vivo" a la derecha (o en pestañas en pantallas estrechas).
- **Al final:** revisor-critico sobre todo el diff, tester con la app real, y una tarea de solo lectura y otra con archivos en `taller-juan`.

## Riesgos

- **`rate_limit_event` solo llega con login de suscripción.** En la versión distribuida (clave de API) el panel de cupo dirá "sin datos" y solo se verán los 429.
- **El relevo entre modelos de Claude no sirve para el límite de 5 h:** ese límite es de toda la cuenta. Hace falta otro proveedor (paso 16) o esperar al reset.
- **Reanudar con otro modelo puede cambiar el estilo de la respuesta a mitad de tarea.** Se avisa en el registro.
