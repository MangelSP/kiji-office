// Detección de CLIs instalados. Una app GUI de macOS no hereda el PATH de la shell, así que se
// construye un PATH ampliado (PATH del proceso + rutas típicas) en vez de lanzar una shell de login:
// es más simple, más rápido y no ejecuta el .zshrc del usuario.
use serde::Serialize;
use std::env;
use std::ffi::OsString;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const CLIS: [&str; 6] = ["claude", "codex", "agy", "gemini", "ollama", "node"];
const VERSION_TIMEOUT: Duration = Duration::from_secs(3);
/// Versión mínima de Claude Code (= `claudeCodeVersion` del Agent SDK fijado). Si es menor, la UI avisa de `claude update`.
pub const MIN_CLAUDE_VERSION: (u64, u64, u64) = (2, 1, 308);

#[derive(Serialize, Clone)]
pub struct CliInfo {
    pub name: String,
    pub found: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    /// Solo `claude`: la versión instalada es menor que `MIN_CLAUDE_VERSION`.
    #[serde(rename = "tooOld")]
    pub too_old: bool,
}

/// Primer `X.Y.Z` de un texto como "2.1.308 (Claude Code)".
pub fn parse_version(s: &str) -> Option<(u64, u64, u64)> {
    let tok = s.split_whitespace().find(|t| t.trim_start_matches('v').starts_with(|c: char| c.is_ascii_digit()))?;
    let mut it = tok.trim_start_matches('v').split('.').map(|p| {
        p.chars().take_while(char::is_ascii_digit).collect::<String>().parse::<u64>().ok()
    });
    Some((it.next()??, it.next()??, it.next()??))
}

/// Directorios donde buscar: rutas típicas primero para ganar a un PATH pobre, luego el PATH del proceso.
pub fn search_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(home) = env::var_os("HOME").or_else(|| env::var_os("USERPROFILE")).map(PathBuf::from) {
        dirs.push(home.join(".local/bin"));
        dirs.push(home.join(".cargo/bin"));
        dirs.push(home.join(".claude/local"));
        // nvm: ~/.nvm/versions/node/<versión>/bin (la más reciente primero)
        if let Ok(rd) = std::fs::read_dir(home.join(".nvm/versions/node")) {
            let mut vers: Vec<PathBuf> = rd.flatten().map(|e| e.path().join("bin")).collect();
            vers.sort();
            vers.reverse();
            dirs.extend(vers);
        }
    }
    for d in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"] {
        dirs.push(PathBuf::from(d));
    }
    if let Some(path) = env::var_os("PATH") {
        dirs.extend(env::split_paths(&path));
    }
    let mut seen = std::collections::HashSet::new();
    dirs.retain(|d| d.is_dir() && seen.insert(d.clone()));
    dirs
}

/// PATH ampliado, para pasarlo a procesos hijos (los CLIs en Node necesitan encontrar `node`).
pub fn extended_path() -> OsString {
    env::join_paths(search_dirs()).unwrap_or_default()
}

fn is_executable(p: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        p.is_file() && p.metadata().map(|m| m.permissions().mode() & 0o111 != 0).unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        p.is_file()
    }
}

/// Busca `name` en los directorios de búsqueda; en Windows prefiere `.exe` sobre `.cmd`/`.bat`.
pub fn find_binary(name: &str) -> Option<PathBuf> {
    find_with(name, if cfg!(windows) { &[".exe", ".cmd", ".bat", ""] } else { &[""] })
}

/// Como `find_binary` pero solo binarios nativos (en Windows, solo `.exe`: el SDK rechaza los shims `.cmd`).
pub fn find_native(name: &str) -> Option<PathBuf> {
    find_with(name, if cfg!(windows) { &[".exe"] } else { &[""] })
}

fn find_with(name: &str, exts: &[&str]) -> Option<PathBuf> {
    for dir in search_dirs() {
        for ext in exts {
            let candidate = dir.join(format!("{name}{ext}"));
            if is_executable(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

/// Ejecuta `<bin> --version` con timeout; devuelve la primera línea o `None` si falla.
/// Entorno acotado y HOME apuntando a `probe_home`: algunos CLIs (gemini) escriben en `~` incluso con `--version`.
fn version_of(bin: &Path, probe_home: &Path) -> Option<String> {
    let mut cmd = Command::new(bin);
    cmd.arg("--version").env_clear().env("PATH", extended_path()).env("HOME", probe_home).env("USERPROFILE", probe_home);
    for var in ["SystemRoot", "TMPDIR", "TEMP", "TMP", "LANG"] {
        if let Some(v) = env::var_os(var) {
            cmd.env(var, v);
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = cmd.current_dir(probe_home)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;
    let start = Instant::now();
    let status = loop {
        match child.try_wait().ok()? {
            Some(s) => break s,
            None if start.elapsed() > VERSION_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            None => std::thread::sleep(Duration::from_millis(20)),
        }
    };
    if !status.success() {
        return None;
    }
    let mut out = String::new();
    child.stdout.take()?.read_to_string(&mut out).ok()?;
    let line = out.lines().map(str::trim).find(|l| !l.is_empty())?;
    Some(line.chars().take(200).collect())
}

fn probe(name: &str, probe_home: &Path) -> CliInfo {
    let path = if name == "claude" { find_native(name) } else { find_binary(name) };
    let version = path.as_deref().and_then(|p| version_of(p, probe_home));
    let too_old = name == "claude"
        && version.as_deref().and_then(parse_version).is_some_and(|v| v < MIN_CLAUDE_VERSION);
    CliInfo { name: name.to_string(), found: path.is_some(), path: path.map(|p| p.display().to_string()), version, too_old }
}

/// Un hilo por CLI: el peor caso total es un timeout, no seis.
#[tauri::command]
pub async fn detect_clis(app: tauri::AppHandle) -> Vec<CliInfo> {
    use tauri::Manager;
    let home = app
        .path()
        .app_cache_dir()
        .unwrap_or_else(|_| env::temp_dir().join("kiji-office"))
        .join("probe-home");
    let _ = std::fs::create_dir_all(&home);
    tauri::async_runtime::spawn_blocking(move || {
        let handles: Vec<_> = CLIS
            .iter()
            .map(|n| {
                let home = home.clone();
                std::thread::spawn(move || probe(n, &home))
            })
            .collect();
        handles.into_iter().filter_map(|h| h.join().ok()).collect()
    })
    .await
    .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    // Requiere `node` instalado (también lo exige el core). `--nocapture` muestra el resultado de los seis.
    #[test]
    fn detecta_node_y_los_demas_sin_fallar() {
        let home = env::temp_dir().join("kiji-probe-home-test");
        std::fs::create_dir_all(&home).unwrap();
        for n in CLIS {
            let i = probe(n, &home);
            println!("{} found={} version={:?} path={:?}", i.name, i.found, i.version, i.path);
        }
        let node = probe("node", &home);
        assert!(node.found && node.version.is_some_and(|v| v.starts_with('v')));
    }

    #[test]
    fn version_minima_de_claude() {
        assert_eq!(parse_version("2.1.308 (Claude Code)"), Some((2, 1, 308)));
        assert_eq!(parse_version("v24.11.0"), Some((24, 11, 0)));
        assert_eq!(parse_version("sin version"), None);
        assert!(parse_version("2.1.9").unwrap() < MIN_CLAUDE_VERSION);
        assert!(parse_version("2.2.0").unwrap() >= MIN_CLAUDE_VERSION);
    }
}
