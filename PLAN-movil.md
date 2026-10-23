# Kiji Office móvil: ver y gestionar los workspaces desde el teléfono

Pedido de Alexis (23-10-2026): una app móvil con un servidor por usuario. Desde el teléfono se ven los workspaces
que están trabajando y se gestionan, como Claude Code en remoto. Estado del repo al 23-10-2026 (commit `01c0abc`).

## 0. Punto de partida (verificado en el repo)

- El cerebro de Kiji (`core/`) es un servidor NDJSON por stdio. Lo lanza Tauri (`src-tauri/src/core_process.rs`) y
  solo habla con la ventana. **No hay red**: hoy nada fuera del Mac puede hablar con él.
- La API ya cubre lo que el móvil necesita:
  - **Métodos:** `workspaces.overview`, `project.list`, `agent.list`, `task.list|create|start|stop|steps`,
    `approval.answer`, `manager.get|stopAll|resume`, `notifications.list|markRead`, `stats.overview`,
    `providers.status`, `events.tail` y `board.move`.
  - **Eventos:** `task.changed`, `agent.status`, `approval.requested`, `notify`, `workspaces.changed`,
    `run.metrics`, `event.appended`, `manager.halted` y otros.
  - Están tipados en `shared/protocol.ts`.
- **Falta un método** para listar las aprobaciones pendientes. Hoy solo llegan como evento `approval.requested`, y un
  móvil que se conecta tarde no las vería. Hay que añadir `approval.list` (ver M0).
- Las claves de API viven solo en el llavero del Mac y nunca deben salir de ahí (`secrets.put` la usa solo Rust).
- La app ya sigue trabajando en segundo plano (bandeja). **Pero si el Mac se duerme, todo se para.**

## 1. Arquitectura

```
 iPhone / Android (Flutter)            Servidor del usuario (relay)               Mac con Kiji Office
 ┌──────────────────────┐   WSS      ┌──────────────────────────┐   WSS (sale)   ┌──────────────────────┐
 │ Workspaces, robots,  │──────────▶│ Sala del usuario: empareja │◀──────────────│ Rust: puente remoto  │
 │ tareas, aprobaciones │  cifrado   │ móvil ↔ Mac, guarda push   │   cifrado      │ (allowlist) ↔ core   │
 │ chat con un robot    │  E2E       │ tokens, NO lee contenido   │   E2E          │ NDJSON por stdio     │
 └──────────────────────┘            └──────────────────────────┘                └──────────────────────┘
          ▲  push APNs/FCM sin contenido ("Kiji necesita tu respuesta")
```

### D1. El Mac sale hacia el servidor (nunca al revés)

El Mac abre un WebSocket **saliente** hacia el relay. No se abren puertos, no hay problemas de NAT y no se expone el
Mac a internet. El relay solo empareja la conexión del Mac con la del móvil.

### D2. Un servidor por usuario: un contenedor del relay por usuario en Coolify

- En la beta, cada usuario tiene su propio contenedor del relay (Node 24 + `ws`, una imagen pequeña) desplegado
  con una plantilla de Coolify, con su propio subdominio (`<usuario>.relay.kiji…`).
- Un usuario técnico también puede desplegarlo él mismo con Docker.
- **Por qué:** es lo que pidió Alexis, aísla a cada usuario y es fácil de razonar.
- **Techo:** con cientos de usuarios cuesta un contenedor por cabeza. Para crecer, el plan es pasar a un relay
  compartido con una sala por usuario, por ejemplo Cloudflare Durable Objects. Como el contenido va cifrado de punta
  a punta (D3), el cambio no toca ni la app ni el Mac.

### D3. Cifrado de punta a punta, y el relay no ve nada

- **Emparejamiento:** el Mac enseña un QR con la URL del relay, un token de un solo uso y su clave pública X25519.
  El móvil lo escanea y responde con la suya.
- **Cifrado:** de ahí sale una clave compartida, y cada mensaje va cifrado con libsodium (`crypto_box`). El relay
  solo ve sobres `{to, from, ciphertext}`.
- **Si roban el servidor**, no se pueden leer las tareas ni el código, ni mandar órdenes.
- **Revocar un móvil** se hace en Kiji › Ajustes › Dispositivos.

### D4. Lista blanca en el Mac: el móvil no puede todo

El puente en Rust filtra cada método antes de pasarlo al core. Lo que no está en la lista se rechaza.

| Nivel | Métodos | Fase |
|---|---|---|
| Ver | `workspaces.overview`, `project.list`, `agent.list`, `task.list`, `task.steps`, `task.diff`, `approval.list`, `notifications.list`, `stats.overview`, `stats.models`, `providers.status`, `manager.get`, `queue.list`, `events.tail` | M2 |
| Responder | `approval.answer`, `notifications.markRead`, `manager.stopAll`, `manager.resume` | M2 |
| Trabajar | `task.create`, `task.start`, `task.stop`, `task.assign`, `task.review`, `board.move` | M3 |
| **Nunca** | `secrets.*`, `connection.*`, `settings.set`, `extensions.remove`, `project.open\|close`, `integration.apply\|revert`, `agent.update` | — |

- Los eventos se reenvían todos excepto `secrets.request`.
- Integrar en la rama base (`integration.apply`) sigue siendo una decisión del Mac. Desde el móvil solo se puede
  pedir, y se queda como notificación en el escritorio. Se puede reconsiderar tras la beta.

### D5. Notificaciones push sin contenido

- El relay guarda el token de push del móvil y, cuando el Mac le dice "despierta", manda por APNs o FCM un aviso
  genérico: "Kiji necesita tu respuesta".
- Al abrirlo, la app se conecta y descarga el detalle cifrado.
- Así ni Apple ni Google ni el relay ven el texto de la pregunta.

### D6. App en Flutter

- **Por qué Flutter:** Alexis ya trabaja con él, y un solo código sirve para iOS y Android.
- **Paquetes:**
  - `mobile_scanner` para el QR;
  - `sodium_libs` para el cifrado;
  - `web_socket_channel`;
  - `firebase_messaging` para el push (en iOS también va por APNs a través de FCM);
  - `flutter_secure_storage` para la clave del dispositivo.
- **Arte:** reutiliza los sprites de `src/assets/sprites` (robots y núcleo de IA), dibujados en pixel art a escala
  entera.

## 2. Pantallas de la app (beta)

1. **Vincular:** escanear el QR que muestra Kiji en el Mac.
2. **Workspaces:** la versión móvil de la tarjeta de Home. Por proyecto muestra los robots trabajando, las tareas por
   estado, el coste de hoy y si hay algo esperando respuesta.
3. **Workspace:** los robots con su avatar y estado en vivo, las tareas, una pizarra simple (columnas en scroll) y
   el botón «Parar todo».
4. **Robot:** su chat (los pasos de la tarea en vivo, sacados de `event.appended`) y una caja para mandarle una
   instrucción (M3).
5. **Pendiente:** las aprobaciones con Aprobar / Rechazar, las mismas opciones que la `ApprovalCard` del escritorio.
6. **Avisos:** las notificaciones del Gerente.
7. **Ajustes:** el Mac vinculado, la desvinculación y el modo oscuro.

## 3. Fases

### M0. El core listo para remoto (en el Mac, sin red todavía)
- Añadir `approval.list` (las pendientes por proyecto) en `core/src/orchestrator/approvals.ts` y en el protocolo.
- `src-tauri/src/remote.rs`, el puente: la lista blanca de D4, los reenvíos de petición y respuesta con ids propios
  (para no chocar con los de la ventana) y la difusión de eventos.
- **Prueba:** un cliente de prueba en Node, contra el puente por un socket local, con tests de la lista blanca.
  `secrets.put` y `connection.create` tienen que dar error.

### M1. Relay y emparejamiento
- `relay/`, un servicio Node 24 + `ws` de unas 300 líneas:
  - salas por usuario y sobres cifrados;
  - tokens de emparejamiento de un solo uso con caducidad de 5 minutos;
  - límite de tamaño y de ritmo por conexión;
  - registro de tokens de push.
  - Lleva un Dockerfile y una plantilla de Coolify.
- **En el Mac:** Ajustes › Móvil, con la URL del relay, «Vincular un móvil» (que muestra el QR), la lista de
  dispositivos y el botón para revocar.
- **Cifrado:** claves X25519 del Mac en el llavero (cuenta `device:mac`) y, en Rust, `crypto_box` con el crate
  `crypto_box` (RustCrypto).
- **Prueba:** el Mac y el cliente de prueba hablan a través del relay, y el relay no puede leer el contenido (test).

### M2. App móvil: ver, aprobar y recibir avisos
- Las pantallas 1, 2, 3, 5, 6 y 7. Reconexión con reintentos, el estado "Mac desconectado" y la caché de lo último
  que se vio.
- Push por FCM/APNs desde el relay.
- **Prueba:** en el simulador de iOS y en un emulador de Android contra un relay local; aprobar una pregunta real
  del Gerente desde el móvil.

### M3. App móvil: trabajar
- Crear una tarea y asignarla, empezar y parar, y el chat del robot (pantalla 4).
- Mover tarjetas de la pizarra.
- **Prueba:** una tarea creada desde el móvil acaba "En revisión" en el escritorio.

### M4. Servidor del usuario con el cerebro dentro (sin Mac)
- El mismo core, en modo sin ventana, dentro del contenedor del usuario, con sus repos clonados ahí. Ya es Node
  puro, sin Tauri.
- **Claves:** sin llavero del SO, así que van cifradas en el servidor con una clave que solo tiene el usuario.
- **Claude:** por clave de API (no hay `claude login` interactivo en el servidor).
- **Qué cambia:** el móvil habla con un "Mac" que en realidad es el servidor, y el protocolo es el mismo.
- **Por qué va al final:** es la fase más cara y la más delicada en seguridad (código del usuario y claves en
  nuestra infraestructura). Solo se hace si la beta con Mac funciona.

## 4. Riesgos

| Riesgo | Mitigación |
|---|---|
| El Mac se duerme y el móvil no ve nada | Opción en Ajustes «Mantener despierto mientras haya robots trabajando» (aserción `IOPMAssertion` desde Rust). En la app, estado claro de "Mac dormido o desconectado". |
| Robo del móvil | Clave del dispositivo en el Secure Enclave o el Keystore, app bloqueada con Face ID para aprobar, y revocación desde el Mac. |
| Robo o fallo del relay | Cifrado E2E (D3): sin contenido legible y sin poder mandar órdenes. Lista blanca en el Mac (D4). |
| Coste de un contenedor por usuario | Beta con pocos usuarios. Con muchos, el plan de salas compartidas (D2). |
| Revisión de App Store y Play | Cuenta Apple Developer (ya prevista para 0.3), política de privacidad y la app útil sin pagos dentro. |
| Prompt injection desde el móvil | El móvil es del propio usuario, pero lo que escribe pasa por las mismas reglas que la caja de pedido del escritorio (políticas del Gerente y preguntas en lo sensible). |

## 5. Decisiones abiertas (para Alexis)

1. **Relay:** un contenedor por usuario en tu Coolify (este plan), o uno compartido desde el principio.
2. **¿Se puede integrar (`integration.apply`) desde el móvil, o solo desde el Mac?** El plan dice solo desde el Mac.
3. **¿M4 (cerebro en el servidor, sin Mac) entra en la primera versión o después?** El plan dice después.
4. **Nombre y dominio** del relay y de la app.

## 6. Orden de trabajo y tamaño

| Fase | Contenido | Tamaño aproximado |
|---|---|---|
| M0 | `approval.list` y el puente en Rust con la lista blanca | 1–2 días |
| M1 | Relay, QR, cifrado y Ajustes › Móvil | 3–4 días |
| M2 | App Flutter para ver, aprobar y recibir avisos | 5–7 días |
| M3 | App Flutter para trabajar | 3–4 días |
| M4 | Cerebro en el servidor | 1–2 semanas |
