# Registro de cambios

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/). Las entregas siguen `PROYECTO.md`.

## [0.3.0] - Sin publicar

### Añadido
- Empaquetado para macOS, Windows y Linux: Node 24 LTS oficial como sidecar (`tools/fetch-node.mjs`, con
  verificación sha256 contra `SHASUMS256.txt`).
- Pantalla «Acerca de» con la versión, el enlace a este registro, la licencia y la política de datos.
- `tools/bump-version.mjs`: una sola orden sincroniza la versión en `package.json`, `core/package.json`,
  `src-tauri/Cargo.toml` y `src-tauri/tauri.conf.json`.
- `THIRD-PARTY.md` con las licencias de las dependencias de ejecución.

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
