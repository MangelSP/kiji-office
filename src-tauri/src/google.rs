// Inicio de sesión con Google para la app móvil (D7 de PLAN-movil.md): OAuth 2.0 para apps de escritorio con PKCE y
// redirección a 127.0.0.1. El refresh token vive solo en el llavero (`google:session`). La puerta valida el ID token;
// aquí solo se lee el correo del payload para mostrarlo.
//
// Configuración en tiempo de compilación (nada en el repo): KIJI_GOOGLE_CLIENT_ID y KIJI_GOOGLE_CLIENT_SECRET del
// cliente OAuth tipo «Escritorio». Google llama "secreto" al de un cliente de escritorio, pero no lo es: va dentro de
// la app y la seguridad la pone PKCE.
use crate::keyring;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64URL;
use sha2::{Digest, Sha256};
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::time::{Duration, Instant};

const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const ACCOUNT: &str = "google:session";
const LOGIN_TIMEOUT: Duration = Duration::from_secs(300);

fn client() -> Option<(&'static str, &'static str)> {
    Some((option_env!("KIJI_GOOGLE_CLIENT_ID")?, option_env!("KIJI_GOOGLE_CLIENT_SECRET").unwrap_or("")))
}

pub fn configured() -> bool {
    client().is_some()
}

fn random_b64(n: usize) -> String {
    let mut b = vec![0u8; n];
    rand::fill(&mut b[..]);
    B64URL.encode(b)
}

fn pkce_challenge(verifier: &str) -> String {
    B64URL.encode(Sha256::digest(verifier.as_bytes()))
}

/// Correo del payload de un ID token (sin verificar la firma: solo para mostrarlo).
pub fn email_of(id_token: &str) -> Option<String> {
    let payload = id_token.split('.').nth(1)?;
    let v: serde_json::Value = serde_json::from_slice(&B64URL.decode(payload.trim_end_matches('=')).ok()?).ok()?;
    v["email"].as_str().map(String::from)
}

/// Saca `code` de la primera línea de la petición del navegador (`GET /?state=..&code=.. HTTP/1.1`), comprobando `state`.
fn code_from_request(first_line: &str, state: &str) -> Result<String, String> {
    let path = first_line.split_whitespace().nth(1).ok_or("petición inválida")?;
    let url = url::Url::parse(&format!("http://127.0.0.1{path}")).map_err(|_| "petición inválida")?;
    let q: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
    if let Some(e) = q.get("error") {
        return Err(format!("Google rechazó el inicio de sesión: {e}"));
    }
    if q.get("state").map(String::as_str) != Some(state) {
        return Err("respuesta de Google inesperada (state)".into());
    }
    q.get("code").cloned().ok_or_else(|| "Google no devolvió el código".into())
}

/// Abre el navegador del sistema, espera la redirección y guarda el refresh token. Devuelve el correo.
pub async fn sign_in(open: impl FnOnce(&str) -> Result<(), String>) -> Result<String, String> {
    let (client_id, secret) = client().ok_or("falta configurar el cliente de Google (KIJI_GOOGLE_CLIENT_ID)")?;
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| format!("no se pudo abrir el puerto local: {e}"))?;
    let redirect = format!("http://127.0.0.1:{}", listener.local_addr().map_err(|e| e.to_string())?.port());
    let (verifier, state) = (random_b64(32), random_b64(16));
    let mut url = url::Url::parse(AUTH_URL).unwrap();
    url.query_pairs_mut()
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", &redirect)
        .append_pair("response_type", "code")
        .append_pair("scope", "openid email")
        .append_pair("code_challenge", &pkce_challenge(&verifier))
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", &state)
        .append_pair("access_type", "offline")
        .append_pair("prompt", "consent");
    open(url.as_str())?;

    let state2 = state.clone();
    let code = tokio::task::spawn_blocking(move || -> Result<String, String> {
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        let deadline = Instant::now() + LOGIN_TIMEOUT;
        loop {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let _ = stream.set_nonblocking(false);
                    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                    let mut line = String::new();
                    let _ = BufReader::new(&stream).read_line(&mut line);
                    if !line.starts_with("GET /?") {
                        let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
                        continue; // favicon u otra cosa del navegador
                    }
                    let res = code_from_request(&line, &state2);
                    let body = if res.is_ok() { "Listo. Ya puedes volver a Kiji Office." } else { "No se pudo iniciar sesión. Vuelve a Kiji Office." };
                    let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                    return res;
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    if Instant::now() > deadline {
                        return Err("se agotó el tiempo para iniciar sesión".into());
                    }
                    std::thread::sleep(Duration::from_millis(150));
                }
                Err(e) => return Err(e.to_string()),
            }
        }
    })
    .await
    .map_err(|e| e.to_string())??;

    let v = token_request(&[
        ("grant_type", "authorization_code"),
        ("code", &code),
        ("code_verifier", &verifier),
        ("redirect_uri", &redirect),
        ("client_id", client_id),
        ("client_secret", secret),
    ])
    .await?;
    let refresh = v["refresh_token"].as_str().ok_or("Google no devolvió un refresh token")?;
    let email = v["id_token"].as_str().and_then(email_of).unwrap_or_default();
    keyring::write(ACCOUNT, Some(refresh))?;
    Ok(email)
}

async fn token_request(form: &[(&str, &str)]) -> Result<serde_json::Value, String> {
    let res = reqwest::Client::new().post(TOKEN_URL).timeout(std::time::Duration::from_secs(20)).form(form).send().await.map_err(|e| format!("sin conexión con Google: {e}"))?;
    let status = res.status();
    let v: serde_json::Value = res.json().await.map_err(|e| format!("respuesta de Google inválida: {e}"))?;
    if !status.is_success() {
        // Solo el código de error: nunca el cuerpo completo (podría traer tokens).
        return Err(format!("Google respondió {status}: {}", v["error"].as_str().unwrap_or("?")));
    }
    Ok(v)
}

/// ID token fresco a partir del refresh token guardado. `Ok(None)` si no hay sesión.
pub async fn id_token() -> Result<Option<String>, String> {
    // Desarrollo: `KIJI_DEV_TOKEN=dev:<correo>` (la puerta solo lo acepta con DEV_INSECURE_TOKENS=1).
    #[cfg(debug_assertions)]
    if let Ok(t) = std::env::var("KIJI_DEV_TOKEN") {
        return Ok(Some(t));
    }
    let Some(refresh) = keyring::read(ACCOUNT)? else { return Ok(None) };
    let (client_id, secret) = client().ok_or("falta configurar el cliente de Google")?;
    let v = token_request(&[
        ("grant_type", "refresh_token"),
        ("refresh_token", &refresh),
        ("client_id", client_id),
        ("client_secret", secret),
    ])
    .await?;
    v["id_token"].as_str().map(|t| Some(t.to_string())).ok_or_else(|| "Google no devolvió un ID token".into())
}

pub fn sign_out() -> Result<(), String> {
    keyring::write(ACCOUNT, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_s256_del_rfc7636() {
        // Ejemplo del apéndice B del RFC 7636.
        assert_eq!(pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }

    #[test]
    fn codigo_de_la_redireccion() {
        assert_eq!(code_from_request("GET /?state=abc&code=4%2F0X HTTP/1.1", "abc").unwrap(), "4/0X");
        assert!(code_from_request("GET /?state=otro&code=x HTTP/1.1", "abc").is_err());
        assert!(code_from_request("GET /?error=access_denied&state=abc HTTP/1.1", "abc").is_err());
        assert!(code_from_request("GET /?state=abc HTTP/1.1", "abc").is_err());
    }

    #[test]
    fn correo_del_id_token() {
        let payload = B64URL.encode(br#"{"email":"a@b.com","sub":"1"}"#);
        assert_eq!(email_of(&format!("x.{payload}.y")).as_deref(), Some("a@b.com"));
        assert_eq!(email_of("basura"), None);
    }
}
