# Kiji Office · BETA

App de escritorio en la que robots en pixel art (agentes de IA) trabajan en tus repositorios. Cada robot es un
agente de Claude, Gemini, OpenAI o una IA local, con su propia tarea, su rama y su chat. El **Gerente** coordina el
trabajo, te avisa y te pide permiso para lo delicado.

> Estado: **beta**. macOS es la plataforma principal. Windows y Linux se compilan en CI, pero están menos probados.

## Qué hace

- **Oficina viva:** cada robot muestra en la escena lo que está haciendo (pensando, escribiendo, te necesita, error,
  terminado). Al hacer clic en uno se abre su panel con el chat, las tareas y sus métricas.
- **Cualquier IA:**
  - Claude Code, mediante el Claude Agent SDK.
  - Cualquier API compatible con OpenAI, en la nube o en local (Ollama, LM Studio…), con permisos por herramienta.
  - Relevo automático a otra IA cuando una llega a su límite, y reintentos ante saturación.
- **Varios workspaces a la vez,** cada uno con sus robots, una cola global con topes de gasto y un Home con métricas.
- **Pizarra Scrum:** los robots se levantan y pegan su tarea en la columna que toca (de refinamiento a Done
  producción).
- **Gerente autónomo:** política auto / avisa / pregunta, con candados fijos, objetivos, integración con deshacer,
  memoria y «Parar todo».
- **Ajustes completos:** IAs, skills, MCP (con desinstalación segura), avisos, datos y actualizaciones.
- **App móvil (en construcción):** ver y gestionar tus workspaces desde el teléfono, con inicio de sesión con Google
  y cifrado de punta a punta. Ver [`PLAN-movil.md`](PLAN-movil.md).

## Seguridad

- Las claves de API viven solo en el **llavero del sistema**. Nunca van a archivos ni a logs, y la interfaz solo ve
  sus últimos 4 caracteres.
- Cada robot trabaja en su propio `git worktree`, y solo el jefe integra en la rama base.
- La app móvil no puede tocar claves, conexiones ni ajustes: hay una lista blanca en el Mac
  (`src-tauri/src/remote.rs`). El servidor solo pasa mensajes cifrados que no puede leer.

## Estructura

| Carpeta | Qué hay |
|---|---|
| `src/` | Interfaz: React 19 + TypeScript + zustand, escena 2D con PixiJS 8 |
| `src-tauri/` | Núcleo nativo en Rust (Tauri 2): llavero, proceso del cerebro, bandeja, notificaciones, actualizaciones, puente móvil |
| `core/` | Cerebro de la oficina en Node 24 (`node:sqlite`): orquestador, adaptadores de IA, Gerente, pizarra. Habla con Rust por NDJSON sobre stdio |
| `shared/protocol.ts` | Contrato de tipos entre la interfaz y el cerebro |
| `server/` | Puerta y relay de la app móvil (Node, WebSocket). Ver [`server/README.md`](server/README.md) |
| `tools/` | Sidecar de Node, versión, sprites (Pixelorama) y clientes de prueba del puente móvil |
| `docs/` | Guía de publicación ([`RELEASE.md`](docs/RELEASE.md)) y checklist de QA |

## Desarrollo

Requisitos: Node ≥ 22.18, Rust estable y, en macOS, Xcode Command Line Tools. Para los robots de Claude hace falta
Claude Code instalado y con sesión iniciada (`claude`).

```bash
npm install
npm run build:core
npm run tauri dev
```

`tauri dev` descarga solo el Node que va dentro de la app (`kiji-node`).

- **macOS:** el binario de desarrollo se firma con tu certificado «Apple Development» (`src-tauri/dev-run.sh`). Así,
  el «Permitir siempre» del llavero sobrevive a cada compilación.
- **Tests:**
  - `npm test`: interfaz, cerebro y servidor.
  - `cd src-tauri && cargo test`: Rust.
  - `cargo test -- --ignored puente`: el puente contra el cerebro real.
- **Puente móvil en local:** levanta la puerta y el relay (ver `server/README.md`), abre la app con
  `KIJI_GATEWAY_URL=http://127.0.0.1:8090 KIJI_DEV_TOKEN=dev:<correo> KIJI_DEV_AUTOPAIR=1` y ejecuta
  `node tools/mobile-phone-sim.mjs "<enlace kiji://pair del log>"`.

## Planes y cambios

- Brief del producto: [`PROYECTO.md`](PROYECTO.md).
- Planes por entrega: `PLAN-*.md`.
- Registro de cambios: [`CHANGELOG.md`](CHANGELOG.md).

## Licencia

Por decidir antes de la versión 1.0. Las licencias de terceros están en [`THIRD-PARTY.md`](THIRD-PARTY.md).
