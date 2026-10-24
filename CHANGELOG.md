# Registro de cambios

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/). Las entregas siguen `PROYECTO.md`.

## [0.3.0] - Sin publicar

### Añadido
- App móvil, fases M0 y M1 (`PLAN-movil.md`):
  - `approval.list` y un puente remoto con lista blanca (`src-tauri/src/remote.rs`).
  - Inicio de sesión con Google (PKCE), clave del Mac en el llavero y conexión de salida al relay.
  - Emparejamiento por QR y cifrado de punta a punta con sesión y contador contra la reproducción.
  - Ajustes › Móvil.
  - `server/` (puerta y relay por usuario, con clave de firma derivada por usuario y provisión en Coolify).
  - Móvil simulado para la prueba de punta a punta.
- Pantalla de inicio animada (robots y un núcleo de IA dibujado en Pixelorama) y la marca **BETA**.
- Pizarra Scrum (0.4a): 10 columnas automáticas por estado, arrastrar y soltar, y robots que caminan a la pizarra.
- Ajustes completos (0.4b), Tus IAs y Modelos más usados en el Home, y un panel de métricas estilo monitor.
- Gestión de MCP y skills (globales, por proyecto y de plugins), con copia de seguridad y papelera al desinstalar.
- Panel del agente enfocado: avatares reales, tarjetas plegables y el chat dentro del panel.
- `README.md`.
- Empaquetado para macOS, Windows y Linux: Node 24 LTS oficial como sidecar (`tools/fetch-node.mjs`, con
  verificación sha256 contra `SHASUMS256.txt`).
- Pantalla «Acerca de» con la versión, el enlace a este registro, la licencia y la política de datos.
- `tools/bump-version.mjs`: una sola orden sincroniza la versión en `package.json`, `core/package.json`,
  `src-tauri/Cargo.toml` y `src-tauri/tauri.conf.json`.
- `THIRD-PARTY.md` con las licencias de las dependencias de ejecución.

### Corregido
- Gemini 3: se conservan los campos extra de `tool_calls` (`thought_signature`). Antes daba HTTP 400.
- Reintentos automáticos ante saturación o cortes (5xx, 408, 429 puntual, red), con espera creciente.
- La pantalla dejaba de actualizarse al remontar la app: la suscripción a los eventos ahora vive lo que la página.
- En macOS (desarrollo), el llavero ya no vuelve a pedir la contraseña tras cada compilación.

## [0.2d] - 2026-10-23

### Añadido
- Gerente autónomo: herramientas propias, política auto / avisa / pregunta con candados, bucle por eventos, topes de
  gasto y memoria con búsqueda de texto (FTS5).
- Objetivos, revisión de tareas, integración con deshacer y diario.
- Avisos con campana, notificaciones del sistema y «Parar todo» (también desde la bandeja), con parada persistente.

### Corregido
- Integración sin bloquear el router, avisos urgentes sin límite de frecuencia, `halted` antes del merge.
- Los robots ya no leen la memoria automática de Claude Code (`~/.claude/projects`) sin preguntar.

## [0.2c] - 2026-10-23

### Añadido
- Varios workspaces abiertos a la vez, con pestañas e insignias (te necesitan, en marcha, en cola, límite).
- Cola global con topes y Home con métricas por workspace.
- Estado de la interfaz particionado por proyecto.

### Corregido
- Huecos en la cola, cierre de workspace, gasto a medianoche, orden de relevos y saneo al arrancar.

## [0.2b] - 2026-10-23

### Añadido
- Conexiones a cualquier IA compatible con OpenAI, local (Ollama, LM Studio…) o en la nube, con adaptador
  `api-loop` y permisos por herramienta.
- Claves de conexión en el llavero del sistema; relevo automático a otra IA.

### Corregido
- Borrado de claves, `grep` sin ReDoS, `read_file` con tope, aviso de cambio de host y nombres de conexión legibles.

## [0.2a] - 2026-10-23

### Añadido
- Pestañas por agente, métricas, cupo, relevo entre IAs y perfil con skills.
- Pedido desde la oficina, IAs detectadas en vivo, ejecución en segundo plano y aviso al cerrar.

### Corregido
- Servidores MCP aislados, skills sin `allowed-tools`, relevo por proyecto, coste con `resume` y traspaso delimitado.

## [0.1] - 2026-10-22

### Añadido
- Aplicación de escritorio Tauri 2 (React + TypeScript) con un núcleo Node que habla NDJSON por stdio.
- Base de datos SQLite con migraciones, orquestador (proyectos, agentes, tareas, runs y aprobaciones) y un
  git worktree por tarea, con integración y deshacer.
- Adaptador de Claude con clasificador de comandos y detección de límites.
- Oficina en pixel art con PixiJS (robots por estado), creación de agentes y asistente de primera vez
  (CLIs, claves en el llavero, prueba de conexión).
