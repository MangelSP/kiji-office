// App móvil, lado del Mac (M1 de PLAN-movil.md, sección 7): sesión con la puerta, WebSocket saliente al relay del
// usuario, emparejamiento por QR y cifrado de punta a punta. Lo que el móvil pide pasa por `remote::handle_line` (la
// lista blanca de M0); lo que el core emite vuelve cifrado solo a los móviles vinculados y conectados.
//
// Guardado: la clave privada X25519 del Mac en el llavero (`device:mac`); los móviles vinculados (claves públicas,
// nada secreto) en `mobile.json` de la carpeta de datos.
use crate::{google, keyring, remote::RemoteState};
use base64::Engine;
use base64::engine::general_purpose::{STANDARD as B64, URL_SAFE_NO_PAD as B64URL};
use crypto_box::aead::{Aead, AeadCore, OsRng};
use crypto_box::{Nonce, PublicKey, SalsaBox, SecretKey};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};
use tokio_tungstenite::tungstenite::Message;

const PAIR_TTL: Duration = Duration::from_secs(300);
const KEY_ACCOUNT: &str = "device:mac";

fn gateway_url() -> Option<String> {
    #[cfg(debug_assertions)]
    if let Ok(u) = std::env::var("KIJI_GATEWAY_URL") {
        return Some(u);
    }
    option_env!("KIJI_GATEWAY_URL").map(String::from)
}

// --- Cifrado (NaCl crypto_box) ---

/// Caja para `peer` con nonce aleatorio: `(nonce, box)` en base64.
pub fn seal(bx: &SalsaBox, plain: &[u8]) -> (String, String) {
    let nonce = SalsaBox::generate_nonce(&mut OsRng);
    let ct = bx.encrypt(&nonce, plain).expect("cifrar no falla");
    (B64.encode(nonce), B64.encode(ct))
}

pub fn open(bx: &SalsaBox, nonce: &str, ct: &str) -> Option<Vec<u8>> {
    let n = B64.decode(nonce).ok().filter(|n| n.len() == 24)?;
    bx.decrypt(Nonce::from_slice(&n), B64.decode(ct).ok()?.as_slice()).ok()
}

fn public_key(b64: &str) -> Option<PublicKey> {
    PublicKey::from_slice(&B64.decode(b64).ok()?).ok()
}

/// Comparación en tiempo constante (el secreto del QR).
fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Abre un `pair.claim`: devuelve el nombre del móvil si la caja es suya y trae el secreto del QR.
pub fn open_claim(mac: &SecretKey, from: &str, nonce: &str, ct: &str, secret: &str) -> Option<String> {
    let bx = SalsaBox::new(&public_key(from)?, mac);
    let v: Value = serde_json::from_slice(&open(&bx, nonce, ct)?).ok()?;
    same(v["secret"].as_str()?.as_bytes(), secret.as_bytes()).then(|| v["name"].as_str().unwrap_or("Móvil").chars().take(60).collect())
}

/// Mensaje `msg` cifrado para un dispositivo.
fn envelope(bx: &SalsaBox, to: &str, inner: &Value) -> String {
    let (nonce, b) = seal(bx, inner.to_string().as_bytes());
    json!({ "type": "msg", "to": to, "nonce": nonce, "box": b }).to_string()
}

fn pair_uri(gateway: &str, mac_pub: &str, pair_id: &str, secret: &str) -> String {
    let mut u = url::Url::parse("kiji://pair").unwrap();
    u.query_pairs_mut().append_pair("g", gateway).append_pair("m", mac_pub).append_pair("p", pair_id).append_pair("s", secret);
    u.to_string()
}

// --- Estado ---

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub pubkey: String,
    pub name: String,
    pub paired_at: u64,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Saved {
    enabled: bool,
    email: String,
    devices: Vec<Device>,
}

#[derive(Default)]
struct Inner {
    saved: Option<Saved>,
    connection: &'static str,
    error: Option<String>,
    /// Hacia el relay mientras hay conexión.
    tx: Option<UnboundedSender<String>>,
    /// Móviles vinculados y conectados.
    online: HashMap<String, Peer>,
    pending_pair: Option<(String, String, Instant)>,
    /// Cada arranque o parada del bucle lo incrementa; un bucle viejo se retira al verlo cambiado.
    run: u64,
    /// Tarea del bucle de conexión (se aborta al parar o reiniciar: así se cierra el WebSocket de verdad).
    task: Option<tauri::async_runtime::JoinHandle<()>>,
    /// Sink de `push.wake` en el puente (retiene un emisor hacia el relay: hay que quitarlo al cerrar).
    wake: Option<u64>,
}

/// Un móvil conectado. Contra la reproducción de órdenes: cada conexión tiene un id de sesión aleatorio que el Mac le
/// manda cifrado (`{"t":"session","s"}`), y cada petición debe traer ese `s` y un `n` estrictamente creciente. Una
/// caja grabada de otra sesión, o repetida en esta, se descarta aunque abra bien.
struct Peer {
    client: u64,
    session: String,
    last_n: u64,
}

#[derive(Default)]
pub struct MobileState {
    inner: Mutex<Inner>,
    /// Móviles conectados (para `push.wake` sin tomar el Mutex desde el puente).
    phones: Arc<AtomicUsize>,
}

fn data_file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("mobile.json"))
}

fn saved<'a>(app: &AppHandle, g: &'a mut Inner) -> &'a mut Saved {
    g.saved.get_or_insert_with(|| {
        data_file(app).and_then(|p| std::fs::read(p).ok()).and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    })
}

fn persist(app: &AppHandle, s: &Saved) {
    if let Some(p) = data_file(app) {
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir); // primer arranque: puede que el core aún no la haya creado
        }
        if let Err(e) = std::fs::write(&p, serde_json::to_vec_pretty(s).unwrap()) {
            eprintln!("[mobile] no se pudo guardar {}: {e}", p.display());
        }
    }
}

fn status_json(app: &AppHandle, g: &mut Inner) -> Value {
    let connection = if g.connection.is_empty() { "off" } else { g.connection };
    let error = g.error.clone();
    let online: Vec<String> = g.online.keys().cloned().collect();
    let s = saved(app, g);
    json!({
        "configured": gateway_url().is_some() && (google::configured() || cfg!(debug_assertions) && std::env::var("KIJI_DEV_TOKEN").is_ok()),
        "signedIn": !s.email.is_empty(),
        "email": s.email,
        "enabled": s.enabled,
        "connection": connection,
        "error": error,
        "devices": s.devices.iter().map(|d| json!({ "pubkey": d.pubkey, "name": d.name, "pairedAt": d.paired_at, "online": online.contains(&d.pubkey) })).collect::<Vec<_>>(),
    })
}

fn set_conn(app: &AppHandle, connection: &'static str, error: Option<String>) {
    let st = app.state::<MobileState>();
    let mut g = st.inner.lock().unwrap();
    g.connection = connection;
    g.error = error;
    let v = status_json(app, &mut g);
    drop(g);
    let _ = app.emit("mobile:status", v);
}

fn emit_status(app: &AppHandle) {
    let st = app.state::<MobileState>();
    let v = status_json(app, &mut st.inner.lock().unwrap());
    let _ = app.emit("mobile:status", v);
}

/// Clave privada del Mac (se crea la primera vez).
fn mac_key() -> Result<SecretKey, String> {
    if let Some(b) = keyring::read(KEY_ACCOUNT)? {
        let raw = B64.decode(b).map_err(|_| "clave del Mac dañada")?;
        return SecretKey::from_slice(&raw).map_err(|_| "clave del Mac dañada".into());
    }
    let sk = SecretKey::generate(&mut OsRng);
    keyring::write(KEY_ACCOUNT, Some(&B64.encode(sk.to_bytes())))?;
    Ok(sk)
}

fn is_paired(app: &AppHandle, pubkey: &str) -> bool {
    let st = app.state::<MobileState>();
    let mut g = st.inner.lock().unwrap();
    saved(app, &mut g).devices.iter().any(|d| d.pubkey == pubkey)
}

/// Registra un móvil vinculado y conectado como cliente del puente (le llegan los eventos y sus respuestas, cifrados)
/// y le manda su id de sesión. Todo bajo un único lock de `MobileState`, para no competir con `mobile_revoke`.
/// Llamar a `RemoteState::add` con este lock tomado es seguro: ningún sink toma `MobileState`.
fn go_online(app: &AppHandle, sk: &SecretKey, pubkey: &str) -> Option<u64> {
    let st = app.state::<MobileState>();
    let mut g = st.inner.lock().unwrap();
    if let Some(p) = g.online.get(pubkey) {
        return Some(p.client);
    }
    if !saved(app, &mut g).devices.iter().any(|d| d.pubkey == pubkey) {
        return None;
    }
    let tx = g.tx.clone()?;
    let bx = SalsaBox::new(&public_key(pubkey)?, sk);
    let session = B64URL.encode(rand::random::<[u8; 16]>());
    let _ = tx.send(envelope(&bx, pubkey, &json!({ "t": "session", "s": session })));
    let to = pubkey.to_string();
    let client = app.state::<RemoteState>().add(Box::new(move |line: &str| tx.send(envelope(&bx, &to, &json!({ "t": "line", "line": line }))).is_ok()));
    g.online.insert(pubkey.to_string(), Peer { client, session, last_n: 0 });
    st.phones.fetch_add(1, Ordering::Relaxed);
    Some(client)
}

/// Vuelve a mandar el id de sesión (el móvil saluda con `{"t":"hello"}` al conectarse o si lo perdió).
fn resend_session(app: &AppHandle, sk: &SecretKey, pubkey: &str) {
    let st = app.state::<MobileState>();
    let g = st.inner.lock().unwrap();
    if let (Some(p), Some(tx), Some(pk)) = (g.online.get(pubkey), g.tx.as_ref(), public_key(pubkey)) {
        let _ = tx.send(envelope(&SalsaBox::new(&pk, sk), pubkey, &json!({ "t": "session", "s": p.session })));
    }
}

/// Acepta una petición solo si trae el id de la sesión actual y un `n` mayor que el último. Devuelve el cliente.
fn accept_req(app: &AppHandle, pubkey: &str, s: Option<&str>, n: Option<u64>) -> Option<u64> {
    let st = app.state::<MobileState>();
    let mut g = st.inner.lock().unwrap();
    let p = g.online.get_mut(pubkey)?;
    fresh(p, s, n).then_some(p.client)
}

/// ¿Es de esta sesión y más nueva que la última? Si lo es, la anota.
fn fresh(p: &mut Peer, s: Option<&str>, n: Option<u64>) -> bool {
    let (Some(s), Some(n)) = (s, n) else { return false };
    if !same(s.as_bytes(), p.session.as_bytes()) || n <= p.last_n {
        return false;
    }
    p.last_n = n;
    true
}

fn go_offline(app: &AppHandle, pubkey: &str) {
    let st = app.state::<MobileState>();
    let peer = st.inner.lock().unwrap().online.remove(pubkey);
    if let Some(p) = peer {
        app.state::<RemoteState>().remove(p.client);
        st.phones.fetch_sub(1, Ordering::Relaxed);
    }
}

fn send(app: &AppHandle, line: String) -> bool {
    let st = app.state::<MobileState>();
    let tx = st.inner.lock().unwrap().tx.clone();
    tx.is_some_and(|tx| tx.send(line).is_ok())
}

// --- Bucle de conexión ---

/// Arranca (o reinicia) el bucle de conexión con el relay.
pub fn start(app: &AppHandle) {
    let st = app.state::<MobileState>();
    let run_id = {
        let mut g = st.inner.lock().unwrap();
        g.run += 1;
        g.run
    };
    let old = st.inner.lock().unwrap().task.take();
    if let Some(t) = old {
        t.abort();
    }
    cleanup(app); // lo que dejara la conexión del bucle anterior, antes de que arranque el nuevo
    let app2 = app.clone();
    let task = tauri::async_runtime::spawn(async move {
        let app = app2;
        let mut backoff = 2;
        loop {
            if app.state::<MobileState>().inner.lock().unwrap().run != run_id {
                return;
            }
            set_conn(&app, "connecting", None);
            let started = Instant::now();
            let res = connect_once(&app, run_id).await;
            cleanup(&app);
            if app.state::<MobileState>().inner.lock().unwrap().run != run_id {
                return;
            }
            if started.elapsed() > Duration::from_secs(60) {
                backoff = 2;
            }
            set_conn(&app, "error", Some(res.err().unwrap_or_else(|| "conexión cerrada".into())));
            tokio::time::sleep(Duration::from_secs(backoff)).await;
            backoff = (backoff * 2).min(60);
        }
    });
    st.inner.lock().unwrap().task = Some(task);
}

/// Para el bucle y cierra la conexión.
pub fn stop(app: &AppHandle) {
    let st = app.state::<MobileState>();
    let task = {
        let mut g = st.inner.lock().unwrap();
        g.run += 1;
        g.task.take()
    };
    // Abortar suelta el lector; `cleanup` suelta todos los emisores, y el escritor cierra el WebSocket.
    if let Some(t) = task {
        t.abort();
    }
    cleanup(app);
    set_conn(app, "off", None);
}

fn cleanup(app: &AppHandle) {
    let st = app.state::<MobileState>();
    let (keys, wake): (Vec<String>, _) = {
        let mut g = st.inner.lock().unwrap();
        g.tx = None;
        g.pending_pair = None;
        (g.online.keys().cloned().collect(), g.wake.take())
    };
    if let Some(w) = wake {
        app.state::<RemoteState>().remove(w);
    }
    for k in keys {
        go_offline(app, &k);
    }
}

async fn connect_once(app: &AppHandle, run_id: u64) -> Result<(), String> {
    let gateway = gateway_url().ok_or("falta configurar la puerta (KIJI_GATEWAY_URL)")?;
    let id_token = google::id_token().await?.ok_or("inicia sesión con Google")?;
    let res = reqwest::Client::new()
        .post(format!("{}/session", gateway.trim_end_matches('/')))
        .json(&json!({ "idToken": id_token, "device": "mac" }))
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| format!("sin conexión con la puerta: {e}"))?;
    let status = res.status();
    let body: Value = res.json().await.unwrap_or(Value::Null);
    match (status.as_u16(), body["error"].as_str()) {
        (200, _) => {}
        (503, _) => return Err("preparando tu servidor; reintento en unos segundos".into()),
        (403, _) => return Err("tu cuenta no está en la lista de la beta".into()),
        (_, e) => return Err(format!("la puerta respondió {status}: {}", e.unwrap_or("?"))),
    }
    let (relay, pass) = (body["relayUrl"].as_str().ok_or("respuesta de la puerta sin relayUrl")?, body["pass"].as_str().ok_or("respuesta sin pase")?);
    if let Some(email) = body["email"].as_str() {
        let st = app.state::<MobileState>();
        let mut g = st.inner.lock().unwrap();
        let s = saved(app, &mut g);
        if s.email != email {
            s.email = email.to_string();
            persist(app, s);
        }
    }

    let sk = tokio::task::spawn_blocking(mac_key).await.map_err(|e| e.to_string())??;
    let my_pub = B64.encode(sk.public_key().as_bytes());
    let (ws, _) = tokio::time::timeout(Duration::from_secs(20), tokio_tungstenite::connect_async(relay))
        .await
        .map_err(|_| "el relay no respondió a tiempo".to_string())?
        .map_err(|e| format!("no se pudo conectar al relay: {e}"))?;
    let (mut sink, mut stream) = ws.split();
    sink.send(Message::text(json!({ "type": "hello", "pass": pass, "pubkey": my_pub }).to_string())).await.map_err(|e| e.to_string())?;

    let (tx, mut rx) = unbounded_channel::<String>();
    {
        let st = app.state::<MobileState>();
        let mut g = st.inner.lock().unwrap();
        if g.run != run_id {
            return Ok(());
        }
        g.tx = Some(tx.clone());
    }
    // Escritor: todo lo que va al relay pasa por el canal; cuando el último emisor se suelta, cierra.
    let writer = tauri::async_runtime::spawn(async move {
        while let Some(l) = rx.recv().await {
            if sink.send(Message::text(l)).await.is_err() {
                break;
            }
        }
        let _ = sink.close().await;
    });
    // Aviso al móvil (push sin contenido) cuando hay algo que responder y ningún móvil está conectado.
    let phones = app.state::<MobileState>().phones.clone();
    let wake_tx = tx.clone();
    let wake = app.state::<RemoteState>().add(Box::new(move |line: &str| {
        if phones.load(Ordering::Relaxed) == 0
            && (line.starts_with(r#"{"type":"event","name":"approval.requested""#) || line.starts_with(r#"{"type":"event","name":"notify""#) && line.contains(r#""level":"ask""#))
        {
            return wake_tx.send(json!({ "type": "push.wake" }).to_string()).is_ok();
        }
        !wake_tx.is_closed()
    }));
    app.state::<MobileState>().inner.lock().unwrap().wake = Some(wake);
    drop(tx);

    let mut result = Ok(());
    while let Some(msg) = stream.next().await {
        let text = match msg {
            Ok(Message::Text(t)) => t,
            Ok(Message::Close(_)) => break,
            Ok(_) => continue,
            Err(e) => {
                result = Err(format!("se cortó la conexión con el relay: {e}"));
                break;
            }
        };
        if let Err(e) = handle_relay(app, &sk, &text) {
            result = Err(e);
            break;
        }
        if app.state::<MobileState>().inner.lock().unwrap().run != run_id {
            break;
        }
    }
    writer.abort();
    result
}

/// Un mensaje del relay. `Err` corta la conexión.
fn handle_relay(app: &AppHandle, sk: &SecretKey, text: &str) -> Result<(), String> {
    let Ok(v) = serde_json::from_str::<Value>(text) else { return Ok(()) };
    let s = |k: &str| v[k].as_str().unwrap_or("");
    match s("type") {
        "welcome" => {
            set_conn(app, "connected", None);
            // Solo desarrollo: ofrece una vinculación nada más conectar (prueba de punta a punta sin interfaz).
            #[cfg(debug_assertions)]
            if std::env::var("KIJI_DEV_AUTOPAIR").is_ok() {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = mobile_pair_start(app).await {
                        eprintln!("[mobile] (dev) autopair: {e}");
                    }
                });
            }
            for p in v["peers"].as_array().into_iter().flatten() {
                let pk = p["pubkey"].as_str().unwrap_or("");
                if p["dev"] == "phone" && is_paired(app, pk) {
                    go_online(app, sk, pk);
                }
            }
            emit_status(app);
        }
        "peer.online" if v["dev"] == "phone" && is_paired(app, s("pubkey")) => {
            go_online(app, sk, s("pubkey"));
            emit_status(app);
        }
        "peer.offline" => {
            go_offline(app, s("pubkey"));
            emit_status(app);
        }
        "pair.claim" => on_claim(app, sk, s("from"), s("pairId"), s("nonce"), s("box")),
        "msg" => {
            let from = s("from");
            // `go_online` devuelve None si no está vinculado: lo de desconocidos se ignora.
            let Some(bx) = public_key(from).map(|pk| SalsaBox::new(&pk, sk)) else { return Ok(()) };
            let Some(inner) = open(&bx, s("nonce"), s("box")).and_then(|b| serde_json::from_slice::<Value>(&b).ok()) else {
                return Ok(());
            };
            if go_online(app, sk, from).is_none() {
                return Ok(());
            }
            match inner["t"].as_str() {
                Some("hello") => resend_session(app, sk, from),
                Some("req") => {
                    let Some(client) = accept_req(app, from, inner["s"].as_str(), inner["n"].as_u64()) else {
                        return Ok(()); // sesión vieja o repetida: posible reproducción
                    };
                    let mut req = inner;
                    if let Some(o) = req.as_object_mut() {
                        for k in ["t", "s", "n"] {
                            o.remove(k);
                        }
                    }
                    crate::remote::handle_line(app, client, &req.to_string());
                }
                _ => {}
            }
        }
        "error" if s("code") == "unauthorized" => return Err("el relay rechazó el pase".into()),
        "error" => eprintln!("[mobile] relay: error {}", s("code")),
        _ => {}
    }
    Ok(())
}

fn on_claim(app: &AppHandle, sk: &SecretKey, from: &str, pair_id: &str, nonce: &str, ct: &str) {
    let st = app.state::<MobileState>();
    let (secret, until) = {
        let mut g = st.inner.lock().unwrap();
        match g.pending_pair.take() {
            Some((id, secret, until)) if id == pair_id && Instant::now() < until => (secret, until),
            other => {
                g.pending_pair = other; // no era la nuestra: se conserva la oferta
                return;
            }
        }
    };
    let Some(name) = open_claim(sk, from, nonce, ct, &secret) else {
        // Se conserva la oferta: una caja basura (p. ej. del relay) no debe anular el QR que sigue en pantalla.
        eprintln!("[mobile] vinculación rechazada: el secreto no coincide");
        let mut g = st.inner.lock().unwrap();
        if g.pending_pair.is_none() {
            g.pending_pair = Some((pair_id.to_string(), secret, until));
        }
        return;
    };
    {
        let mut g = st.inner.lock().unwrap();
        let s = saved(app, &mut g);
        s.devices.retain(|d| d.pubkey != from);
        let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        s.devices.push(Device { pubkey: from.to_string(), name: name.clone(), paired_at: now });
        persist(app, s);
    }
    if let Some(pk) = public_key(from) {
        send(app, envelope(&SalsaBox::new(&pk, sk), from, &json!({ "t": "pair.ok" })));
    }
    go_online(app, sk, from);
    // Siempre se avisa en el escritorio de un móvil nuevo (si te roban la cuenta de Google, lo verías aquí).
    use tauri_plugin_notification::NotificationExt;
    let _ = app.notification().builder().title("Móvil vinculado").body(format!("«{name}» ya puede ver y gestionar tus workspaces.")).show();
    let _ = app.emit("mobile:paired", json!({ "name": name }));
    emit_status(app);
}

// --- Comandos ---

#[tauri::command]
pub async fn mobile_status(app: AppHandle) -> Value {
    let st = app.state::<MobileState>();
    let v = status_json(&app, &mut st.inner.lock().unwrap());
    v
}

#[tauri::command]
pub async fn mobile_sign_in(app: AppHandle) -> Result<Value, String> {
    use tauri_plugin_opener::OpenerExt;
    let opener = app.clone();
    let email = google::sign_in(move |url| opener.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())).await?;
    {
        let st = app.state::<MobileState>();
        let mut g = st.inner.lock().unwrap();
        let s = saved(&app, &mut g);
        s.email = email;
        s.enabled = true;
        persist(&app, s);
    }
    start(&app);
    Ok(mobile_status(app).await)
}

#[tauri::command]
pub async fn mobile_sign_out(app: AppHandle) -> Result<Value, String> {
    stop(&app);
    google::sign_out()?;
    {
        let st = app.state::<MobileState>();
        let mut g = st.inner.lock().unwrap();
        let s = saved(&app, &mut g);
        s.email.clear();
        s.enabled = false;
        persist(&app, s);
    }
    Ok(mobile_status(app).await)
}

#[tauri::command]
pub async fn mobile_set_enabled(app: AppHandle, enabled: bool) -> Value {
    {
        let st = app.state::<MobileState>();
        let mut g = st.inner.lock().unwrap();
        let s = saved(&app, &mut g);
        s.enabled = enabled;
        persist(&app, s);
    }
    if enabled { start(&app) } else { stop(&app) }
    mobile_status(app).await
}

/// Empieza una vinculación: anuncia la oferta al relay y devuelve el QR (SVG). El secreto solo viaja dentro del QR.
#[tauri::command]
pub async fn mobile_pair_start(app: AppHandle) -> Result<Value, String> {
    let gateway = gateway_url().ok_or("falta configurar la puerta")?;
    let sk = tokio::task::spawn_blocking(mac_key).await.map_err(|e| e.to_string())??;
    let (pair_id, secret) = (B64URL.encode(rand::random::<[u8; 16]>()), B64URL.encode(rand::random::<[u8; 32]>()));
    if !send(&app, json!({ "type": "pair.offer", "pairId": pair_id }).to_string()) {
        return Err("no hay conexión con tu servidor; espera a que diga «Conectado»".into());
    }
    app.state::<MobileState>().inner.lock().unwrap().pending_pair = Some((pair_id.clone(), secret.clone(), Instant::now() + PAIR_TTL));
    let uri = pair_uri(&gateway, &B64.encode(sk.public_key().as_bytes()), &pair_id, &secret);
    // Solo desarrollo: la prueba de punta a punta (`tools/mobile-phone-sim.mjs`) lee el QR del log.
    #[cfg(debug_assertions)]
    if std::env::var("KIJI_DEV_AUTOPAIR").is_ok() {
        eprintln!("[mobile] (dev) QR: {uri}");
    }
    let svg = qrcode::QrCode::new(uri.as_bytes())
        .map_err(|e| e.to_string())?
        .render::<qrcode::render::svg::Color>()
        .min_dimensions(240, 240)
        .quiet_zone(true)
        .build();
    Ok(json!({ "svg": svg, "expiresInSecs": PAIR_TTL.as_secs() }))
}

#[tauri::command]
pub async fn mobile_revoke(app: AppHandle, pubkey: String) -> Result<Value, String> {
    let online = app.state::<MobileState>().inner.lock().unwrap().online.contains_key(&pubkey);
    if online {
        if let (Ok(sk), Some(pk)) = (tokio::task::spawn_blocking(mac_key).await.map_err(|e| e.to_string())?, public_key(&pubkey)) {
            send(&app, envelope(&SalsaBox::new(&pk, &sk), &pubkey, &json!({ "t": "revoked" })));
        }
    }
    go_offline(&app, &pubkey);
    {
        let st = app.state::<MobileState>();
        let mut g = st.inner.lock().unwrap();
        let s = saved(&app, &mut g);
        s.devices.retain(|d| d.pubkey != pubkey);
        persist(&app, s);
    }
    Ok(mobile_status(app).await)
}

/// Al arrancar la app: si el puente móvil estaba activado, se conecta solo.
pub fn resume(app: &AppHandle) {
    let enabled = {
        let st = app.state::<MobileState>();
        let mut g = st.inner.lock().unwrap();
        saved(app, &mut g).enabled
    };
    // Solo desarrollo: la prueba de punta a punta arranca conectada aunque no haya nada guardado.
    let enabled = enabled || cfg!(debug_assertions) && std::env::var("KIJI_DEV_AUTOPAIR").is_ok();
    if enabled {
        start(app);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caja_de_ida_y_vuelta() {
        let (a, b) = (SecretKey::generate(&mut OsRng), SecretKey::generate(&mut OsRng));
        let (n, c) = seal(&SalsaBox::new(&b.public_key(), &a), b"hola");
        assert_eq!(open(&SalsaBox::new(&a.public_key(), &b), &n, &c).as_deref(), Some(&b"hola"[..]));
        // Otra clave o un byte cambiado: no abre.
        let x = SecretKey::generate(&mut OsRng);
        assert!(open(&SalsaBox::new(&x.public_key(), &b), &n, &c).is_none());
        let mut bad = B64.decode(&c).unwrap();
        bad[0] ^= 1;
        assert!(open(&SalsaBox::new(&a.public_key(), &b), &n, &B64.encode(bad)).is_none());
        assert!(open(&SalsaBox::new(&a.public_key(), &b), "corto", &c).is_none());
    }

    #[test]
    fn vinculacion_exige_el_secreto_del_qr() {
        let (mac, phone) = (SecretKey::generate(&mut OsRng), SecretKey::generate(&mut OsRng));
        let phone_pub = B64.encode(phone.public_key().as_bytes());
        let bx = SalsaBox::new(&mac.public_key(), &phone);
        let (n, c) = seal(&bx, br#"{"secret":"s3cr3t","name":"iPhone de Alexis"}"#);
        assert_eq!(open_claim(&mac, &phone_pub, &n, &c, "s3cr3t").as_deref(), Some("iPhone de Alexis"));
        assert_eq!(open_claim(&mac, &phone_pub, &n, &c, "otro"), None);
        // El relay no puede cambiar la clave pública del remitente: con otra `from` la caja no abre.
        let intruso = B64.encode(SecretKey::generate(&mut OsRng).public_key().as_bytes());
        assert_eq!(open_claim(&mac, &intruso, &n, &c, "s3cr3t"), None);
    }

    #[test]
    fn compatible_con_tweetnacl() {
        // Vector generado con `tweetnacl` (nacl.box), lo mismo que usan el móvil y las pruebas del servidor.
        let mac = SecretKey::from_slice(&B64.decode("YbJancrjROSsZkNhMHoMU1WGAYUNzNCdTdCOvuA0RdA=").unwrap()).unwrap();
        let name = open_claim(
            &mac,
            "UISbrlSwb3g1kkNtCC+45+RfSTo+AqFxDsoRRPN8/AM=",
            "DDQwYVj8tF3oa7g3AOOiC3adWLJ5yV/p",
            "SFv08cvW1yI365KR+KTDz5VrdxXnEpA8hgwNnOQYuvgUIia1eHn/wA++mR3bsewBKDE=",
            "s3cr3t",
        );
        assert_eq!(name.as_deref(), Some("Pixel"));
    }

    #[test]
    fn peticiones_reproducidas_se_descartan() {
        let mut p = Peer { client: 1, session: "S1".into(), last_n: 0 };
        assert!(fresh(&mut p, Some("S1"), Some(1)));
        assert!(!fresh(&mut p, Some("S1"), Some(1)), "la misma caja otra vez");
        assert!(!fresh(&mut p, Some("S1"), Some(0)), "una anterior");
        assert!(fresh(&mut p, Some("S1"), Some(5)));
        assert!(!fresh(&mut p, Some("S0"), Some(9)), "de otra sesión (grabada antes)");
        assert!(!fresh(&mut p, None, Some(9)));
        assert!(!fresh(&mut p, Some("S1"), None));
    }

    #[test]
    fn uri_del_qr() {
        let u = pair_uri("https://gw.example", "ab+/=", "pid", "sec");
        assert_eq!(u, "kiji://pair?g=https%3A%2F%2Fgw.example&m=ab%2B%2F%3D&p=pid&s=sec");
    }

    #[test]
    fn comparacion_constante() {
        assert!(same(b"abc", b"abc"));
        assert!(!same(b"abc", b"abd"));
        assert!(!same(b"abc", b"ab"));
    }
}
