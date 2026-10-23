// Ciclo de vida de la ventana: bandeja del sistema, segundo plano y aviso al cerrar.
// Rust no decide: al cerrar o pedir salir emite `app-close-requested` y la UI (CloseGuard) responde con
// `app_close_ack` (ya me ocupo), y luego `app_hide`, `app_quit` o nada (cancelar).
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State};

/// Si la UI no confirma en este tiempo (webview colgado), se sale sin preguntar.
const ACK_TIMEOUT: Duration = Duration::from_secs(3);
const MAIN: &str = "main";

#[derive(Default)]
pub struct LifecycleState {
    /// Salida real en curso: ya no se pregunta (evita bucles con `ExitRequested`).
    quitting: AtomicBool,
    /// Hay una petición de cierre sin confirmar por la UI.
    awaiting_ack: Arc<AtomicBool>,
    busy_item: Mutex<Option<MenuItem<tauri::Wry>>>,
    stop_item: Mutex<Option<MenuItem<tauri::Wry>>>,
    /// El gerente está parado (`manager.halted`): el menú ofrece «Reanudar».
    halted: AtomicBool,
}

fn busy_label(n: u32) -> String {
    match n {
        0 => "Ningún robot trabajando".into(),
        1 => "1 robot trabajando".into(),
        n => format!("{n} robots trabajando"),
    }
}

fn stop_label(halted: bool) -> &'static str {
    if halted { "Reanudar" } else { "Parar todo" }
}

/// El core avisa de que la parada global cambió: alterna el texto del menú.
pub fn set_halted(app: &AppHandle, halted: bool) {
    let state = app.state::<LifecycleState>();
    state.halted.store(halted, Ordering::SeqCst);
    if let Some(item) = state.stop_item.lock().unwrap().as_ref() {
        let _ = item.set_text(stop_label(halted));
    }
}

/// Vuelve a mostrar la ventana (y el icono del Dock en macOS).
pub fn show_main(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// Pide a la UI que decida. `kind`: `window` (cerrar ventana) o `quit` (salir de la app).
pub fn request_close(app: &AppHandle, kind: &str) {
    let state = app.state::<LifecycleState>();
    if state.quitting.load(Ordering::SeqCst) {
        return;
    }
    // La UI necesita una ventana visible para mostrar el diálogo.
    show_main(app);
    state.awaiting_ack.store(true, Ordering::SeqCst);
    let _ = app.emit("app-close-requested", serde_json::json!({ "kind": kind }));
    let (app, awaiting) = (app.clone(), state.awaiting_ack.clone());
    std::thread::spawn(move || {
        std::thread::sleep(ACK_TIMEOUT);
        if awaiting.swap(false, Ordering::SeqCst) {
            eprintln!("[app] la UI no respondió al cierre; saliendo");
            quit(&app);
        }
    });
}

/// Salida real: marca `quitting` y sale (el `Exit` detiene el core).
pub fn quit(app: &AppHandle) {
    app.state::<LifecycleState>().quitting.store(true, Ordering::SeqCst);
    app.exit(0);
}

/// ¿Debe cancelarse esta petición de salida para preguntar a la UI? (`code` solo viene con `app.exit`.)
pub fn should_intercept_exit(app: &AppHandle, code: Option<i32>) -> bool {
    code.is_none() && !app.state::<LifecycleState>().quitting.load(Ordering::SeqCst)
}

/// Crea el icono de la bandeja con su menú.
pub fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Mostrar Kiji Office", true, None::<&str>)?;
    let busy = MenuItem::with_id(app, "busy", busy_label(0), false, None::<&str>)?;
    let stop = MenuItem::with_id(app, "stop", stop_label(false), true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Salir", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&show, &busy, &stop, &sep, &quit_item])?;
    *app.state::<LifecycleState>().busy_item.lock().unwrap() = Some(busy);
    *app.state::<LifecycleState>().stop_item.lock().unwrap() = Some(stop);

    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("Kiji Office")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main(app),
            "stop" => {
                let halted = app.state::<LifecycleState>().halted.load(Ordering::SeqCst);
                crate::core_process::send_simple(app, if halted { "manager.resume" } else { "manager.stopAll" });
            }
            "quit" => request_close(app, "quit"),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

/// La UI confirma que recibió la petición de cierre (cancela la salida automática).
#[tauri::command]
pub fn app_close_ack(state: State<'_, LifecycleState>) {
    state.awaiting_ack.store(false, Ordering::SeqCst);
}

/// Segundo plano: oculta la ventana (y el Dock en macOS); el core sigue.
#[tauri::command]
pub fn app_hide(app: AppHandle) {
    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = w.hide();
    }
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
}

/// Salida real sin volver a preguntar.
#[tauri::command]
pub fn app_quit(app: AppHandle) {
    quit(&app);
}

/// Actualiza el texto «N robots trabajando» de la bandeja.
#[tauri::command]
pub fn tray_set_busy(app: AppHandle, state: State<'_, LifecycleState>, count: u32) {
    let label = busy_label(count);
    if let Some(item) = state.busy_item.lock().unwrap().as_ref() {
        let _ = item.set_text(&label);
    }
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_tooltip(Some(format!("Kiji Office — {label}")));
    }
}
