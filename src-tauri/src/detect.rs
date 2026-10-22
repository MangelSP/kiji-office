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

#[derive(Serialize, Clone)]
pub struct CliInfo {
    pub name: String,
    pub found: bool,
    pub path: Option<String>,
    pub version: Option<String>,
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

pub fn find_binary(name: &str) -> Option<PathBuf> {
    let exts: &[&str] = if cfg!(windows) { &[".exe", ".cmd", ".bat", ""] } else { &[""] };
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
fn version_of(bin: &Path) -> Option<String> {
    let mut child = Command::new(bin)
        .arg("--version")
        .env("PATH", extended_path())
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

fn probe(name: &str) -> CliInfo {
    let path = find_binary(name);
    let version = path.as_deref().and_then(version_of);
    CliInfo { name: name.to_string(), found: path.is_some(), path: path.map(|p| p.display().to_string()), version }
}

/// Un hilo por CLI: el peor caso total es un timeout, no seis.
#[tauri::command]
pub async fn detect_clis() -> Vec<CliInfo> {
    tauri::async_runtime::spawn_blocking(|| {
        let handles: Vec<_> = CLIS.iter().map(|n| std::thread::spawn(move || probe(n))).collect();
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
        for n in CLIS {
            let i = probe(n);
            println!("{} found={} version={:?} path={:?}", i.name, i.found, i.version, i.path);
        }
        let node = probe("node");
        assert!(node.found && node.version.is_some_and(|v| v.starts_with('v')));
    }
}
