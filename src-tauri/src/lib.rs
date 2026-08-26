use tauri::Manager;

pub mod cache;
pub mod commands;
pub mod edit;
pub mod error;
pub mod export;
pub mod limits;
pub mod load;
pub mod media;
pub mod osk;
pub mod osz;
pub mod scene;
pub mod settings;
pub mod skin;
pub mod stable;
pub mod state;
pub mod video;

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
            let data_root = app.path().app_local_data_dir()?;
            let cache_root = data_root.join("osz-cache");
            // permanent, and deliberately NOT under the collected cache root:
            // a persisted skin locator points here and must survive orphan gc
            let skins_root = data_root.join("skins");
            // a crash's leftover cache dirs are unlocked by now; a live
            // instance cannot race this because of single-instance + locks
            cache::collect_orphans(&cache_root);
            // the video seam's own startup passes, beside the cache gc on the
            // same terms: unrenamed temps are a crash's, job dirs never
            // survive a restart, and the staged-set cap is enforced here
            let danser_root = data_root.join("danser");
            let jobs_root = data_root.join("danser-jobs");
            let songs_root = data_root.join("danser-songs");
            video::danser::sweep_install_temps(&danser_root);
            video::sweep_job_dirs(&jobs_root);
            video::staging::sweep_staging(&songs_root);
            let video_state = video::VideoState::new(
                std::sync::Arc::new(video::danser::DanserRenderer::new(danser_root)),
                jobs_root,
                songs_root,
            );
            app.manage(state::AppState::new(config_dir, cache_root, skins_root, video_state));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::load_replay,
            commands::load_replay_with_beatmap,
            commands::get_settings,
            commands::set_osu_stable_path,
            commands::set_viewer_prefs,
            commands::clear_recents,
            commands::list_skins,
            commands::get_skin,
            commands::set_skin,
            commands::import_skin,
            commands::apply_edit,
            commands::undo,
            commands::redo,
            commands::revert_all,
            commands::resync,
            commands::export_replay,
            commands::export_video,
            commands::cancel_video_export,
            commands::get_video_renderer_status,
            commands::install_video_renderer,
            commands::set_video_prefs,
            commands::redetect_video_encoder
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
