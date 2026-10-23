# QA 0.3 — pruebas de instalación

Máquinas limpias (VM o equipo sin herramientas de desarrollo). Instala el artefacto de la release **borrador**.
Marca cada casilla por plataforma: mac arm64 / Windows 11 x64 / Ubuntu 22.04.

| Plataforma | Artefacto |
|---|---|
| macOS arm64 | `.dmg` aarch64 |
| Windows 11 | `setup.exe` (SmartScreen: Más información → Ejecutar de todas formas) |
| Ubuntu 22.04 | `.AppImage` y `.deb` |

## A. Sin Node, Git ni Claude Code

- [ ] Verificado antes: `node`, `git`, `claude` no están en PATH.
- [ ] Instala y abre la app sin errores; macOS: sin aviso de Gatekeeper (firmado y notarizado).
- [ ] El core arranca solo (Node empaquetado): la UI llega a estado listo, sin pantalla de error.
- [ ] El Asistente muestra "Claude Code no está instalado" con comando y botón de copiar.
- [ ] Crear agente con proveedor de API (clave) funciona sin Node del sistema.
- [ ] Sin Git: mensaje claro (en Windows, "Instala Git for Windows"); no hay cuelgues.
- [ ] No aparecen archivos basura (`~/.gemini/*.tmp`) tras arrancar.

## B. Con Node, Git y Claude Code instalados

- [ ] La app detecta `claude` y su versión; un objetivo de prueba completa un run.
- [ ] Un agente crea su worktree, edita y el jefe integra.
- [ ] Windows: `run_command "echo hola && ls"` y `grep` devuelven resultado (Git for Windows).
- [ ] La app usa su propio Node (no el del sistema): comprobar versión del sidecar v24.x.

## C. Llavero

- [ ] Guardar una clave de API; cerrar y reabrir la app: sigue disponible.
- [ ] Borrar la clave: desaparece del llavero del sistema (Llaveros / Administrador de credenciales / Seahorse).
- [ ] La clave no aparece en logs ni en archivos de `.kiji/`.
- [ ] Linux sin Secret Service activo: error claro, no panic.

## D. CSP y consola

- [ ] Abrir DevTools (build release o `--debug`): cero violaciones "Content Security Policy" en todas las pantallas
  (Asistente, escena, Acerca de, ajustes).
- [ ] Imágenes, sprites y fuentes cargan; Markdown renderiza.

## E. Actualización 0.3.0 → 0.3.1

Preparación: publicar 0.3.1 (bump, tag, release publicada) con 0.3.0 ya instalada.

- [ ] Acerca de muestra 0.3.0; "Buscar actualizaciones" detecta 0.3.1 con notas.
- [ ] Con robots trabajando no se ofrece instalar; sin trabajo sí, y pregunta antes.
- [ ] Descarga, instala y reinicia: la versión pasa a 0.3.1; datos y claves se conservan.
- [ ] Sin actualización pendiente: mensaje "ya estás al día".
- [ ] Sin red: error legible. Firma manipulada: rechazada.
- [ ] Linux: AppImage se actualiza; `.deb`/`.rpm` muestran aviso con enlace.
- [ ] Windows: el instalador NSIS (por usuario) actualiza sin pedir administrador.

## F. Desinstalación

- [ ] Se desinstala limpiamente (mac: arrastrar; Windows: Aplicaciones; Linux: `apt remove`).
