# Kiji Office: pizarra Scrum (entrega 0.4a)

Pedido de Alexis (23-10-2026): un tablero tipo Scrum. Cada robot se levanta de su sitio, va a la pizarra de la
oficina y coloca su tarea en la columna que toca.

## Columnas (en orden de flujo)

| Clave | Columna | Cuándo entra una tarea (automático) |
|---|---|---|
| `refinement` | Refinamiento | Creada sin agente, o sin archivos ni criterio de aceptación (idea en bruto). |
| `refined` | Refinado | Tiene agente asignado y está lista para empezar (`assigned`, o `todo` con agente). |
| `doing_dev` | Doing (Dev) | `running` / `needs_you` de un agente que no es tester. |
| `committed` | Committed | El run terminó y hay commit en su rama: estado `review`. |
| `doing_qa` | Doing (QA) | Un tester o el revisor trabaja sobre ella. También cuando se revisa la tarea o corren los tests de integración (fase `tests`). |
| `bug` | Bug | Tests fallidos en la integración, o revisión `changes` con hallazgos que describen un fallo. |
| `fix` | Fix | Vuelve a `running` después de `changes`, `bug` o `failed`, con hallazgos. |
| `functional` | Prueba funcional | `approved`: está a la espera de que Alexis la pruebe a mano y la integre. |
| `done` | Done | `integrated`: está en la rama base. |
| `done_prod` | Done producción | Solo a mano, o cuando una release (tag `v*`) incluye su commit (más adelante). |

`blocked`, `failed` y `paused_limit` no tienen columna propia: la tarea se queda en la columna donde estaba y
lleva una marca (⛔ bloqueada, ✖ fallida, ⏸ límite).

## Reglas

- Columna nueva `tasks.board_column` (migración 6), más `board_manual` (0/1).
- El core recalcula la columna en cada transición de estado (`boardColumnFor(task, contexto)`), salvo que
  `board_manual = 1`. El modo manual dura hasta la siguiente transición de estado, que lo apaga y vuelve a lo
  automático. Esa transición deja constancia en el registro.
- `board.move {taskId, column}` (lo usa Alexis al arrastrar): pone `board_manual = 1`. El paso a `done_prod`
  solo se permite desde `done`.
- `task.changed` lleva `board_column`, `board_manual` y `board_flag` (`blocked|failed|paused_limit|null`).
- Evento `board.moved {projectId, taskId, agentId, from, to, auto}`: la escena lo usa para animar al robot.
  El agente de la animación es el de la tarea; si no tiene, el jefe.

## Escena

- El robot camina desde su escritorio hasta un punto delante de la pizarra (`board` en `oficina.json`) en unos
  1,2 s, se para 0,6 s con la animación de "pegar nota" y vuelve a su sitio.
- Las animaciones de un mismo robot se encolan.
- La caminata usa interpolación con un pequeño balanceo. Si hay sprites `walk_*`, los usa.
- Con reduced motion no hay caminata: solo un destello en la pizarra.
- La pizarra de la escena muestra notitas de colores por columna (10 franjas finas) con el número de tareas.
  Un clic en la pizarra abre la vista de tablero.

## Interfaz

- Vista **Pizarra** del workspace: un botón en la barra del workspace y un clic en la pizarra de la escena.
- Tablero kanban con las 10 columnas y scroll horizontal.
- Cada tarjeta muestra el título, el avatar del robot, el modelo, la marca, el coste y el indicador
  "manual" o "auto".
- Arrastrar y soltar (con teclado: mover con flechas) usa `board.move`.
- Filtro por robot y opción "ocultar Done producción".
