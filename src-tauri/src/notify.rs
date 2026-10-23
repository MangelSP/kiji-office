// Avisos de escritorio: el core emite `notify`; aquí se decide si sale la notificación del sistema
// (recorte, ventana enfocada, throttle por proyecto). La UI recibe siempre el evento (campana).
//
// Limitación: en escritorio tauri-plugin-notification (notify-rust) no ofrece callback de clic fiable
// (en macOS tampoco). Al hacer clic, macOS reactiva la app: en `RunEvent::Reopen` traemos la ventana al
// frente y emitimos `notification-clicked` con el último aviso lanzado si es reciente (`CLICK_WINDOW`).
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

const MAX_CHARS: usize = 120;
const THROTTLE: Duration = Duration::from_secs(3);
const CLICK_WINDOW: Duration = Duration::from_secs(60);

#[derive(Default)]
struct Slot {
    last: Option<Instant>,
    suppressed: u32,
}

/// Throttle por proyecto: 1 aviso del sistema cada `THROTTLE`; el resto se cuenta para el siguiente.
#[derive(Default)]
pub struct Throttle(HashMap<String, Slot>);

impl Throttle {
    /// `Some(n)` = se puede lanzar ahora, con `n` avisos agrupados desde el último; `None` = suprimir.
    pub fn check(&mut self, project: &str, now: Instant) -> Option<u32> {
        let s = self.0.entry(project.to_string()).or_default();
        if s.last.is_some_and(|t| now.duration_since(t) < THROTTLE) {
            s.suppressed += 1;
            return None;
        }
        s.last = Some(now);
        Some(std::mem::take(&mut s.suppressed))
    }
}

#[derive(Default)]
pub struct NotifyState {
    throttle: Mutex<Throttle>,
    last: Mutex<Option<(String, i64, Instant)>>,
}

/// Recorta a `max` caracteres (no bytes), con «…» si se pasó.
pub fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

fn body_with_group(body: &str, extra: u32) -> String {
    if extra == 0 {
        return clip(body, MAX_CHARS);
    }
    format!("{} (y {extra} avisos más)", clip(body, MAX_CHARS))
}

/// ¿Debe omitirse la del sistema porque la UI ya la está mostrando? (ventana visible y enfocada + info)
pub fn skip_for_ui(level: &str, visible_and_focused: bool) -> bool {
    level == "info" && visible_and_focused
}

/// Trata un evento `notify` (payload ya parseado). Nunca falla: el reenvío al webview lo hace el llamador.
pub fn handle(app: &AppHandle, payload: &serde_json::Value) {
    let (Some(project), Some(title)) = (payload["projectId"].as_str(), payload["title"].as_str()) else { return };
    let level = payload["level"].as_str().unwrap_or("info");
    let id = payload["id"].as_i64().unwrap_or(0);
    let focused = app
        .get_webview_window("main")
        .is_some_and(|w| w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false));
    if skip_for_ui(level, focused) {
        return;
    }
    let state = app.state::<NotifyState>();
    let Some(extra) = state.throttle.lock().unwrap().check(project, Instant::now()) else { return };
    let body = body_with_group(payload["body"].as_str().unwrap_or(""), extra);
    if let Err(e) = app.notification().builder().title(clip(title, MAX_CHARS)).body(body).show() {
        eprintln!("[notify] no se pudo mostrar la notificación: {e}");
        return;
    }
    *state.last.lock().unwrap() = Some((project.to_string(), id, Instant::now()));
}

/// La app se reactivó (clic en la notificación o en el Dock): ventana al frente y, si hay un aviso reciente,
/// la UI abre su proyecto.
pub fn on_reactivated(app: &AppHandle) {
    crate::lifecycle::show_main(app);
    let last = app.state::<NotifyState>().last.lock().unwrap().take();
    if let Some((project_id, id, at)) = last {
        if at.elapsed() < CLICK_WINDOW {
            let _ = app.emit("notification-clicked", serde_json::json!({ "projectId": project_id, "id": id }));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recorta_por_caracteres() {
        assert_eq!(clip("abc", 120), "abc");
        let largo = "ñ".repeat(200);
        let c = clip(&largo, 120);
        assert_eq!(c.chars().count(), 120);
        assert!(c.ends_with('…'));
    }

    #[test]
    fn throttle_agrupa_por_proyecto() {
        let mut t = Throttle::default();
        let t0 = Instant::now();
        assert_eq!(t.check("a", t0), Some(0));
        assert_eq!(t.check("a", t0 + Duration::from_secs(1)), None);
        assert_eq!(t.check("a", t0 + Duration::from_secs(2)), None);
        assert_eq!(t.check("b", t0 + Duration::from_secs(2)), Some(0));
        assert_eq!(t.check("a", t0 + Duration::from_secs(3)), Some(2));
        assert_eq!(t.check("a", t0 + Duration::from_secs(4)), None);
    }

    #[test]
    fn agrupado_y_foco() {
        assert_eq!(body_with_group("x", 0), "x");
        assert_eq!(body_with_group("x", 2), "x (y 2 avisos más)");
        assert!(skip_for_ui("info", true));
        assert!(!skip_for_ui("warn", true));
        assert!(!skip_for_ui("ask", true));
        assert!(!skip_for_ui("info", false));
    }
}
