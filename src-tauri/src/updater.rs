// Actualizaciones automáticas (tauri-plugin-updater + GitHub Releases). La UI decide cuándo comprobar e instalar
// (nunca con robots trabajando); aquí solo se consulta el endpoint y se instala.
//
// Configuración en `tauri.conf.json` → `plugins.updater`:
//  - `endpoints`: `https://github.com/<OWNER>/<REPO>/releases/latest/download/latest.json`
//  - `pubkey`: clave pública minisign (`npx tauri signer generate`).
// Mientras alguno de los dos contenga el marcador `REEMPLAZAR_` no se hace red y se devuelve un error legible.
use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

pub const PLACEHOLDER: &str = "REEMPLAZAR_";
const NOT_YET: &str = "Las actualizaciones se activarán cuando se publique la primera versión.";

#[derive(Debug, Serialize, PartialEq)]
pub struct UpdateInfo {
    pub available: bool,
    pub version: String,
    pub notes: Option<String>,
    pub date: Option<String>,
}

/// `Err` con texto para el usuario si la configuración del updater aún tiene marcadores.
pub fn ensure_configured(config: Option<&serde_json::Value>) -> Result<(), String> {
    let Some(cfg) = config else { return Err(NOT_YET.into()) };
    if cfg.to_string().contains(PLACEHOLDER) {
        return Err(NOT_YET.into());
    }
    Ok(())
}

/// Resumen para la UI; `None` si no hay versión nueva.
pub fn summarize(version: &str, body: Option<&str>, date: Option<String>) -> UpdateInfo {
    UpdateInfo {
        available: true,
        version: version.to_string(),
        notes: body.map(str::trim).filter(|s| !s.is_empty()).map(String::from),
        date,
    }
}

/// En Linux solo el AppImage se autoactualiza (define `APPIMAGE`); `.deb`/`.rpm` se actualizan a mano.
fn ensure_supported() -> Result<(), String> {
    if cfg!(target_os = "linux") && std::env::var_os("APPIMAGE").is_none() {
        return Err("Esta instalación (.deb/.rpm) no se actualiza sola: descarga la nueva versión desde la página de descargas.".into());
    }
    Ok(())
}

fn check_config(app: &AppHandle) -> Result<(), String> {
    ensure_configured(app.config().plugins.0.get("updater"))?;
    ensure_supported()
}

#[tauri::command]
pub async fn check_update(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    check_config(&app)?;
    let updater = app.updater().map_err(|e| e.to_string())?;
    let found = updater.check().await.map_err(|e| format!("No se pudo comprobar: {e}"))?;
    Ok(found.map(|u| summarize(&u.version, u.body.as_deref(), u.date.map(|d| d.to_string()))))
}

const BUSY: &str = "Hay robots trabajando: espera a que terminen o detenlos";

/// La UI ya lo comprueba, pero Rust es quien lo impone: no se instala con robots trabajando.
fn ensure_idle(busy: u32) -> Result<(), String> {
    if busy > 0 { Err(BUSY.into()) } else { Ok(()) }
}

#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    check_config(&app)?;
    ensure_idle(crate::lifecycle::busy_count(&app))?;
    // En Windows el plugin llama a `std::process::exit(0)` dentro de `install`, así que ni `shutdown` ni `restart`
    // llegan a ejecutarse: el hook libera `kiji-node.exe` justo antes de lanzar el instalador.
    let hook_app = app.clone();
    let updater = app
        .updater_builder()
        .on_before_exit(move || crate::core_process::shutdown(&hook_app))
        .build()
        .map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| format!("No se pudo comprobar: {e}"))? else {
        return Err("Ya tienes la última versión.".into());
    };
    let bytes = update
        .download(|_, _| {}, || {})
        .await
        .map_err(|e| format!("No se pudo descargar: {e}"))?;
    // La descarga es larga: puede haberse puesto a trabajar algún robot mientras tanto.
    ensure_idle(crate::lifecycle::busy_count(&app))?;
    // Se para el core antes de sustituir la app (en Windows, `node.exe` bloquearía el instalador).
    crate::core_process::shutdown(&app);
    if let Err(e) = update.install(bytes) {
        if let Err(r) = crate::core_process::relaunch(&app) {
            eprintln!("[updater] no se pudo relanzar el core: {r}");
        }
        return Err(format!("No se pudo instalar: {e}"));
    }
    // `restart` no emite `RunEvent::Exit`; el core ya está parado.
    app.restart()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn marcador_en_endpoint_o_clave_no_hace_red() {
        let ep = json!({"endpoints": ["https://github.com/REEMPLAZAR_OWNER/REEMPLAZAR_REPO/releases/latest/download/latest.json"], "pubkey": "abc"});
        assert_eq!(ensure_configured(Some(&ep)).unwrap_err(), NOT_YET);
        let key = json!({"endpoints": ["https://github.com/a/b/releases/latest/download/latest.json"], "pubkey": "REEMPLAZAR_CLAVE_PUBLICA"});
        assert_eq!(ensure_configured(Some(&key)).unwrap_err(), NOT_YET);
        assert!(ensure_configured(None).is_err());
    }

    #[test]
    fn se_niega_con_robots_trabajando() {
        assert_eq!(ensure_idle(1).unwrap_err(), BUSY);
        assert_eq!(ensure_idle(3).unwrap_err(), BUSY);
        assert!(ensure_idle(0).is_ok());
    }

    #[test]
    fn configuracion_real_pasa() {
        let ok = json!({"endpoints": ["https://github.com/a/b/releases/latest/download/latest.json"], "pubkey": "dW50cnVzdGVk"});
        assert!(ensure_configured(Some(&ok)).is_ok());
    }

    #[test]
    fn resume_notas_y_fecha() {
        let i = summarize("0.4.0", Some("  \n"), Some("2026-01-01".into()));
        assert_eq!(i, UpdateInfo { available: true, version: "0.4.0".into(), notes: None, date: Some("2026-01-01".into()) });
        assert_eq!(summarize("0.4.0", Some(" Mejoras "), None).notes.as_deref(), Some("Mejoras"));
        let v = serde_json::to_value(&i).unwrap();
        assert_eq!(v["available"], true);
        assert_eq!(v["version"], "0.4.0");
    }
}
