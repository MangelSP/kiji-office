mod core_process;
mod detect;
mod keyring;
mod lifecycle;
mod notify;
mod updater;

use tauri::{Manager, RunEvent, WindowEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(notify::NotifyState::default())
        .manage(core_process::CoreState::default())
        .manage(lifecycle::LifecycleState::default())
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    lifecycle::request_close(window.app_handle(), "window");
                }
            }
        })
        .setup(|app| {
            lifecycle::setup_tray(app.handle())?;
            // Fuera del hilo principal: leer el llavero puede mostrar un aviso del SO y no debe bloquear la ventana.
            let handle = app.handle().clone();
            std::thread::spawn(move || core_process::start(&handle));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ui_log,
            keyring::secret_set,
            keyring::secret_get,
            keyring::secret_delete,
            detect::detect_clis,
            core_process::core_send,
            core_process::core_restart,
            lifecycle::app_close_ack,
            lifecycle::app_hide,
            lifecycle::app_quit,
            lifecycle::tray_set_busy,
            updater::check_update,
            updater::install_update,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|handle, event| {
        match event {
            // Cmd+Q / salir del Dock: la UI decide (salvo si ya estamos saliendo de verdad).
            RunEvent::ExitRequested { api, code, .. } if lifecycle::should_intercept_exit(handle, code) => {
                api.prevent_exit();
                lifecycle::request_close(handle, "quit");
            }
            // Clic en una notificación (o en el Dock) con la app en segundo plano: ventana al frente.
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { .. } => notify::on_reactivated(handle),
            RunEvent::Exit => core_process::shutdown(handle),
            _ => {}
        }
    });
}

/// Solo desarrollo: la UI vuelca aquí sus errores y eventos para verlos en el log de `tauri dev`.
#[tauri::command]
fn ui_log(msg: String) {
    if cfg!(debug_assertions) {
        eprintln!("[ui] {}", msg.chars().take(600).collect::<String>());
    }
}
