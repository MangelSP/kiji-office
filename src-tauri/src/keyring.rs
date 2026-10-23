// Llavero del sistema: único sitio donde viven las claves de API (nunca en archivos ni en logs).
use crate::core_process::{self, CoreState};
use keyring::{Entry, Error};
use tauri::State;

const SERVICE: &str = "kiji-office";

/// Cuentas permitidas y la variable de entorno con la que se entregan al core.
pub const ALLOWED: [(&str, &str); 3] = [
    ("anthropic", "ANTHROPIC_API_KEY"),
    ("openai", "OPENAI_API_KEY"),
    ("gemini", "GEMINI_API_KEY"),
];

/// `conn:<uuid v4 en minúsculas>` (8-4-4-4-12 hex, versión 4, variante 8/9/a/b). Sin crate regex: es estricta a mano.
pub fn is_conn_account(user: &str) -> bool {
    let Some(id) = user.strip_prefix("conn:") else { return false };
    let b = id.as_bytes();
    if b.len() != 36 {
        return false;
    }
    b.iter().enumerate().all(|(i, c)| match i {
        8 | 13 | 18 | 23 => *c == b'-',
        14 => *c == b'4',
        19 => matches!(c, b'8' | b'9' | b'a' | b'b'),
        _ => matches!(c, b'0'..=b'9' | b'a'..=b'f'),
    })
}

/// Cuentas internas de la app móvil (PLAN-movil.md, M1): la sesión de Google y la clave privada X25519 del Mac.
/// Solo las usa Rust: la UI no puede leerlas ni escribirlas (ver `ui_account`).
pub const INTERNAL: [&str; 2] = ["google:session", "device:mac"];

/// Cuenta fija permitida o conexión válida.
pub fn is_valid_account(user: &str) -> bool {
    ALLOWED.iter().any(|(u, _)| *u == user) || is_conn_account(user) || INTERNAL.contains(&user)
}

/// Lo que la UI puede tocar por los comandos `secret_*`: todo menos las cuentas internas.
fn ui_account(user: &str) -> Result<(), String> {
    if INTERNAL.contains(&user) {
        return Err(format!("cuenta no permitida: {user}"));
    }
    Ok(())
}

/// Guarda o borra (con None) una cuenta desde Rust.
pub fn write(user: &str, value: Option<&str>) -> Result<(), String> {
    let e = entry(user)?;
    match value {
        Some(v) => e.set_password(v).map_err(|e| format!("no se pudo guardar '{user}': {e}")),
        None => match e.delete_credential() {
            Ok(()) | Err(Error::NoEntry) => Ok(()),
            Err(err) => Err(format!("no se pudo borrar '{user}': {err}")),
        },
    }
}

fn entry(user: &str) -> Result<Entry, String> {
    if !is_valid_account(user) {
        return Err(format!("cuenta no permitida: {user}"));
    }
    Entry::new(SERVICE, user).map_err(|e| format!("llavero no disponible: {e}"))
}

/// Lee una clave; `None` si no existe. Los errores del llavero no incluyen valores.
pub fn read(user: &str) -> Result<Option<String>, String> {
    // Solo desarrollo: pruebas automáticas sin los avisos del llavero (las claves de IA se tratan como vacías).
    #[cfg(debug_assertions)]
    if std::env::var("KIJI_DEV_SKIP_KEYCHAIN").is_ok() && !INTERNAL.contains(&user) {
        return Ok(None);
    }
    match entry(user)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("no se pudo leer '{user}': {e}")),
    }
}

// Los comandos son async para que el acceso al llavero (puede mostrar un aviso del SO) no bloquee el hilo principal.
#[tauri::command]
pub async fn secret_set(state: State<'_, CoreState>, user: String, value: String) -> Result<(), String> {
    ui_account(&user)?;
    entry(&user)?
        .set_password(&value)
        .map_err(|e| format!("no se pudo guardar '{user}': {e}"))?;
    if is_conn_account(&user) {
        core_process::push_secret(&state, &user, Some(&value));
    }
    Ok(())
}

/// Al webview solo le llega si la clave existe y sus últimos 4 caracteres ("…abcd"): el valor completo
/// nunca sale de Rust (va directo al entorno del core).
#[tauri::command]
pub async fn secret_get(user: String) -> Result<Option<String>, String> {
    ui_account(&user)?;
    Ok(read(&user)?.map(|v| mask(&v)))
}

fn mask(v: &str) -> String {
    let n = v.chars().count();
    let tail: String = v.chars().skip(n.saturating_sub(4)).collect();
    if n <= 8 { "…".into() } else { format!("…{tail}") }
}

/// Borrar algo que no existe no es un error.
#[tauri::command]
pub async fn secret_delete(state: State<'_, CoreState>, user: String) -> Result<(), String> {
    ui_account(&user)?;
    match entry(&user)?.delete_credential() {
        Ok(()) | Err(Error::NoEntry) => {}
        Err(e) => return Err(format!("no se pudo borrar '{user}': {e}")),
    }
    if is_conn_account(&user) {
        core_process::push_secret(&state, &user, None);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enmascara_sin_revelar_la_clave() {
        assert_eq!(mask("sk-ant-1234567890abcd"), "…abcd");
        assert_eq!(mask("corta"), "…");
        assert_eq!(mask(""), "…");
    }

    #[test]
    fn regex_de_cuentas_conn() {
        let ok = "conn:3f2b8c1e-5a4d-4e7f-9b6a-0123456789ab";
        assert!(is_conn_account(ok));
        assert!(is_valid_account(ok));
        assert!(is_valid_account("openai"));
        for mal in [
            "conn:",
            "conn:3F2B8C1E-5A4D-4E7F-9B6A-0123456789AB", // mayúsculas
            "conn:3f2b8c1e-5a4d-1e7f-9b6a-0123456789ab", // no es v4
            "conn:3f2b8c1e-5a4d-4e7f-cb6a-0123456789ab", // variante inválida
            "conn:3f2b8c1e-5a4d-4e7f-9b6a-0123456789abc", // larga
            "conn:3f2b8c1e-5a4d-4e7f-9b6a-0123456789a",  // corta
            "conn:3f2b8c1e5a4d4e7f9b6a0123456789ab",     // sin guiones
            "conn:3f2b8c1e-5a4d-4e7f-9b6a-0123456789ab\n",
            " conn:3f2b8c1e-5a4d-4e7f-9b6a-0123456789ab",
            "conn:../3f2b8c1e-5a4d-4e7f-9b6a-0123456789",
            "conn:ñf2b8c1e-5a4d-4e7f-9b6a-0123456789ab",
        ] {
            assert!(!is_valid_account(mal), "{mal:?}");
            assert!(entry(mal).is_err());
        }
    }

    #[test]
    fn cuentas_internas_fuera_del_alcance_de_la_ui() {
        for u in INTERNAL {
            assert!(is_valid_account(u));
            assert!(ui_account(u).is_err());
        }
        assert!(ui_account("openai").is_ok());
    }

    #[test]
    fn rechaza_cuentas_desconocidas() {
        assert!(entry("otra").is_err());
        assert!(entry("").is_err());
        assert!(entry("Anthropic").is_err());
    }

    // Toca el llavero real, solo la cuenta `anthropic` con un valor de prueba: `cargo test -- --ignored`.
    // OJO: sobrescribe y luego borra la clave `anthropic` si el usuario ya tenía una guardada.
    #[test]
    #[ignore]
    fn roundtrip_en_llavero_real() {
        let previo = read("anthropic").expect("lectura previa");
        assert!(previo.is_none(), "ya hay una clave 'anthropic' real; no se pisa");
        let e = entry("anthropic").unwrap();
        e.set_password("kiji-test-123").unwrap();
        assert_eq!(read("anthropic").unwrap().as_deref(), Some("kiji-test-123"));
        match e.delete_credential() {
            Ok(()) => {}
            Err(err) => panic!("limpieza fallida: {err}"),
        }
        assert_eq!(read("anthropic").unwrap(), None);
    }
}
