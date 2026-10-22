// Proceso hijo `kiji-core` (Node): Rust solo lo lanza, le inyecta las claves del llavero por entorno
// y hace de tubería NDJSON (stdout -> evento `core:line`, comando `core_send` -> stdin).
use crate::{detect, keyring};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
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

/// Ruta de `core/dist/index.js`. En debug sale de la raíz del repo (fijada en tiempo de compilación,
/// no depende del cwd). En release se espera como recurso empaquetado (se resolverá bien en 0.3 con el sidecar).
fn core_entry(app: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    let path = {
        let _ = app;
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../core/dist/index.js")
    };
    #[cfg(not(debug_assertions))]
    let path = app.path().resource_dir().map_err(|e| e.to_string())?.join("core/dist/index.js");
    path.canonicalize()
        .map_err(|_| format!("no existe {} (¿falta `npm run build:core`?)", path.display()))
}

/// Emite un evento sintético con la misma forma que los del core (`{type:"event",name,payload}`).
fn emit_event(app: &AppHandle, name: &str, payload: serde_json::Value) {
    let line = serde_json::json!({ "type": "event", "name": name, "payload": payload }).to_string();
    let _ = app.emit("core:line", line);
}

/// Lanza el core y sus hilos de relé. Debe llamarse con el Mutex tomado.
fn spawn(app: &AppHandle, inner: &mut Inner) -> Result<(), String> {
    let entry = core_entry(app)?;
    let node = detect::find_binary("node").ok_or("no se encontró `node` (se necesita Node >= 22.13)")?;
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&data_dir).map_err(|e| format!("no se pudo crear el directorio de datos: {e}"))?;
    let db = data_dir.join("kiji.db");

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
    cmd.env("PATH", detect::extended_path());
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
            log_milestones(&line);
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

/// Escribe una línea NDJSON en el stdin del core.
#[tauri::command]
pub async fn core_send(state: State<'_, CoreState>, line: String) -> Result<(), String> {
    let line = line.trim_end_matches(['\r', '\n']);
    if line.contains(['\r', '\n']) {
        return Err("la línea no puede contener saltos de línea".into());
    }
    let mut g = state.0.lock().unwrap();
    let stdin = g.stdin.as_mut().ok_or("el core no está en marcha")?;
    stdin
        .write_all(line.as_bytes())
        .and_then(|_| stdin.write_all(b"\n"))
        .and_then(|_| stdin.flush())
        .map_err(|e| format!("no se pudo escribir en el core: {e}"))
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
