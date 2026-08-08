mod podman;

use podman::{
    CleanupResult, ContainerSummary, ImageSummary, MachineInfo, NetworkSummary, PodmanError,
    StatusInfo, VolumeSummary,
};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, WindowEvent,
};

#[tauri::command]
fn podman_status() -> StatusInfo {
    podman::status()
}

#[tauri::command]
fn list_containers() -> Result<Vec<ContainerSummary>, PodmanError> {
    podman::list_containers()
}

#[tauri::command]
fn list_images() -> Result<Vec<ImageSummary>, PodmanError> {
    podman::list_images()
}

#[tauri::command]
fn container_action(id: String, action: String) -> Result<(), PodmanError> {
    podman::container_action(&id, &action)
}

#[tauri::command]
fn remove_container(id: String, force: bool) -> Result<(), PodmanError> {
    podman::remove_container(&id, force)
}

#[tauri::command]
fn remove_image(id: String, force: bool) -> Result<(), PodmanError> {
    podman::remove_image(&id, force)
}

#[tauri::command]
fn list_volumes() -> Result<Vec<VolumeSummary>, PodmanError> {
    podman::list_volumes()
}

#[tauri::command]
fn remove_volume(name: String, force: bool) -> Result<(), PodmanError> {
    podman::remove_volume(&name, force)
}

#[tauri::command]
fn list_networks() -> Result<Vec<NetworkSummary>, PodmanError> {
    podman::list_networks()
}

#[tauri::command]
fn remove_network(name: String, force: bool) -> Result<(), PodmanError> {
    podman::remove_network(&name, force)
}

#[tauri::command]
fn container_logs(id: String, tail: u32) -> Result<String, PodmanError> {
    podman::container_logs(&id, tail)
}

#[tauri::command]
fn container_stats(id: String) -> Result<String, PodmanError> {
    podman::container_stats(&id)
}

#[tauri::command]
fn cleanup_all(containers: bool, images: bool, volumes: bool, networks: bool) -> Vec<CleanupResult> {
    podman::cleanup(containers, images, volumes, networks)
}

#[tauri::command]
fn inspect_container(id: String) -> Result<String, PodmanError> {
    podman::inspect_container(&id)
}

#[tauri::command]
fn inspect_image(id: String) -> Result<String, PodmanError> {
    podman::inspect_image(&id)
}

#[tauri::command]
fn inspect_volume(name: String) -> Result<String, PodmanError> {
    podman::inspect_volume(&name)
}

#[tauri::command]
fn inspect_network(name: String) -> Result<String, PodmanError> {
    podman::inspect_network(&name)
}

#[tauri::command]
fn list_machines() -> Vec<MachineInfo> {
    podman::list_machines()
}

#[tauri::command]
fn start_machine(name: Option<String>) -> Result<(), PodmanError> {
    podman::start_machine(name.as_deref())
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Must be the first plugin registered: it short-circuits the rest of
        // startup for any launch after the first, so a second `podtool.exe`
        // just focuses the existing window instead of opening a duplicate.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            podman_status,
            list_containers,
            list_images,
            container_action,
            remove_container,
            remove_image,
            list_volumes,
            remove_volume,
            list_networks,
            remove_network,
            container_logs,
            container_stats,
            cleanup_all,
            inspect_container,
            inspect_image,
            inspect_volume,
            inspect_network,
            list_machines,
            start_machine,
        ])
        .setup(|app| {
            let show_item = MenuItem::with_id(app, "show", "Show PodTool", true, None::<&str>)?;
            let about_item = MenuItem::with_id(app, "about", "About PodTool", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(app, &[&show_item, &about_item, &separator, &quit_item])?;

            let icon = app
                .default_window_icon()
                .cloned()
                .expect("bundled window icon missing");

            let tray = TrayIconBuilder::new()
                .icon(icon)
                .menu(&menu)
                .show_menu_on_left_click(false)
                .tooltip("PodTool")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main_window(app),
                    "about" => {
                        show_main_window(app);
                        let _ = app.emit("show-about", ());
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                })
                .build(app)?;

            // The tray icon is removed as soon as this handle is dropped, so it
            // must be kept alive for the app's lifetime rather than discarded.
            app.manage(tray);

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // Minimize to tray instead of quitting; the tray menu's
                // "Quit" is the only way to actually exit the app.
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
