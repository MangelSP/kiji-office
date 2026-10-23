// Proceso hijo `kiji-core` (Node): Rust solo lo lanza, le inyecta las claves del llavero por entorno
// y hace de tubería NDJSON (stdout -> evento `core:line`, comando `core_send` -> stdin).
use crate::{detect, keyring};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

/// Reinicios automáticos seguidos permitidos antes de rendirse.
const MAX_RESTARTS: u32 = 3;
/// Si el core aguantó vivo este tiempo, el contador de reinicios vuelve a cero.
const STABLE_AFTER: Duration = Duration::from_secs(60);
/// Variables del sistema que el core (y los CLIs que lance) necesitan; todo lo demás no se hereda.
const PASS_ENV: [&str; 21] = [
    "HOME", "USER", "LOGNAME", "SHELL", "TERM", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TEMP", "TMP",
    "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR", "SSH_AUTH_SOCK",
    "SystemRoot", "APPDATA", "LOCALAPPDATA", "USERPROFILE", "PATHEXT", "COMSPEC",
];

/// Lee líneas sin rendirse ante bytes que no son UTF-8: una línea rara no debe parecer el fin del core.
fn lossy_lines(r: impl std::io::Read) -> impl Iterator<Item = String> {
    BufReader::new(r)
        .split(b'\n')
        .map_while(Result::ok)
        .map(|b| String::from_utf8_lossy(&b).trim_end_matches('\r').to_string())
}

/// Contador de ids de las peticiones que origina Rust (`rust:<n>`).
static RUST_REQ: AtomicU64 = AtomicU64::new(1);

/// Línea NDJSON `secrets.put` (`value` None = borrar, se envía como "": el core también acepta null). Es la única que lleva el valor: no se registra nunca.
fn put_line(n: u64, account: &str, value: Option<&str>) -> String {
    serde_json::json!({
        "id": format!("rust:{n}"), "type": "req", "method": "secrets.put",
        "params": { "account": account, "value": value.unwrap_or("") }
    })
    .to_string()
}

/// Línea NDJSON de una petición sin parámetros que origina Rust (`manager.stopAll` / `manager.resume`).
fn simple_req_line(n: u64, method: &str) -> String {
    serde_json::json!({ "id": format!("rust:{n}"), "type": "req", "method": method }).to_string()
}

/// Envía una petición sin parámetros al core en marcha. La respuesta (`rust:*`) se descarta; si el core aún
/// no conoce el método, el error también.
pub fn send_simple(app: &AppHandle, method: &str) {
    let state = app.state::<CoreState>();
    let mut g = state.0.lock().unwrap();
    if let Some(stdin) = g.stdin.as_mut() {
        let line = simple_req_line(RUST_REQ.fetch_add(1, Ordering::Relaxed), method);
        if let Err(e) = write_line(stdin, &line) {
            eprintln!("[core] no se pudo enviar {method}: {e}");
        }
    }
}

/// Efectos laterales de eventos que Rust también atiende (siguen reenviándose al webview).
fn side_effects(app: &AppHandle, line: &str) {
    if !(line.contains("\"notify\"") || line.contains("manager.halted")) {
        return;
    }
    let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { return };
    if v["type"] != "event" {
        return;
    }
    match v["name"].as_str() {
        Some("notify") => crate::notify::handle(app, &v["payload"]),
        Some("manager.halted") => {
            crate::lifecycle::set_halted(app, v["payload"]["halted"].as_bool().unwrap_or(false))
        }
        _ => {}
    }
}

/// Escribe una línea + salto en el escritor dado (el stdin del core, o uno falso en tests).
fn write_line<W: Write>(w: &mut W, line: &str) -> std::io::Result<()> {
    w.write_all(line.as_bytes())?;
    w.write_all(b"\n")?;
    w.flush()
}

fn send_put<W: Write>(w: &mut W, account: &str, value: Option<&str>) -> std::io::Result<()> {
    write_line(w, &put_line(RUST_REQ.fetch_add(1, Ordering::Relaxed), account, value))
}

/// ¿Es un mensaje que solo Rust puede enviar (id `rust:*` o método `secrets.put`)? Lo no parseable también se rechaza.
fn is_reserved(line: &str) -> bool {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { return true };
    v["id"].as_str().is_some_and(|i| i.starts_with("rust:") || i.starts_with(crate::remote::PREFIX))
        || v["method"].as_str() == Some("secrets.put")
}

/// Escribe una línea ya validada en el stdin del core (la usa el puente remoto).
pub fn send_line(state: &CoreState, line: &str) -> Result<(), String> {
    let mut g = state.0.lock().unwrap();
    let stdin = g.stdin.as_mut().ok_or("el core no está en marcha")?;
    write_line(stdin, line).map_err(|e| format!("no se pudo escribir en el core: {e}"))
}

/// Qué hacer con una línea de stdout del core.
#[derive(Debug, PartialEq)]
enum Route {
    Forward,
    Drop,
    /// `secrets.request`: cuentas pedidas (se consumen en Rust, no llegan al webview).
    SecretsRequest(Vec<String>),
}

fn route_line(line: &str) -> Route {
    if !(line.contains("rust") || line.contains("secrets.request")) {
        return Route::Forward;
    }
    let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { return Route::Forward };
    if v["id"].as_str().is_some_and(|i| i.starts_with("rust:")) {
        return Route::Drop;
    }
    if v["type"] == "event" && v["name"] == "secrets.request" {
        let accounts = v["payload"]["accounts"]
            .as_array()
            .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
            .unwrap_or_default();
        return Route::SecretsRequest(accounts);
    }
    Route::Forward
}

/// Empuja (o borra, con None) un secreto en el core en marcha. Si no hay core, no hace nada: lo pedirá al arrancar.
pub fn push_secret(state: &CoreState, account: &str, value: Option<&str>) {
    let mut g = state.0.lock().unwrap();
    if let Some(stdin) = g.stdin.as_mut() {
        if let Err(e) = send_put(stdin, account, value) {
            eprintln!("[core] no se pudo enviar el secreto de '{account}': {e}");
        }
    }
}

/// Responde a `secrets.request`: lee del llavero (fuera del Mutex, puede mostrar un aviso del SO) solo las
/// cuentas válidas y las empuja al core de esta generación. Solo se registra el nombre de la cuenta.
fn answer_secrets_request(app: &AppHandle, generation: u64, accounts: Vec<String>) {
    let mut found: Vec<(String, String)> = Vec::new();
    for account in accounts.into_iter().filter(|a| keyring::is_valid_account(a)) {
        match keyring::read(&account) {
            Ok(Some(v)) if !v.is_empty() => found.push((account, v)),
            Ok(_) => {}
            Err(e) => eprintln!("[core] {e}"),
        }
    }
    let state = app.state::<CoreState>();
    let mut g = state.0.lock().unwrap();
    if g.generation != generation {
        return;
    }
    let Some(stdin) = g.stdin.as_mut() else { return };
    for (account, value) in &found {
        if let Err(e) = send_put(stdin, account, Some(value)) {
            eprintln!("[core] no se pudo enviar el secreto de '{account}': {e}");
            return;
        }
    }
    eprintln!("[core] {} secretos enviados al core", found.len());
}

#[derive(Default)]
struct Inner {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    /// Se incrementa en cada arranque; los hilos de una ejecución vieja se reconocen por él y se retiran.
    generation: u64,
    restarts: u32,
    started_at: Option<Instant>,
    shutting_down: bool,
}

#[derive(Default)]
pub struct CoreState(Mutex<Inner>);

/// Triple de Rust del host (solo para localizar `binaries/node-<triple>` en debug).
#[cfg(debug_assertions)]
fn host_triple() -> &'static str {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "aarch64-apple-darwin"
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        "x86_64-apple-darwin"
    } else if cfg!(all(windows, target_arch = "x86_64")) {
        "x86_64-pc-windows-msvc"
    } else if cfg!(all(windows, target_arch = "aarch64")) {
        "aarch64-pc-windows-msvc"
    } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
        "aarch64-unknown-linux-gnu"
    } else {
        "x86_64-unknown-linux-gnu"
    }
}

/// Node que ejecuta el core. Release: el sidecar `kiji-node` junto al ejecutable (`Contents/MacOS/kiji-node`).
/// Debug: el sidecar descargado en `src-tauri/binaries/kiji-node-<triple>`. Si no existe, el `node` del sistema.
/// (Se llama `kiji-node` para no chocar con `/usr/bin/node` del paquete nodejs en .deb/.rpm.)
fn node_path() -> Result<PathBuf, String> {
    let ext = if cfg!(windows) { ".exe" } else { "" };
    #[cfg(not(debug_assertions))]
    let sidecar = std::env::current_exe().ok().and_then(|exe| exe.parent().map(|d| d.join(format!("kiji-node{ext}"))));
    #[cfg(debug_assertions)]
    let sidecar = Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("binaries/kiji-node-{}{ext}", host_triple())));
    if let Some(p) = sidecar.filter(|p| p.is_file()) {
        return Ok(p);
    }
    detect::find_binary("node").ok_or_else(|| "no se encontró el sidecar `kiji-node` ni `node` (se necesita Node >= 22.13)".to_string())
}

/// Crea `<dir>/node[.exe]` apuntando a `node` (enlace simbólico; en Windows enlace duro o, si no, copia) para que
/// las CLIs con `#!/usr/bin/env node` (Gemini) encuentren Node aunque el sidecar se llame `kiji-node`.
fn ensure_node_shim(dir: &std::path::Path, node: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let link = dir.join(if cfg!(windows) { "node.exe" } else { "node" });
    if std::fs::symlink_metadata(&link).is_ok() {
        std::fs::remove_file(&link)?;
    }
    #[cfg(unix)]
    return std::os::unix::fs::symlink(node, &link);
    #[cfg(windows)]
    return std::fs::hard_link(node, &link).or_else(|_| std::fs::copy(node, &link).map(|_| ()));
}

/// Entrada del core. Release: recurso empaquetado `core/kiji-core.mjs`. Debug: `core/dist/index.js` del repo
/// (fijado en tiempo de compilación, no depende del cwd) o, si no existe, `core/dist/kiji-core.mjs`.
fn core_entry(app: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    let path = {
        let _ = app;
        let dist = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../core/dist");
        if dist.join("index.js").is_file() { dist.join("index.js") } else { dist.join("kiji-core.mjs") }
    };
    #[cfg(not(debug_assertions))]
    let path = app.path().resource_dir().map_err(|e| e.to_string())?.join("core/kiji-core.mjs");
    path.canonicalize()
        .map_err(|_| format!("no existe {} (¿falta `npm run build:core`?)", path.display()))
}

/// PATH del core: la carpeta de shims (con `node`) al frente (Gemini CLI, que es una app Node, funciona sin Node
/// instalado) y después el PATH ampliado.
fn child_path(shims: &std::path::Path) -> std::ffi::OsString {
    let mut dirs: Vec<PathBuf> = vec![shims.to_path_buf()];
    dirs.extend(std::env::split_paths(&detect::extended_path()));
    std::env::join_paths(dirs).unwrap_or_default()
}

/// Emite un evento sintético con la misma forma que los del core (`{type:"event",name,payload}`).
fn emit_event(app: &AppHandle, name: &str, payload: serde_json::Value) {
    let line = serde_json::json!({ "type": "event", "name": name, "payload": payload }).to_string();
    let _ = app.emit("core:line", line);
}

/// Lanza el core y sus hilos de relé. Debe llamarse con el Mutex tomado.
fn spawn(app: &AppHandle, inner: &mut Inner) -> Result<(), String> {
    let entry = core_entry(app)?;
    let node = node_path()?;
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&data_dir).map_err(|e| format!("no se pudo crear el directorio de datos: {e}"))?;
    let db = data_dir.join("kiji.db");
    let shims = data_dir.join("shims");
    if let Err(e) = ensure_node_shim(&shims, &node) {
        eprintln!("[core] no se pudo crear el shim de node: {e}");
    }

    let mut cmd = Command::new(&node);
    cmd.arg(&entry).arg("--db").arg(&db);
    // Entorno limpio: así ninguna variable heredada (ANTHROPIC_BASE_URL, GOOGLE_API_KEY…) cambia a qué
    // endpoint van las claves, y el core se comporta igual lanzado desde la terminal o desde Finder.
    cmd.env_clear();
    for var in PASS_ENV {
        if let Some(v) = std::env::var_os(var) {
            cmd.env(var, v);
        }
    }
    // PATH ampliado: el core lanzará claude/codex/git y una app GUI de macOS no hereda el PATH de la shell.
    cmd.env("PATH", child_path(&shims));
    // Ruta del `claude` nativo instalado por el usuario (el adaptador la usa como pathToClaudeCodeExecutable).
    if let Some(claude) = detect::find_native("claude") {
        cmd.env("KIJI_CLAUDE_PATH", claude);
    }
    // El llavero es la única fuente de claves.
    let mut secrets: Vec<String> = Vec::new();
    for (user, var) in keyring::ALLOWED {
        match keyring::read(user) {
            Ok(Some(v)) if !v.is_empty() => {
                cmd.env(var, &v);
                secrets.push(v);
            }
            Ok(_) => {}
            Err(e) => eprintln!("[core] {e}"),
        }
    }
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }

    let mut child = cmd.spawn().map_err(|e| format!("no se pudo lanzar el core: {e}"))?;
    let stdout = child.stdout.take().ok_or("sin stdout")?;
    let stderr = child.stderr.take().ok_or("sin stderr")?;
    inner.stdin = child.stdin.take();
    inner.child = Some(child);
    inner.generation += 1;
    inner.started_at = Some(Instant::now());
    let generation = inner.generation;
    eprintln!("[core] lanzado (generación {generation}, {} claves del llavero)", secrets.len());

    // stdout: cada línea es un mensaje NDJSON para el frontend.
    let app_out = app.clone();
    std::thread::spawn(move || {
        for line in lossy_lines(stdout) {
            if line.is_empty() {
                continue;
            }
            match route_line(&line) {
                Route::Drop => continue,
                Route::SecretsRequest(accounts) => {
                    answer_secrets_request(&app_out, generation, accounts);
                    continue;
                }
                Route::Forward => {}
            }
            if app_out.state::<crate::remote::RemoteState>().dispatch(&line) {
                continue; // respuesta a un cliente remoto: no es para la ventana
            }
            log_milestones(&line);
            side_effects(&app_out, &line);
            let _ = app_out.emit("core:line", line);
        }
        on_exit(&app_out, generation);
    });

    // stderr: al log de Rust, tapando cualquier valor de clave por si el core lo imprimiera.
    std::thread::spawn(move || {
        for mut line in lossy_lines(stderr) {
            for s in secrets.iter().filter(|s| s.len() >= 8) {
                line = line.replace(s.as_str(), "***");
            }
            eprintln!("[core:stderr] {line}");
        }
    });
    Ok(())
}

/// Hitos para el log de Rust. No imprime el contenido de las líneas.
fn log_milestones(line: &str) {
    if !(line.contains("core.ready") || (cfg!(debug_assertions) && line.contains("pong"))) {
        return;
    }
    let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { return };
    if v["type"] == "event" && v["name"] == "core.ready" {
        eprintln!("[core] core listo");
    } else if cfg!(debug_assertions) && v["type"] == "res" && v["result"] == "pong" {
        eprintln!("[core] core → pong recibido");
    }
}

/// El stdout del core se cerró: murió (o lo mataron). Reinicia hasta MAX_RESTARTS veces.
fn on_exit(app: &AppHandle, generation: u64) {
    let state = app.state::<CoreState>();
    let attempt = {
        let mut g = state.0.lock().unwrap();
        if g.generation != generation || g.shutting_down {
            return; // reinicio manual o cierre de la app: no es un fallo
        }
        g.stdin = None;
        let mut code = None;
        if let Some(mut c) = g.child.take() {
            let _ = c.kill(); // por si cerró stdout pero sigue vivo
            code = c.wait().ok().and_then(|s| s.code());
        }
        if g.started_at.is_some_and(|t| t.elapsed() > STABLE_AFTER) {
            g.restarts = 0;
        }
        if g.restarts >= MAX_RESTARTS {
            eprintln!("[core] murió (código {code:?}); se agotaron los {MAX_RESTARTS} reinicios");
            drop(g);
            emit_event(app, "core.crashed", serde_json::json!({ "code": code, "willRestart": false }));
            return;
        }
        g.restarts += 1;
        eprintln!("[core] murió (código {code:?}); reinicio {}/{MAX_RESTARTS}", g.restarts);
        g.restarts
    };
    emit_event(app, "core.crashed", serde_json::json!({ "willRestart": true, "attempt": attempt }));
    std::thread::sleep(Duration::from_millis(500 * u64::from(attempt)));
    let mut g = state.0.lock().unwrap();
    if g.generation != generation || g.shutting_down {
        return; // mientras esperábamos hubo un reinicio manual
    }
    if let Err(e) = spawn(app, &mut g) {
        eprintln!("[core] no se pudo relanzar: {e}");
        drop(g);
        emit_event(app, "core.crashed", serde_json::json!({ "error": e, "willRestart": false }));
    }
}

/// Cierra stdin para que el core termine solo (y cierre la BD) y lo mata si en 1 s no lo hizo.
fn stop(inner: &mut Inner) {
    inner.stdin = None;
    if let Some(mut c) = inner.child.take() {
        for _ in 0..20 {
            if matches!(c.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = c.kill();
        let _ = c.wait();
    }
}

/// Arranque inicial (desde `setup`).
pub fn start(app: &AppHandle) {
    let state = app.state::<CoreState>();
    let mut g = state.0.lock().unwrap();
    if let Err(e) = spawn(app, &mut g) {
        eprintln!("[core] no se pudo iniciar: {e}");
        drop(g);
        emit_event(app, "core.crashed", serde_json::json!({ "error": e, "willRestart": false }));
    }
}

/// Cierre de la app: no reiniciar y matar al hijo.
pub fn shutdown(app: &AppHandle) {
    let state = app.state::<CoreState>();
    let mut g = state.0.lock().unwrap();
    g.shutting_down = true;
    stop(&mut g);
}

/// Vuelve a lanzar el core tras un `shutdown` que no acabó en salida (p. ej. la instalación de una actualización falló).
pub fn relaunch(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<CoreState>();
    let mut g = state.0.lock().unwrap();
    g.shutting_down = false;
    g.restarts = 0;
    stop(&mut g);
    spawn(app, &mut g)
}

/// Escribe una línea NDJSON en el stdin del core.
#[tauri::command]
pub async fn core_send(state: State<'_, CoreState>, line: String) -> Result<(), String> {
    let line = line.trim_end_matches(['\r', '\n']);
    if line.contains(['\r', '\n']) {
        return Err("la línea no puede contener saltos de línea".into());
    }
    if is_reserved(line) {
        return Err("mensaje reservado (id `rust:*` o `remote:*`, o `secrets.put`)".into());
    }
    send_line(&state, line)
}

/// Reinicia el core (p. ej. tras guardar claves nuevas) y vuelve a poner a cero el contador de fallos.
#[tauri::command]
pub async fn core_restart(app: AppHandle, state: State<'_, CoreState>) -> Result<(), String> {
    let mut g = state.0.lock().unwrap();
    g.shutting_down = false;
    g.restarts = 0;
    stop(&mut g);
    spawn(&app, &mut g)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_del_hijo_empieza_por_los_shims() {
        let dir = std::env::temp_dir().join("shims");
        let p = child_path(&dir);
        assert_eq!(std::env::split_paths(&p).next().unwrap(), dir);
    }

    #[cfg(unix)]
    #[test]
    fn shim_node_apunta_al_sidecar_y_se_regenera() {
        let base = std::env::temp_dir().join(format!("kiji-shim-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let (a, b) = (base.join("kiji-node-a"), base.join("kiji-node-b"));
        std::fs::write(&a, "a").unwrap();
        std::fs::write(&b, "b").unwrap();
        let shims = base.join("shims");
        ensure_node_shim(&shims, &a).unwrap();
        assert_eq!(std::fs::read_link(shims.join("node")).unwrap(), a);
        ensure_node_shim(&shims, &b).unwrap(); // arranque posterior con otra ruta (p. ej. tras actualizar)
        assert_eq!(std::fs::read_link(shims.join("node")).unwrap(), b);
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn linea_secrets_put() {
        let mut buf: Vec<u8> = Vec::new();
        send_put(&mut buf, "conn:x", Some("sk-\"1\"")).unwrap();
        send_put(&mut buf, "conn:x", None).unwrap();
        let s = String::from_utf8(buf).unwrap();
        let ls: Vec<serde_json::Value> = s.lines().map(|l| serde_json::from_str(l).unwrap()).collect();
        assert_eq!(ls.len(), 2);
        assert!(s.ends_with('\n'));
        assert_eq!(ls[0]["type"], "req");
        assert_eq!(ls[0]["method"], "secrets.put");
        assert_eq!(ls[0]["params"]["account"], "conn:x");
        assert_eq!(ls[0]["params"]["value"], "sk-\"1\"");
        assert_eq!(ls[1]["params"]["value"], "");
        let id = |i: usize| ls[i]["id"].as_str().unwrap().strip_prefix("rust:").unwrap().parse::<u64>().unwrap();
        assert!(id(1) > id(0));
    }

    #[test]
    fn peticion_stop_all() {
        let v: serde_json::Value = serde_json::from_str(&simple_req_line(7, "manager.stopAll")).unwrap();
        assert_eq!(v["id"], "rust:7");
        assert_eq!(v["type"], "req");
        assert_eq!(v["method"], "manager.stopAll");
        assert!(is_reserved(&simple_req_line(8, "manager.resume")));
    }

    #[test]
    fn core_send_rechaza_reservados() {
        assert!(is_reserved(r#"{"id":"rust:1","type":"req","method":"ping"}"#));
        assert!(is_reserved(r#"{"id":"a","type":"req","method":"secrets.put","params":{}}"#));
        assert!(is_reserved(r#"{"id":"\u0072ust:9","method":"x"}"#));
        assert!(is_reserved("no es json"));
        assert!(!is_reserved(r#"{"id":"web:1","type":"req","method":"ping"}"#));
        assert!(is_reserved(r#"{"id":"remote:1:a","type":"req","method":"ping"}"#));
        assert!(!is_reserved(r#"{"id":"1","type":"req","method":"secrets.putx"}"#));
    }

    #[test]
    fn filtro_de_lineas_del_core() {
        assert_eq!(route_line(r#"{"id":"rust:3","type":"res","result":null}"#), Route::Drop);
        assert_eq!(route_line(r#"{"id":"web:3","type":"res","result":"rust:"}"#), Route::Forward);
        assert_eq!(route_line(r#"{"type":"event","name":"core.ready","payload":{}}"#), Route::Forward);
        assert_eq!(
            route_line(r#"{"type":"event","name":"secrets.request","payload":{"accounts":["openai","conn:a",7]}}"#),
            Route::SecretsRequest(vec!["openai".into(), "conn:a".into()])
        );
    }
}
