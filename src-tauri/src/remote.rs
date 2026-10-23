// Puente remoto (M0 de PLAN-movil.md): deja que un cliente de fuera de la ventana (el móvil, más adelante a través
// del relay) hable con el core, pero solo con los métodos de la lista blanca. Las peticiones remotas llevan id
// `remote:<cliente>:<id original>`; sus respuestas vuelven solo a ese cliente y no llegan al webview. Los eventos
// se difunden a todos los clientes (`secrets.request` ya lo consume Rust antes).
//
// Transporte de M0: un socket Unix local solo en builds de desarrollo, para el cliente de prueba
// (`tools/remote-client.mjs`). En M1 lo sustituye la conexión cifrada con el relay.
// ponytail: en release aún no hay transporte (llega en M1 con el relay), así que parte del puente no se usa.
#![cfg_attr(not(all(debug_assertions, unix)), allow(dead_code))]

use crate::core_process::CoreState;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

/// Lo que el móvil puede pedir (D4 de PLAN-movil.md: niveles Ver, Responder y Trabajar). Todo lo demás se rechaza
/// aquí, antes de llegar al core: claves, conexiones, ajustes, extensiones, abrir proyectos e integrar.
pub const ALLOWED: [&str; 26] = [
    // Ver
    "ping", "workspaces.overview", "project.list", "agent.list", "task.list", "task.steps", "task.diff",
    "approval.list", "notifications.list", "stats.overview", "stats.models", "providers.status", "manager.get",
    "queue.list", "events.tail",
    // Responder
    "approval.answer", "notifications.markRead", "manager.stopAll", "manager.resume",
    // Trabajar
    "task.create", "task.start", "task.stop", "task.assign", "task.review", "board.move", "agent.metrics",
];

pub const PREFIX: &str = "remote:";

pub fn allowed(method: &str) -> bool {
    ALLOWED.contains(&method)
}

fn error_line(id: &Value, code: &str, message: &str) -> String {
    json!({ "id": id, "type": "res", "error": { "code": code, "message": message } }).to_string()
}

/// Petición de un cliente remoto → línea para el core (`Ok`) o respuesta de error para ese cliente (`Err`).
pub fn inbound(client: u64, line: &str) -> Result<String, String> {
    let Ok(mut v) = serde_json::from_str::<Value>(line) else {
        return Err(error_line(&Value::Null, "invalid_json", "JSON inválido"));
    };
    let id = v["id"].clone();
    let (Some(id_str), Some("req")) = (id.as_str(), v["type"].as_str()) else {
        return Err(error_line(&id, "invalid_request", "se esperaba {id, type:\"req\", method}"));
    };
    let method = v["method"].as_str().unwrap_or("");
    if !allowed(method) {
        return Err(error_line(&id, "forbidden", &format!("método no permitido en remoto: {method}")));
    }
    v["id"] = json!(format!("{PREFIX}{client}:{id_str}"));
    Ok(v.to_string())
}

/// A quién va una línea del core.
#[derive(Debug, PartialEq)]
pub enum Out {
    /// Respuesta a una petición remota: solo para ese cliente (con su id original); no va al webview.
    Reply(u64, String),
    /// Evento: a todos los clientes remotos (y también al webview).
    Broadcast,
    /// Respuesta del webview o de Rust: no es asunto del puente.
    None,
}

/// El core escribe con `JSON.stringify` y orden de claves fijo: los eventos empiezan por `{"type":"event"` y las
/// respuestas por `{"id":`. Mirar el comienzo evita confundir una respuesta que lleva eventos dentro (`events.tail`).
pub fn outbound(line: &str) -> Out {
    if line.starts_with(r#"{"type":"event","name":"secrets.request""#) {
        return Out::None;
    }
    if line.starts_with(r#"{"type":"event""#) {
        return Out::Broadcast;
    }
    if !line.starts_with(r#"{"id":"remote:"#) {
        return Out::None;
    }
    let Ok(mut v) = serde_json::from_str::<Value>(line) else { return Out::None };
    let Some(rest) = v["id"].as_str().and_then(|i| i.strip_prefix(PREFIX)) else { return Out::None };
    let Some((client, original)) = rest.split_once(':') else { return Out::None };
    let Ok(client) = client.parse() else { return Out::None };
    v["id"] = json!(original);
    Out::Reply(client, v.to_string())
}

/// Clientes conectados: id → función que le escribe una línea (devuelve false si se cayó).
type Sink = Box<dyn FnMut(&str) -> bool + Send>;
#[derive(Default)]
pub struct RemoteState(Mutex<(u64, HashMap<u64, Sink>)>);

impl RemoteState {
    pub fn add(&self, sink: Sink) -> u64 {
        let mut g = self.0.lock().unwrap();
        g.0 += 1;
        let id = g.0;
        g.1.insert(id, sink);
        id
    }
    pub fn remove(&self, id: u64) {
        self.0.lock().unwrap().1.remove(&id);
    }
    /// Reparte una línea del core. Devuelve true si era solo para un cliente remoto (no debe llegar al webview).
    pub fn dispatch(&self, line: &str) -> bool {
        let mut g = self.0.lock().unwrap();
        if g.1.is_empty() {
            return line.starts_with(r#"{"id":"remote:"#); // nadie escucha: la respuesta huérfana se descarta
        }
        let out = outbound(line);
        match out {
            Out::Reply(id, l) => {
                if let Some(sink) = g.1.get_mut(&id) {
                    if !sink(&l) {
                        g.1.remove(&id);
                    }
                }
                true
            }
            Out::Broadcast => {
                g.1.retain(|_, sink| sink(line));
                false
            }
            Out::None => false,
        }
    }
}

/// Atiende una línea de un cliente: la pasa al core o le contesta con el error.
pub fn handle_line(app: &AppHandle, client: u64, line: &str) {
    match inbound(client, line) {
        Ok(l) => {
            if let Err(e) = crate::core_process::send_line(&app.state::<CoreState>(), &l) {
                let id = serde_json::from_str::<Value>(line).map(|v| v["id"].clone()).unwrap_or(Value::Null);
                reply(app, client, &error_line(&id, "core_unavailable", &e));
            }
        }
        Err(err) => reply(app, client, &err),
    }
}

fn reply(app: &AppHandle, client: u64, line: &str) {
    let state = app.state::<RemoteState>();
    let mut g = state.0.lock().unwrap();
    if let Some(sink) = g.1.get_mut(&client) {
        sink(line);
    }
}

/// Solo desarrollo y Unix: socket `remote-dev.sock` (permisos 0600) en la carpeta de datos de la app.
#[cfg(all(debug_assertions, unix))]
pub fn start_dev_socket(app: &AppHandle) {
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::UnixListener;

    let Ok(dir) = app.path().app_data_dir() else { return };
    let path = dir.join("remote-dev.sock");
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::remove_file(&path);
    let listener = match UnixListener::bind(&path) {
        Ok(l) => l,
        Err(e) => return eprintln!("[remote] no se pudo abrir {}: {e}", path.display()),
    };
    let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    eprintln!("[remote] socket de desarrollo en {}", path.display());
    let app = app.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let Ok(mut writer) = stream.try_clone() else { continue };
            let id = app.state::<RemoteState>().add(Box::new(move |l: &str| {
                writer.write_all(l.as_bytes()).and_then(|_| writer.write_all(b"\n")).is_ok()
            }));
            let app = app.clone();
            std::thread::spawn(move || {
                for line in BufReader::new(stream).lines().map_while(Result::ok) {
                    if !line.trim().is_empty() {
                        handle_line(&app, id, &line);
                    }
                }
                app.state::<RemoteState>().remove(id);
            });
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lista_blanca() {
        for m in ["workspaces.overview", "approval.list", "approval.answer", "task.create", "manager.stopAll"] {
            assert!(allowed(m), "{m}");
        }
        for m in [
            "secrets.put", "connection.create", "connection.list", "settings.set", "extensions.remove", "project.open",
            "project.close", "integration.apply", "integration.revert", "agent.update", "", "approval.answer ",
        ] {
            assert!(!allowed(m), "{m}");
        }
    }

    #[test]
    fn entrada_reescribe_el_id_o_rechaza() {
        let ok = inbound(7, r#"{"id":"a1","type":"req","method":"task.list","params":{"projectId":"p"}}"#).unwrap();
        let v: Value = serde_json::from_str(&ok).unwrap();
        assert_eq!(v["id"], "remote:7:a1");
        assert_eq!(v["params"]["projectId"], "p");

        let err = inbound(7, r#"{"id":"a2","type":"req","method":"secrets.put","params":{"account":"openai"}}"#).unwrap_err();
        let v: Value = serde_json::from_str(&err).unwrap();
        assert_eq!((v["id"].as_str(), v["error"]["code"].as_str()), (Some("a2"), Some("forbidden")));

        assert!(inbound(7, r#"{"id":"rust:1","type":"req","method":"connection.create"}"#).is_err());
        assert!(inbound(7, "no es json").is_err());
        assert!(inbound(7, r#"{"id":5,"type":"req","method":"ping"}"#).is_err()); // id no string
        assert!(inbound(7, r#"{"id":"x","type":"res","method":"ping"}"#).is_err());
    }

    #[test]
    fn salida_respuestas_y_eventos() {
        assert_eq!(
            outbound(r#"{"id":"remote:7:a1","type":"res","result":[1]}"#),
            Out::Reply(7, r#"{"id":"a1","result":[1],"type":"res"}"#.into())
        );
        // id original con dos puntos: se conserva entero.
        assert!(matches!(outbound(r#"{"id":"remote:3:x:y","type":"res","result":null}"#), Out::Reply(3, l) if l.contains(r#""id":"x:y""#)));
        assert_eq!(outbound(r#"{"type":"event","name":"task.changed","payload":{}}"#), Out::Broadcast);
        assert_eq!(outbound(r#"{"type":"event","name":"secrets.request","payload":{}}"#), Out::None);
        assert_eq!(outbound(r#"{"id":"web:1","type":"res","result":"remote:"}"#), Out::None);
        assert_eq!(outbound(r#"{"id":"remote:abc:1","type":"res"}"#), Out::None);
        // Una respuesta del webview que trae eventos dentro no se difunde.
        assert_eq!(outbound(r#"{"id":"web:2","type":"res","result":[{"type":"event","name":"notify"}]}"#), Out::None);
    }

    #[test]
    fn reparto_entre_clientes() {
        use std::sync::{Arc, Mutex as M};
        let st = RemoteState::default();
        let got: Arc<M<Vec<(u64, String)>>> = Arc::default();
        let mk = |n: u64| {
            let g = got.clone();
            Box::new(move |l: &str| {
                g.lock().unwrap().push((n, l.to_string()));
                true
            }) as Sink
        };
        let a = st.add(mk(1));
        let _b = st.add(mk(2));
        assert!(st.dispatch(&format!(r#"{{"id":"remote:{a}:q","type":"res","result":1}}"#)));
        assert!(!st.dispatch(r#"{"type":"event","name":"notify","payload":{}}"#));
        let got = got.lock().unwrap();
        assert_eq!(got.iter().filter(|(n, _)| *n == 1).count(), 2); // su respuesta + el evento
        assert_eq!(got.iter().filter(|(n, _)| *n == 2).count(), 1); // solo el evento
    }

    // Ida y vuelta contra el core de verdad (Node + `core/dist`, BD en memoria): `cargo test -- --ignored puente`.
    #[test]
    #[ignore]
    fn puente_contra_core_real() {
        use std::io::{BufRead, BufReader, Write};
        use std::process::{Command, Stdio};
        let entry = concat!(env!("CARGO_MANIFEST_DIR"), "/../core/dist/index.js");
        let mut core = Command::new("node").arg(entry).arg("--db").arg(":memory:")
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().expect("node");
        let mut stdin = core.stdin.take().unwrap();
        let mut lines = BufReader::new(core.stdout.take().unwrap()).lines().map_while(Result::ok);
        for req in [
            r#"{"id":"1","type":"req","method":"ping"}"#,
            r#"{"id":"2","type":"req","method":"approval.list"}"#,
            r#"{"id":"3","type":"req","method":"workspaces.overview"}"#,
        ] {
            writeln!(stdin, "{}", inbound(4, req).unwrap()).unwrap();
        }
        assert!(inbound(4, r#"{"id":"4","type":"req","method":"secrets.put"}"#).is_err());
        let (mut replies, mut events) = (Vec::new(), 0);
        while replies.len() < 3 {
            match outbound(&lines.next().expect("el core cerró")) {
                Out::Reply(4, l) => replies.push(serde_json::from_str::<Value>(&l).unwrap()),
                Out::Broadcast => events += 1,
                other => panic!("inesperado: {other:?}"),
            }
        }
        assert_eq!(replies[0], json!({"id":"1","type":"res","result":"pong"}));
        assert_eq!(replies[1]["result"], json!([]));
        assert!(replies[2]["result"]["workspaces"].is_array(), "{}", replies[2]);
        assert!(events >= 1); // core.ready
        drop(stdin);
        let _ = core.wait();
    }
}
