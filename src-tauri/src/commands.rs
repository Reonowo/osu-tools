//! the thin command layer: clone inputs, run the pure pipeline on a blocking
//! thread, allow media on the asset-protocol scope, swap the session

use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::{AppHandle, Manager, Runtime, State};

use crate::error::IpcError;
use crate::load::{self, LoadOutcome, SavedBeatmap};
use crate::scene::LoadedScene;
use crate::settings::{save_settings, EditingPrefs, EffectPrefs, OverlayPrefs, RecentReplay, Settings};
use crate::state::AppState;

fn join_err(e: tauri::Error) -> IpcError {
    IpcError::Internal { message: format!("load task failed: {e}") }
}

/// media files ride the asset protocol; the runtime scope allowance is what
/// makes convertFileSrc urls resolvable. allowances for songs-folder media
/// accumulate for the session (TODO.md tracks revocation-on-replace)
fn install_scene<R: Runtime>(app: &AppHandle<R>, state: &AppState, outcome: LoadOutcome) -> LoadedScene {
    let LoadOutcome { scene, session, .. } = outcome;
    let scope = app.asset_protocol_scope();
    for path in [scene.audio_path.as_deref(), scene.background_path.as_deref()].into_iter().flatten() {
        let _ = scope.allow_file(Path::new(path));
    }
    // replacing the session drops the previous scene's cache lease, which
    // deletes its extracted directory
    *state.session.lock().expect("session lock") = Some(session);
    scene
}

/// standard accuracy over the header counts -- the same weighting the replay
/// panel shows, computed here so the recents card needs no scene
fn header_accuracy(replay: &crate::scene::ReplayMeta) -> f64 {
    let judged = u32::from(replay.count_300)
        + u32::from(replay.count_100)
        + u32::from(replay.count_50)
        + u32::from(replay.count_miss);
    if judged == 0 {
        return 0.0;
    }
    let weighted = 300.0 * f64::from(replay.count_300)
        + 100.0 * f64::from(replay.count_100)
        + 50.0 * f64::from(replay.count_50);
    weighted / (300.0 * f64::from(judged))
}

/// a recents write is a convenience, never a reason to fail a load that
/// already succeeded: an unwritable settings file must still leave the
/// replay open. the entry carries the beatmap origin the load resolved, so
/// every successful open -- first or thousandth -- refreshes what the next
/// reopen resolves through. it borrows the outcome install_scene consumes, so
/// it runs first; the two share no state, and neither can fail
fn record_recent(state: &AppState, osr_path: &str, outcome: &LoadOutcome) {
    let LoadOutcome { scene, origin, .. } = outcome;
    let opened_at_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let entry = RecentReplay {
        osr_path: osr_path.to_string(),
        title: scene.beatmap.title.clone(),
        version: scene.beatmap.version.clone(),
        player_name: scene.replay.player_name.clone(),
        accuracy: header_accuracy(&scene.replay),
        max_combo: u32::from(scene.replay.max_combo),
        opened_at_ms,
        beatmap_path: Some(origin.path.display().to_string()),
        beatmap_dir: Some(origin.dir.display().to_string()),
        beatmap_md5: Some(origin.md5.clone()),
        allow_mismatch: origin.mismatch,
    };
    let mut settings = state.settings.lock().expect("settings lock");
    let mut candidate = settings.clone();
    candidate.push_recent(entry);
    if save_settings(&state.config_dir, &candidate).is_ok() {
        *settings = candidate;
    }
}

/// the association the recents entry for `osr_path` carries, if any. an
/// unknown path (or a legacy entry) yields an empty association, which the
/// pipeline resolves exactly like a plain auto load
fn saved_beatmap(settings: &Settings, osr_path: &str) -> SavedBeatmap {
    let Some(entry) = settings.recents.iter().find(|r| r.osr_path == osr_path) else {
        return SavedBeatmap::default();
    };
    SavedBeatmap {
        path: entry.beatmap_path.as_deref().map(PathBuf::from),
        dir: entry.beatmap_dir.as_deref().map(PathBuf::from),
        md5: entry.beatmap_md5.clone(),
        allow_mismatch: entry.allow_mismatch,
    }
}

#[tauri::command]
pub async fn load_replay<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    osr_path: String,
) -> Result<LoadedScene, IpcError> {
    let override_path = state.settings.lock().expect("settings lock").osu_stable_path.clone();
    let listing_cache = Arc::clone(&state.listing_cache);
    let osr_path_for_recents = osr_path.clone();
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
    record_recent(state.inner(), &osr_path_for_recents, &outcome);
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
    let osr_path_for_recents = osr_path.clone();
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
    record_recent(state.inner(), &osr_path_for_recents, &outcome);
    Ok(install_scene(&app, state.inner(), outcome))
}

/// reopening from the recents list. the frontend sends only the .osr path:
/// the beatmap association lives in the settings file this process owns, so
/// passing it across the boundary would only be a second copy to keep in sync
#[tauri::command]
pub async fn load_recent_replay<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    osr_path: String,
) -> Result<LoadedScene, IpcError> {
    let (override_path, saved) = {
        let settings = state.settings.lock().expect("settings lock");
        (settings.osu_stable_path.clone(), saved_beatmap(&settings, &osr_path))
    };
    let listing_cache = Arc::clone(&state.listing_cache);
    let cache_root = state.cache_root.clone();
    let osr_path_for_recents = osr_path.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        load::load_recent_replay(
            Path::new(&osr_path),
            &saved,
            override_path.as_deref().map(Path::new),
            &crate::stable::default_candidates(),
            &listing_cache,
            &cache_root,
        )
    })
    .await
    .map_err(join_err)??;
    record_recent(state.inner(), &osr_path_for_recents, &outcome);
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

/// the viewer preferences that survive a restart. the frontend debounces its
/// calls (state/persist.ts), so this runs on a settled value rather than per
/// slider tick. sanitized before the write for the same reason load_settings
/// sanitizes after the read -- neither side trusts a range it did not clamp
#[tauri::command]
pub fn set_viewer_prefs(
    state: State<'_, AppState>,
    volume: u32,
    overlays: OverlayPrefs,
    editing: EditingPrefs,
    effects: EffectPrefs,
) -> Result<Settings, IpcError> {
    let mut settings = state.settings.lock().expect("settings lock");
    // persist before publishing, as in set_osu_stable_path
    let mut candidate = settings.clone();
    candidate.volume = volume;
    candidate.overlays = overlays;
    candidate.editing = editing;
    candidate.effects = effects;
    candidate.sanitize();
    save_settings(&state.config_dir, &candidate)?;
    *settings = candidate;
    Ok(settings.clone())
}

#[tauri::command]
pub fn clear_recents(state: State<'_, AppState>) -> Result<Settings, IpcError> {
    let mut settings = state.settings.lock().expect("settings lock");
    // persist before publishing, as in set_osu_stable_path
    let mut candidate = settings.clone();
    candidate.recents.clear();
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
                load_recent_replay,
                get_settings,
                set_osu_stable_path,
                set_viewer_prefs,
                clear_recents
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

    #[test]
    fn viewer_prefs_persist_and_clamp() {
        let dir = tempfile::tempdir().unwrap();
        let config_dir = dir.path().join("config");
        let app = mock_app(config_dir.clone(), dir.path().join("cache"));

        let prefs = OverlayPrefs {
            cursor_path: true,
            key_overlay: false,
            display_length: 50.0, // below the range floor
            ..OverlayPrefs::default()
        };
        let editing = EditingPrefs { snap_to_lattice: false, warn_on_overwrite: false };
        // the master off with granular flags left on: the command stores both
        // halves verbatim, since folding the master in is the frontend's job
        let effects = EffectPrefs { enabled: false, cursor_trail: false, ..EffectPrefs::default() };
        // volume over 100
        let updated =
            set_viewer_prefs(app.state(), 250, prefs, editing.clone(), effects.clone()).unwrap();

        assert_eq!(updated.volume, 100);
        assert_eq!(updated.overlays.display_length, crate::settings::DISPLAY_LENGTH_MIN);
        assert!(updated.overlays.cursor_path);
        assert!(!updated.overlays.key_overlay);
        assert_eq!(updated.editing, editing);
        assert_eq!(updated.effects, effects);
        assert!(updated.effects.hit_effects, "a granular flag survives a disabled master");

        // persisted in sanitized form, not just published
        let from_disk = crate::settings::load_settings(&config_dir);
        assert_eq!(from_disk, updated);
        assert_eq!(get_settings(app.state()), updated);
    }

    #[test]
    fn setting_viewer_prefs_leaves_the_stable_path_alone() {
        let dir = tempfile::tempdir().unwrap();
        let config_dir = dir.path().join("config");
        let app = mock_app(config_dir.clone(), dir.path().join("cache"));

        set_osu_stable_path(app.state(), Some(r"D:\osu!".into())).unwrap();
        let updated = set_viewer_prefs(
            app.state(),
            30,
            OverlayPrefs::default(),
            EditingPrefs::default(),
            EffectPrefs::default(),
        )
        .unwrap();

        assert_eq!(updated.osu_stable_path.as_deref(), Some(r"D:\osu!"));
        assert_eq!(crate::settings::load_settings(&config_dir).osu_stable_path.as_deref(), Some(r"D:\osu!"));
    }

    #[test]
    fn a_failed_prefs_save_leaves_them_unpublished() {
        let dir = tempfile::tempdir().unwrap();
        let blocker = dir.path().join("blocker");
        std::fs::write(&blocker, b"not a directory").unwrap();
        let app = mock_app(blocker.join("config"), dir.path().join("cache"));

        let err = set_viewer_prefs(
            app.state(),
            25,
            OverlayPrefs::default(),
            EditingPrefs::default(),
            EffectPrefs::default(),
        )
        .unwrap_err();
        assert!(matches!(err, IpcError::Io { .. }));
        assert_eq!(get_settings(app.state()).volume, 100, "the rejected volume must not linger");
    }

    #[test]
    fn a_successful_load_records_a_recent() {
        let dir = tempfile::tempdir().unwrap();
        let config_dir = dir.path().join("config");
        let app = mock_app(config_dir.clone(), dir.path().join("cache"));
        let (osr_path, osu_path) = staged_replay(dir.path());

        tauri::async_runtime::block_on(load_replay_with_beatmap(
            app.handle().clone(),
            app.state(),
            osr_path.display().to_string(),
            osu_path.display().to_string(),
            false,
        ))
        .unwrap();

        let settings = get_settings(app.state());
        assert_eq!(settings.recents.len(), 1);
        assert_eq!(settings.recents[0].osr_path, osr_path.display().to_string());
        assert_eq!(settings.recents[0].title, "Stacking Fixture");
        // persisted, not just published
        assert_eq!(crate::settings::load_settings(&config_dir).recents.len(), 1);
    }

    #[test]
    fn a_recorded_recent_carries_the_beatmap_it_resolved() {
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

        let settings = get_settings(app.state());
        let entry = &settings.recents[0];
        assert_eq!(entry.beatmap_path.as_deref(), Some(osu_path.display().to_string().as_str()));
        assert_eq!(entry.beatmap_dir.as_deref(), Some(dir.path().display().to_string().as_str()));
        assert_eq!(entry.beatmap_md5.as_deref(), Some(scene.beatmap.md5.as_str()));
        assert!(!entry.allow_mismatch, "a hash-matched load records no override consent");
    }

    #[test]
    fn an_osz_load_records_the_archive_folder_not_its_cache_dir() {
        // the .osz scene's media resolves from a cache lease that is deleted
        // as soon as the session is replaced, so recording that directory
        // would leave the entry pointing at nothing on the next reopen
        let dir = tempfile::tempdir().unwrap();
        let app = mock_app(dir.path().join("config"), dir.path().join("cache"));
        let osu_bytes = std::fs::read(fixtures_dir().join("beatmaps").join("stacking-v14.osu")).unwrap();
        let md5 = format!("{:x}", md5::compute(&osu_bytes));
        let osz_path = dir.path().join("set.osz");
        write_osz(&osz_path, &[("map.osu", osu_bytes.as_slice())]);
        let osr_path = dir.path().join("replay.osr");
        std::fs::write(&osr_path, osr_bytes(&md5, 0, None)).unwrap();

        tauri::async_runtime::block_on(load_replay_with_beatmap(
            app.handle().clone(),
            app.state(),
            osr_path.display().to_string(),
            osz_path.display().to_string(),
            false,
        ))
        .unwrap();

        let state = app.state::<AppState>();
        let lease_dir = {
            let session = state.session.lock().unwrap();
            session.as_ref().unwrap().lease.as_ref().unwrap().dir().to_path_buf()
        };
        let settings = get_settings(app.state());
        let entry = &settings.recents[0];
        assert_eq!(entry.beatmap_path.as_deref(), Some(osz_path.display().to_string().as_str()));
        assert_eq!(entry.beatmap_dir.as_deref(), Some(dir.path().display().to_string().as_str()));

        // dropping the session deletes the lease; what was recorded survives
        *state.session.lock().unwrap() = None;
        assert!(!lease_dir.exists());
        assert!(std::path::Path::new(entry.beatmap_dir.as_deref().unwrap()).is_dir());
    }

    #[test]
    fn reopening_a_recent_resolves_through_its_association_and_refreshes_it() {
        let dir = tempfile::tempdir().unwrap();
        let config_dir = dir.path().join("config");
        let app = mock_app(config_dir.clone(), dir.path().join("cache"));
        let (osr_path, osu_path) = staged_replay(dir.path());
        // an install directory holding no osu!.db, so the stable lookup cannot
        // be what answers the reopen -- and no real install is consulted
        let no_install = dir.path().join("no-install");
        std::fs::create_dir_all(&no_install).unwrap();
        set_osu_stable_path(app.state(), Some(no_install.display().to_string())).unwrap();

        tauri::async_runtime::block_on(load_replay_with_beatmap(
            app.handle().clone(),
            app.state(),
            osr_path.display().to_string(),
            osu_path.display().to_string(),
            false,
        ))
        .unwrap();

        // the difficulty is renamed between the two opens, so the folder the
        // association remembers is what finds it again
        let renamed = dir.path().join("renamed.osu");
        std::fs::rename(&osu_path, &renamed).unwrap();

        let scene = tauri::async_runtime::block_on(load_recent_replay(
            app.handle().clone(),
            app.state(),
            osr_path.display().to_string(),
        ))
        .unwrap();
        assert_eq!(scene.beatmap.title, "Stacking Fixture");

        let settings = get_settings(app.state());
        assert_eq!(settings.recents.len(), 1, "a reopen moves the entry rather than adding one");
        assert_eq!(
            settings.recents[0].beatmap_path.as_deref(),
            Some(renamed.display().to_string().as_str()),
            "every successful reopen refreshes the origin"
        );
        // persisted, not just published
        assert_eq!(crate::settings::load_settings(&config_dir).recents, settings.recents);
    }

    #[test]
    fn a_consented_override_persists_and_the_reopen_resolves_through_it() {
        // the whole path a user walks when the picked beatmap is not the one
        // the replay was played on: consent once, and every reopen must land
        // back on that same map. the three legs are covered apart (here,
        // settings.rs, load.rs); this is the one that fails as "the app
        // silently loaded the wrong beatmap"
        use crate::error::Warning;
        use crate::scene::{NotSimulatedReason, SimulationDto};

        let dir = tempfile::tempdir().unwrap();
        let config_dir = dir.path().join("config");
        let app = mock_app(config_dir.clone(), dir.path().join("cache"));
        // the map the replay's header hashes to stays right next to it, so a
        // reopen that fell through to the folder scan would resolve that one
        let (osr_path, played_path) = staged_replay(dir.path());
        let played_md5 = format!("{:x}", md5::compute(std::fs::read(&played_path).unwrap()));
        let override_bytes =
            std::fs::read(fixtures_dir().join("beatmaps").join("slider-zoo-v14.osu")).unwrap();
        let override_md5 = format!("{:x}", md5::compute(&override_bytes));
        let override_path = dir.path().join("override.osu");
        std::fs::write(&override_path, &override_bytes).unwrap();
        // an install directory holding no osu!.db, so the stable lookup cannot
        // be what answers the reopen -- and no real install is consulted
        let no_install = dir.path().join("no-install");
        std::fs::create_dir_all(&no_install).unwrap();
        set_osu_stable_path(app.state(), Some(no_install.display().to_string())).unwrap();

        let opened = tauri::async_runtime::block_on(load_replay_with_beatmap(
            app.handle().clone(),
            app.state(),
            osr_path.display().to_string(),
            override_path.display().to_string(),
            true,
        ))
        .unwrap();
        assert_eq!(opened.beatmap.md5, override_md5, "the consented map is what opened");

        let settings = get_settings(app.state());
        let entry = &settings.recents[0];
        assert!(entry.allow_mismatch, "the consent has to be recorded, not just honoured once");
        assert_eq!(entry.beatmap_path.as_deref(), Some(override_path.display().to_string().as_str()));
        assert_eq!(entry.beatmap_dir.as_deref(), Some(dir.path().display().to_string().as_str()));
        assert_eq!(entry.beatmap_md5.as_deref(), Some(override_md5.as_str()));
        // persisted, not just published: a reopen after a restart reads disk
        assert_eq!(crate::settings::load_settings(&config_dir).recents, settings.recents);

        let reopened = tauri::async_runtime::block_on(load_recent_replay(
            app.handle().clone(),
            app.state(),
            osr_path.display().to_string(),
        ))
        .unwrap();
        assert_eq!(reopened.beatmap.md5, override_md5, "the reopen resolves through the consent");
        assert_ne!(reopened.beatmap.md5, played_md5, "the hash-matched neighbour must not win");
        // and it comes back in the same shape the consented load did, rather
        // than as an ordinary match
        assert!(matches!(reopened.warnings[0], Warning::BeatmapMismatch { .. }));
        assert!(matches!(
            &reopened.simulation,
            SimulationDto::NotSimulated { reason: NotSimulatedReason::BeatmapMismatch }
        ));

        let after = get_settings(app.state());
        assert_eq!(after.recents.len(), 1, "a reopen moves the entry rather than adding one");
        assert!(after.recents[0].allow_mismatch, "the refreshed entry keeps the consent");
        assert_eq!(
            after.recents[0].beatmap_path.as_deref(),
            Some(override_path.display().to_string().as_str())
        );
    }

    #[test]
    fn reopening_without_an_association_reports_the_missing_install() {
        // an entry written before the association existed, or a path that is
        // not in recents at all: nothing was consulted but the install, so
        // its own error stands rather than folding into beatmapNotFound.
        // both route to the beatmap picker frontend-side (state/errors.ts),
        // but only this one also says to set the install path
        let dir = tempfile::tempdir().unwrap();
        let app = mock_app(dir.path().join("config"), dir.path().join("cache"));
        let (osr_path, _osu_path) = staged_replay(dir.path());
        let no_install = dir.path().join("no-install");
        std::fs::create_dir_all(&no_install).unwrap();
        set_osu_stable_path(app.state(), Some(no_install.display().to_string())).unwrap();

        let err = tauri::async_runtime::block_on(load_recent_replay(
            app.handle().clone(),
            app.state(),
            osr_path.display().to_string(),
        ))
        .unwrap_err();
        assert!(matches!(err, IpcError::OsuDbNotFound { .. }), "got {err:?}");
        assert!(get_settings(app.state()).recents.is_empty(), "a failed reopen records nothing");
    }

    #[test]
    fn clear_recents_empties_and_persists() {
        let dir = tempfile::tempdir().unwrap();
        let config_dir = dir.path().join("config");
        let app = mock_app(config_dir.clone(), dir.path().join("cache"));
        let (osr_path, osu_path) = staged_replay(dir.path());

        tauri::async_runtime::block_on(load_replay_with_beatmap(
            app.handle().clone(),
            app.state(),
            osr_path.display().to_string(),
            osu_path.display().to_string(),
            false,
        ))
        .unwrap();
        assert_eq!(get_settings(app.state()).recents.len(), 1);

        assert!(clear_recents(app.state()).unwrap().recents.is_empty());
        assert!(crate::settings::load_settings(&config_dir).recents.is_empty());
    }

    #[test]
    fn an_unwritable_settings_file_does_not_fail_the_load() {
        let dir = tempfile::tempdir().unwrap();
        let blocker = dir.path().join("blocker");
        std::fs::write(&blocker, b"not a directory").unwrap();
        let app = mock_app(blocker.join("config"), dir.path().join("cache"));
        let (osr_path, osu_path) = staged_replay(dir.path());

        let scene = tauri::async_runtime::block_on(load_replay_with_beatmap(
            app.handle().clone(),
            app.state(),
            osr_path.display().to_string(),
            osu_path.display().to_string(),
            false,
        ));
        assert!(scene.is_ok(), "a recents write failure must not fail the load");
        assert!(get_settings(app.state()).recents.is_empty());
    }
}
