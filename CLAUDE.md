# Kiji Office — guía para Claude

Programa de escritorio (Tauri 2) que orquesta agentes de varias IAs como robots en pixel art. Brief completo,
funcionalidades por entrega y riesgos en `PROYECTO.md`: léelo antes de planear.

## Stack

- Tauri 2: núcleo en Rust (`src-tauri/`), interfaz React + TypeScript (`src/`), escena 2D con PixiJS.
- Un clon nuevo necesita Rust (`rustc`) y Node >= 22: `tauri dev`/`tauri build` descargan solos el sidecar `kiji-node` del host (`npm run fetch:node:host`).
- Claves de API en el llavero del sistema (plugin de Tauri), nunca en archivos ni en logs.
- Cada agente trabaja en su propio git worktree; solo el agente jefe integra.

## Skills

frontend-design, vercel:react-best-practices, patrones-de-diseno, game-feel (animaciones de los robots),
game-ui-ux (pantallas tipo juego), godot-kit:pixel-art-for-games (sprites), engineering:testing-strategy.

## Flujo de agentes

explorador → arquitecto (plan) → programador / modelador-2d en paralelo (sin tocar los mismos archivos) →
tester → revisor-critico (obligatorio en claves, git y ejecución de comandos de agentes).

## Herramientas

`.mcp.json`: `ias` (Ollama local, `CUSTOM_API_URL`) y `navegador` (Playwright para probar la interfaz).
Sprites: PNG + JSON en `src/assets/sprites/`, generados por `modelador-2d`; retoque en Pixelorama.
