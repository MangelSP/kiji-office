# Plan de la entrega 0.1 — "la oficina trabaja"

Alcance: puntos 1–7 de `PROYECTO.md`. Fuera: casa, MCP, tope de gasto, relevo automático, firma, auto‑update.
Fecha: 2026‑10‑22. Estado verificado en la Mac del usuario: Node 22.23.4, npm 10.9.9, git 2.53, Xcode (CLT),
`claude` 2.1.296, `agy` 1.3.0 (Antigravity CLI), `uv`. **No** hay Rust, Codex, Gemini CLI ni Ollama.

---

## 1. Decisiones

### D1. La orquestación vive en un proceso Node/TS (`core/`), hijo de Rust

**Decisión.** Un programa Node/TypeScript (`kiji-core`) hace todo lo "inteligente": adaptadores de IA, jefe,
tareas, worktrees, propiedad de archivos, aprobaciones y base de datos. Rust (Tauri) hace solo tres cosas: la
ventana, el llavero del sistema y lanzar `kiji-core` como proceso hijo pasándole las claves por variables de
entorno; después es una tubería: cada línea JSON que escribe el core se reenvía al frontend como evento Tauri y
cada petición del frontend se escribe en su stdin. El frontend (React + PixiJS) solo pinta.

**Por qué.**
- Los cuatro caminos oficiales para hablar con las IAs son TypeScript o CLIs: `@anthropic-ai/claude-agent-sdk`
  (único con callback `canUseTool`, el mecanismo que necesitamos para "espera tu clic"), `@openai/codex-sdk`,
  cliente `openai` (sirve para OpenAI, Gemini vía su endpoint compatible y Ollama). Reescribir eso en Rust es
  reimplementar tres protocolos JSONL y el protocolo de control de Claude Code (no documentado, `@alpha`).
- El core se puede ejecutar y probar desde la terminal sin Tauri (`node core/dist/index.js`), lo que adelanta el
  primer hito y hace que `tester` pueda automatizar todo con fixtures.
- El `programador` (Sonnet) rinde mucho más en TS que en Rust, y Rust ni siquiera está instalado.
- Las claves nunca pasan por el webview: Rust las lee del llavero y las inyecta en el entorno del core.

**Alternativa descartada.** Todo en Rust (parsear tres formatos JSONL, sin `canUseTool`, compilaciones lentas,
Rust sin instalar) o todo en el frontend con `plugin-shell` (las claves cruzarían el webview y el ciclo de vida de
la pestaña dominaría procesos de larga duración).

**Nota de empaquetado.** En 0.1 el core corre con el `node` del sistema (requisito: Node ≥ 22.13 por
`node:sqlite`). En 0.3 se compila a un binario (Node SEA o `bun build --compile`) y se declara como sidecar en
`bundle.externalBin` (Tauri lo soporta: https://v2.tauri.app/develop/sidecar/). No cambia nada del diseño. Pendiente para entonces: declarar `core/dist` en `bundle.resources` (hoy un `tauri build`
arranca sin core) y revisar la CSP de producción (`app.security.csp`) con el bundle real.

### D2. Un adaptador por proveedor con una interfaz común de eventos

**Decisión.** Interfaz `AgentAdapter` (sección 4) con eventos `thinking`, `text`, `tool`, `permission_request`,
`done`, `error`, `limit`. Tres adaptadores en 0.1:

| Adaptador | Cubre | Cómo | Aprobaciones |
|---|---|---|---|
| `claude` | Claude (jefe y trabajadores) | `query()` del Agent SDK con `cwd` = worktree, `permissionMode: 'default'`, `canUseTool` | nativas: `canUseTool` espera el clic del usuario |
| `codex` | OpenAI vía Codex CLI (login del usuario) | `@openai/codex-sdk`, `sandboxMode: 'workspace-write'`, `approvalPolicy: 'never'`, `networkAccessEnabled: false` | no existe callback en modo no interactivo; el sandbox impide lo riesgoso y el core revisa el diff después |
| `api-loop` | Ollama, Gemini (API key), OpenAI (API key) | cliente `openai` contra endpoint compatible; bucle de herramientas propio (`read_file`, `write_file`, `edit_file`, `list_dir`, `grep`, `run_command`) | las herramientas son nuestras: cada llamada pasa por el clasificador de riesgo |

**Gemini en 0.1 va por API key, no por CLI.** Verificado: Gemini CLI fue reemplazado por Antigravity CLI (`agy`)
el 18‑06‑2026 para cuentas personales; `agy -p --output-format stream-json` funciona (probado localmente: eventos
`init`, `step_update`, `result`), pero en headless **deniega los comandos de shell** salvo reglas globales en
`~/.gemini/antigravity-cli/settings.json`, y un `control_request` por stdin termina el proceso con código 2: no hay
forma de que el host apruebe una acción. Gemini sí ofrece endpoint compatible con OpenAI con tools y streaming
(beta). El adaptador `antigravity` queda como pieza de 0.2 detrás de la misma interfaz; el asistente de primera
vez sí **detecta** `agy`/`gemini` para avisar.

**Alternativa descartada.** Un solo adaptador "CLI genérico" que parsea stdout: cada CLI cambia su formato y
ninguno comparte el de permisos.

**"Límite alcanzado" ≠ error** (lo que necesita el relevo de 0.2). Cada adaptador emite `limit` solo en estas
señales, el resto es `error`:

| Adaptador | Señal de límite | `kind` |
|---|---|---|
| `claude` | `rate_limit_event.rate_limit_info.status === 'rejected'` | `rate` (+ `resetsAt`) |
| `claude` | `rate_limit_info.errorCode === 'credits_required'` | `credits` |
| `claude` | `system/api_retry` con `error` ∈ {`rate_limit`, `billing_error`} y `attempt === max_retries` | `rate` / `credits` |
| `claude` | `result.subtype === 'error_max_budget_usd'` | `budget` |
| `claude` | `result.is_error` y `errors[]` cumple `/rate limit|usage limit|overloaded/i` | `rate` |
| `codex` | `turn.failed.error.message` o `error.message` cumple `/usage limit|rate limit|429|quota|insufficient_quota/i` | `rate`/`quota` |
| `api-loop` | `RateLimitError` (HTTP 429); Gemini responde `RESOURCE_EXHAUSTED`; OpenAI `code: 'insufficient_quota'` | `rate` / `quota` / `credits` |
| `api-loop` | Ollama `ECONNREFUSED` o 5xx | **error** (no es límite) |

El core convierte `limit` en estado de tarea `paused_limit` y guarda `run.resume_hint` (worktree, rama, archivos,
sesión del proveedor). **Aquí encaja el relevo de 0.2**: un módulo `relay.ts` se suscribe a `paused_limit`, lee
`agents.relay_order` (columna reservada, JSON) y arranca un `run` nuevo con el mismo worktree; nada de 0.1 cambia.

### D3. El jefe planea y revisa con salida estructurada (JSON Schema), no con texto libre

**Decisión.** El jefe es un `run` del adaptador `claude` (modelo `opus` por defecto; `fable` si la cuenta lo
tiene) con herramientas de solo lectura (`Read`, `Glob`, `Grep`) en el repo principal y salida estructurada
(`--json-schema` / `outputFormat` del SDK, campo `structured_output` del `result`). Dos esquemas:

- `Plan`: `{ summary, tasks: [{ id, title, description, files_owned: string[], role, agent_id?, acceptance: string[], depends_on: string[] }] }`
- `Review`: `{ verdict: 'approve' | 'changes', findings: [{ file, line?, problem, fix }], summary }`

El core **valida el plan con código, no con el modelo**: `files_owned` disjuntos entre tareas, roles existentes,
rutas dentro del repo. Si falla, reintenta una vez con el error en el prompt; si vuelve a fallar, se lo muestra al
usuario para editarlo. La revisión recibe `git diff <base>...<rama>` y la salida de los tests, y se ejecuta con el
mismo `session_id` (`resume`) del plan para que el jefe tenga contexto.

**Alternativa descartada.** Jefe como agente interactivo que invoca a los trabajadores como herramientas: no se
puede dibujar ni controlar bien, y factura todo al modelo caro.

### D4. Trabajo seguro: un worktree por tarea, propiedad en tabla, integración por el core a nombre del jefe

- **Worktrees.** `git worktree add -b kiji/<taskId> <repo>/.kiji/worktrees/<taskId> <base>` (base = rama
  principal del proyecto). Uno **por tarea** (un agente hace una tarea a la vez, así que en la práctica es uno por
  agente, y el relevo de 0.2 hereda el worktree sin tocar nada). `.kiji/` va en `.git/info/exclude`.
- **Propiedad de archivos.** Tabla `task_files(task_id, path)`; una ruta no puede pertenecer a dos tareas
  activas (índice único parcial). Se hace cumplir en tres capas: (1) el prompt lista los archivos permitidos;
  (2) `claude`: `canUseTool` deniega `Edit`/`Write`/`NotebookEdit` fuera de la lista y manda a aprobación los
  `Bash` que escriben; `api-loop`: las herramientas comprueban la ruta; (3) **red de seguridad para todos**
  (imprescindible para `codex`, que no se puede interceptar): al terminar el run, `git -C <worktree> diff
  --name-only <base>` ∪ `git status --porcelain`; cualquier archivo fuera de la lista → la tarea pasa a
  `changes` con el hallazgo "tocó archivos ajenos: …" y el core revierte esos archivos (`git checkout -- <f>`).
- **Integración (solo el jefe).** Tras `done`: el core hace `git -C <worktree> add -A && commit`, luego
  `git rebase <base>` (si hay conflicto → `rebase --abort`, tarea `blocked` con aviso al usuario), corre el
  comando de tests del proyecto **en el worktree** (configurable, p. ej. `npm test`), pide la `Review` al jefe,
  y si es `approve` muestra la tarjeta "Integrar". Con el clic: `git merge --ff-only kiji/<id>` en el repo
  principal, `git worktree remove` + `git branch -d`. Se guarda `integrations(before_sha, after_sha)`.
- **Acciones riesgosas** (piden clic). Clasificador único `classify.ts` usado por `claude` (`canUseTool`) y
  `api-loop` (`run_command`); en `codex` el sandbox sin red las hace imposibles y el diff posterior cubre borrados.
  - **Siempre preguntar:** `git push`, `git reset --hard`, `git clean`, `git checkout -- .`, `rm -r*`,
    borrar un archivo no poseído, `npm publish`, `docker push`, CLIs de despliegue (`vercel`, `fly`, `gcloud`,
    `aws`, `kubectl`, `heroku`, `netlify`), `curl`/`wget` con `-X POST|PUT|DELETE` o `-d`, instalar paquetes
    (`npm i`, `pip install`, `brew`, `cargo add`), `sudo`, escribir fuera del worktree, tocar `.env*`,
    `*.pem`, `*.key`, `.git/`.
  - **Nunca (deny fijo):** `git push --force*`, `rm -rf /`/`~`, leer o escribir ficheros de credenciales del
    sistema. En `claude` además `disallowedTools: ['Bash(git push --force*)', 'Edit(//**/.env*)']`.
- **Deshacer.** Tarea no integrada: `git worktree remove --force` + `git branch -D` (nada toca `main`).
  Integración: botón "Deshacer" → `git revert --no-edit <before_sha>..<after_sha>`. Siempre con git, sin copias.

**Alternativa descartada.** Un worktree por agente reutilizado entre tareas: mezcla cambios de tareas distintas
y rompe el "una tarea, una rama, un deshacer".

### D5. Persistencia: SQLite con `node:sqlite` dentro del core

**Decisión.** El core es el único dueño de los datos (`node:sqlite`, incluido en Node ≥ 22.13 sin flag, modo
WAL; fichero en el `app_data_dir` que Rust le pasa como argumento). El frontend no ejecuta SQL: pide
`tasks.list`, `events.tail`, etc. por el protocolo.

**Alternativa descartada.** `tauri-plugin-sql` desde el frontend: el core, que genera todos los eventos, tendría
que pedir a Rust cada escritura, y habría dos dueños de los mismos datos.

### D6. Escena: `pixi.js` directo dentro de un componente React, máquina de estados tabular

**Decisión.** `pixi.js` 8.22 creado en `OfficeScene.tsx` (`useEffect` → `new Application()`, `await app.init()`,
`app.destroy()` al desmontar). Sin `@pixi/react`. Cada robot es una clase `RobotSprite` (un `AnimatedSprite`
desde el spritesheet + etiqueta + icono de estado). El estado del agente (`idle | thinking | writing | needs_you |
error | done`) lo decide el core (lo emite como evento `agent.status`), el store lo guarda y la escena solo hace
`robot.setState(s)`, que consulta una tabla `estado → {animación, loop, volverA}`. Pixel perfecto: texturas con
`scaleMode: 'nearest'`, `roundPixels: true`, escala entera ×3 (32×40 → 96×120).

**Alternativa descartada.** `@pixi/react` 8.0.5: exige React 19 y añade un reconciliador para seis sprites; y el
patrón State con una clase por estado: la lógica cabe en una tabla.

### D7. Carpetas del repo

```
kiji-office/
├─ package.json            # workspaces: ["core"]; scripts: dev, tauri, test, build:core
├─ vite.config.ts, tsconfig.json, index.html
├─ shared/protocol.ts      # tipos del protocolo UI↔core (lo importan src/ y core/)
├─ src/                    # frontend React + TS + PixiJS
│  ├─ main.tsx, App.tsx
│  ├─ core/client.ts       # invoke('core_send') + listen('core:line'); req/res por id
│  ├─ store/               # zustand: agents, tasks, events, approvals
│  ├─ scenes/              # OfficeScene.tsx, RobotSprite.ts, robotStates.ts, officeLayout.ts
│  ├─ screens/             # Wizard/, Office/, CreateAgent/, RobotDetail/
│  ├─ components/          # TaskBoard, TaskCard, LogPanel, ApprovalCard, Chat, PlanCard
│  └─ assets/sprites/      # robot-*.png/json, oficina.png/json (los hace modelador-2d)
├─ core/                   # proceso Node/TS (kiji-core)
│  ├─ package.json, tsconfig.json
│  ├─ src/index.ts         # servidor NDJSON por stdio
│  ├─ src/db/              # schema.sql, db.ts, repos.ts
│  ├─ src/adapters/        # types.ts, claude.ts, codex.ts, apiLoop.ts, tools/, classify.ts
│  ├─ src/boss/            # plan.ts, review.ts, schemas.ts, roles/*.md, prompts.ts
│  ├─ src/git/             # worktree.ts, integrate.ts
│  ├─ src/orchestrator/    # tasks.ts, runs.ts, approvals.ts, chat.ts, status.ts
│  └─ test/                # vitest; fixtures de eventos grabados por proveedor
├─ src-tauri/
│  ├─ src/lib.rs, main.rs, keyring.rs, core_process.rs, detect.rs
│  ├─ capabilities/default.json, tauri.conf.json, Cargo.toml
├─ PROYECTO.md, CLAUDE.md, PLAN-0.1.md
```

**Patrones usados (y por qué, con el problema concreto).** *Adapter*: tres proveedores con tres formatos de
eventos distintos detrás de `AgentAdapter` (sección 4). *Observer*: el core emite eventos y UI/escena se
suscriben; es lo que ya hacen `listen` de Tauri y el store. Nada más: el resto es código directo.

---

## 2. Arquitectura

```
┌────────────────────────── Tauri (ventana) ──────────────────────────┐
│  Frontend React + TS                                                 │
│  ┌──────────┐ ┌────────────┐ ┌─────────┐ ┌──────────┐ ┌──────────┐  │
│  │ Wizard   │ │ Oficina    │ │ Pizarra │ │ Registro │ │ Detalle  │  │
│  │ (claves) │ │ PixiJS     │ │ (DnD)   │ │          │ │ robot    │  │
│  └────┬─────┘ └─────┬──────┘ └────┬────┘ └────┬─────┘ └────┬─────┘  │
│       └─────────────┴─── store (zustand) ──────┴────────────┘        │
│                              │ src/core/client.ts                    │
│              invoke('core_send', line)  /  listen('core:line')       │
├──────────────────────────────┼───────────────────────────────────────┤
│  Rust (src-tauri)            │                                       │
│  keyring.rs  ─ llavero del SO (crate keyring 4)                      │
│  detect.rs   ─ which claude/codex/agy/gemini/ollama + versiones      │
│  core_process.rs ─ spawn `node core/dist/index.js --db <ruta>`       │
│                    env: ANTHROPIC_API_KEY?, OPENAI_API_KEY?, …       │
│                    stdin ← líneas; stdout → app.emit("core:line")    │
└──────────────────────────────┼───────────────────────────────────────┘
                               │ NDJSON por stdio
┌────────────────────────── kiji-core (Node/TS) ──────────────────────┐
│ index.ts: router req/res + bus de eventos                            │
│ orchestrator/: tareas (máquina de estados), runs, aprobaciones, chat │
│ boss/: plan.ts, review.ts (claude + JSON Schema)                     │
│ git/: worktree.ts, integrate.ts                                      │
│ adapters/: claude.ts | codex.ts | apiLoop.ts  ← classify.ts          │
│ db/: node:sqlite (WAL)                                               │
└───────┬──────────────────┬──────────────────────┬────────────────────┘
        │ Agent SDK        │ Codex SDK → codex    │ HTTP OpenAI‑compat
   claude (binario)     (CLI del usuario)      Ollama / Gemini / OpenAI
        └──────────── cada trabajador opera en <repo>/.kiji/worktrees/<taskId> ────┘
```

**Flujo de un objetivo de punta a punta**

1. Usuario escribe el objetivo en la pizarra → `objective.create`.
2. Core lanza el jefe (`claude`, solo lectura, `cwd` = repo) con el esquema `Plan` → evento `plan.proposed`.
3. Core valida el plan (archivos disjuntos, roles) → tarjeta "Plan" en la UI; el usuario acepta o edita.
4. Se crean `tasks` (estado `todo`) y `task_files`. El jefe propone `agent_id` por rol; el usuario puede
   arrastrar una tarjeta a otro robot (`task.assign`).
5. `task.start`: `worktree.ts` crea rama y worktree; `runs` nuevo; el adaptador del agente arranca con el
   prompt de rol + tarea + lista de archivos. Eventos `thinking/text/tool` → `events` + `agent.status`
   (el robot cambia de animación).
6. Si el agente pide algo riesgoso → `permission_request` → fila en `approvals` → robot "te necesita" +
   tarjeta de aprobación. El clic resuelve la promesa del `canUseTool` (o la herramienta de `api-loop`).
7. `done` → red de seguridad de propiedad → `commit` → `rebase` → tests en el worktree → `Review` del jefe.
8. `approve` → tarjeta "Integrar"; clic → `merge --ff-only` → `integrated` (botón "Deshacer" = `revert`).
   `changes` → la tarea vuelve al agente con los hallazgos (nuevo run en el mismo worktree).
9. `limit` en cualquier punto → `paused_limit` + aviso; en 0.2 lo toma el relevo.

---

## 3. Modelo de datos (SQLite, `core/src/db/schema.sql`)

| Tabla | Campos clave |
|---|---|
| `projects` | `id`, `path` (único), `name`, `base_branch` (p. ej. `main`), `test_command`, `created_at` |
| `agents` | `id`, `project_id`, `name`, `provider` (`claude`\|`codex`\|`api`), `api_base` (para `api`: Ollama/Gemini/OpenAI), `model`, `role` (nombre del agente del kit), `color`, `is_boss` (0/1), `relay_order` TEXT NULL (reservado 0.2), `created_at` |
| `objectives` | `id`, `project_id`, `text`, `status` (`planning`\|`active`\|`done`), `boss_session_id`, `created_at` |
| `tasks` | `id`, `objective_id`, `title`, `description`, `agent_id` NULL, `status` (`todo`\|`assigned`\|`running`\|`needs_you`\|`review`\|`changes`\|`approved`\|`integrated`\|`blocked`\|`failed`\|`paused_limit`), `branch`, `worktree_path`, `acceptance` (JSON), `depends_on` (JSON), `order`, `updated_at` |
| `task_files` | `task_id`, `path`; índice único `(project_id, path)` sobre tareas no terminadas |
| `runs` | `id`, `task_id`, `agent_id`, `provider_session_id` (para `resume`/`resumeThread`), `status`, `cost_usd`, `input_tokens`, `output_tokens`, `resume_hint` (JSON), `started_at`, `ended_at` |
| `messages` | `id`, `run_id`, `agent_id`, `role` (`user`\|`agent`\|`boss`\|`system`), `text`, `created_at` — chat por robot |
| `events` | `id`, `project_id`, `task_id` NULL, `agent_id` NULL, `run_id` NULL, `kind` (`thinking`\|`text`\|`tool`\|`permission`\|`status`\|`limit`\|`error`\|`git`\|`test`), `payload` (JSON), `created_at` — registro general y por robot |
| `approvals` | `id`, `run_id`, `task_id`, `tool`, `input` (JSON), `risk` (`ask`\|`never`), `status` (`pending`\|`approved`\|`denied`), `decided_at` |
| `test_runs` | `id`, `task_id`, `command`, `exit_code`, `output` (recortada a 64 KB), `created_at` |
| `integrations` | `id`, `task_id`, `before_sha`, `after_sha`, `reverted_at` NULL |
| `settings` | `key`, `value` — p. ej. `default_budget_usd` = `2` |

Las claves de API **no** están en ninguna tabla: viven en el llavero (`service = "kiji-office"`, `user =
"anthropic" | "openai" | "gemini"`).

---

## 4. Interfaz del adaptador (`core/src/adapters/types.ts`)

```ts
export type RunSpec = {
  runId: string; cwd: string;                 // cwd = worktree (o repo para el jefe)
  model: string; systemPrompt: string; prompt: string;
  allowedPaths: string[];                     // propiedad de archivos
  readOnly?: boolean;                         // jefe
  outputSchema?: object;                      // Plan / Review
  resumeSessionId?: string; budgetUsd: number;
};

export type AgentEvent =
  | { type: 'thinking' }
  | { type: 'text'; delta: string }
  | { type: 'tool'; name: string; input: unknown; status: 'start' | 'end'; output?: string }
  | { type: 'permission_request'; id: string; tool: string; input: unknown; risk: 'ask' }
  | { type: 'done'; text: string; structured?: unknown; sessionId?: string;
      costUsd?: number; usage?: { input: number; output: number } }
  | { type: 'error'; message: string; retryable: boolean }
  | { type: 'limit'; kind: 'rate' | 'quota' | 'credits' | 'budget'; resetsAt?: number; message: string };

export interface AgentAdapter {
  readonly provider: 'claude' | 'codex' | 'api';
  start(spec: RunSpec): AsyncIterable<AgentEvent>;
  send(text: string): Promise<void>;                       // chat durante el run
  answerPermission(id: string, allow: boolean, reason?: string): void;
  stop(): Promise<void>;
}
```

`classify.ts` exporta `classifyCommand(cmd): 'ok' | 'ask' | 'never'` y `isPathAllowed(path, allowed, cwd)`;
`limits.ts` exporta `toLimit(provider, rawError): AgentEvent | null`. Ambos tienen tests de tabla.

**Protocolo UI↔core** (`shared/protocol.ts`): `{ id, type: 'req', method, params }` →
`{ id, type: 'res', result | error }`; eventos `{ type: 'event', name, payload }`. Métodos de 0.1:
`project.open/get`, `providers.detect`, `providers.test`, `agent.create/list/update`, `objective.create`,
`plan.accept`, `task.list/assign/start/stop/undo`, `approval.answer`, `integration.apply/revert`,
`chat.send/history`, `events.tail`. Eventos: `plan.proposed`, `task.changed`, `agent.status`, `event.appended`,
`approval.requested`, `review.ready`.

---

## 5. Pasos

Convenciones: **Agente** = quien lo ejecuta. **Hecho** = criterio verificable. **Dep.** = pasos previos.
`revisor-critico` es obligatorio donde se marca (claves, git, ejecución de comandos de agentes).
Grupos en paralelo: pasos con la misma letra **(P‑x)** no tocan los mismos archivos y pueden correr a la vez.

| # | Paso | Archivos | Agente | Hecho cuando | Dep. |
|---|---|---|---|---|---|
| 0 | **Entorno.** Instalar Rust (`curl … sh.rustup.rs \| sh`, requiere el OK del usuario), `rustc --print host-tuple` = `aarch64-apple-darwin`. `npm create tauri-app@latest` (React + TypeScript, npm) en un directorio temporal y copiar su contenido al repo sin pisar `PROYECTO.md`/`CLAUDE.md`/`.mcp.json`. Añadir workspace `core/` (tsconfig `NodeNext`, `vitest`), `shared/`, scripts `build:core`, `test`. `.gitignore`: `core/dist/`, `.kiji/`. | raíz, `src-tauri/`, `core/package.json`, `shared/` | programador | `npm run tauri dev` abre una ventana; `npm test` (vitest vacío) y `cargo build` pasan | — |
| 1 | **Protocolo + servidor stdio del core.** Tipos en `shared/protocol.ts`; `core/src/index.ts` lee NDJSON de stdin, enruta `method` a handlers, responde y emite eventos; `ping` y `events.tail` de prueba. Test que lanza el core como proceso hijo y hace `ping`. **(P‑a)** | `shared/protocol.ts`, `core/src/index.ts`, `core/src/bus.ts`, `core/test/protocol.test.ts` | programador | `echo '{"id":"1","type":"req","method":"ping"}' \| node core/dist/index.js` responde `pong`; test verde | 0 |
| 2 | **Rust: llavero, detección y proceso del core.** `keyring.rs` (crate `keyring` 4 sin features: la `v1` por defecto ya elige Keychain / Credential Manager / Secret Service; `secret_get` solo devuelve `…` + últimos 4 caracteres, el valor completo nunca llega al webview): comandos `secret_set/get/delete` (`service="kiji-office"`). `detect.rs`: `which` de `claude`, `codex`, `agy`, `gemini`, `ollama`, `node` + `--version`. `core_process.rs`: spawn `node <core/dist/index.js> --db <app_data_dir>/kiji.db` con las claves del llavero en `env`, relé stdin/stdout (`app.emit("core:line")`), reinicio si muere (máx. 3). Capabilities mínimas (`core:default`, `event:default`). Las claves nunca se loguean. **(P‑a)** | `src-tauri/src/*.rs`, `src-tauri/Cargo.toml`, `src-tauri/capabilities/default.json` | programador → **revisor-critico** | Desde la consola del webview: `invoke('secret_set',…)` y `secret_get` devuelven lo guardado (visible en Acceso a Llaveros); `invoke('core_send', ping)` recibe `pong` por `core:line`; `grep -r "ANTHROPIC" src-tauri/src` no aparece en ningún `println!`/log | 0 |
| 3 | **Base de datos.** `schema.sql` (sección 3), `db.ts` (`node:sqlite`, WAL, migraciones por `user_version`), `repos.ts` (CRUD mínimo). Tests con `:memory:`. **(P‑a)** | `core/src/db/*`, `core/test/db.test.ts` | programador | Tests de inserción/consulta por tabla; el índice único de `task_files` rechaza la segunda tarea sobre la misma ruta | 0 |
| 4 | **Adaptador `claude` + clasificador + límites.** `types.ts`, `classify.ts`, `limits.ts`, `claude.ts` con el Agent SDK: `query()` con `cwd`, `permissionMode: 'default'`, `settingSources: []`, `allowedTools` básicos, `disallowedTools` de la lista "nunca", `maxBudgetUsd`, `includePartialMessages`; `canUseTool` → `isPathAllowed` / `classifyCommand` → `permission_request` y promesa pendiente; `AskUserQuestion` también se muestra como aprobación con opciones; mapeo de `result`, `rate_limit_event`, `api_retry` según D2. Tests con fixtures de mensajes SDK grabados (sin red) + un test manual real de una línea. **(P‑b)** | `core/src/adapters/{types,classify,limits,claude}.ts`, `core/test/adapters/*` | programador → **revisor-critico** | Tests de tabla de `classify` (≥ 25 casos) y `limits` (todas las filas de D2); con fixtures, un run produce la secuencia `thinking→tool→permission_request→done`; prueba real: `node core/dist/index.js` + `run.start` sobre un repo temporal hace que Claude cree un archivo permitido y pida permiso para `rm` | 1, 3 |
| 5 | **Git: worktrees e integración.** `worktree.ts` (`add -b`, `remove`, `prune` al abrir proyecto, `list --porcelain`, `changedFiles(base)`), `integrate.ts` (`commitAll`, `rebase` con abort, `runTests(test_command)` con límite de tiempo, `mergeFfOnly`, `revertRange`). Todo con `child_process.execFile` (sin shell). Tests sobre un repo temporal creado en el test. **(P‑b)** | `core/src/git/*`, `core/test/git/*` | programador → tester → **revisor-critico** | Tests: crear/retirar worktree, rebase con y sin conflicto, ff‑merge, revert deja `main` como antes; nunca se ejecuta con `shell: true` | 1 |
| 6 | **Orquestador.** Máquina de estados de tareas (D4), `runs.ts` (arranca el adaptador según `agents.provider`, persiste eventos, calcula `agent.status`), `approvals.ts` (crea fila, resuelve promesa al `approval.answer`), red de seguridad de propiedad tras `done`, `status.ts`. Handlers de `project.open`, `agent.*`, `task.*`, `approval.answer`, `events.tail`. | `core/src/orchestrator/*`, `core/src/index.ts` (registro de handlers) | programador | Test de integración con un adaptador falso: `task.start` → eventos → `permission_request` → `approval.answer` → `done` → `review` (sin jefe aún: pasa a `review` y se queda); el estado del robot pasa por `thinking/writing/needs_you/done` | 1, 3, 4, 5 |
| 7 | **UI mínima (v0, sin pixel art).** `client.ts` (correlación `id`, reconexión), store, pantalla única con: botón "Abrir proyecto" (`@tauri-apps/plugin-dialog`), lista de agentes en texto, formulario "crear tarea" (título, archivos, agente), lista de tareas por estado, registro en vivo, tarjeta de aprobación (Permitir/Denegar), botón "Ver diff" (`git diff` del worktree por `task.diff`). **(P‑b)** | `src/core/client.ts`, `src/store/*`, `src/screens/Office/OfficeV0.tsx`, `src/components/{LogPanel,ApprovalCard,TaskList}.tsx` | programador | Con el core corriendo, se ve el ping, se crea un agente Claude, se crea y arranca una tarea y los eventos aparecen en el registro | 1 (tipos); para probar de verdad, 2 y 6 |
| **H1** | **Hito 1** — ver sección 6 | | tester | | 2, 6, 7 |
| 8 | **Sprites y escena pixel art.** Spritesheet por robot: 32×40, 6 animaciones (`idle` 4f, `thinking` 4f, `writing` 6f, `needs_you` 2f (mano levantada), `error` 2f, `done` 4f) en formato TexturePacker (`frames`/`animations`/`meta`), 4 paletas (terracota, azul, verde, crema: Claude/Gemini/OpenAI/Ollama, sin logos), generadas por `tools/sprites/gen.py`. Fondo `oficina.png` (320×180 lógicos dibujados ×3, tiles 16 px) + `oficina-frente.png`: 6 escritorios + oficina de cristal del jefe + pizarra; `oficina.json` con posiciones de escritorios y zona del jefe. **(P‑c)** | `src/assets/sprites/robot-{terracota,azul,verde,violeta}.{png,json}`, `src/assets/sprites/oficina.{png,json}`, `src/assets/sprites/README.md` | modelador-2d | Los JSON cargan con `Assets.load` sin error (test de smoke en vitest con `Spritesheet.parse` sobre datos); cada animación tiene los frames declarados; ningún PNG supera 256 KB | 0 |
| 9 | **Escena PixiJS.** `OfficeScene.tsx` (init/destroy seguro con StrictMode), `RobotSprite.ts`, `robotStates.ts` (tabla estado→animación, `done` vuelve a `idle` a los 4 s), `officeLayout.ts` (asigna escritorio por orden de creación), `scene.robotAt(clientX, clientY)` para el arrastre, `scaleMode: 'nearest'`, `roundPixels`. Hasta que llegue 8, usa rectángulos de color como placeholder. **(P‑c)** | `src/scenes/*` | programador | Con tres agentes creados se ven tres robots en sus escritorios; forzando `agent.status` desde la consola cambian de animación sin parpadeo; `robotAt` devuelve el agente correcto bajo el cursor | 7; (8 para el arte) |
| 10 | **Asistente de primera vez.** Pantalla por pasos: (1) proveedores detectados (`providers.detect` ← `detect_clis` de Rust) con versión y estado; (2) claves opcionales (Anthropic, OpenAI, Gemini) → `secret_set`; URL de Ollama; (3) `providers.test` por proveedor (una llamada mínima: SDK `query` de una frase, `GET /v1/models`); (4) elegir carpeta del proyecto, rama base y comando de tests. Se muestra si no hay proyecto; reabrible desde ajustes. **(P‑d)** | `src/screens/Wizard/*`, `core/src/orchestrator/providers.ts` | programador → **revisor-critico** | Tras el asistente, `secret_get` devuelve las claves, el core las recibe por `env` al reiniciarse, y `providers.test` marca verde lo configurado; el campo de clave es `type=password` y no se persiste en el store | 2, 7 |
| 11 | **Crear agente.** Pantalla: IA (según lo detectado/configurado), modelo (lista: `claude` → alias `sonnet/opus/haiku`; `api` → `GET /v1/models`; `codex` → lista fija), rol (lee `core/src/boss/roles/*.md`), nombre, color/paleta. El jefe se crea solo (Claude, rol `jefe`, `is_boss=1`) al abrir proyecto. **(P‑d)** | `src/screens/CreateAgent/*`, `core/src/orchestrator/agents.ts` | programador | Crear un agente lo hace aparecer en la oficina con su paleta; no se puede crear un segundo jefe | 9, 10 |
| 12a | **Roles del kit.** Copiar los prompts de `skills-claude-miguel/agents/{programador,tester,explorador,modelador-2d,documentador,revisor-critico}.md` a `core/src/boss/roles/` (sin el frontmatter) y escribir `jefe.md` (reglas: plan con archivos disjuntos, criterios verificables, revisar con el diff y los tests). **(P‑e)** | `core/src/boss/roles/*.md` | explorador | Existen los 7 ficheros; `jefe.md` nombra los campos del esquema `Plan` | 0 |
| 12 | **Jefe: plan y revisión.** `schemas.ts` (`Plan`, `Review`), `prompts.ts`, `plan.ts` (run `claude` solo lectura con `outputSchema`, validación por código, 1 reintento), `review.ts` (resume `boss_session_id`, recibe diff + salida de tests). Integra con el orquestador: `objective.create` → `plan.proposed`; `plan.accept` crea tareas; tras `done` → tests → review → `review.ready`. **(P‑e)** | `core/src/boss/*`, `core/src/orchestrator/{objectives,review}.ts` | programador → tester | Test con fixture de `structured_output`: un plan con dos tareas que comparten un archivo se rechaza y se reintenta; con el fixture bueno se crean tareas y `task_files`; test real: objetivo "añade README con instrucciones" en un repo temporal produce un plan válido | 4, 6, 12a |
| 13 | **Pizarra de tareas.** Columnas por estado, tarjeta con agente/archivos/estado, campo de objetivo, `PlanCard` (aceptar/editar título‑archivos‑agente), arrastrar tarjeta sobre un robot (HTML5 DnD sobre el canvas + `scene.robotAt`) → `task.assign`, botón ▶ → `task.start`. **(P‑e)** | `src/components/{TaskBoard,TaskCard,PlanCard}.tsx`, `src/screens/Office/Office.tsx` | programador | Arrastrar una tarjeta a un robot cambia `agent_id` en la BD y la tarjeta muestra su color; soltar fuera no cambia nada | 9 |
| 14 | **Aprobaciones e integración en la UI.** `ApprovalCard` con tres variantes: acción riesgosa (comando/archivo, Permitir/Denegar), pregunta del agente (opciones), integrar (resumen de la review, "Integrar"/"Pedir cambios"), y botón "Deshacer" en tareas integradas. Robot en `needs_you` mientras haya una pendiente. | `src/components/ApprovalCard.tsx`, `src/store/approvals.ts` | programador | Flujo completo en la UI: tarea → permiso → review → integrar → `git log` del repo muestra el commit → deshacer → `git log` muestra el revert | 12, 13 |
| **H3** | **Hito 3** — ver sección 6 | | tester | | 14 |
| 15 | **Adaptador `codex`.** `@openai/codex-sdk`: `startThread({ workingDirectory, sandboxMode: 'workspace-write', approvalPolicy: 'never', networkAccessEnabled: false, skipGitRepoCheck: false, model })`, `runStreamed` → mapeo `item.*`/`turn.*` a `AgentEvent`; `resumeThread` para chat; límites según D2. Si `codex` no está instalado, `providers.detect` lo marca y el agente no se puede crear. **(P‑f)** | `core/src/adapters/codex.ts`, `core/test/adapters/codex.test.ts` | programador → **revisor-critico** | Tests con fixtures JSONL de Codex; prueba real (cuando el usuario instale `codex`): una tarea que intenta `git push` no lo consigue y la red de seguridad de propiedad detecta un archivo ajeno | 6 |
| 16 | **Adaptador `api-loop` + herramientas.** Cliente `openai` con `baseURL` (Ollama `http://localhost:11434/v1`, Gemini `https://generativelanguage.googleapis.com/v1beta/openai/`, OpenAI); bucle: `chat.completions` con `tools` y `stream`, ejecuta `read_file/write_file/edit_file/list_dir/grep/run_command` (todas pasan por `isPathAllowed`/`classifyCommand`; `run_command` con `execFile`, cwd = worktree, timeout), máx. N turnos, presupuesto por tokens. **(P‑f)** | `core/src/adapters/apiLoop.ts`, `core/src/adapters/tools/*`, `core/test/adapters/apiLoop.test.ts` | programador → **revisor-critico** | Tests con un servidor HTTP falso que devuelve tool calls; prueba real con Ollama (`ollama pull llama3.2`): crea un archivo permitido, intenta `rm -rf` y aparece la aprobación | 6 |
| 17 | **Detalle del robot.** Pantalla: chat (`chat.send` → `adapter.send` si hay run activo, si no, `resume` del último), archivos bloqueados (`task_files` de la tarea activa), último `test_runs` (salida), gasto acumulado (`runs.cost_usd`), estado. **(P‑f)** | `src/screens/RobotDetail/*`, `core/src/orchestrator/chat.ts` | programador | Escribir en el chat durante un run llega al agente y su respuesta aparece como `message`; la lista de archivos coincide con la BD | 9, 6 |
| 18 | **Registro general y por robot.** `LogPanel` con filtros (agente, tipo), `events.tail` paginado, exportar a texto. **(P‑f)** | `src/components/LogPanel.tsx`, `core/src/orchestrator/events.ts` | programador | Con dos agentes activos, filtrar por robot muestra solo sus eventos; ninguna línea contiene una clave (test: buscar `sk-`/`AIza` en `events.payload`) | 7 |
| 19 | **Pruebas de 0.1.** (a) e2e con dos agentes (Claude + Ollama o Claude + adaptador falso) en módulos vecinos del mismo repo, integración de ambas sin conflicto; (b) intento de tocar un archivo ajeno → `changes`; (c) acción riesgosa aprobada y denegada; (d) deshacer una integración; (e) adaptador falso que emite `limit` → `paused_limit` y aviso en la UI; (f) reinicio del core con una tarea `running` → la tarea queda `blocked` con aviso, el worktree sigue. | `core/test/e2e/*`, `src/**/*.test.tsx`, `tests/playwright/*` (MCP `navegador`) | tester | Los seis escenarios pasan en `npm test` (los que necesitan IA real se marcan `manual` y se documentan) | 15–18 |
| 20 | **Documentación y revisión final.** `README.md` de desarrollo (requisitos, `npm run tauri dev`, estructura, cómo añadir un adaptador), actualizar la sección Stack/Flujo de `CLAUDE.md` si cambió algo. Revisión final de claves, git y ejecución de comandos. | `README.md`, `CLAUDE.md` | documentador → **revisor-critico** | Un desarrollador nuevo levanta el proyecto siguiendo el README; veredicto APROBADO del revisor | 19 |
| **H4** | **Hito 4 = 0.1 completa** | | | | 20 |

**Paralelismo (resumen).** Tras el 0: **1‖2‖3** y **8** (arte) desde el principio. Luego **4‖5‖7** (7 solo con
tipos). 6 cierra la primera cadena. Después **9‖10‖12a**, **11‖12**, **13**, 14. Finalmente **15‖16‖17‖18**, 19, 20.

---

## 6. Hitos (qué se puede demostrar)

| Hito | Después de | Demostración |
|---|---|---|
| **H0 — arranca** | paso 0 | `npm run tauri dev` abre la ventana vacía; `cargo build` y `npm test` pasan |
| **H1 — un robot Claude trabaja de verdad** | pasos 2, 6, 7 (UI v0, sin pixel art) | Abrir un repo de prueba, crear un agente Claude, crear la tarea "añade `sum(a,b)` en `src/math.ts` con test" con ese archivo, pulsar ▶: en el registro se ven pensando/herramientas, Claude pide permiso para algo (`npm test` o `rm`), el usuario aprueba, la tarea termina y "Ver diff" muestra el cambio en `.kiji/worktrees/<id>` |
| **H2 — la oficina existe** | pasos 8–11 | Asistente de primera vez (CLIs detectados, clave en el llavero, prueba de conexión), oficina pixel art con robots animados por estado, crear agentes con paleta y rol |
| **H3 — el jefe dirige** | pasos 12–14 | Objetivo → plan estructurado (tarjeta editable) → tareas en la pizarra → arrastrar a un robot → trabajo → tests → review del jefe → "Integrar" → commit en `main` → "Deshacer" |
| **H4 — varias IAs, seguro** | pasos 15–20 | Claude + Ollama (o Codex) en módulos vecinos, propiedad de archivos cumplida, acciones riesgosas con clic, chat y registro por robot, límite simulado deja la tarea en pausa |

---

## 7. Riesgos y cómo se verifica cada uno

| Riesgo | Mitigación | Verificación |
|---|---|---|
| El Agent SDK lanzado desde el core no encuentra la sesión de claude.ai del usuario (usa su propio binario) | No usar `--bare`; dejar `settingSources: []` pero sin tocar la autenticación; si falla, `pathToClaudeCodeExecutable` = ruta del `claude` detectado; alternativa: `ANTHROPIC_API_KEY` del llavero | Paso 4, prueba real de una línea; `claude auth status` en Rust `detect.rs` para mostrar el método de auth en el asistente |
| Términos de uso: una app de terceros que se distribuye no puede ofrecer el login de claude.ai (suscripción) para el Agent SDK (ver Riesgos de `PROYECTO.md`) | En desarrollo vale la sesión local del desarrollador; para usuarios, el camino por defecto del adaptador `claude` es `ANTHROPIC_API_KEY` del llavero, y el asistente lo pide así. Revisar los términos vigentes de Anthropic antes de la 0.3 | Paso 10: el asistente pide la API key de Anthropic; `revisor-critico` lo comprueba en el paso 20 |
| Gemini/Antigravity en headless no permite aprobar desde el host | 0.1 usa Gemini por API key (`api-loop`); `agy` solo se detecta | Probado: `control_request` → exit 2 según docs; `agy -p … stream-json` emite `init/step_update/result` (prueba local 22‑10‑2026) |
| Codex no intercepta acciones riesgosas | Sandbox `workspace-write` sin red + `approvalPolicy: 'never'` + red de seguridad de propiedad tras el run | Paso 15: tarea que intenta `git push` y toca un archivo ajeno |
| `node:sqlite` es "release candidate" | Pin de Node ≥ 22.13 comprobado por `detect.rs` y en el asistente; si rompe, cambiar `db.ts` a `better-sqlite3` (misma API síncrona) | Paso 3; `node -v` en el paso 0 |
| Gasto descontrolado (jefe Opus + varios trabajadores) | `maxBudgetUsd` por run (ajuste `default_budget_usd` = 2); `maxTurns` 40; `api-loop` con límite de tokens; costo visible en el detalle del robot | Paso 4 (fixture `error_max_budget_usd` → `limit: budget`), paso 17 |
| Dos tareas tocan el mismo archivo pese al plan | Validación por código del plan + índice único en `task_files` + rebase antes de integrar; conflicto → `blocked`, nunca merge a medias | Pasos 5 (test de conflicto), 12, 19a |
| Escritura por `Bash` que esquiva la propiedad (`sed -i`, `echo >`) | `classifyCommand` manda a aprobación cualquier comando que escriba; red de seguridad del diff al terminar | Paso 4 (tabla de casos), 19b |
| El core muere a mitad de un run | Rust lo reinicia (máx. 3); al arrancar, runs `running` → `blocked`, `git worktree prune`, el worktree se conserva | Paso 19f |
| PixiJS con React StrictMode (doble montaje) | Guard de inicialización y `app.destroy(true)` en el cleanup | Paso 9 en modo dev |
| Rust no está instalado; primeras compilaciones lentas | Paso 0 explícito; `cargo build` incremental; el core y la UI se desarrollan sin recompilar Rust | Paso 0 (tiempo de `cargo build` anotado en README) |
| Claves en logs o en el store | Rust nunca imprime `env`; el core recibe claves solo por `env` y no las incluye en `events`; test que busca prefijos de clave en la BD | Pasos 2, 10, 18 con `revisor-critico` |
| Windows/Linux no probados en 0.1 | Diseño sin rutas fijas (`app_data_dir`, `execFile`), features de `keyring` por plataforma ya declaradas | Fuera de 0.1; se anota en README |

---

## 8. Fuentes consultadas

**Claude Code / Agent SDK**
- Modo no interactivo (`claude -p`, `--output-format stream-json`, `--allowedTools`, `--permission-mode`, `api_retry`, `--max-budget-usd`): https://code.claude.com/docs/en/headless
- Referencia de la CLI (`--add-dir`, `--json-schema`, `--permission-prompt-tool`, `--resume`, `--worktree`): https://code.claude.com/docs/en/cli-reference
- Agent SDK TypeScript (`query`, `canUseTool`, `maxBudgetUsd`, `SDKResultMessage`, `SDKRateLimitEvent`, `SDKSystemMessage`): https://code.claude.com/docs/en/agent-sdk/typescript
- Permisos y orden de evaluación: https://code.claude.com/docs/en/agent-sdk/permissions
- Aprobaciones y `AskUserQuestion`: https://code.claude.com/docs/en/agent-sdk/user-input
- Paquete npm `@anthropic-ai/claude-agent-sdk` 0.3.308: https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/latest

**Codex**
- Modo no interactivo (`codex exec`, `--json`, `--sandbox`, `--output-schema`, `resume`): https://developers.openai.com/codex/non-interactive-mode (redirige a https://learn.chatgpt.com/docs/non-interactive-mode)
- Referencia de comandos (`-C`, `-a on-request|never`, `--approve-for-me`, `--add-dir`): https://developers.openai.com/codex/developer-commands?surface=cli
- Codex SDK (`@openai/codex-sdk` 0.163.0, `resumeThread`, aprobaciones solo vía app‑server): https://developers.openai.com/codex/sdk ; tipos `ThreadOptions`/eventos/items: https://github.com/openai/codex/tree/main/sdk/typescript/src

**Gemini / Antigravity**
- Aviso de reemplazo de Gemini CLI por Antigravity CLI (18‑06‑2026): https://geminicli.com/docs/cli/headless/ y https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli
- Referencia de flags de Gemini CLI (`--approval-mode`, `--output-format`): https://geminicli.com/docs/cli/cli-reference/
- Antigravity CLI headless (eventos `init/step_update/result`, permisos `request-review`, `control_request` → exit 2): https://antigravity.google/docs/cli/headless/ ; migración: https://antigravity.google/docs/cli/gcli-migration
- Compatibilidad OpenAI de la API Gemini (tools, streaming): https://ai.google.dev/gemini-api/docs/openai ; límites (429 `RESOURCE_EXHAUSTED`): https://ai.google.dev/gemini-api/docs/rate-limits

**OpenAI / Ollama**
- Ollama compatible con OpenAI (`/v1/chat/completions` con tools y streaming): https://docs.ollama.com/api/openai-compatibility
- Agents SDK vs Responses API: https://developers.openai.com/api/docs/guides/agents ; paquete `openai` 7.42.0: https://registry.npmjs.org/openai/latest

**Tauri 2**
- Plugin shell y sidecars (`externalBin`, `shell:allow-execute`): https://v2.tauri.app/plugin/shell/ , https://v2.tauri.app/develop/sidecar/
- Plugin SQL (SQLite, migraciones): https://v2.tauri.app/plugin/sql/
- Stronghold (requiere contraseña del usuario): https://v2.tauri.app/plugin/stronghold/ ; plugin comunitario `tauri-plugin-keyring` 0.1.0 (2024‑12, sin mantenimiento): https://crates.io/api/v1/crates/tauri-plugin-keyring ; crate `keyring` 4.2.0: https://docs.rs/keyring/latest/keyring/
- Eventos Rust→frontend (`app.emit`, `listen`, Channels): https://v2.tauri.app/develop/calling-frontend/
- Prerrequisitos y creación del proyecto: https://v2.tauri.app/start/prerequisites/ , https://v2.tauri.app/start/create-project/ ; `@tauri-apps/cli` 2.12.4, `@tauri-apps/plugin-shell` 2.5.0 (npm)

**PixiJS**
- `pixi.js` 8.22.0: https://registry.npmjs.org/pixi.js/latest ; `@pixi/react` 8.0.5 (React ≥ 19): https://registry.npmjs.org/@pixi/react/latest
- Application v8 (`init`, `resolution`, `resizeTo`): https://pixijs.com/8.x/guides/components/application
- `AnimatedSprite` y `Spritesheet` (JSON `frames/animations/meta`): https://pixijs.download/release/docs/scene.AnimatedSprite.html , https://pixijs.download/release/docs/assets.Spritesheet.html

**Node / git**
- `node:sqlite` (sin flag desde 22.13): https://nodejs.org/docs/latest-v22.x/api/sqlite.html
- `git worktree add/remove/prune/list --porcelain`: https://git-scm.com/docs/git-worktree
