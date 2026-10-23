# PLAN 0.3 — Listo para distribuir

Entrega 0.3 de `PROYECTO.md` (puntos 14 y 15): instaladores para macOS, Windows y Linux, firma, actualización
automática y versión 0.3.0. Estado al 2026-10-23. Las funcionalidades (13, personalizar robots) no entran en este
plan: esto es solo empaquetado y distribución.

## 0. Punto de partida (verificado en el repo y en un build de prueba en macOS)

- `npx tauri build --bundles app --no-sign` funciona (4m42s, `.app` de 4,9 MB, solo arm64). Pero la `.app` solo
  lleva el binario, `Info.plist` e icono: **no incluye `core/dist`, ni `node_modules` del core, ni Node**. Al
  arrancar: `[core] no se pudo iniciar: no existe …/Contents/Resources/core/dist/index.js` (`core_entry` en
  `src-tauri/src/core_process.rs` falla en `canonicalize`). Node se busca con `detect::find_binary("node")`.
- Sprites: ya van dentro de `dist/assets` del frontend (Vite). Nada que hacer.
- CSP de producción: no rompe scripts, `data:` ni IPC; `img-src` no incluye `blob:`.
- `bundle.targets = "all"`; `version` 0.1.0 repetida en `package.json`, `core/package.json`, `Cargo.toml` y
  `tauri.conf.json`.
- `detect_clis` escribe `~/.gemini/projects.json.tmp` al ejecutar `gemini --version` (efecto secundario).
- **Hallazgo clave sobre el Agent SDK 0.3.308**: ya **no** lanza `cli.js` con `node`. Lanza un **binario nativo
  `claude`** (~275–297 MB) que viene en paquetes opcionales por plataforma
  (`@anthropic-ai/claude-agent-sdk-darwin-arm64`, `…-win32-x64`, etc.; `manifest.json` con sha256 por plataforma).
  Si se pasa `options.pathToClaudeCodeExecutable`, usa ese ejecutable y no busca el paquete. El mensaje de error del
  propio SDK sugiere "Claude Code installed via native installer". `claude.ts` ya acepta `pathToClaudeCodeExecutable`
  (línea 32/240) pero nadie lo rellena. En Windows el SDK **rechaza** shims `.cmd` (seguridad): hay que apuntar a
  `claude.exe`.
- El core usa `node:sqlite` (Node ≥ 22.13; en Node 26 es "release candidate", sin flag). Node 24 es LTS activa
  (hasta abril 2028), Node 26 es Current y pasa a LTS en octubre 2026.

## 1. Decisiones

### D1. Runtime del núcleo: Node 24 LTS oficial como sidecar (`bundle.externalBin`)

**Decisión.** Descargar en build el binario oficial de Node 24 LTS de `nodejs.org/dist` por plataforma, verificar
el sha256 contra `SHASUMS256.txt`, extraer solo el ejecutable `node` y declararlo como sidecar
`src-tauri/binaries/node-<triple>`. Tauri lo copia junto al ejecutable principal (`Contents/MacOS/node` en macOS,
misma carpeta en Windows/Linux) y, en macOS, **lo firma y lo notariza automáticamente** (el bundler firma
frameworks y sidecars "de dentro hacia fuera" antes de la `.app`, con el `entitlements` y hardened runtime).
Rust lo localiza con `current_exe().parent().join("node")`; no hace falta el plugin `shell`.

Tamaño: ~110 MB sin comprimir / ~30–45 MB comprimido por instalador. Arquitecturas 0.3: mac arm64 y x64 como
**dos builds separados** (no universal: el sidecar tendría que ser universal con `lipo`), win x64, linux x64.
win arm64 y linux arm64 quedan preparados en el script pero fuera de la matriz inicial.

Extra gratis: se antepone la carpeta del sidecar al `PATH` que recibe el core, así Gemini CLI (app Node) funciona
aunque el usuario no tenga Node.

**Descartadas.**
- *Node SEA*: estabilidad 1.1, el blob debe generarse con el mismo binario de Node de cada plataforma (cross-build =
  descargar 4 Nodes + `postject` + firmar igual); mismo tamaño que el sidecar y más piezas. No aporta nada.
- *Bun / Deno compile*: `node:sqlite` llegó a Bun 1.4 pero no está probado dentro de `bun build --compile`; el SDK
  exige el flujo `extractFromBunfs`. Riesgo alto, beneficio cero.
- *Exigir Node instalado*: el público ya no necesita Node (Claude Code es binario nativo, Codex es Rust); romper el
  arranque por falta de Node es una mala primera impresión.

### D2. Claude Code: usar el `claude` instalado por el usuario, no empaquetar los 275 MB

**Decisión.** Rust detecta `claude` (ya lo hace `detect.rs`; en Windows debe preferir `claude.exe` del instalador
nativo, `%USERPROFILE%\.local\bin\claude.exe`, y nunca `claude.cmd`) y pasa la ruta al core por entorno
`KIJI_CLAUDE_PATH`; el adaptador `claude` la pone en `pathToClaudeCodeExecutable`. Si no está instalado, el
Asistente lo dice y ofrece el instalador oficial (`curl -fsSL https://claude.ai/install.sh | bash` /
`irm https://claude.ai/install.ps1 | iex`) con un clic que abre la terminal o copia el comando (no lo ejecutamos
nosotros). Claude Code ya era requisito del producto (el jefe es Claude).

Compatibilidad: el SDK fijado (0.3.308) viene emparejado con CLI 2.1.308; el `manifest.json` muestra que cada
CLI se prueba contra ~30 wrappers anteriores. Política: mínimo exigido = `claudeCodeVersion` del `package.json`
del SDK (se lee en build y se mete como constante); si `claude --version` es menor, aviso "ejecuta `claude update`".
Y en cada release de Kiji se actualiza el SDK.

**Descartadas.** Empaquetar el binario (instalador ×4, notarizar 300 MB más, actualizaciones lentas, licencia
"SEE LICENSE" del binario) y descargarlo en el primer arranque desde el bucket del instalador (URL no documentada).

### D3. Recursos: el core se empaqueta como **un solo archivo** con esbuild

**Decisión.** `esbuild core/src/index.ts --bundle --platform=node --format=esm --target=node24
--outfile=core/dist/kiji-core.mjs` con `schema.sql` importado como texto (`--loader:.sql=text`). En
`tauri.conf.json`: `"resources": { "../core/dist/kiji-core.mjs": "core/kiji-core.mjs" }`. `core_entry` en release
= `resource_dir()/core/kiji-core.mjs`. La extensión `.mjs` evita necesitar `core/package.json` (`"type":"module"`).
Sin `node_modules` en el bundle (los paquetes opcionales del SDK ni se copian: D2).

**Descartada.** Copiar `core/dist` + `node_modules` de producción: 40 MB y miles de archivos sin el binario
(300 MB con él), symlinks de `.bin`, notarización más lenta, y `resource_dir` con `node_modules` es frágil en
Linux (`/usr/lib/kiji-office/`).

### D4. Windows: Git Bash para `run_command` y el `grep` de Git

**Decisión.** Git ya es requisito (worktrees). Git for Windows trae `usr\bin\bash.exe` y `usr\bin\grep.exe`
(GNU grep, mismas banderas `-rnIE --null --exclude-dir`). En `core/src/adapters/tools/index.ts`: una función
`shell()` devuelve `/bin/sh` en Unix y `<GitRoot>\usr\bin\bash.exe` en Windows (GitRoot se obtiene de
`where git` → `<GitRoot>\cmd\git.exe`); `grep` se resuelve igual. Así `classifyCommand` (sintaxis POSIX) sigue
valiendo. `detached:true` + `process.kill(-pid)` solo en Unix; en Windows `taskkill /T /F` (ya existe en
`core/src/git/integrate.ts`, se reutiliza). Sin Git: error claro "Instala Git for Windows".

**Descartada.** `cmd.exe`/PowerShell: habría que reescribir el clasificador de riesgo para otra sintaxis.

### D5. Firma: Apple sí; Windows sin firmar en 0.3; Linux sin firma

- **macOS**: Developer ID Application + notarización (cuenta Apple Developer, **99 USD/año**). Entitlements
  necesarios por el sidecar Node (V8 hace JIT): `com.apple.security.cs.allow-jit` y
  `com.apple.security.cs.allow-unsigned-executable-memory` (son las que usa el propio Node en
  `tools/osx-entitlements.plist`). Tauri aplica el mismo `entitlements` a todos los binarios: aceptable.
- **Windows**: Azure Artifact Signing (ex Trusted Signing) cuesta 9,99 USD/mes pero para **individuos solo en
  EE. UU. y Canadá**; un certificado OV cuesta 200–400 USD/año con token físico y desde 2024 **ni OV ni EV evitan
  SmartScreen** al principio (la reputación se gana con descargas). Decisión: 0.3 sin firmar, con instrucción en la
  página de descarga ("Más información → Ejecutar de todas formas"). La integridad de las actualizaciones la
  garantiza la firma minisign del updater (D6), no Authenticode.
- **Linux**: sin firma; `sha256` de cada artefacto en las notas de la release.

### D6. Actualización automática: `tauri-plugin-updater` + GitHub Releases

Claves con `tauri signer generate -w ~/.tauri/kiji.key` (la privada va al secreto `TAURI_SIGNING_PRIVATE_KEY`
del repo **y** a un gestor de contraseñas: si se pierde, no se pueden publicar más actualizaciones a lo instalado).
`bundle.createUpdaterArtifacts: true`; endpoint
`https://github.com/<owner>/<repo>/releases/latest/download/latest.json` (lo genera `tauri-action`).
Comprobación al arrancar + botón en "Acerca de"; la UI pregunta antes de instalar y **nunca** mientras hay robots
trabajando (reusa `tray_set_busy`). En Linux solo se autoactualiza el AppImage; `.deb`/`.rpm` muestran aviso y enlace.
Requiere `tauri-plugin-process` para reiniciar.

### D7. Dónde publicar

GitHub Releases exige un remoto. Recomendación: **repo público** (Actions gratis e ilimitadas; macOS cuesta ×10
minutos en repos privados: los 2000 min gratis dan ~200 min de mac/mes, 2–4 releases). Si el código sigue privado:
repo privado para el código + repo público `kiji-office-releases` solo para artefactos (`tauri-action` acepta
`owner`/`repo` con un token). Decisión de Alexis (ver final).

### D8. Versión 0.3.0, changelog, Acerca de, licencia, telemetría

- Fuente única de versión: `package.json`; `tauri.conf.json` → `"version": "../package.json"` (Tauri 2 admite
  ruta a package.json); `tools/bump-version.mjs` sincroniza `core/package.json` y `Cargo.toml`. Tag `v0.3.0`.
- `CHANGELOG.md` formato Keep a Changelog, secciones 0.1 / 0.2 / 0.3.
- Pantalla "Acerca de": versión (`getVersion()` de `@tauri-apps/api/app`), "Buscar actualizaciones", enlace al
  changelog, avisos de terceros (`THIRD-PARTY.md`: Node MIT, Agent SDK, PixiJS…), y el texto "Kiji Office no envía
  telemetría ni datos de uso a nadie; tus claves van solo a los proveedores que configures. Claude Code aplica su
  propia política de datos de Anthropic". **Ninguna telemetría propia**; no hay nada que consentir.
- Licencia: decisión de Alexis (pregunta abierta de `PROYECTO.md`). Por defecto, `LICENSE` "Todos los derechos
  reservados" si el código es privado; MIT si lo abre.

### D9. CSP de producción

`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: asset:
http://asset.localhost; font-src 'self' data:; worker-src 'self' blob:; connect-src 'self' ipc:
http://ipc.localhost`. `blob:` en `img-src`/`worker-src` por PixiJS (texturas y workers por blob). Se verifica con
`tauri build --debug` (devtools) mirando la consola: cero violaciones de CSP en Oficina, Casa, chat y Acerca de.

### D10. Plataforma por plataforma (lo que no es decisión, solo trabajo)

| Tema | Qué se hace |
|---|---|
| PATH en macOS (app GUI) | Ya resuelto por `detect::extended_path`; se añade la carpeta del sidecar al frente. |
| Llavero Linux | `keyring 4` usa `zbus-secret-service` (Rust puro, D-Bus; sin libsecret). Necesita gnome-keyring o KWallet ≥ 5.97 con la API Secret Service activada. Si falla, el Asistente lo explica ("instala gnome-keyring") en vez de un error críptico. |
| Tray Linux | `.deb` depende de `libayatana-appindicator3-1` (lo añade Tauri); en GNOME hace falta la extensión AppIndicator. La app no depende de la bandeja para nada esencial. |
| Notificaciones Windows | Solo salen con la app instalada (AppUserModelID del NSIS); en dev no se ven. Normal. |
| WebView2 | `downloadBootstrapper` (por defecto, 0 MB): Windows 10/11 ya lo traen. |
| Targets | `["app","dmg","nsis","deb","rpm","appimage"]` (sin `msi`: evita WiX/VBScript y el updater prefiere NSIS). NSIS por usuario (sin admin). Ubuntu 22.04 como base del AppImage/deb. |
| `detect_clis` escribe en `~/.gemini` | `version_of` corre con `HOME`/`USERPROFILE` apuntando a `app_cache_dir()/probe-home` para que los CLIs escriban ahí. |
| Windows: `claude.cmd` | `find_binary("claude")` prefiere `.exe`; `.cmd` se ignora para Claude (el SDK lo rechaza). |

## 2. Pasos

Agente `programador` salvo indicación. "Hecho cuando" = verificación concreta.

| # | Paso | Archivos | Hecho cuando |
|---|---|---|---|
| 1 | Script `tools/fetch-node.mjs <triple>`: descarga Node 24 LTS oficial, verifica `SHASUMS256.txt`, extrae `node`/`node.exe` a `src-tauri/binaries/node-<triple>`; `src-tauri/binaries/` en `.gitignore`; script npm `fetch:node`. | `tools/fetch-node.mjs`, `package.json`, `.gitignore` | `npm run fetch:node -- aarch64-apple-darwin` deja un binario ejecutable que responde `node --version` = v24.x; sha256 incorrecto → falla. |
| 2 | Bundle del core con esbuild (`kiji-core.mjs`, `schema.sql` como texto); `db.ts` deja de leer `schema.sql` por ruta; `build:core` produce el bundle. | `core/package.json`, `core/src/db/db.ts`, `core/esbuild.mjs`, `tsconfig` | `node core/dist/kiji-core.mjs --db /tmp/k.db` responde a `ping` desde cualquier cwd y sin `node_modules`; `vitest` del core en verde. |
| 3 | `tauri.conf.json`: `externalBin: ["binaries/node"]`, `resources`, `targets` explícitos, `version` desde `package.json`, `createUpdaterArtifacts`, CSP de D9, `macOS.entitlements`, `windows.nsis` por usuario. `src-tauri/Entitlements.plist`. | `src-tauri/tauri.conf.json`, `src-tauri/Entitlements.plist` | `tauri build --bundles app --no-sign` en mac deja `Contents/MacOS/node` y `Contents/Resources/core/kiji-core.mjs`. |
| 4 | `core_process.rs`: `node_path()` (release: junto a `current_exe`; debug: `binaries/node-<host>` si existe, si no `find_binary`), `core_entry` nuevo, PATH con sidecar al frente, `KIJI_CLAUDE_PATH`; `detect.rs`: preferir `.exe`, HOME de prueba, mínimo de versión de `claude`. | `src-tauri/src/core_process.rs`, `src-tauri/src/detect.rs`, `src-tauri/src/lib.rs` | `cargo test`; la `.app` sin Node en PATH (`env -i`) arranca el core y llega `core.ready`; no aparece `~/.gemini/*.tmp`. |
| 5 | Adaptador `claude`: `pathToClaudeCodeExecutable` desde `KIJI_CLAUDE_PATH`; aviso de versión mínima; Asistente: tarjeta "Claude Code no está instalado" con comando oficial y botón copiar/abrir docs. | `core/src/adapters/claude.ts`, `core/src/orchestrator/providers.ts`, `src/screens/Wizard/*` | Con `KIJI_CLAUDE_PATH` apuntando a `~/.local/bin/claude` un objetivo de prueba completa un run; sin Claude instalado el Asistente muestra la tarjeta. |
| 6 | Windows en el core: `shell()`/`grepBin()` vía Git for Windows, kill con `taskkill`, `detached` solo Unix. Tests con `process.platform` simulado. | `core/src/adapters/tools/index.ts`, `core/src/adapters/tools/platform.ts` | `vitest` en verde en mac; en una VM/CI Windows `run_command "echo hola && ls"` y `grep` devuelven resultado. |
| 7 | Updater: plugins `updater` y `process`, capability, `plugins.updater.{pubkey,endpoints}`, comando `check_update`; UI: diálogo "Hay una versión X" (no si hay robots trabajando), botón en Acerca de. | `src-tauri/Cargo.toml`, `src-tauri/src/updater.rs`, `src-tauri/capabilities/default.json`, `src/screens/About/*` (`unity-gameplay` no aplica; UI la hace `programador`) | Con un `latest.json` local de prueba (endpoint `dangerousInsecureTransportProtocol` solo en dev) la app detecta 0.3.1 > 0.3.0 y descarga; firma inválida → rechaza. |
| 8 | Versión y textos: `bump-version.mjs`, `CHANGELOG.md`, `THIRD-PARTY.md`, `LICENSE`, pantalla Acerca de con texto de telemetría. | `tools/bump-version.mjs`, `CHANGELOG.md`, `THIRD-PARTY.md`, `LICENSE`, `src/screens/About/*` | `npm run bump 0.3.0` deja 0.3.0 en los 4 sitios; `git diff` lo muestra; Acerca de enseña "0.3.0". |
| 9 | CI: `.github/workflows/ci.yml` (vitest + cargo test en ubuntu) y `release.yml` (tag `v*`; matriz mac arm64/x64 con `--target`, windows-latest, ubuntu-22.04; apt de Tauri; `setup-node@v6` + `rust-cache`; paso `fetch:node` por target; `tauri-action@v1` con `releaseDraft: true`, `tagName: v__VERSION__`). Secretos documentados en `docs/RELEASE.md`. | `.github/workflows/*.yml`, `docs/RELEASE.md` | Un tag en el remoto genera una release borrador con dmg×2, setup.exe, deb, rpm, AppImage, `.sig` y `latest.json`. |
| 10 | Firma macOS: certificado Developer ID en el llavero de Alexis; `.p12` base64 + `APPLE_ID`/`APPLE_PASSWORD`/`APPLE_TEAM_ID` como secretos; build local `npm run release:mac` (firma + notariza en su Mac). | `docs/RELEASE.md`, `package.json` | `spctl -a -vv Kiji\ Office.app` → "accepted, source=Notarized Developer ID"; `codesign -dv --entitlements - Contents/MacOS/node` muestra `allow-jit`. |
| 11 | Pruebas de instalación (`tester`): máquina/VM limpia sin Node, Git y Claude Code; luego con ellos. Lista en `docs/QA-0.3.md`. | `docs/QA-0.3.md` | Checklist pasada en mac arm64, Windows 11 x64 y Ubuntu 22.04; sin violaciones de CSP; llavero funciona en los tres. |
| 12 | `revisor-critico`: revisión de 4, 5, 6, 7 (ejecución de comandos, claves, updater). | — | Sin hallazgos bloqueantes. |

**Paralelismo.** Tanda A (sin archivos en común): 1 ∥ 2 ∥ 6 ∥ 8. Tanda B: 3 y 4 juntos (mismo programador) ∥ 5 ∥ 7.
Tanda C: 9 → 10 → 11 → 12. El modelador-2d no participa en 0.3; `tester` solo en 11.

**Estimación.** A: 1,5 días. B: 2 días. C: 2 días más la espera de Apple (aprobación de la cuenta: 1–2 días;
notarización: minutos). Total ~6 días de trabajo de agentes + decisiones de Alexis.

## 3. Riesgos

| Riesgo | Mitigación | Verificación |
|---|---|---|
| esbuild no puede empaquetar algo del SDK (`createRequire` dinámico del paquete nativo, `@anthropic-ai/sdk`). | El `require` dinámico solo corre sin `pathToClaudeCodeExecutable`; se marca `--external` lo que falle y se copia aparte como recurso (plan B acotado a ese paquete). | Paso 2: run completo con el bundle. |
| Notarización rechaza el sidecar (hardened runtime sin JIT). | Entitlements de D5; sidecar firmado por Tauri. | Paso 10: `spctl` y log de `notarytool`. |
| CLI de Claude del usuario más nuevo/viejo que el SDK. | Mínimo de versión + actualizar SDK en cada release; mensaje "claude update". | Paso 5 con `claude` 2.1.296 (el local) y el actual. |
| Perder la clave privada del updater. | Copia en gestor de contraseñas y secreto del repo. | Documentado en `docs/RELEASE.md`. |
| Repo privado agota minutos de macOS en Actions. | Build de mac local (paso 10) y CI solo para Windows/Linux; o repo público. | Factura de Actions. |
| Windows sin firma: SmartScreen asusta. | Texto en la página de descarga; `sha256` publicados; firma en 0.4 si hay ventas. | Prueba en VM limpia. |
| Linux sin Secret Service (servidores, WMs mínimos). | Mensaje claro en el Asistente. | Paso 11 en Ubuntu sin gnome-keyring. |
| Tamaño del instalador sube de 5 MB a ~45 MB (Node). | Aceptado; sin Claude dentro se queda ahí. | Tamaños en la release. |
| Updater pisa trabajo en curso. | No ofrecer instalar con robots ocupados; instalar al salir. | Paso 7. |

## 4. Fuentes

- Sidecar/externalBin: https://v2.tauri.app/develop/sidecar/ ; recursos: https://v2.tauri.app/develop/resources/
- Firma de sidecars en el bundler (orden "inside out", entitlements a todos): `crates/tauri-bundler/src/bundle/macos/app.rs` y `sign.rs`
- macOS: https://v2.tauri.app/distribute/sign/macos/ ; Windows: https://v2.tauri.app/distribute/sign/windows/ ; instalador Windows: https://v2.tauri.app/distribute/windows-installer/
- Updater: https://v2.tauri.app/plugin/updater/ ; tauri-action: https://github.com/tauri-apps/tauri-action ; CI: https://v2.tauri.app/distribute/pipelines/github/
- CSP: https://v2.tauri.app/security/csp/
- Node: https://nodejs.org/en/about/previous-releases ; SEA: https://nodejs.org/api/single-executable-applications.html ; `node:sqlite`: https://nodejs.org/api/sqlite.html ; entitlements de Node: `tools/osx-entitlements.plist`
- Agent SDK: https://code.claude.com/docs/en/agent-sdk/troubleshooting (binario nativo, `.cmd` rechazado); README del paquete 0.3.308 (`bun build --compile`, `extractFromBunfs`)
- Azure Artifact Signing (precio y elegibilidad): https://www.devclass.com/security/2026/01/14/code-signing-windows-apps-may-be-easier-and-more-secure-with-new-azure-artifact-service/4079554
- keyring 4 features: https://docs.rs/crate/keyring/latest/features ; KWallet Secret Service ≥ 5.97: https://bugs.archlinux.org/task/75616
- Minutos de Actions (×2 Windows, ×10 macOS): https://docs.github.com/en/billing/concepts/product-billing/github-actions
