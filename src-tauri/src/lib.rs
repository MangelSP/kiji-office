mod core_process;
mod detect;
mod keyring;

use tauri::RunEvent;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(core_process::CoreState::default())
        .setup(|app| {
            // Fuera del hilo principal: leer el llavero puede mostrar un aviso del SO y no debe bloquear la ventana.
            let handle = app.handle().clone();
            std::thread::spawn(move || core_process::start(&handle));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            keyring::secret_set,
            keyring::secret_get,
            keyring::secret_delete,
            detect::detect_clis,
            core_process::core_send,
            core_process::core_restart,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            core_process::shutdown(handle);
        }
    });
}
