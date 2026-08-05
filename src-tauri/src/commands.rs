//! the thin command layer: clone inputs, run the pure pipeline on a blocking
//! thread, allow media on the asset-protocol scope, swap the session

use std::path::Path;
use std::sync::Arc;

use tauri::{AppHandle, Manager, Runtime, State};

use crate::error::IpcError;
use crate::load::{self, LoadOutcome};
use crate::scene::LoadedScene;
use crate::settings::{save_settings, Settings};
use crate::state::AppState;

fn join_err(e: tauri::Error) -> IpcError {
    IpcError::Internal { message: format!("load task failed: {e}") }
}

/// media files ride the asset protocol; the runtime scope allowance is what
/// makes convertFileSrc urls resolvable. allowances for songs-folder media
/// accumulate for the session (TODO.md tracks revocation-on-replace)
fn install_scene<R: Runtime>(app: &AppHandle<R>, state: &AppState, outcome: LoadOutcome) -> LoadedScene {
    let LoadOutcome { scene, session } = outcome;
    let scope = app.asset_protocol_scope();
    for path in [scene.audio_path.as_deref(), scene.background_path.as_deref()].into_iter().flatten() {
        let _ = scope.allow_file(Path::new(path));
    }
    // replacing the session drops the previous scene's cache lease, which
    // deletes its extracted directory
    *state.session.lock().expect("session lock") = Some(session);
    scene
}

#[tauri::command]
pub async fn load_replay<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    osr_path: String,
) -> Result<LoadedScene, IpcError> {
    let override_path = state.settings.lock().expect("settings lock").osu_stable_path.clone();
    let listing_cache = Arc::clone(&state.listing_cache);
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        load::load_replay_auto(
            Path::new(&osr_path),
            override_path.as_deref().map(Path::new),
            &crate::stable::default_candidates(),
            &listing_cache,
        )
    })
    .await
    .map_err(join_err)??;
    Ok(install_scene(&app, state.inner(), outcome))
}

#[tauri::command]
pub async fn load_replay_with_beatmap<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    osr_path: String,
    beatmap_path: String,
    allow_mismatch: bool,
) -> Result<LoadedScene, IpcError> {
    let cache_root = state.cache_root.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        load::load_with_beatmap(
            Path::new(&osr_path),
            Path::new(&beatmap_path),
            allow_mismatch,
            &cache_root,
        )
    })
    .await
    .map_err(join_err)??;
    Ok(install_scene(&app, state.inner(), outcome))
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Settings {
    state.settings.lock().expect("settings lock").clone()
}

#[tauri::command]
pub fn set_osu_stable_path(
    state: State<'_, AppState>,
    path: Option<String>,
) -> Result<Settings, IpcError> {
    let mut settings = state.settings.lock().expect("settings lock");
    // persist before publishing: a failed save must not leave memory ahead
    // of disk, where the frontend was told the change was rejected but every
    // later load would use it anyway
    let mut candidate = settings.clone();
    candidate.osu_stable_path = path;
    save_settings(&state.config_dir, &candidate)?;
    *settings = candidate;
    Ok(settings.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::AppState;
    use crate::testutil::{fixtures_dir, osr_bytes, write_osz};
    use tauri::Manager;

    fn mock_app(config_dir: std::path::PathBuf, cache_root: std::path::PathBuf) -> tauri::App<tauri::test::MockRuntime> {
        tauri::test::mock_builder()
            .invoke_handler(tauri::generate_handler![
                load_replay,
                load_replay_with_beatmap,
                get_settings,
                set_osu_stable_path
            ])
            .manage(AppState::new(config_dir, cache_root))
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap()
    }

    /// stages the committed fixture map and a matching .osr in a temp dir
    fn staged_replay(dir: &std::path::Path) -> (std::path::PathBuf, std::path::PathBuf) {
        let osu_bytes = std::fs::read(fixtures_dir().join("beatmaps").join("stacking-v14.osu")).unwrap();
        let md5 = format!("{:x}", md5::compute(&osu_bytes));
        let osu_path = dir.join("map.osu");
        std::fs::write(&osu_path, &osu_bytes).unwrap();
        let osr_path = dir.join("replay.osr");
        std::fs::write(&osr_path, osr_bytes(&md5, 0, None)).unwrap();
        (osr_path, osu_path)
    }

    #[test]
    fn the_manual_command_loads_and_stores_the_session() {
        let dir = tempfile::tempdir().unwrap();
        let app = mock_app(dir.path().join("config"), dir.path().join("cache"));
        let (osr_path, osu_path) = staged_replay(dir.path());

        let scene = tauri::async_runtime::block_on(load_replay_with_beatmap(
            app.handle().clone(),
            app.state(),
            osr_path.display().to_string(),
            osu_path.display().to_string(),
            false,
        ))
        .unwrap();
        assert_eq!(scene.beatmap.title, "Stacking Fixture");

        let state = app.state::<AppState>();
        assert!(state.session.lock().unwrap().is_some(), "the session must be retained");
    }

    #[test]
    fn replacing_the_session_deletes_the_previous_cache_dir() {
        let dir = tempfile::tempdir().unwrap();
        let app = mock_app(dir.path().join("config"), dir.path().join("cache"));

        let osu_bytes = std::fs::read(fixtures_dir().join("beatmaps").join("stacking-v14.osu")).unwrap();
        let md5 = format!("{:x}", md5::compute(&osu_bytes));
        let osz_path = dir.path().join("set.osz");
        write_osz(&osz_path, &[("map.osu", osu_bytes.as_slice())]);
        let osr_path = dir.path().join("replay.osr");
        std::fs::write(&osr_path, osr_bytes(&md5, 0, None)).unwrap();

        let load = || {
            tauri::async_runtime::block_on(load_replay_with_beatmap(
                app.handle().clone(),
                app.state(),
                osr_path.display().to_string(),
                osz_path.display().to_string(),
                false,
            ))
            .unwrap()
        };

        load();
        let state = app.state::<AppState>();
        let first_dir = {
            let session = state.session.lock().unwrap();
            session.as_ref().unwrap().lease.as_ref().unwrap().dir().to_path_buf()
        };
        assert!(first_dir.is_dir());

        load();
        assert!(!first_dir.exists(), "the replaced session's cache dir must be deleted");
        let second_dir = {
            let session = state.session.lock().unwrap();
            session.as_ref().unwrap().lease.as_ref().unwrap().dir().to_path_buf()
        };
        assert!(second_dir.is_dir());
        assert_ne!(first_dir, second_dir);
    }

    #[test]
    fn typed_errors_cross_the_command_boundary() {
        let dir = tempfile::tempdir().unwrap();
        let app = mock_app(dir.path().join("config"), dir.path().join("cache"));
        let (osr_path, _osu) = staged_replay(dir.path());
        let other = dir.path().join("other.osu");
        std::fs::write(&other, b"osu file format v14\n\n[General]\nMode: 0\n").unwrap();

        let err = tauri::async_runtime::block_on(load_replay_with_beatmap(
            app.handle().clone(),
            app.state(),
            osr_path.display().to_string(),
            other.display().to_string(),
            false,
        ))
        .unwrap_err();
        assert!(matches!(err, crate::error::IpcError::BeatmapMismatch { .. }));
    }

    #[test]
    fn settings_commands_persist_the_override() {
        let dir = tempfile::tempdir().unwrap();
        let config_dir = dir.path().join("config");
        let app = mock_app(config_dir.clone(), dir.path().join("cache"));

        assert_eq!(get_settings(app.state()).osu_stable_path, None);
        let updated =
            set_osu_stable_path(app.state(), Some(r"D:\osu!".into())).unwrap();
        assert_eq!(updated.osu_stable_path.as_deref(), Some(r"D:\osu!"));
        // persisted, not just in memory
        assert_eq!(
            crate::settings::load_settings(&config_dir).osu_stable_path.as_deref(),
            Some(r"D:\osu!")
        );
        assert_eq!(get_settings(app.state()).osu_stable_path.as_deref(), Some(r"D:\osu!"));
    }

    #[test]
    fn a_failed_save_leaves_the_setting_unpublished() {
        let dir = tempfile::tempdir().unwrap();
        // the config dir's parent is a file, so save_settings cannot create
        // the directory and the write fails
        let blocker = dir.path().join("blocker");
        std::fs::write(&blocker, b"not a directory").unwrap();
        let app = mock_app(blocker.join("config"), dir.path().join("cache"));

        let err = set_osu_stable_path(app.state(), Some(r"D:\osu!".into())).unwrap_err();
        assert!(matches!(err, IpcError::Io { .. }));
        // the rejected value must not linger in memory to drive later loads
        assert_eq!(get_settings(app.state()).osu_stable_path, None);
    }
}
