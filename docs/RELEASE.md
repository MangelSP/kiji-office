# Publicar Kiji Office — guía paso a paso

Resumen: un tag `vX.Y.Z` dispara `.github/workflows/release.yml`, que compila en macOS (arm64 y x64), Windows y
Linux y deja una **release borrador** con instaladores, firmas del updater y `latest.json`. Tú la revisas y la publicas.

Requisitos de un clon nuevo: Rust y Node >= 22. `beforeDevCommand`/`beforeBuildCommand` ejecutan
`npm run fetch:node:host`, que descarga a `src-tauri/binaries/kiji-node-<triple>` el Node del host si falta. El sidecar se
llama `kiji-node` (no `node`) para no chocar con `/usr/bin/node` en .deb/.rpm; la app crea en su carpeta de datos un
directorio `shims/` con `node` -> `kiji-node` y lo antepone al PATH del core.

## Secretos del repositorio (Settings → Secrets and variables → Actions)

| Secreto | Obligatorio | Qué es |
|---|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | sí | Contenido de `~/.tauri/kiji.key` (clave privada del updater) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | sí | Contraseña con que la protegiste |
| `APPLE_CERTIFICATE` | solo para firmar mac | `.p12` de "Developer ID Application" en base64 |
| `APPLE_CERTIFICATE_PASSWORD` | idem | Contraseña del `.p12` |
| `APPLE_SIGNING_IDENTITY` | idem | Ej. `Developer ID Application: Tu Nombre (TEAMID)` |
| `APPLE_ID` | idem | Correo de tu cuenta Apple Developer |
| `APPLE_PASSWORD` | idem | Contraseña específica de aplicación (no la de tu Apple ID) |
| `APPLE_TEAM_ID` | idem | Team ID de 10 caracteres |

`GITHUB_TOKEN` lo pone Actions solo. **Si falta cualquiera de los seis `APPLE_*`**, el workflow avisa y la build de
macOS sale sin firmar ni notarizar (no falla). Un dmg sin firmar no es válido para distribuir: Gatekeeper lo bloquea.

## 1. Apple Developer y certificado (99 USD/año)

1. Inscríbete en <https://developer.apple.com/programs/> (cuenta individual; la aprobación tarda 1–2 días).
2. Team ID: developer.apple.com → Account → Membership details → *Team ID*.
3. Certificado: Xcode → Settings → Accounts → Manage Certificates → `+` → **Developer ID Application**
   (o en developer.apple.com → Certificates).
4. Exportar: *Acceso a Llaveros* → Mis certificados → clic derecho en "Developer ID Application: …" →
   Exportar → `.p12` con una contraseña (será `APPLE_CERTIFICATE_PASSWORD`).
5. Base64 al portapapeles: `base64 -i certificado.p12 | pbcopy` → pégalo como `APPLE_CERTIFICATE`. Borra el `.p12` después
   o guárdalo en tu gestor de contraseñas.
6. Identidad: `security find-identity -v -p codesigning` → copia el nombre completo entre comillas
   (`APPLE_SIGNING_IDENTITY`).
7. Contraseña de aplicación: <https://account.apple.com> → Inicio de sesión y seguridad → Contraseñas de apps →
   genera una (`APPLE_PASSWORD`). `APPLE_ID` es tu correo.

## 2. Claves del updater

```sh
npx tauri signer generate -w ~/.tauri/kiji.key
```

- Guarda la **privada** (`~/.tauri/kiji.key`) y su contraseña en tu gestor de contraseñas. **Si la pierdes, no podrás
  publicar actualizaciones para lo ya instalado.** Nunca la subas al repo.
- Pon el contenido de `~/.tauri/kiji.key.pub` en `src-tauri/tauri.conf.json` → `plugins.updater.pubkey`.
- Privada y contraseña → secretos `TAURI_SIGNING_PRIVATE_KEY` y `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

## 3. Repositorio público en GitHub

1. Crea el repo público (Actions gratis e ilimitadas; en privado los minutos de macOS cuentan ×10). Antes de abrir el
   código, decide la licencia (hoy no hay `LICENSE`).
2. En `src-tauri/tauri.conf.json` sustituye `REEMPLAZAR_OWNER` y `REEMPLAZAR_REPO` en `plugins.updater.endpoints`.
   Mientras quede algún `REEMPLAZAR_` la app no comprueba actualizaciones.
3. Añade los secretos de la tabla. `git remote add origin …` y sube `main`; el workflow `CI` debe quedar en verde.
4. Settings → Actions → General → Workflow permissions: "Read and write" (el workflow ya pide `contents: write`).

## 4. Publicar 0.3.0

```sh
npm run bump -- 0.3.0        # package.json, core, tauri.conf.json, Cargo.toml/lock
# edita CHANGELOG.md (mueve lo pendiente a [0.3.0])
git commit -am "Release 0.3.0"
git tag v0.3.0
git push origin main v0.3.0
```

El tag dispara `Release`. Al terminar (unos 20–30 min) aparece una release **borrador** con: dmg (arm64 y x64),
`.app.tar.gz` + `.sig`, `setup.exe` + `.sig`, `.deb`, `.rpm`, `.AppImage` + `.sig` y `latest.json`. Revísala,
añade los sha256 (`shasum -a 256 *`) y las notas, y pulsa **Publish**. El endpoint `releases/latest/download/latest.json`
solo funciona con la release publicada (no borrador, no prerelease).

## 5. Windows y Linux

- **Windows (sin firma Authenticode):** SmartScreen mostrará "Windows protegió su PC": *Más información → Ejecutar de
  todas formas*. Dilo en la página de descarga y publica el sha256 del `setup.exe`. La integridad de las
  actualizaciones la garantiza la firma del updater.
- **Linux:** `.AppImage` (se autoactualiza), `.deb` y `.rpm` (la app solo avisa de la versión nueva). Sin firma; sha256 en
  las notas. Las claves de API usan el llavero Secret Service: hace falta `gnome-keyring` o KWallet con sesión
  de escritorio; sin él, la app debe mostrar un error claro.

## 6. Build y firma local en el Mac

Con el certificado en tu llavero y estas variables en la terminal (no en archivos; no las pegues en un script):

```sh
export APPLE_SIGNING_IDENTITY="Developer ID Application: Tu Nombre (TEAMID)"
export APPLE_ID="tu@correo.com"
export APPLE_PASSWORD="xxxx-xxxx-xxxx-xxxx"   # contraseña de app
export APPLE_TEAM_ID="TEAMID"
npm run release:mac
```

El script descarga el Node del host (`fetch:node`), compila el core y ejecuta `tauri build --bundles app,dmg`.
Tauri firma con `APPLE_SIGNING_IDENTITY` si está definida y notariza si están `APPLE_ID`, `APPLE_PASSWORD` y
`APPLE_TEAM_ID`; sin variables, la build sale sin firmar. Resultado en `src-tauri/target/release/bundle/`.
Compila solo la arquitectura del Mac donde lo ejecutas.

Verificación:

```sh
spctl -a -vv "src-tauri/target/release/bundle/macos/Kiji Office.app"   # accepted, source=Notarized Developer ID
codesign -dv --entitlements - "src-tauri/target/release/bundle/macos/Kiji Office.app/Contents/MacOS/kiji-node"  # allow-jit
```

Si Apple rechaza la notarización: `xcrun notarytool log <id> --apple-id … --team-id …`.

## Notas

- Intel (x64) se compila en `macos-14` con `--target x86_64-apple-darwin` (los runners Intel `macos-13` están retirados).
  El `fetch:node` descarga el Node x64 sin ejecutarlo, por lo que no hay problema de arquitectura.
- Acciones fijadas a la etiqueta mayor: `checkout@v7`, `setup-node@v7`, `rust-cache@v2`, `tauri-action@v1`,
  `dtolnay/rust-toolchain@stable`.
- El workflow crea `updater-artifacts.json` en el runner (`createUpdaterArtifacts: true`); el repo lo mantiene en `false`.
