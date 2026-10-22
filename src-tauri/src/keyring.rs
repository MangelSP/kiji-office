// Llavero del sistema: único sitio donde viven las claves de API (nunca en archivos ni en logs).
use keyring::{Entry, Error};

const SERVICE: &str = "kiji-office";

/// Cuentas permitidas y la variable de entorno con la que se entregan al core.
pub const ALLOWED: [(&str, &str); 3] = [
    ("anthropic", "ANTHROPIC_API_KEY"),
    ("openai", "OPENAI_API_KEY"),
    ("gemini", "GEMINI_API_KEY"),
];

fn entry(user: &str) -> Result<Entry, String> {
    if !ALLOWED.iter().any(|(u, _)| *u == user) {
        return Err(format!("cuenta no permitida: {user}"));
    }
    Entry::new(SERVICE, user).map_err(|e| format!("llavero no disponible: {e}"))
}

/// Lee una clave; `None` si no existe. Los errores del llavero no incluyen valores.
pub fn read(user: &str) -> Result<Option<String>, String> {
    match entry(user)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("no se pudo leer '{user}': {e}")),
    }
}

// Los comandos son async para que el acceso al llavero (puede mostrar un aviso del SO) no bloquee el hilo principal.
#[tauri::command]
pub async fn secret_set(user: String, value: String) -> Result<(), String> {
    entry(&user)?
        .set_password(&value)
        .map_err(|e| format!("no se pudo guardar '{user}': {e}"))
}

/// Al webview solo le llega si la clave existe y sus últimos 4 caracteres ("…abcd"): el valor completo
/// nunca sale de Rust (va directo al entorno del core).
#[tauri::command]
pub async fn secret_get(user: String) -> Result<Option<String>, String> {
    Ok(read(&user)?.map(|v| mask(&v)))
}

fn mask(v: &str) -> String {
    let n = v.chars().count();
    let tail: String = v.chars().skip(n.saturating_sub(4)).collect();
    if n <= 8 { "…".into() } else { format!("…{tail}") }
}

/// Borrar algo que no existe no es un error.
#[tauri::command]
pub async fn secret_delete(user: String) -> Result<(), String> {
    match entry(&user)?.delete_credential() {
        Ok(()) | Err(Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("no se pudo borrar '{user}': {e}")),
    }
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
