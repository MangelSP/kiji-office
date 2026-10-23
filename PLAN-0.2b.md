# Kiji Office — Plan 0.2b → 0.2e: conexiones, multiproyecto y gerente autónomo

Pedido de Alexis (23-10-2026), tres cosas:

1. Conectar **cualquier IA**, también local (LM Studio, Ollama, llama.cpp…), de forma fácil.
2. **Varios proyectos** con distintos agentes o workspaces.
3. Un **agente autónomo** ("como Hermes o Muse"): le doy una clave y un cerebro, gestiona todo, me avisa y me pide permiso en lo delicado.

Estado del código al escribir esto (commit `7197b64` + trabajo en curso de 0.2a): un solo proyecto activo en
`ctx.activeProject`; adaptador `claude` (Agent SDK) único; `agents.provider` admite `claude|codex|api` pero
`agent.create` solo deja `claude`; `providers.ts` ya sondea Ollama y prueba claves de OpenAI/Gemini; `keyring.rs`
solo admite tres cuentas (`anthropic`, `openai`, `gemini`) inyectadas por entorno al arrancar el core; relevo D10
solo entre modelos de Claude. Nada de este plan toca lo que están programando ahora en `core/**` y `src-tauri/**`
hasta que 0.2a cierre: 0.2b empieza con la migración 3, encima de la 2.

Orden de entregas (pequeñas, cada una demostrable): **0.2b conexiones → 0.2c multiproyecto → 0.2d gerente →
0.2e puente exterior (Telegram + servidor MCP)**. El punto 1 va primero porque el 2 y el 3 lo necesitan (un
agente apunta a una conexión; el cerebro del gerente es una conexión).

---

## Parte 1 — Conexiones: cualquier IA, local o en la nube (entrega 0.2b)

### Lo que hay fuera (investigado 23-10-2026)

| Servidor / proveedor | OpenAI Chat Completions con `tools` | Anthropic Messages (`/v1/messages`) | Nota |
|---|---|---|---|
| Ollama (local :11434) | sí (`/v1/chat/completions`, `/v1/models`) | sí desde 01-2026; tools, streaming, thinking; sin `tool_choice`, sin caché | Contexto por defecto pequeño: hay que subirlo (`OLLAMA_CONTEXT_LENGTH`) |
| LM Studio (local :1234) | sí | sí desde 0.4.1; acepta `x-api-key` o Bearer si se activa auth | Recomienda >25k de contexto para agentes |
| llama.cpp `llama-server` (:8080) | sí | sí desde 01-2026 (traduce a OpenAI por dentro) | |
| vLLM (:8000) | sí | sí (`/v1/messages`, `count_tokens`) | Nombres con `/` dan problemas en Claude Code |
| OpenRouter | sí | sí ("Anthropic skin"), pero solo garantizado para modelos de Anthropic | |
| LiteLLM proxy | sí | sí, traduciendo (pierde caché/thinking) o passthrough opt-in | Es un servidor más que instalar |
| Groq, Together, Mistral, Gemini (`/v1beta/openai/`), OpenAI | sí | no (Groq lo tiene pedido) | |
| DeepSeek, Kimi (Moonshot), GLM (Z.ai) | sí | sí (`/anthropic`) | Mapean nombres `claude-*` a los suyos |

Dos hechos que deciden la arquitectura:

- **OpenAI Chat Completions con `tools` lo hablan todos.** Anthropic Messages lo hablan muchos, pero no Groq,
  Together, Mistral ni Gemini. Un solo protocolo cliente cubre el 100 %.
- **Anthropic dice en su documentación de gateways** que "no soporta enrutar Claude Code a modelos que no sean
  Claude a través de ningún gateway" (code.claude.com/docs/en/llm-gateway). Funciona hoy (`ANTHROPIC_BASE_URL` +
  `ANTHROPIC_AUTH_TOKEN`), pero una app distribuida no puede apoyar su función estrella en algo que el fabricante
  declara no soportado y que cambia con cada versión del CLI (cabeceras beta, campos `context_management`, tool
  `advisor`…: la propia tabla de errores de esa página lo muestra). Además el system prompt y las ~20
  herramientas de Claude Code ahogan a un modelo local de 8–30B.

### D14. Un adaptador propio `api-loop` (OpenAI Chat Completions + tools) para todo lo que no sea Claude

**Decisión.** Lo que ya preveía PLAN-0.1 como paso 16, ahora como pieza central: `core/src/adapters/apiLoop.ts`
habla `POST {base}/chat/completions` con `stream: true` y `tools`, y ejecuta **nuestras seis herramientas**
(`read_file`, `write_file`, `edit_file`, `list_dir`, `grep`, `run_command`) dentro del worktree. Cada
`write/edit` pasa por `isPathAllowed` y cada `run_command` por `classifyCommand` **antes** de ejecutarse: el
mismo clasificador y la misma tarjeta de aprobación que Claude, sin depender de ningún `canUseTool` ajeno.
Sin dependencia nueva: `fetch` nativo de Node 22 + parseo SSE propio (60 líneas); el paquete `openai` no aporta
nada que necesitemos y añade 2 MB.

**Alternativas descartadas.**
- (a) Agent SDK + `ANTHROPIC_BASE_URL` hacia Ollama/LM Studio: no soportado por Anthropic, frágil por versión,
  y mal rendimiento de modelos locales con el prompt de Claude Code. Queda documentado como truco "para tu propio
  Claude Code", no como función de Kiji.
- (c) Proxy OpenAI↔Anthropic local: un proceso más que mantener y hereda todos los problemas de (a).
- Cliente Anthropic Messages propio además del OpenAI: segundo protocolo para cero cobertura extra. Si algún día
  hace falta (p. ej. caché de prompt en DeepSeek), se añade como `kind: 'anthropic_compat'` detrás de la misma
  interfaz.

### D15. "Conexión" como entidad: tabla `connections`, secreto en el llavero, `agents.connection_id`

Una **conexión** = un servidor con su URL, su forma de autenticarse y su lista de modelos. Los agentes apuntan
a una conexión (o a ninguna = Claude nativo por el Agent SDK, como hoy). Un robot de Ollama y otro de Groq son
dos conexiones distintas con el mismo adaptador.

```sql
-- Migración 3 (user_version 3)
CREATE TABLE connections (
  id             TEXT PRIMARY KEY,                 -- uuid; la clave vive en el llavero como "conn:<id>"
  name           TEXT NOT NULL,                    -- "Mi LM Studio", "Groq"
  preset         TEXT NOT NULL,                    -- ollama|lmstudio|llamacpp|vllm|openai|groq|together|deepseek|mistral|gemini|openrouter|litellm|custom
  kind           TEXT NOT NULL DEFAULT 'openai_compat' CHECK (kind IN ('openai_compat')),
  base_url       TEXT NOT NULL,                    -- sin barra final; termina en /v1 (o /v1beta/openai para Gemini)
  auth           TEXT NOT NULL CHECK (auth IN ('none', 'bearer', 'x-api-key')),
  has_secret     INTEGER NOT NULL DEFAULT 0,       -- 1 si hay clave en el llavero (nunca la clave)
  default_model  TEXT,
  context_window INTEGER NOT NULL DEFAULT 32768,   -- editable; se corrige con /v1/models si el servidor lo informa
  tool_quality   TEXT NOT NULL DEFAULT 'unknown' CHECK (tool_quality IN ('unknown', 'ok', 'weak', 'none')),
  prices_json    TEXT NOT NULL DEFAULT '{}',       -- {"<modelo>": {"in": usd/Mtok, "out": usd/Mtok}} opcional
  last_test_at   INTEGER, last_test_ok INTEGER,
  created_at     INTEGER NOT NULL
);
ALTER TABLE agents ADD COLUMN connection_id TEXT REFERENCES connections(id) ON DELETE SET NULL; -- NULL = Claude nativo
-- agents.api_base queda sin uso (se conserva por compatibilidad de la migración 1).
```

**Secretos: del llavero al core sin pasar por la pantalla ni por archivos.** Hoy Rust inyecta las tres claves
fijas por entorno al arrancar; una conexión nueva obligaría a reiniciar el core (y pararía los runs). Cambio
pequeño en `core_process.rs` + `keyring.rs`:

- `keyring.rs`: además de `ALLOWED`, acepta cuentas `conn:<uuid>` (regex estricta). `secret_set` para esas cuentas
  guarda en el llavero **y** escribe en el stdin del core la línea
  `{"id":"rust:<n>","type":"req","method":"secrets.put","params":{"account":"conn:<uuid>","value":"…"}}`.
- `core_process.rs`: las respuestas cuyo `id` empieza por `rust:` **no** se reenvían al webview (filtro junto a
  `log_milestones`). Cuando el core emite el evento `secrets.request {accounts: string[]}` (al abrir la BD y al
  crear una conexión), el hilo de stdout lee cada cuenta del llavero y la empuja con `secrets.put`.
- Core: `ctx.secrets: Map<account, string>` en memoria; `redact()` de `providers.ts` tapa también estos valores.
  `secrets.put` solo se acepta si llega por stdin con id `rust:*` (el webview no puede falsificarlo porque
  `core_send` rechaza ids con ese prefijo).

Alternativa descartada: reiniciar el core tras guardar (patrón actual del asistente): mata los runs en curso y
obliga a enumerar el llavero, que la crate `keyring` no permite.

### D16. Calidad del tool-calling: se mide, no se supone

`connection.test` hace tres comprobaciones y guarda `tool_quality`:

1. `GET {base}/models` → alcanzable y clave válida (lista de modelos para el selector).
2. `chat/completions` de un token con el modelo elegido → responde.
3. **Sonda de herramientas**: se declara `kiji_ping(n: integer)` y se pide "llama a kiji_ping con n=7".
   `ok` = llega un `tool_calls` con `{"n":7}`; `weak` = lo escribe como texto/JSON en el contenido; `none` = ni eso.

Consecuencias en la UI y el core: una conexión `none` solo sirve para **tareas de solo lectura** (consultas) y la
pantalla lo dice; `weak` permite trabajar con aviso ("puede fallar al editar archivos"); el `api-loop` en `weak`
activa un rescate: si el modelo devuelve en texto un JSON con `name`/`arguments` de una herramienta conocida, se
ejecuta como si fuera un tool call (una vez por turno, con log).

### D17. Autodetección y presets de un clic

- **Sondeo local** (`connections.discover`): `GET /v1/models` con 800 ms a `localhost:11434` (Ollama),
  `:1234` (LM Studio), `:8080` (llama.cpp), `:8000` (vLLM). Se ejecuta al abrir "Conexiones" y con el botón
  "Buscar en este equipo". Resultado: tarjetas "Encontrado: LM Studio · 3 modelos · [Conectar]". Un clic crea la
  conexión con `auth: 'none'` y lanza `connection.test`. Si Rust detectó el binario `ollama` pero el puerto no
  responde: "Ollama está instalado pero no en marcha: ejecuta `ollama serve`".
- **Presets de nube** (tabla fija en `core/src/orchestrator/connections.ts`, y espejo en la UI):

| preset | base_url | auth | modelos sugeridos |
|---|---|---|---|
| openai | https://api.openai.com/v1 | bearer | de `/models` |
| groq | https://api.groq.com/openai/v1 | bearer | de `/models` |
| together | https://api.together.xyz/v1 | bearer | de `/models` |
| deepseek | https://api.deepseek.com/v1 | bearer | de `/models` |
| mistral | https://api.mistral.ai/v1 | bearer | de `/models` |
| gemini | https://generativelanguage.googleapis.com/v1beta/openai | bearer | de `/models` |
| openrouter | https://openrouter.ai/api/v1 | bearer | de `/models` (lista larga: con buscador) |
| litellm | http://localhost:4000/v1 | bearer o none | de `/models` |
| custom | lo que escriba | elegible | de `/models` o a mano |

  El preset `openai`/`gemini` de aquí **sustituye** a las claves fijas `openai`/`gemini` del asistente: al migrar,
  si existe la clave en el llavero se crea la conexión automáticamente apuntando a esa cuenta (sin mover el
  secreto). `anthropic` sigue siendo especial (Agent SDK).

### D18. Relevo entre proveedores (cierra el hueco de D10)

`agents.relay_order` sigue siendo `string[]`, pero cada elemento es un alias de Claude (`opus|sonnet|haiku`) **o**
`conn:<uuid>/<modelo>`. `chooseRelayModel` elige el primero no limitado; si el destino es otra conexión no hay
sesión del SDK que reanudar, así que se arranca un run nuevo con el **prompt de traspaso** de D11 (`buildHandover`
ya existe; se reutiliza con `from === to`). Así el límite de toda la cuenta (`five_hour`, `seven_day`) por fin
tiene salida: Opus → (cuenta agotada) → `conn:lmstudio/qwen3-coder` y la tarea sigue en el mismo worktree. El
camino inverso también: una conexión local caída (`ECONNREFUSED`) es `error`, no `limit` (D2), y no releva.

Métricas (D8) para `api-loop`: el campo `usage` de cada respuesta da `prompt_tokens/completion_tokens`; coste =
`prices_json` de la conexión si existe, si no `0` y la UI muestra "—" (local = gratis). `contextWindow` = el de la
conexión. Sin `rate_limit_event`: 429 → `limit: rate` con `Retry-After` si llega.

### Contrato core ⇄ UI (0.2b)

Tipos nuevos en `shared/protocol.ts`:

```ts
export type ConnectionPreset = 'ollama'|'lmstudio'|'llamacpp'|'vllm'|'openai'|'groq'|'together'|'deepseek'|'mistral'|'gemini'|'openrouter'|'litellm'|'custom';
export type ConnectionAuth = 'none'|'bearer'|'x-api-key';
export type ToolQuality = 'unknown'|'ok'|'weak'|'none';
export type ConnectionView = {
  id: string; name: string; preset: ConnectionPreset; baseUrl: string; auth: ConnectionAuth; hasSecret: boolean;
  defaultModel: string | null; contextWindow: number; toolQuality: ToolQuality;
  lastTestAt: number | null; lastTestOk: boolean | null; agents: string[]; // nombres de agentes que la usan
};
export type ConnectionTest = { ok: boolean; detail: string; models?: string[]; toolQuality?: ToolQuality; latencyMs?: number };
export type DiscoveredServer = { preset: ConnectionPreset; baseUrl: string; models: string[]; alreadyConnected: boolean };
```

| Método | Parámetros | Devuelve |
|---|---|---|
| `connection.list` | — | `ConnectionView[]` |
| `connection.create` | `{name, preset, baseUrl?, auth?, defaultModel?, contextWindow?}` (los presets rellenan lo que falte) | `ConnectionView`; emite `secrets.request` |
| `connection.update` | `{id, name?, baseUrl?, auth?, defaultModel?, contextWindow?, prices?}` | `ConnectionView` |
| `connection.delete` | `{id}` | `true`; falla si algún agente la usa (la UI ofrece reasignar) |
| `connection.test` | `{id, model?}` | `ConnectionTest` (actualiza `tool_quality`, `last_test_*`) |
| `connection.models` | `{id}` | `string[]` (cache 60 s) |
| `connections.discover` | — | `DiscoveredServer[]` |
| `secrets.put` | solo por stdin desde Rust | `true` |
| `agent.create` / `agent.update` | añaden `connectionId?: string \| null`, y `model` libre cuando hay conexión | fila |

`ProviderStatus` (panel "IAs en vivo") pasa a tener una tarjeta por conexión además de la de Claude:
`id` deja de ser un enum cerrado (`'claude' | 'conn:<uuid>'`), con `state` = `ok` si el último test fue bien y
hay runs sin error en la última hora; `off` si no responde.

Rust: `secret_set/get/delete` aceptan `conn:<uuid>`; `secret_set` empuja `secrets.put`; nuevo comando
`core_push` **no**: se hace dentro de `secret_set` para que el valor nunca vuelva al webview.

### UI "Conexiones" (tres pantallas, estilo juego)

1. **Lista** (`src/screens/Connections/ConnectionsScreen.tsx`): arriba "En este equipo" con lo descubierto y botón
   Conectar; debajo las conexiones como tarjetas de "enchufes" con un LED (verde/ámbar/gris), nombre, modelo por
   defecto, calidad de herramientas en palabras ("usa herramientas bien" / "a medias" / "solo responde") y los
   robots que la usan. Botón "+ Nueva conexión".
2. **Nueva/editar** (`ConnectionForm.tsx`): paso 1 elegir preset (rejilla de iconos propios, sin logos oficiales);
   paso 2 URL (prellenada), clave (campo `type=password`, se guarda con `secret_set('conn:<id>')` y no se queda
   en el store), botón **Probar** que muestra las tres comprobaciones con ✓/✗ en vivo; paso 3 modelo por defecto
   (desplegable de `connection.models`, con buscador) y ventana de contexto con el aviso de Ollama.
3. **Crear agente** (`src/screens/CreateAgent`): el selector "IA" lista `Claude` + las conexiones; al elegir una,
   el selector de modelo pasa a `connection.models`. Si `tool_quality === 'none'` muestra "este robot solo podrá
   responder consultas".

El asistente de primera vez (paso 2 "claves") se reduce a Anthropic + "Añadir otras IAs después en Conexiones".

### Pasos 0.2b y quién los hace

| # | Paso | Archivos | Agente | Hecho cuando |
|---|---|---|---|---|
| B1 | Migración 3 + repos (`connections`, `agents.connection_id`) y creación automática de conexiones `openai`/`gemini` si hay clave | `core/src/db/db.ts`, `core/src/db/repos.ts`, `core/test/db.test.ts` | programador | tests de repos; BD de 0.2a migra sin perder agentes |
| B2 | Secretos en memoria: `secrets.put`, `secrets.request`, `ctx.secrets`, `redact` ampliado | `core/src/orchestrator/secrets.ts`, `context.ts`, `index.ts`, `providers.ts` | programador → **revisor-critico** | test: `secrets.put` con id sin prefijo `rust:` se rechaza; ningún evento ni respuesta contiene el valor |
| B3 | Rust: cuentas `conn:*`, empuje por stdin, filtro de respuestas `rust:*`, reacción a `secrets.request` | `src-tauri/src/keyring.rs`, `core_process.rs` | programador → **revisor-critico** | `cargo test`; en la app: guardar una clave y `connection.test` pasa sin reiniciar el core; `grep` de la clave en stdout del core: nada |
| B4 | Adaptador `api-loop`: SSE, bucle de tools, 6 herramientas con clasificador, `usage`, `limit` (429/insufficient_quota/RESOURCE_EXHAUSTED), rescate `weak`, `maxTurns` 40, parada | `core/src/adapters/apiLoop.ts`, `core/src/adapters/tools/*.ts`, `core/src/adapters/sse.ts`, `core/src/adapters/limits.ts` (rama `api`), `core/test/adapters/apiLoop.test.ts` | programador → **revisor-critico** | tests con servidor HTTP falso (fixtures grabadas de Ollama y LM Studio); `rm -rf` → `permission_request`; escribir fuera de la lista → deny con mensaje |
| B5 | Handlers `connection.*`, `connections.discover`, presets, prueba en tres pasos; `agent.create/update` con `connectionId` y modelo libre; `adapterFactory` elige `ApiLoopAdapter` cuando hay `connection_id`; `ProviderStatus` por conexión | `core/src/orchestrator/connections.ts`, `agents.ts`, `providers.ts`, `orchestrator/index.ts`, `shared/protocol.ts`, `core/test/orchestrator/connections.test.ts` | programador | tests; `connections.discover` con un servidor falso en :1234 lo encuentra en < 1 s |
| B6 | Relevo entre proveedores: `relay_order` con `conn:<id>/<modelo>`, traspaso con `buildHandover`, validación en `agent.update` | `core/src/orchestrator/relay.ts`, `agents.ts`, `core/test/orchestrator/relay.test.ts` | programador | test: límite `five_hour` con `auto_relay` y una conexión en la lista → run nuevo en el mismo worktree con prompt de traspaso; `relays` registra `to_model = conn:…` |
| B7 | UI Conexiones (3 pantallas), store, selector de IA en Crear agente y en Perfil, tarjetas por conexión en "IAs en vivo", asistente simplificado | `src/screens/Connections/**`, `src/store/connections.ts`, `src/screens/CreateAgent/*`, `src/screens/Agents/AgentProfile.tsx`, `src/components/ProvidersPanel*`, `src/screens/Wizard/StepKeys.tsx` | programador (UI) | con LM Studio real: Buscar → Conectar → Probar (3 ✓) → crear robot → tarea "añade sum() en math.ts" se completa y el diff aparece |
| B8 | Sprite de "enchufe"/LED y paleta `crema` para robots locales ya existe; icono de preset genérico (8 iconos 16×16) | `src/assets/sprites/conexiones.{png,json}` | modelador-2d | cargan con `Assets.load`; ningún logo oficial |
| B9 | Pruebas 0.2b | `core/test/e2e/connections.test.ts`, Playwright | tester | escenarios: (a) Ollama apagado → mensaje claro; (b) clave mala → 401 legible sin la clave; (c) `tool_quality none` → solo consultas; (d) relevo Claude→local por `five_hour` simulado; (e) 2 robots (Claude + local) en módulos vecinos integran sin conflicto |

**Paralelo:** B1 ‖ B3 ‖ B4 ‖ B8 desde el principio (B4 solo depende de `types.ts`, que no cambia). B2 tras B1.
B5 tras B1+B2+B4. B6 tras B5. B7 puede empezar con los tipos de `shared/protocol.ts` fijados en B5 (se escriben
primero). B9 al final. **Estimación:** 8–10 días de agentes; hito **H5**: "LM Studio y Groq trabajan como robots
con permisos, y Claude releva a un modelo local cuando se agota la cuenta".

### Riesgos 0.2b

| Riesgo | Mitigación | Verificación |
|---|---|---|
| Modelos locales pequeños llaman mal a las herramientas (JSON roto, rutas inventadas) | sonda `tool_quality`; rescate `weak`; errores de herramienta devueltos al modelo como `tool` result con instrucción; `maxTurns`; red de seguridad de propiedad al terminar (ya existe) | B4 fixtures de respuestas rotas; B9(c) |
| Contexto de Ollama por defecto demasiado corto: el modelo "olvida" la tarea | `context_window` visible, aviso con el comando; recorte de salidas de herramientas a 4000 chars (igual que Claude); resumen del hilo cuando `prompt_tokens` > 80 % | B4 test de recorte; prueba manual con `OLLAMA_CONTEXT_LENGTH=4096` |
| Una URL de conexión apunta a un host malicioso y recibe el contenido del repo | la URL la escribe el usuario; `redirect: 'error'`; solo `http://` en `localhost`/LAN privada, `https://` para el resto (aviso si no) | B5 test de validación de URL |
| La clave viaja al webview por error | nunca se devuelve en `ConnectionView` (`hasSecret`), `secret_get` sigue enmascarando; respuestas `rust:*` filtradas | B2/B3 revisor-critico; test que busca prefijos de clave en todo lo emitido |
| Groq/Together devuelven `tool_calls` troceados en el stream de forma distinta | acumulación por `index` del delta (estándar OpenAI); fixtures de 3 proveedores | B4 |

---

## Parte 2 — Varios proyectos (entrega 0.2c)

### D19. Varios proyectos abiertos a la vez, con runs simultáneos; una oficina por proyecto en pestañas

**Decisión.** `ctx.activeProject` → `ctx.projects: Map<id, ProjectRow>` (los abiertos). Todo lo que hoy depende
del activo recibe `projectId`. Los runs ya llevan `projectId` en `LiveRun`, los eventos en `events.project_id`,
las tareas cuelgan de `objectives.project_id` y los worktrees viven dentro de cada repo: el core casi está listo;
lo único global es `activeProject`. **Sí** a runs simultáneos en repos distintos (es el caso de uso: "que mi app
avance mientras arreglo la web"), con un **tope global de runs concurrentes** (`max_concurrent_runs`, por defecto
3) y un **tope de gasto diario global** (`daily_budget_usd`, por defecto 10): al llegar al tope, `task.start`
deja la tarea en cola (`assigned` + `queued_at` en memoria, la vista muestra "en cola") y la arranca cuando se
libera un hueco; el relevo y la reanudación al reset pasan por la misma cola.

**Alternativa descartada: cambio rápido de proyecto (uno activo).** Más simple, pero el relevo al reset y el
gerente (parte 3) necesitan actuar en un proyecto que no está en pantalla; y el coste de hacerlo bien ahora es
bajo porque la BD ya está particionada por `project_id`.

**Escena.** Una pestaña por proyecto abierto (como un navegador); cada pestaña monta su `OfficeScene` con sus
robots. Las pestañas de proyectos en segundo plano llevan **insignias**: mano levantada (aprobaciones pendientes),
engranaje (runs vivos), rayo (límite). Descartado: una sola escena con varios pisos: complica el render y la
selección por nada; la metáfora "una oficina por proyecto" se entiende sola. El escenario "casa" (punto 8 de
PROYECTO.md) encaja aquí como `projects.scene` (`'oficina' | 'casa'`).

### D20. Agentes por proyecto + plantillas globales (el "equipo"); nada de workspaces

- Los **agentes siguen siendo del proyecto** (un robot vive en una oficina; sus métricas, chat y worktrees son de
  ese repo).
- **Plantillas de agente** globales (`agent_templates`): nombre, conexión/modelo, rol, color, personalidad,
  skills, orden de relevo. Acciones: "Guardar como plantilla" en el perfil, "Añadir desde plantilla" en la
  oficina y "Equipo inicial" al abrir un proyecto nuevo (elige plantillas). La plantilla se **copia** al crear
  el agente (sin enlace vivo): si cambias la plantilla no cambian los robots ya creados. Es lo que menos sorprende.
- **Workspace (grupo de proyectos): no.** Las pestañas + "Recientes" cubren el caso de un indie con 2–5
  proyectos. Si algún día hace falta, es una tabla `workspaces` y una columna; nada de lo de aquí lo impide.

```sql
-- Migración 4 (user_version 4)
CREATE TABLE agent_templates (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, connection_id TEXT REFERENCES connections(id) ON DELETE SET NULL,
  model TEXT, role TEXT NOT NULL, color TEXT NOT NULL, persona TEXT NOT NULL DEFAULT '', skills TEXT NOT NULL DEFAULT '[]',
  relay_order TEXT, created_at INTEGER NOT NULL
);
ALTER TABLE projects ADD COLUMN scene TEXT NOT NULL DEFAULT 'oficina';
ALTER TABLE projects ADD COLUMN last_opened_at INTEGER;
ALTER TABLE projects ADD COLUMN color TEXT;            -- color de la pestaña
```

### Contrato (0.2c)

- **Todos los métodos de proyecto llevan `projectId`**: `agent.list/create`, `task.list/create`, `objective.create`,
  `events.tail`, `relays.list`, `chat.*`, `agent.metrics`… Durante la transición, si falta `projectId` se usa el
  **último abierto** (`ctx.lastProjectId`) para que la UI de 0.2a siga funcionando mientras se migra pantalla a
  pantalla; al cerrar 0.2c pasa a ser obligatorio.
- **Todos los eventos llevan `projectId`** en el payload (`task.changed`, `agent.status`, `event.appended`,
  `approval.requested`, `review.ready`, `run.metrics`, `relay.happened`, `agent.changed`, `plan.proposed`). El store
  de la UI se particiona por proyecto (`useStore(s => s.projects[id].tasks)`).
- Nuevos: `project.list` (todos los conocidos, con `open: boolean`, `lastOpenedAt`, contadores de pendientes),
  `project.close {projectId}` (falla si hay runs vivos salvo `force`), `project.update` añade `scene`, `color`.
  `template.list/create/delete`, `agent.createFromTemplate {projectId, templateId, name?}`,
  `agent.saveAsTemplate {agentId, name}`. `settings` admite `max_concurrent_runs` y `daily_budget_usd`.
  Evento `queue.changed {projectId, taskId, queued: boolean, position}`.
- `providers.status` agrega los runs y el gasto de **todos** los proyectos abiertos.

### Pasos 0.2c

| # | Paso | Archivos | Agente | Hecho cuando |
|---|---|---|---|---|
| C1 | Migración 4 + repos de plantillas y campos de proyecto | `core/src/db/*`, `core/test/db.test.ts` | programador | tests |
| C2 | `ctx.projects`, `projectId` en handlers y eventos, `requireProject(ctx, projectId)`, `project.list/close`, `rescheduleResumes` por proyecto, `recoverStaleRuns` solo del que se abre | `core/src/orchestrator/{context,projects,agents,tasks,runs,events,relay,metrics,providers,approvals,chat}.ts`, tests | programador → **revisor-critico** (git: dos repos a la vez) | test: dos proyectos abiertos, un run en cada uno, eventos con `projectId` correcto; cerrar uno no toca al otro |
| C3 | Cola global: `max_concurrent_runs`, `daily_budget_usd`, `queue.changed`, integración con relevo/reanudación | `core/src/orchestrator/queue.ts`, `runs.ts`, `relay.ts`, `settings.ts`, tests | programador | test: tope 1 → la segunda tarea queda en cola y arranca al terminar la primera; tope diario → nada arranca y se avisa |
| C4 | Plantillas: handlers `template.*`, `agent.createFromTemplate`, `agent.saveAsTemplate` | `core/src/orchestrator/templates.ts`, `agents.ts`, tests | programador | test: copiar plantilla crea agente con persona/skills/relay; cambiar la plantilla no cambia al agente |
| C5 | UI: pestañas de proyecto con insignias, "Recientes", store particionado, `OfficeScene` por pestaña, campo `scene`, selector de plantillas en Crear agente, pantalla "Equipo" (plantillas) | `src/screens/Projects/**`, `src/store/**`, `src/App.tsx`, `src/screens/Office/*`, `src/screens/CreateAgent/*`, `src/screens/Team/**` | programador (UI) | dos repos abiertos; aprobar en el segundo desde la insignia de su pestaña; ninguna tarea del primero se mezcla |
| C6 | Escenario casa (fondo + posiciones) e insignias de pestaña (3 iconos 12×12) | `src/assets/sprites/casa.{png,json}`, `src/assets/sprites/insignias.{png,json}` | modelador-2d | cargan; `casa.json` tiene tantos escritorios como `oficina.json` |
| C7 | Pruebas 0.2c | `core/test/e2e/multiproject.test.ts`, Playwright | tester | (a) 2 proyectos, 3 runs, tope 2 → cola; (b) reinicio del core con 2 proyectos abiertos → ambos recuperan sus `blocked`; (c) borrar un proyecto no borra plantillas |

**Paralelo:** C1 ‖ C6; C2 tras C1; C3 ‖ C4 tras C2; C5 arranca con los tipos de C2 escritos. **Estimación:**
6–8 días; hito **H6**: "dos repos trabajando a la vez, un equipo de plantillas reutilizable".

### Riesgos 0.2c

| Riesgo | Mitigación | Verificación |
|---|---|---|
| Un handler olvida `projectId` y mezcla datos | `requireProject(ctx, projectId)` lanza si falta cuando ya no hay fallback; test que recorre todos los handlers con dos proyectos y comprueba que cada uno devuelve solo lo suyo | C2, C7(a) |
| Gasto multiplicado por N proyectos | tope global diario + tope de runs; panel "IAs en vivo" muestra gasto de hoy total | C3 |
| Dos proyectos que son el mismo repo (ruta distinta por symlink) | `projects.path` ya es `rev-parse --show-toplevel` realpath; abrir el mismo devuelve la misma fila | C2 test |

---

## Parte 3 — Gerente autónomo (entrega 0.2d) y puente exterior (0.2e)

### Lo que son hoy Hermes y Muse (investigado 23-10-2026)

- **Hermes Agent (Nous Research, v0.2 03-2026):** agente personal open source en Python. Bucle con 60+ herramientas,
  **memoria** curada por el propio agente + búsqueda FTS5 de sesiones pasadas + modelo del usuario (Honcho),
  **skills** que crea y mejora solo (estándar agentskills.io), **cron** con entrega a 20+ canales (Telegram,
  Discord, Slack, WhatsApp, Signal, email…). Cerebro = cualquier endpoint (Nous Portal, OpenRouter, OpenAI,
  "any endpoint"). Integración: CLI, **ACP** (`hermes acp`, JSON-RPC por stdio para IDEs), API HTTP+SSE compatible
  con OpenAI, gateway TUI JSON-RPC, **cliente MCP** y **servidor MCP** (plugin `mcp-serve`). Seguridad: lista de
  comandos peligrosos con modos `smart` (un LLM auxiliar decide), `manual`, `off`; lista negra dura sin
  excepción (ni en `--yolo`); en modo desatendido (cron, webhook) **deniega por defecto**; aprobaciones por chat
  ("sí"/"no") con **timeout 300 s → denegado**; sin presupuesto de tokens.
- **Muse (Meta, 09-2026):** agente personal de consumo, cerrado, en VM propia; y **nanoMuse** (Zhejiang, GPL-3,
  10-2026): "memoria como archivos" editables, pide aprobación antes de acciones irreversibles, multi‑dispositivo.
- **ACP (Agent Client Protocol, Zed, 2025):** JSON-RPC; el agente es subproceso del cliente; el cliente provee
  `session/request_permission`, `fs/*` y `terminal/*`. Pensado para que un **editor** aloje a un agente de código.

Lo que Alexis quiere ("le paso una clave y su cerebro, gestiona todo, me avisa, me pide permiso en lo
delicado") coincide con lo bueno de Hermes: cerebro configurable, memoria, política de aprobación con denegación
por defecto, canales de aviso. Lo que **no** quiere Kiji de Hermes: que un LLM auxiliar decida qué es
peligroso (modo `smart`), y que el agente tenga shell propia fuera del clasificador.

### D21. El Gerente es el jefe con autonomía activada, dentro de Kiji; y Kiji se expone como servidor MCP para agentes externos (opción c, en dos entregas)

**Decisión.**
- **0.2d (a):** el **jefe** de cada proyecto gana un modo **autónomo**. Su cerebro es cualquier agente de Kiji
  (Claude nativo o una conexión de la parte 1), su memoria es persistente por proyecto, actúa con herramientas
  propias de Kiji (`manager tools`) que **llaman a los mismos handlers** que pulsa el usuario (`startTask`,
  `task.assign`, `integration.apply`…), y una **política de autonomía** por categoría decide si hace, avisa o
  pregunta. Nunca toca el clasificador ni responde aprobaciones: `approval.answer` no es una herramienta del
  gerente.
- **0.2e (c):** las mismas `manager tools` se publican como **servidor MCP stdio** (`kiji-mcp`) para que Hermes (o
  Claude Desktop, Cursor…) dirija Kiji desde fuera. Como son los mismos handlers, el agente externo no puede
  saltarse ni la propiedad de archivos ni las aprobaciones: lo máximo que puede hacer es lo que puede hacer el
  gerente. ACP se descarta como vía de integración: está pensado para que un editor aloje a un agente; aquí Kiji
  es el "editor" y lo que necesita es exponer **acciones**, que es exactamente MCP.

**Alternativa descartada: (b) Hermes como robot/proveedor dentro de Kiji.** Exige instalar Python/Hermes (o un
VPS), su bucle ejecuta shell con su propia política (choca con el clasificador), no sabe de worktrees ni de
propiedad, y su "smart approval" decide con otro LLM. Lo que sí vale de Hermes (canales, memoria) lo hacemos en
Kiji con tres tablas y un bot de Telegram.

### D22. Política de autonomía: tres niveles por categoría, con candados fijos

`settings.manager_policy` (JSON, uno por proyecto en `projects.manager_policy` TEXT):

```ts
export type AutonomyLevel = 'auto' | 'notify' | 'ask';
export type ManagerPolicy = {
  enabled: boolean;
  brain: { agentId: string };                 // el jefe (is_boss) u otro agente del proyecto; su conexión/modelo decide el cerebro
  levels: {
    plan: AutonomyLevel;        // objetivo → plan → crear tareas (por defecto 'auto')
    assign: AutonomyLevel;      // elegir robot por rol/plantilla ('auto')
    start: AutonomyLevel;       // arrancar tareas ('auto')
    retry: AutonomyLevel;       // reintentar `failed`/`changes` con hallazgos (máx. 2 por tarea) ('auto')
    relay: AutonomyLevel;       // cambiar de IA a mano cuando un run lleva > N min sin avance ('notify')
    integrate: AutonomyLevel;   // merge a la rama base tras review 'approve' ('ask' por defecto)
    spend: AutonomyLevel;       // seguir cuando el gasto del día del proyecto supere `spendAskUsd` ('ask')
  };
  spendAskUsd: number;          // p. ej. 5
  dayBudgetUsd: number;         // tope duro del gerente + sus robots en el día (p. ej. 15); al llegar: para y avisa
  maxTickMinutes: number;       // un tick del gerente no puede durar más (p. ej. 5)
  maxTicksPerHour: number;      // p. ej. 20
  quietHours?: { from: string; to: string }; // "23:00"–"08:00": solo avisa, no arranca nada
};
```

**Candados (no configurables, siempre `ask` al humano):** todo lo que el clasificador marca `ask` en los robots
(push, borrar fuera del worktree, desplegar, pagar, instalar paquetes, tocar secretos, red con efectos) sigue
llegando como `permission_request` **al usuario**, nunca al gerente; `never` sigue siendo `never`. `integration.revert`,
`project.*`, `connection.*`, `settings.*` y `approval.answer` no existen como herramientas del gerente.
Lo delicado que sí decide el gerente es organizativo (qué tarea, a quién, cuándo), y ahí la política manda.

Modo desatendido fail-closed, como Hermes: una pregunta del gerente (`ask`) sin respuesta en
`ask_timeout_minutes` (por defecto 60) se da por **no** y queda en el diario.

### D23. Bucle por eventos, no por sondeo; un tick = un run de solo lectura con herramientas Kiji

El gerente no tiene un `while(true)`. Se despierta (**tick**) con disparadores: `objective.create`,
`task.changed` a `review|changes|failed|blocked|paused_limit`, fin de run, respuesta a una pregunta suya, un
temporizador cada 15 min si hay objetivos abiertos, y "Habla con el gerente" desde la UI. Reglas: un tick a la
vez por proyecto; mínimo 30 s entre ticks; `maxTicksPerHour`; nada en `quietHours` salvo avisar.

Un tick es un **run** (`RunSpec` con `readOnly: true`, `cwd` = repo) del agente cerebro, con:
- **Claude nativo:** `mcpServers: { kiji: createSdkMcpServer({ name: 'kiji', tools }) }` (verificado en
  `sdk.d.ts` 0.3.308: `createSdkMcpServer` y `tool()` existen; los nombres llegan como `mcp__kiji__<tool>`), y
  `canUseTool` del jefe permite `mcp__kiji__*` además de Read/Glob/Grep.
- **Conexión OpenAI‑compat:** las mismas herramientas como `tools` del `api-loop` (el módulo
  `core/src/manager/tools.ts` define cada herramienta una vez con esquema zod y la convierte a los dos formatos).

Herramientas del gerente (`manager tools`), todas con `projectId` fijado por el core, no por el modelo:
`get_state` (objetivos, tareas, robots, cola, gasto hoy, política), `create_tasks(plan)` (valida como D3),
`assign_task`, `start_task`, `stop_task`, `retry_task(findings)`, `switch_task(model|agentId)`, `get_diff`,
`get_test_output`, `request_integration` (→ `integrate` según política), `remember(kind, text)`,
`recall(query)`, `notify_user(text, level)`, `ask_user(question, options)` (crea una fila en `approvals` con
`tool = 'manager:<accion>'`; reutiliza `ApprovalCard`), `done(summary)`.

El prompt del tick incluye: rol de gerente (`core/src/boss/roles/gerente.md`), la política en palabras, el
estado (`get_state` pre‑inyectado), las 30 memorias más recientes + 10 relevantes por FTS5 (comprobado: `node:sqlite`
22.23 trae FTS5), y lo que disparó el tick. Salida: llamadas a herramientas y un `done(summary)` que se guarda
como memoria `kind: 'decision'`.

### D24. Memoria, diario, avisos y parada

```sql
-- Migración 5 (user_version 5)
ALTER TABLE projects ADD COLUMN manager_policy TEXT;                 -- JSON ManagerPolicy; NULL = gerente apagado
CREATE TABLE memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('fact', 'decision', 'preference', 'todo')),
  text TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'manager',       -- manager | user
  archived INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE VIRTUAL TABLE memory_fts USING fts5(text, content='memory', content_rowid='id');
-- triggers de sincronía insert/update/delete (estándar FTS5 external content)
CREATE TABLE manager_ticks (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  trigger TEXT NOT NULL, run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  summary TEXT NOT NULL DEFAULT '', cost_usd REAL NOT NULL DEFAULT 0, started_at INTEGER NOT NULL, ended_at INTEGER
);
CREATE TABLE manager_actions (                                       -- diario auditable
  id INTEGER PRIMARY KEY AUTOINCREMENT, tick_id TEXT NOT NULL REFERENCES manager_ticks(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL, tool TEXT NOT NULL, input TEXT NOT NULL, result TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('auto', 'notify', 'ask')), decided_by TEXT, -- 'policy' | 'user' | 'timeout'
  created_at INTEGER NOT NULL
);
CREATE TABLE notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, level TEXT NOT NULL CHECK (level IN ('info', 'warn', 'ask')),
  title TEXT NOT NULL, body TEXT NOT NULL, approval_id TEXT, read_at INTEGER, created_at INTEGER NOT NULL
);
```

- **Avisos de escritorio:** el core emite `notify {projectId, level, title, body, approvalId?}`; Rust lo ve en el
  hilo de stdout (como `log_milestones`) y lanza la notificación con `tauri-plugin-notification`; la UI además la
  muestra en una bandeja (campana) y, si es `ask`, abre la `ApprovalCard`. Clic en la notificación trae la ventana
  y la pestaña del proyecto.
- **Parada global:** botón rojo en la barra y en la bandeja del sistema → `manager.stopAll`: `ctx.halted = true`
  (todo `task.start` y todo tick se rechazan), para los runs vivos (`stopAll` existente sin cerrar), cancela
  temporizadores, deniega aprobaciones `manager:*` pendientes, y queda en el diario. "Reanudar" lo quita.
- **Presupuesto/tiempo:** `dayBudgetUsd` cuenta el gerente + los runs que él arrancó (`runs.started_by =
  'manager'`, columna nueva); al superarlo: tick que solo avisa; `maxTickMinutes` aborta el run del tick.

### Condiciones de Anthropic

El gerente corre con la **clave de API** del llavero (como todo en la app distribuida); nada de login de
claude.ai. Un tick es una petición normal de la API con herramientas; no hay "modo YOLO" sobre Claude Code: el
jefe sigue siendo de solo lectura (`tools: Read/Glob/Grep + mcp__kiji__*`), todo cambio lo hacen los robots con
su clasificador.

### Contrato (0.2d)

| Método | Parámetros | Devuelve |
|---|---|---|
| `manager.get` | `{projectId}` | `{policy: ManagerPolicy \| null, halted: boolean, lastTick, todayCostUsd}` |
| `manager.set` | `{projectId, policy}` | igual; valida candados (no admite claves fuera de `levels`) |
| `manager.tick` | `{projectId, message?}` | `tickId` ("Habla con el gerente") |
| `manager.stopAll` / `manager.resume` | — | `{halted}` |
| `manager.diary` | `{projectId, limit?}` | `ManagerAction[]` con tick y resumen |
| `memory.list/add/archive` | `{projectId, …}` | filas |
| `notifications.list/markRead` | `{projectId?, …}` | filas |

Eventos: `manager.tick` (`started|ended`), `manager.action`, `notify`, `manager.halted`. `approval.requested`
gana `kind: 'tool' | 'question' | 'integrate' | 'manager'`.

### UI (0.2d)

1. **Interruptor "Gerente autónomo"** en la oficina de cristal del jefe: al activarlo, asistente de 3 pasos:
   cerebro (lista de agentes/conexiones), nivel general (deslizador **Prudente / Equilibrado / Autónomo** que
   rellena `levels`; "Ajustar" muestra las 7 filas con auto/avisa/pregunta), límites (gasto para preguntar, tope
   del día, horas de silencio). Los candados se muestran como filas bloqueadas con un candado: "esto siempre te lo
   pregunto".
2. **Diario del gerente** (pestaña junto a Registro): cronología de ticks con resumen, acciones (icono por nivel),
   coste; filtro "solo lo que decidió solo".
3. **Memoria**: lista editable (añadir, archivar), buscador.
4. **Campana + botón rojo** en la barra superior; tarjeta `ApprovalCard` variante "pregunta del gerente".

### Pasos 0.2d

| # | Paso | Archivos | Agente | Hecho cuando |
|---|---|---|---|---|
| D1 | Migración 5 + repos (memoria con FTS5 y triggers, ticks, acciones, notificaciones, `runs.started_by`) | `core/src/db/*`, tests | programador | tests; `recall('worktree')` encuentra por FTS5 |
| D2 | `manager/tools.ts`: definición única (zod) → `createSdkMcpServer` y → `tools` OpenAI; cada herramienta llama al handler existente y escribe `manager_actions`; aplicación de `levels` (auto/notify/ask) y candados | `core/src/manager/tools.ts`, `core/src/manager/policy.ts`, `core/test/manager/tools.test.ts` | programador → **revisor-critico** | test de tabla: cada herramienta × nivel → acción, aviso o `approvals` fila; `approval.answer` no está; `projectId` no se puede sobrescribir desde el modelo |
| D3 | `manager/loop.ts`: disparadores, un tick a la vez, 30 s, `maxTicksPerHour`, `quietHours`, `maxTickMinutes`, prompt del tick, `done → memory`, timeout de preguntas (fail-closed) | `core/src/manager/loop.ts`, `core/src/boss/roles/gerente.md`, `runs.ts` (hook de fin de run), tests | programador → **revisor-critico** | test con adaptador falso: `objective.create` → tick → `create_tasks` + `start_task`; `review` → `request_integration` con `integrate: 'ask'` → aprobación al usuario; sin respuesta → denegado y diario |
| D4 | Handlers `manager.*`, `memory.*`, `notifications.*`, `ctx.halted`, parada global, presupuesto del día | `core/src/orchestrator/{manager,memory,notifications}.ts`, `runs.ts`, `shared/protocol.ts`, tests | programador | test: `stopAll` deja todo parado y `task.start` falla con mensaje; `dayBudgetUsd` superado → solo avisa |
| D5 | Rust: notificaciones del sistema desde el evento `notify`, botón rojo en la bandeja | `src-tauri/src/notify.rs`, `lifecycle.rs` (menú), `Cargo.toml` (`tauri-plugin-notification`), `capabilities/default.json` | programador | aparece la notificación del SO; clic → ventana al frente |
| D6 | UI: interruptor + asistente de política, diario, memoria, campana, botón rojo, `ApprovalCard` variante gerente, robot jefe con insignia "autónomo" | `src/screens/Manager/**`, `src/components/{NotificationBell,StopAllButton,ApprovalCard}.tsx`, `src/store/manager.ts`, `src/scenes/*` | programador (UI) | flujo: activar → objetivo → el gerente planifica y arranca solo → pregunta por integrar → aprobar desde la notificación |
| D7 | Sprites: insignia "autónomo" del jefe, animación `supervising` (4f), iconos campana/stop | `src/assets/sprites/robot-terracota-jefe.{png,json}`, `src/assets/sprites/ui.{png,json}` | modelador-2d | cargan; `robotStates` tiene `supervising` |
| D8 | Pruebas 0.2d | `core/test/e2e/manager.test.ts`, Playwright | tester | (a) 3 niveles de política con el mismo guion → acciones distintas; (b) un robot pide `git push` con gerente en Autónomo → sigue llegando al usuario; (c) tope del día → para y avisa; (d) parada global en mitad de 2 runs → ambos `assigned`, diario con la parada; (e) reinicio del core → ticks pendientes no se duplican |

**Paralelo:** D1 ‖ D5 ‖ D7; D2 tras D1; D3 ‖ D4 tras D2; D6 con los tipos de D4. **Estimación:** 10–12 días;
hito **H7**: "le doy un objetivo, me voy, y al volver hay tareas integradas o preguntas esperando, con diario".

### 0.2e — Puente exterior: Telegram y `kiji-mcp` (opcional, 4–5 días)

- **Telegram** (`core/src/notify/telegram.ts`): token del bot en el llavero (`conn:telegram`), `chat_id` en
  settings; el core hace *long polling* de `getUpdates` (sin URL pública). Cada `notify` se envía; los `ask`
  llevan botones inline **Sí / No** cuyo callback responde la `approvals` fila (solo del `chat_id` autorizado,
  igual que el allowlist de Hermes). Las aprobaciones de **candado** (push, borrar…) también se pueden responder
  desde el móvil si Alexis activa "aprobar desde Telegram" (por defecto apagado). Es el equivalente a "notificar
  al móvil" sin construir una app.
- **`kiji-mcp`** (`core/src/mcp/server.ts`, binario `node core/dist/mcp.js --db …`): servidor MCP stdio con
  `@modelcontextprotocol/sdk` que expone las `manager tools` de D2 contra la misma BD y un core en marcha (se
  conecta a él por un socket local `~/.kiji/core.sock`; sin core abierto responde "abre Kiji"). Hermes lo usa con
  `mcp_servers.kiji.command = "node"`, Claude Desktop/Cursor igual. Cada llamada queda en `manager_actions` con
  `decided_by = 'external:<cliente>'`. Hito **H8**: "Hermes en un VPS me manda por Telegram 'arranqué la tarea X
  en Kiji' y me pregunta si integro".

### Riesgos 0.2d/0.2e

| Riesgo | Mitigación | Verificación |
|---|---|---|
| El gerente entra en bucle (tick → tarea falla → retry → tick…) | `retry` máx. 2 por tarea; 30 s entre ticks; `maxTicksPerHour`; `dayBudgetUsd` | D3 test de bucle; D8(c) |
| El modelo del gerente inventa `projectId`/`taskId` de otro proyecto | `projectId` lo fija el core en el cierre de cada herramienta; ids de tarea se validan contra el proyecto del tick | D2 test |
| Cerebro local flojo toma malas decisiones organizativas | la política limita el daño: en Prudente todo es `notify`/`ask`; la UI recomienda Claude/Gemini para el gerente si `tool_quality !== 'ok'` | D6 |
| Un cliente MCP externo (o un bot) aprueba un candado | `kiji-mcp` no expone `approval.answer`; Telegram solo responde aprobaciones si el usuario lo activa y solo desde su `chat_id` | 0.2e revisor-critico |
| Notificación con datos sensibles en pantalla de bloqueo | `body` recortado a 120 chars, sin rutas absolutas ni diffs; nunca contenido de archivos | D5 |
| Cuentas de Anthropic: uso desatendido con clave de API | permitido (API comercial); se registra el coste por tick y se respeta `maxBudgetUsd` por run | D4 |

---

## Fuentes consultadas (23-10-2026)

- Ollama, compatibilidad Anthropic: https://docs.ollama.com/api/anthropic-compatibility ; OpenAI: https://docs.ollama.com/api/openai-compatibility
- LM Studio 0.4.1 `/v1/messages` y Claude Code: https://lmstudio.ai/docs/developer/anthropic-compat , https://lmstudio.ai/docs/integrations/claude-code , https://lmstudio.ai/docs/developer/api-changelog
- llama.cpp `/v1/messages`: https://huggingface.co/blog/ggml-org/anthropic-messages-api-in-llamacpp (PR #17570)
- vLLM Anthropic endpoints: https://www.developersdigest.tech/reference/api-compatibility/vllm
- OpenRouter con Claude Code: https://openrouter.ai/docs/guides/coding-agents/claude-code-integration
- LiteLLM `/v1/messages` passthrough: https://docs.litellm.ai/docs/anthropic_unified/native_passthrough
- DeepSeek Anthropic API: https://api-docs.deepseek.com/guides/anthropic_api ; tabla de endpoints compatibles: https://mcsaguru.com/anthropic-compatible-endpoints-claude-code
- Claude Code y gateways ("no soporta modelos no‑Claude"): https://code.claude.com/docs/en/llm-gateway ; variables: https://code.claude.com/docs/en/llm-gateway-connect
- Agent SDK TS (`createSdkMcpServer`, `tool`, `env`, hooks): https://code.claude.com/docs/en/agent-sdk/typescript y `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` 0.3.308
- Hermes Agent: https://hermes-agent.nousresearch.com/docs , seguridad https://hermes-agent.nousresearch.com/docs/user-guide/security , MCP https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp , integración programática https://hermes-agent.nousresearch.com/docs/developer-guide/programmatic-integration
- Muse (Meta) y nanoMuse: https://www.vellum.ai/blog/official-muse-breakdown , https://alphaxiv.org/abs/2610.08699v1
- Agent Client Protocol: https://agentclientprotocol.com/protocol/overview
- Tauri notificaciones: https://v2.tauri.app/plugin/notification/
