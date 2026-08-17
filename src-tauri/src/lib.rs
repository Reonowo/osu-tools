use tauri::Manager;

pub mod cache;
pub mod commands;
pub mod edit;
pub mod error;
pub mod export;
pub mod limits;
pub mod load;
pub mod media;
pub mod osz;
pub mod scene;
pub mod settings;
pub mod stable;
pub mod state;

#[cfg(test)]
mod testutil;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // single-instance must be the first registered plugin (its docs);
        // it is also the primary guard that keeps cache gc race-free
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // a second launch focuses the existing window; forwarding its
            // argv (file-association open) is plan 4 frontend work (TODO.md)
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            let cache_root = app.path().app_local_data_dir()?.join("osz-cache");
            // a crash's leftover cache dirs are unlocked by now; a live
            // instance cannot race this because of single-instance + locks
            cache::collect_orphans(&cache_root);
            app.manage(state::AppState::new(config_dir, cache_root));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::load_replay,
            commands::load_replay_with_beatmap,
            commands::get_settings,
            commands::set_osu_stable_path,
            commands::set_viewer_prefs,
            commands::clear_recents,
            commands::apply_edit,
            commands::undo,
            commands::redo,
            commands::revert_all,
            commands::resync,
            commands::export_replay
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
