# Kiji Office

## Idea

Un programa de escritorio donde tus agentes de IA son robots en pixel art que trabajan en una oficina o en una
casa. Le das un objetivo al jefe (Claude), él lo divide en tareas, las reparte entre robots de distintas IAs
(Claude, Gemini, OpenAI, modelos locales) y revisa lo que entregan. Todo se configura por interfaz, como un juego:
nada de archivos JSON ni terminal.

## Problema

Usar varias IAs a la vez en un proyecto hoy significa configurar a mano claves, CLIs y servidores MCP, y
arriesgarse a que dos agentes se pisen el trabajo. No hay una forma visual de ver quién hace qué, cuánto cuesta y
aprobar lo riesgoso.

## Público

Desarrolladores indie y creadores que ya usan Claude Code, Gemini CLI, Codex u Ollama y quieren orquestarlos sin
pelearse con la configuración.

## Datos del proyecto

| | |
|---|---|
| Tipo | Programa de escritorio (Windows, macOS, Linux) |
| Dueño | Propio |
| Etapa | MVP, en 3 entregas |
| Stack | Tauri 2 (núcleo Rust) + React + TypeScript + PixiJS |
| Estilo | Pixel art, escenarios oficina y casa |
| IAs del producto | Claude (jefe), Gemini, OpenAI, Ollama; por API key o por los CLIs instalados |

## Concepto

- **La oficina**: escritorios con un robot por agente, la oficina de cristal del jefe, una pizarra de tareas. La
  **casa** es el mismo sistema con otro escenario.
- **Los robots** se animan según su estado: en espera, pensando, escribiendo, esperando aprobación (levanta la
  mano), error, listo. Clic en un robot: su chat, lo que hizo y lo que gastó.
- **Los personajes** llevan los colores de cada IA (Claude naranja terracota, Gemini azul) pero son diseños
  propios: sin logos oficiales.
- **El jefe**: un agente Claude (Opus/Fable) con rol de supervisor. Recibe el objetivo, hace el plan, asigna y
  revisa; solo él integra cambios al proyecto.
- **Roles** de los trabajadores: los agentes del kit `skills-claude-miguel` (programador, tester, explorador,
  modelador-2d, etc.), cada uno con su IA y modelo.

## Funcionalidades

### Entrega 0.1 — la oficina trabaja

1. Asistente de primera vez: claves en el llavero del sistema (nunca en texto), detección de CLIs (Claude Code,
   Gemini CLI, Codex, Ollama).
2. Oficina en pixel art con robots animados por estado.
3. Crear agentes: IA y modelo, rol, nombre y color del robot.
4. Claude jefe: objetivo → plan → tareas → asignación → revisión → aprobación.
5. Pizarra de tareas; arrastrar una tarjeta a un robot la asigna.
6. Trabajo seguro: git worktree por agente, un archivo pertenece a una sola tarea a la vez, solo el jefe integra y
   después de los tests, acciones riesgosas (borrar, publicar, desplegar, pagar) esperan tu clic, todo se deshace
   con git.
7. Chat y registro por robot + registro general.

### Entrega 0.2 — más mundo y herramientas

8. Escenario casa.
9. Abrir o crear proyecto, con el asistente de `/nuevo-proyecto` como formulario.
10. Herramientas MCP con un botón: Blender, Unity, Godot, Aseprite (catálogo del kit).
11. Tope de gasto por agente y contador de costo en vivo.

### Entrega 0.3 — listo para distribuir

12. Personalizar robots: accesorios, colores, animaciones.
13. Instaladores firmados (Apple Developer, certificado de Windows) para Windows, macOS y Linux.
14. Actualización automática.

### Después

Más escenarios, equipos compartidos (varias personas, misma oficina), voz, tienda de agentes.

## Herramientas para desarrollarlo

- Claude Code con los agentes del kit (arquitecto, programador, tester, modelador-2d, revisor-critico).
- MCP `ias` con Ollama local (pruebas del soporte de modelos locales sin gasto) y `navegador` (Playwright, probar la
  interfaz web de Tauri).
- Sprites: los genera Claude (agente `modelador-2d`, skill de pixel art) como PNG + JSON; se retocan en Pixelorama.

## Riesgos

- **Costo**: varias IAs en paralelo multiplican el gasto; el tope por agente (0.2) es importante.
- **Conflictos de código**: se evitan con worktrees y propiedad de archivos; probar con dos agentes editando
  módulos vecinos desde la 0.1.
- **CLIs de terceros**: cada CLI cambia su formato de salida; aislar cada integración detrás de un adaptador.
- **Términos de uso**: las suscripciones de consumo (claude.ai, Gemini, ChatGPT) no se pueden conectar por OAuth
  desde una app de terceros; se usan API keys o el CLI oficial que el usuario ya tiene instalado.
- **Firma**: macOS sin notarizar muestra advertencias; requiere cuenta de Apple Developer (99 USD/año).
- **Marcas**: nada de logos oficiales de Anthropic, Google u OpenAI en los robots.

## Preguntas abiertas

- ¿Gratis, pago único o suscripción?
- ¿Se publica el código (open source)?
- ¿Idiomas de la interfaz: español e inglés desde la 0.1?
