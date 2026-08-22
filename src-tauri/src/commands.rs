//! the thin command layer: clone inputs, run the pure pipeline on a blocking
//! thread, allow media on the asset-protocol scope, swap the session

use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::{AppHandle, Manager, Runtime, State};

use crate::edit::{self, EditDelta, EditOp, HistoryDto};
use crate::error::{editor_engine_error, IpcError};
use crate::load::{self, LoadOutcome, SavedBeatmap, SessionState};
use crate::scene::LoadedScene;
use crate::settings::{
    save_settings, AudioPrefs, EditingPrefs, EffectPrefs, GameplayPrefs, KeybindOverrides, OverlayPrefs,
    RecentReplay, Settings, TimelinePrefs,
};
use crate::skin::{SkinEntry, SkinEra, SkinLocator, SkinManifest, SkinSource};
use crate::state::AppState;
use engine::formats::osr::FIRST_LAZER_VERSION;
use engine::simulation::simulate;

fn join_err(task: &str, e: tauri::Error) -> IpcError {
    IpcError::Internal {
        message: format!("{task} task failed: {e}"),
    }
}

/// media files ride the asset protocol; the runtime scope allowance is what
/// makes convertFileSrc urls resolvable. allowances for songs-folder media
/// accumulate for the session (TODO.md tracks revocation-on-replace)
fn install_scene<R: Runtime>(app: &AppHandle<R>, state: &AppState, outcome: LoadOutcome) -> LoadedScene {
    let LoadOutcome {
        mut scene,
        mut session,
        ..
    } = outcome;
    let epoch = crate::state::next_epoch();
    scene.epoch = epoch;
    session.epoch = epoch;
    let scope = app.asset_protocol_scope();
    // the map's own hit-sample files and its own ART ride the same protocol as
    // its audio and background. every one of them was resolved strictly inside
    // the beatmap's own directory (media::resolve_sample_files and
    // media::resolve_texture_files), so allowing them widens the scope by
    // exactly the files the lookup chain can ask for -- and without it a
    // beatmap skin's textures resolve to urls the protocol refuses, which reads
    // as the mapset having shipped no art at all
    for path in [scene.audio_path.as_deref(), scene.background_path.as_deref()]
        .into_iter()
        .flatten()
        .chain(scene.sample_files.values().map(String::as_str))
        .chain(scene.texture_files.values().map(String::as_str))
    {
        let _ = scope.allow_file(Path::new(path));
    }
    // replacing the session drops the previous scene's cache lease, which
    // deletes its extracted directory
    *state.session.lock().expect("session lock") = Some(session);
    scene
}

/// a skin's own files ride the asset protocol exactly as the beatmap's media
/// does, and for the same reason: `convertFileSrc` urls are only resolvable
/// once the runtime scope allows the path. every entry in the manifest was
/// resolved strictly inside the skin's own directory (`skin::load_skin`), so
/// this widens the scope by exactly the files the lookup chain can ask for.
///
/// without it a user skin's samples resolve to a url the protocol refuses and
/// the fetch fails silently, which reads as the skin having no samples at all
fn allow_skin_files<R: Runtime>(app: &AppHandle<R>, manifest: &SkinManifest) {
    let scope = app.asset_protocol_scope();
    for path in manifest.files.values() {
        let _ = scope.allow_file(Path::new(path));
    }
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

/// the beatmap association `osr_path` carries, if any. the recents entry is
/// where it is stored, not what it belongs to (docs/adr/0005): an unknown path
/// -- or a legacy entry written before the association existed -- yields an
/// empty one, which the pipeline resolves exactly like a plain auto load
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

/// the one open: a picked file, a drop, a recents card, and every future route
/// alike. the frontend sends only the `.osr` path -- the beatmap association
/// lives in the settings file this process owns, so passing it across the
/// boundary would only be a second copy to keep in sync
#[tauri::command]
pub async fn load_replay<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    osr_path: String,
) -> Result<LoadedScene, IpcError> {
    let (override_path, saved) = {
        let settings = state.settings.lock().expect("settings lock");
        (
            settings.osu_stable_path.clone(),
            saved_beatmap(&settings, &osr_path),
        )
    };
    let listing_cache = Arc::clone(&state.listing_cache);
    let cache_root = state.cache_root.clone();
    let osr_path_for_recents = osr_path.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        load::load_replay_auto(
            Path::new(&osr_path),
            &saved,
            override_path.as_deref().map(Path::new),
            &crate::stable::default_candidates(),
            &listing_cache,
            &cache_root,
        )
    })
    .await
    .map_err(|e| join_err("load", e))??;
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
    .map_err(|e| join_err("load", e))??;
    record_recent(state.inner(), &osr_path_for_recents, &outcome);
    Ok(install_scene(&app, state.inner(), outcome))
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Settings {
    state.settings.lock().expect("settings lock").clone()
}

#[tauri::command]
pub fn set_osu_stable_path(state: State<'_, AppState>, path: Option<String>) -> Result<Settings, IpcError> {
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
    audio: AudioPrefs,
    gameplay: GameplayPrefs,
    overlays: OverlayPrefs,
    editing: EditingPrefs,
    effects: EffectPrefs,
    timeline: TimelinePrefs,
    keybinds: KeybindOverrides,
) -> Result<Settings, IpcError> {
    let mut settings = state.settings.lock().expect("settings lock");
    // persist before publishing, as in set_osu_stable_path
    let mut candidate = settings.clone();
    candidate.volume = volume;
    candidate.audio = audio;
    candidate.gameplay = gameplay;
    candidate.overlays = overlays;
    candidate.editing = editing;
    candidate.effects = effects;
    candidate.timeline = timeline;
    candidate.keybinds = keybinds;
    candidate.sanitize();
    save_settings(&state.config_dir, &candidate)?;
    *settings = candidate;
    Ok(settings.clone())
}

/// runs a closure off the ipc thread, mapping a join failure the way the other
/// blocking commands do.
///
/// every skin command does unbounded disk work -- `scan_skin_dir` stats each
/// file and opens each texture's header, and `list_skins` does that once per
/// skin in the install -- and a non-async `#[tauri::command]` resolves inline
/// on the webview's own thread. `get_skin` is on the STARTUP path, so leaving
/// these synchronous would freeze the window for the length of a full skin
/// walk before the app is interactive
async fn off_thread<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, IpcError> + Send + 'static,
) -> Result<T, IpcError> {
    match tauri::async_runtime::spawn_blocking(work).await {
        Ok(result) => result,
        Err(error) => Err(IpcError::Internal {
            message: format!("skin work failed to run: {error}"),
        }),
    }
}

/// every skin the app knows about: the bundled row first, then the detected
/// stable install's, then the imported ones.
///
/// the bundled row is a ROW rather than a "no skin selected" state -- that is
/// the decision that makes the rest coherent, since the user can always get
/// back to the app's own look without having to know that "no skin" means
/// something different.
///
/// no stable install is an empty stretch of the list, never an error: someone
/// with no osu! installation still gets a picker with the bundled row and
/// whatever they imported
#[tauri::command]
pub async fn list_skins(state: State<'_, AppState>) -> Result<Vec<SkinEntry>, IpcError> {
    // owned before the await, so no lock and no state borrow crosses it
    let (stable_root, selected) = {
        let settings = state.settings.lock().expect("settings lock");
        (settings.osu_stable_path.clone(), settings.skin.clone())
    };
    let skins_root = state.skins_root.clone();
    off_thread(move || Ok(list_skins_blocking(stable_root, selected, &skins_root))).await
}

fn list_skins_blocking(
    stable_root: Option<String>,
    selected: SkinLocator,
    skins_root: &Path,
) -> Vec<SkinEntry> {
    let candidates = match stable_root {
        Some(path) => vec![PathBuf::from(path)],
        None => crate::stable::default_candidates(),
    };

    let mut entries = vec![SkinEntry {
        locator: SkinLocator::Bundled,
        name: SkinManifest::bundled().name,
        author: SkinManifest::bundled().author,
        source: SkinSource::Bundled,
        era: SkinEra::Lazer,
        refusal: None,
    }];

    // the install is located by its own `Skins` folder rather than through
    // `detect_install`: a user can have a skins folder without the `osu!.db`
    // that beatmap lookup needs, and refusing to list their skins over a
    // missing database would be a lookup rule leaking into an unrelated one
    for root in candidates {
        let found = crate::skin::enumerate_stable_skins(&root);
        if !found.is_empty() {
            entries.extend(found);
            break;
        }
    }

    entries.extend(crate::skin::enumerate_imported_skins(skins_root));

    // a folder skin is not enumerable -- it lives wherever the user pointed
    // at, and nothing walks the whole disk looking for more. so the SELECTED
    // one is listed explicitly, or browsing to a skin would leave the picker
    // showing no row selected at all and no way back to it but browsing again
    if let SkinLocator::Folder { path } = &selected {
        let dir = PathBuf::from(path);
        if dir.is_dir() {
            entries.push(crate::skin::entry_for(&dir, SkinSource::Folder));
        }
    }
    entries
}

/// the persisted selection, resolved. called once at startup: a locator that
/// no longer resolves comes back as the bundled default with `fellBack` set,
/// so the surface can say what happened instead of the user wondering where
/// their skin went
#[tauri::command]
pub async fn get_skin<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
) -> Result<SkinManifest, IpcError> {
    let locator = state.settings.lock().expect("settings lock").skin.clone();
    let manifest = off_thread(move || crate::skin::load_skin(&locator)).await?;
    allow_skin_files(&app, &manifest);
    Ok(manifest)
}

/// pick a skin. persists the locator and returns the loaded manifest.
///
/// a cap breach propagates: the skin is refused WHOLE and the previous
/// selection stays, because a half-loaded skin is exactly the unexplained
/// wrongness this posture exists to prevent. a locator that does not resolve
/// is not a breach -- it is a miss, and the manifest says so
#[tauri::command]
pub async fn set_skin<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    locator: SkinLocator,
) -> Result<SkinManifest, IpcError> {
    // load BEFORE persisting: a refusal must not leave the settings file
    // pointing at a skin the app just declined to load
    // ticketed BEFORE the load, so the write order is CALL order -- see
    // `SkinWriteOrder`. without it a slow pick finishing after a fast one would
    // persist last and name a skin the user already moved off
    let ticket = state.skin_writes.lock().expect("skin write lock").issue();
    let loading = locator.clone();
    let manifest = off_thread(move || crate::skin::load_skin(&loading)).await?;
    allow_skin_files(&app, &manifest);
    persist_skin_selection(&state, ticket, locator)?;
    Ok(manifest)
}

/// persists the selection only while this ticket is still the newest to reach
/// the write. the manifest is returned to the caller either way -- what is
/// dropped is the stale WRITE, not the answer
fn persist_skin_selection(state: &AppState, ticket: u64, locator: SkinLocator) -> Result<(), IpcError> {
    let mut order = state.skin_writes.lock().expect("skin write lock");
    if !order.claim(ticket) {
        return Ok(());
    }
    let mut settings = state.settings.lock().expect("settings lock");
    let mut candidate = settings.clone();
    candidate.skin = locator;
    save_settings(&state.config_dir, &candidate)?;
    *settings = candidate;
    Ok(())
}

/// import an `.osk` and select it. the archive is copied into the app-owned
/// skins directory -- the one path that copies, because an archive has nowhere
/// else to be read from
#[tauri::command]
pub async fn import_skin<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    path: String,
) -> Result<SkinManifest, IpcError> {
    // the extract and the walk are both unbounded, so both go off the thread
    let ticket = state.skin_writes.lock().expect("skin write lock").issue();
    let skins_root = state.skins_root.clone();
    let import_lock = state.import_lock.clone();
    let (locator, manifest) = off_thread(move || {
        // one import at a time: the staging and retiring directories are named
        // after the skin, so two same-named archives would trample each other's
        // half-extracted output and could leave the user with neither their old
        // skin nor a whole new one
        let _guard = import_lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        std::fs::create_dir_all(&skins_root)?;
        let locator = crate::osk::import_osk(Path::new(&path), &skins_root)?;
        let manifest = crate::skin::load_skin(&locator)?;
        Ok((locator, manifest))
    })
    .await?;
    allow_skin_files(&app, &manifest);
    persist_skin_selection(&state, ticket, locator)?;
    Ok(manifest)
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

/// the frame/keypress editing gate: NotSimulated scenes cannot re-derive
/// results, and a lazer-native play would re-derive under the wrong rules
/// profile (TODO.md's lazer-native item). metadata ops never pass through here
fn frame_edit_gate(session: &SessionState) -> Result<(), IpcError> {
    if !session.simulatable {
        return Err(IpcError::NotEditable {
            reason: "this replay was not simulated, so frame edits cannot re-derive its results".into(),
        });
    }
    if session.document.header().version >= FIRST_LAZER_VERSION {
        return Err(IpcError::NotEditable {
            reason: "lazer-native replays would re-derive their header under the wrong rules profile; \
                     metadata editing stays available"
                .into(),
        });
    }
    Ok(())
}

/// pushes the new label (clearing redo labels, as the document cleared its
/// redo stack), then trims from the front until the list matches the
/// document's depth -- which is exactly what absorbs an eviction at the cap.
/// the redo side is reconciled the same way against `redo_depth()`; on the
/// rollback path this keeps both mirrored lists in step with whatever the
/// document's checkpoint restored
fn sync_labels(session: &mut SessionState, pushed: Option<String>) {
    if let Some(label) = pushed {
        session.undo_labels.push(label);
        session.redo_labels.clear();
    }
    while session.undo_labels.len() > session.document.undo_depth() {
        session.undo_labels.remove(0);
    }
    session.redo_labels.truncate(session.document.redo_depth());
}

/// every editor command answers with the same authoritative snapshot
fn assemble_delta(
    session: &SessionState,
    frames: Option<edit::FrameChanges>,
    simulation: Option<crate::scene::SimulationDto>,
) -> EditDelta {
    let doc = &session.document;
    let mut labels = session.undo_labels.clone();
    labels.extend(session.redo_labels.iter().rev().cloned());
    EditDelta {
        revision: session.revision,
        frames,
        player_name: doc.header().player_name.clone(),
        timestamp_ticks: doc.header().timestamp_ticks.to_string(),
        dirty: doc.dirty(),
        frames_dirty: doc.frames_dirty(),
        metadata_dirty: doc.metadata_dirty(),
        can_undo: doc.undo_depth() > 0,
        can_redo: doc.redo_depth() > 0,
        history: HistoryDto {
            labels,
            cursor: doc.undo_depth(),
        },
        simulation,
    }
}

/// applies a batch of edits as one undo step and answers with the delta the
/// frontend renders it as: gate and mutate under the lock, re-simulate off
/// it, then publish or roll the mutation back on the way back in. the
/// frontend serializes commits, so nothing else mutates the document between
/// phases -- the epoch re-check in phase 3 guards the one thing that can
/// still happen, a scene install replacing the session out from under this call
#[tauri::command]
pub async fn apply_edit(
    state: State<'_, AppState>,
    epoch: u64,
    base_revision: u64,
    ops: Vec<EditOp>,
    label: String,
) -> Result<EditDelta, IpcError> {
    if label.len() > crate::limits::MAX_EDIT_LABEL_BYTES {
        return Err(IpcError::InvalidEdit {
            message: format!("label exceeds {} bytes", crate::limits::MAX_EDIT_LABEL_BYTES),
        });
    }
    let members = edit::translate_ops(&ops)?;
    let frame_ops = edit::ops_touch_frames(&ops);

    // phase 1: gate and mutate under the lock, snapshot for simulation
    let (report, snapshot, processed) = {
        let mut guard = state.session.lock().expect("session lock");
        let session = guard.as_mut().ok_or(IpcError::StaleSession)?;
        if session.epoch != epoch || session.revision != base_revision {
            return Err(IpcError::StaleSession);
        }
        if frame_ops {
            frame_edit_gate(session)?;
        }
        let Some(report) = session
            .document
            .apply_edit_batch(members)
            .map_err(editor_engine_error)?
        else {
            // every member was an identity: nothing changed, nothing to push
            return Ok(assemble_delta(session, None, None));
        };
        if !edit::frame_changed(&report) {
            session.document.commit_last();
            session.revision += 1;
            sync_labels(session, Some(label));
            return Ok(assemble_delta(session, None, None));
        }
        let snapshot = session.document.frames().to_vec();
        (report, snapshot, Arc::clone(&session.processed))
    };

    // phase 2: re-simulate off the lock -- the feedback loop that shows a
    // miss turning into a 300. a join failure (the blocking task panicked or
    // was cancelled) must reach phase 3 like any simulation refusal, so the
    // mutation rolls back instead of surviving as hidden backend state
    let sim = match tauri::async_runtime::spawn_blocking(move || simulate(&processed, &snapshot)).await {
        Ok(Ok(timeline)) => Ok(timeline),
        Ok(Err(e)) => Err(IpcError::InvalidEdit {
            message: format!("the edited replay exceeded simulation limits: {e}"),
        }),
        Err(e) => Err(join_err("simulation", e)),
    };

    // phase 3: publish, or roll the mutation back so a failed apply_edit
    // leaves the document untouched
    let mut guard = state.session.lock().expect("session lock");
    let session = guard.as_mut().ok_or(IpcError::StaleSession)?;
    if session.epoch != epoch {
        return Err(IpcError::StaleSession);
    }
    match sim {
        Ok(timeline) => {
            session.document.commit_last();
            session.revision += 1;
            sync_labels(session, Some(label));
            session.simulation = crate::scene::SimulationDto::authoritative(&timeline);
            let frames = edit::frame_changes(&report, session.document.frames());
            let simulation = Some(session.simulation.clone());
            Ok(assemble_delta(session, frames, simulation))
        }
        Err(e) => {
            session.document.rollback_last();
            sync_labels(session, None);
            Err(e)
        }
    }
}

enum HistoryDirection {
    Undo,
    Redo,
}

/// undo and redo share one shape: replay the op under the lock, move one
/// label between the stacks, re-simulate when the frames changed on a
/// simulatable scene, and answer with the post-step state. a failed
/// re-simulation replays the op the other way, leaving the document as the
/// command found it
async fn history_step(
    state: State<'_, AppState>,
    epoch: u64,
    direction: HistoryDirection,
) -> Result<EditDelta, IpcError> {
    let (report, snapshot, processed) = {
        let mut guard = state.session.lock().expect("session lock");
        let session = guard.as_mut().ok_or(IpcError::StaleSession)?;
        if session.epoch != epoch {
            return Err(IpcError::StaleSession);
        }
        let report = match direction {
            HistoryDirection::Undo => session.document.undo(),
            HistoryDirection::Redo => session.document.redo(),
        }
        .ok_or_else(|| IpcError::InvalidEdit {
            message: match direction {
                HistoryDirection::Undo => "nothing to undo".into(),
                HistoryDirection::Redo => "nothing to redo".into(),
            },
        })?;
        if !(session.simulatable && edit::frame_changed(&report)) {
            session.revision += 1;
            move_history_label(session, &direction);
            let frames = edit::frame_changes(&report, session.document.frames());
            return Ok(assemble_delta(session, frames, None));
        }
        let snapshot = session.document.frames().to_vec();
        (report, snapshot, Arc::clone(&session.processed))
    };

    // a join failure recovers exactly like a simulation refusal: the step
    // must be replayed the other way, not left installed behind an error
    let sim = match tauri::async_runtime::spawn_blocking(move || simulate(&processed, &snapshot)).await {
        Ok(Ok(timeline)) => Ok(timeline),
        Ok(Err(e)) => Err(IpcError::InvalidEdit {
            message: format!("the resulting replay exceeded simulation limits: {e}"),
        }),
        Err(e) => Err(join_err("simulation", e)),
    };

    let mut guard = state.session.lock().expect("session lock");
    let session = guard.as_mut().ok_or(IpcError::StaleSession)?;
    if session.epoch != epoch {
        return Err(IpcError::StaleSession);
    }
    match sim {
        Ok(timeline) => {
            session.revision += 1;
            move_history_label(session, &direction);
            session.simulation = crate::scene::SimulationDto::authoritative(&timeline);
            let frames = edit::frame_changes(&report, session.document.frames());
            let simulation = Some(session.simulation.clone());
            Ok(assemble_delta(session, frames, simulation))
        }
        Err(e) => {
            match direction {
                HistoryDirection::Undo => session.document.redo(),
                HistoryDirection::Redo => session.document.undo(),
            };
            Err(e)
        }
    }
}

fn move_history_label(session: &mut SessionState, direction: &HistoryDirection) {
    match direction {
        HistoryDirection::Undo => {
            if let Some(label) = session.undo_labels.pop() {
                session.redo_labels.push(label);
            }
        }
        HistoryDirection::Redo => {
            if let Some(label) = session.redo_labels.pop() {
                session.undo_labels.push(label);
            }
        }
    }
}

#[tauri::command]
pub async fn undo(state: State<'_, AppState>, epoch: u64) -> Result<EditDelta, IpcError> {
    history_step(state, epoch, HistoryDirection::Undo).await
}

#[tauri::command]
pub async fn redo(state: State<'_, AppState>, epoch: u64) -> Result<EditDelta, IpcError> {
    history_step(state, epoch, HistoryDirection::Redo).await
}

/// restores the pristine baseline directly from the retained original --
/// never by reloading from disk, and never by walking the undo stack, so
/// history eviction cannot strand it. itself one undoable step
#[tauri::command]
pub async fn revert_all(state: State<'_, AppState>, epoch: u64) -> Result<EditDelta, IpcError> {
    let (report, snapshot, processed) = {
        let mut guard = state.session.lock().expect("session lock");
        let session = guard.as_mut().ok_or(IpcError::StaleSession)?;
        if session.epoch != epoch {
            return Err(IpcError::StaleSession);
        }
        let Some(report) = session.document.revert_all() else {
            // already at the baseline: nothing changed
            return Ok(assemble_delta(session, None, None));
        };
        if !session.simulatable {
            session.document.commit_last();
            session.revision += 1;
            sync_labels(session, Some("revert all".into()));
            let frames = edit::frame_changes(&report, session.document.frames());
            return Ok(assemble_delta(session, frames, None));
        }
        let snapshot = session.document.frames().to_vec();
        (report, snapshot, Arc::clone(&session.processed))
    };

    // a join failure rolls the revert back exactly like a simulation refusal
    let sim = match tauri::async_runtime::spawn_blocking(move || simulate(&processed, &snapshot)).await {
        Ok(Ok(timeline)) => Ok(timeline),
        Ok(Err(e)) => Err(IpcError::InvalidEdit {
            message: format!("the baseline replay exceeded simulation limits: {e}"),
        }),
        Err(e) => Err(join_err("simulation", e)),
    };

    let mut guard = state.session.lock().expect("session lock");
    let session = guard.as_mut().ok_or(IpcError::StaleSession)?;
    if session.epoch != epoch {
        return Err(IpcError::StaleSession);
    }
    match sim {
        Ok(timeline) => {
            session.document.commit_last();
            session.revision += 1;
            sync_labels(session, Some("revert all".into()));
            session.simulation = crate::scene::SimulationDto::authoritative(&timeline);
            let frames = edit::frame_changes(&report, session.document.frames());
            let simulation = Some(session.simulation.clone());
            Ok(assemble_delta(session, frames, simulation))
        }
        Err(e) => {
            session.document.rollback_last();
            sync_labels(session, None);
            Err(e)
        }
    }
}

/// assembles the current authoritative state without touching the document:
/// the StaleSession recovery path. always the full stream, the cached last
/// simulation, and the live history
#[tauri::command]
pub fn resync(state: State<'_, AppState>, epoch: u64) -> Result<EditDelta, IpcError> {
    let guard = state.session.lock().expect("session lock");
    let session = guard.as_ref().ok_or(IpcError::StaleSession)?;
    if session.epoch != epoch {
        return Err(IpcError::StaleSession);
    }
    let frames = edit::full_frames(session.document.frames());
    Ok(assemble_delta(
        session,
        Some(frames),
        Some(session.simulation.clone()),
    ))
}

/// what phase 1 hands the rest of `export_replay`: a pristine or carried
/// export encodes under the lock (both reuse the retained compressed
/// payload, so encoding is cheap), while a frame-dirty document snapshots
/// its inputs for the off-lock re-simulation
enum PreparedExport {
    Encoded(Vec<u8>),
    Resimulate {
        frames: Vec<engine::replay::frames::ReplayFrame>,
        processed: Arc<engine::beatmap::ProcessedBeatmap>,
        score_context: engine::score::ScoreContext,
        revision: u64,
    },
}

/// export works end to end here: the three-path branch on the document's
/// dirty split, the derived-field regeneration for frame-dirty documents
/// (same locking choreography as `apply_edit` -- gate under the lock,
/// simulate off it, publish against an unchanged revision), and the atomic
/// write protocol (`crate::export`)
#[tauri::command]
pub async fn export_replay(
    state: State<'_, AppState>,
    epoch: u64,
    dest_path: String,
    overwrite: bool,
) -> Result<crate::scene::ExportResult, IpcError> {
    // phase 1: gate and branch under the lock
    let prepared = {
        let mut guard = state.session.lock().expect("session lock");
        let session = guard.as_mut().ok_or(IpcError::StaleSession)?;
        if session.epoch != epoch {
            return Err(IpcError::StaleSession);
        }
        if !session.document.frames_dirty() {
            PreparedExport::Encoded(session.document.export_with_derived(None)?)
        } else {
            // a frame-dirty document normally implies the frame-edit gate
            // passed; the one exception is revert_all's marker (Op::Restore
            // dirties both kinds on any scene), where re-derivation is
            // impossible without an authoritative simulation -- refuse typed
            // rather than deriving from a non-authoritative timeline
            frame_edit_gate(session)?;
            PreparedExport::Resimulate {
                frames: session.document.frames().to_vec(),
                processed: Arc::clone(&session.processed),
                score_context: session.score_context,
                revision: session.revision,
            }
        }
    };

    let (bytes, regenerated) = match prepared {
        PreparedExport::Encoded(bytes) => (bytes, None),
        PreparedExport::Resimulate {
            frames,
            processed,
            score_context,
            revision,
        } => {
            // phase 2: re-simulate the final frames and derive every field
            // off the lock
            let sim_processed = Arc::clone(&processed);
            let (derived_frames, derived) = tauri::async_runtime::spawn_blocking(move || {
                let timeline = simulate(&sim_processed, &frames).map_err(|e| IpcError::InvalidEdit {
                    message: format!("the edited replay exceeded simulation limits: {e}"),
                })?;
                let wide = engine::score::derive_score(&sim_processed, &timeline, &score_context)?;
                let narrowed = engine::score::DerivedFields::narrow(&wide).map_err(|overflow| {
                    IpcError::ExportOverflow {
                        field: overflow.field.into(),
                    }
                })?;
                Ok::<_, IpcError>((frames, narrowed))
            })
            .await
            .map_err(|e| join_err("export derivation", e))??;

            // phase 3: encode only against the exact frames the derivation
            // described. the revision alone cannot certify that: a mutating
            // command edits the document under its own phase-1 lock but bumps
            // the revision only in phase 3, so there is a window where the
            // revision still reads unchanged while the document already holds
            // the newer frames. pairing those would write a header describing
            // one play over a payload containing another -- precisely the
            // inconsistency this phase exists to make impossible -- so the
            // frames themselves are the gate, and a mismatch is a stale-session
            // answer like any other lost race
            let mut guard = state.session.lock().expect("session lock");
            let session = guard.as_mut().ok_or(IpcError::StaleSession)?;
            if session.epoch != epoch || session.revision != revision {
                return Err(IpcError::StaleSession);
            }
            if session.document.frames() != derived_frames.as_slice() {
                return Err(IpcError::StaleSession);
            }
            // the export path itself is part of what phase 1 decided, and it
            // can flip without the frames moving a byte: undoing a revert_all
            // that only ever covered metadata edits clears frames_dirty while
            // leaving the frames identical, and `Op::Restore` always reports
            // full_replace, so that undo defers its revision bump like any
            // frame-changing step. `export_with_derived` would then quietly
            // take the carried path and drop `derived`, while the result still
            // advertised a regenerated summary the written header never got
            if !session.document.frames_dirty() {
                return Err(IpcError::StaleSession);
            }
            let bytes = session.document.export_with_derived(Some(&derived))?;
            (bytes, Some(crate::scene::RegeneratedDto::from(&derived)))
        }
    };

    // phase 4: the atomic write protocol, off the lock and off the runtime
    let dest = PathBuf::from(&dest_path);
    let byte_count = bytes.len() as u64;
    tauri::async_runtime::spawn_blocking(move || crate::export::atomic_write(&dest, &bytes, overwrite))
        .await
        .map_err(|e| join_err("export write", e))??;

    Ok(crate::scene::ExportResult {
        path: dest_path,
        bytes: byte_count,
        regenerated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::AppState;
    use crate::testutil::{fixtures_dir, osr_bytes, osr_bytes_versioned, write_osz};
    use tauri::Manager;

    fn mock_app(
        config_dir: std::path::PathBuf,
        cache_root: std::path::PathBuf,
    ) -> tauri::App<tauri::test::MockRuntime> {
        // beside the cache root, never inside it: an imported skin's directory
        // must survive the orphan collection the cache root is subject to
        let skins_root = config_dir.join("skins");
        tauri::test::mock_builder()
            .invoke_handler(tauri::generate_handler![
                load_replay,
                load_replay_with_beatmap,
                get_settings,
                set_osu_stable_path,
                set_viewer_prefs,
                clear_recents,
                list_skins,
                get_skin,
                set_skin,
                import_skin,
                apply_edit,
                undo,
                redo,
                revert_all,
                resync,
                export_replay
            ])
            .manage(AppState::new(config_dir, cache_root, skins_root))
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

    /// enough frames that a small edit stays under the 20% fullFrames
    /// threshold: 30 gameplay actions, 16ms apart, plus the builder's seed
    fn many_actions() -> Vec<engine::formats::osr::ReplayAction> {
        (0..30)
            .map(|i| engine::formats::osr::ReplayAction {
                delta: if i == 0 { 100 } else { 16 },
                x: i as f32,
                y: i as f32,
                z: 0,
            })
            .collect()
    }

    /// stages a matching map + replay and loads it, returning the scene
    fn editable_scene(
        app: &tauri::App<tauri::test::MockRuntime>,
        dir: &std::path::Path,
        mods: u32,
        version: u32,
    ) -> crate::scene::LoadedScene {
        let osu_bytes = std::fs::read(fixtures_dir().join("beatmaps").join("stacking-v14.osu")).unwrap();
        let md5 = format!("{:x}", md5::compute(&osu_bytes));
        let osu_path = dir.join("map.osu");
        std::fs::write(&osu_path, &osu_bytes).unwrap();
        let osr_path = dir.join("replay.osr");
        std::fs::write(
            &osr_path,
            osr_bytes_versioned(&md5, mods, Some(many_actions()), version),
        )
        .unwrap();
        tauri::async_runtime::block_on(load_replay_with_beatmap(
            app.handle().clone(),
            app.state(),
            osr_path.display().to_string(),
            osu_path.display().to_string(),
            false,
        ))
        .unwrap()
    }

    fn move_op(index: usize, x: f32, y: f32) -> crate::edit::EditOp {
        crate::edit::EditOp::MoveFrames {
            moves: vec![crate::edit::FrameMove { index, x, y }],
        }
    }

    #[test]
    fn installs_stamp_a_fresh_epoch_into_scene_and_session() {
        let dir = tempfile::tempdir().unwrap();
        let app = mock_app(dir.path().join("config"), dir.path().join("cache"));
        let (osr_path, osu_path) = staged_replay(dir.path());

        let load = |app: &tauri::App<tauri::test::MockRuntime>| {
            tauri::async_runtime::block_on(load_replay_with_beatmap(
                app.handle().clone(),
                app.state(),
                osr_path.display().to_string(),
                osu_path.display().to_string(),
                false,
            ))
            .unwrap()
        };
        let first = load(&app);
        let second = load(&app);
        assert!(first.epoch > 0);
        assert!(second.epoch > first.epoch, "every install bumps the counter");

        let state = app.state::<AppState>();
        let guard = state.session.lock().unwrap();
        let session = guard.as_ref().unwrap();
        assert_eq!(session.epoch, second.epoch);
        assert_eq!(session.revision, 0);
        assert!(session.simulatable);
        assert!(session.undo_labels.is_empty() && session.redo_labels.is_empty());
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
        assert!(
            state.session.lock().unwrap().is_some(),
            "the session must be retained"
        );
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
            session
                .as_ref()
                .unwrap()
                .lease
                .as_ref()
                .unwrap()
                .dir()
                .to_path_buf()
        };
        assert!(first_dir.is_dir());

        load();
        assert!(
            !first_dir.exists(),
            "the replaced session's cache dir must be deleted"
        );
        let second_dir = {
            let session = state.session.lock().unwrap();
            session
                .as_ref()
                .unwrap()
                .lease
                .as_ref()
                .unwrap()
                .dir()
                .to_path_buf()
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
        let updated = set_osu_stable_path(app.state(), Some(r"D:\osu!".into())).unwrap();
        assert_eq!(updated.osu_stable_path.as_deref(), Some(r"D:\osu!"));
        // persisted, not just in memory
        assert_eq!(
            crate::settings::load_settings(&config_dir)
                .osu_stable_path
                .as_deref(),
            Some(r"D:\osu!")
        );
        assert_eq!(
            get_settings(app.state()).osu_stable_path.as_deref(),
            Some(r"D:\osu!")
        );
    }

    /// stages a skin folder under a fake stable install root
    fn stage_stable_skin(root: &std::path::Path, name: &str, ini: &[u8]) -> std::path::PathBuf {
        let dir = root.join("Skins").join(name);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("skin.ini"), ini).unwrap();
        std::fs::write(dir.join("cursor.png"), b"x").unwrap();
        dir
    }

    #[test]
    fn the_picker_lists_the_bundled_row_plus_the_stable_installs_skins() {
        let dir = tempfile::tempdir().unwrap();
        let app = mock_app(dir.path().join("config"), dir.path().join("cache"));
        let install = dir.path().join("osu!");
        stage_stable_skin(&install, "Rafis", b"[General]\nName: Rafis 2016\nAuthor: Rafis\n");
        stage_stable_skin(&install, "Unnamed", b"[General]\n");
        set_osu_stable_path(app.state(), Some(install.to_string_lossy().into_owned())).unwrap();

        let listed = tauri::async_runtime::block_on(list_skins(app.state())).unwrap();
        assert_eq!(listed[0].locator, SkinLocator::Bundled);
        assert_eq!(listed[0].source, SkinSource::Bundled);
        assert_eq!(listed[0].era, SkinEra::Lazer);

        let names: Vec<&str> = listed[1..].iter().map(|entry| entry.name.as_str()).collect();
        // the declared name where there is one, the folder name where there is not
        assert_eq!(names, vec!["Rafis 2016", "Unnamed"]);
        assert!(listed[1..].iter().all(|entry| entry.source == SkinSource::Stable));
        assert_eq!(listed[1].author, "Rafis");
    }

    #[test]
    fn a_browsed_folder_skin_is_listed_so_the_picker_can_show_it_selected() {
        // a folder skin is not enumerable -- nothing walks the disk for more --
        // so without listing the selected one the picker shows NO row selected
        // after browsing, and the only route back to that skin is browsing to
        // it again
        let dir = tempfile::tempdir().unwrap();
        let app = mock_app(dir.path().join("config"), dir.path().join("cache"));
        let loose = dir.path().join("loose").join("Rafis 2016");
        std::fs::create_dir_all(&loose).unwrap();
        std::fs::write(loose.join("skin.ini"), b"[General]
Name: Rafis 2016
Author: Rafis
").unwrap();
        std::fs::write(loose.join("cursor.png"), b"x").unwrap();

        // not listed until it is the selection: nothing enumerates loose folders
        assert!(!tauri::async_runtime::block_on(list_skins(app.state())).unwrap()
            .iter()
            .any(|entry| entry.source == SkinSource::Folder));

        let locator = SkinLocator::Folder {
            path: loose.to_string_lossy().into_owned(),
        };
        tauri::async_runtime::block_on(set_skin(app.handle().clone(), app.state(), locator.clone())).unwrap();

        let listed = tauri::async_runtime::block_on(list_skins(app.state())).unwrap();
        let row = listed
            .iter()
            .find(|entry| entry.source == SkinSource::Folder)
            .expect("the selected folder skin is a row");
        assert_eq!(row.name, "Rafis 2016");
        assert_eq!(row.locator, locator);
    }

    #[test]
    fn selecting_a_skin_persists_across_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let config_dir = dir.path().join("config");
        let app = mock_app(config_dir.clone(), dir.path().join("cache"));
        let install = dir.path().join("osu!");
        let skin = stage_stable_skin(&install, "Chosen", b"[General]\nName: Chosen\nVersion: 2.5\n");
        let locator = SkinLocator::Stable {
            path: skin.to_string_lossy().into_owned(),
        };

        let manifest = tauri::async_runtime::block_on(set_skin(app.handle().clone(), app.state(), locator.clone())).unwrap();
        assert_eq!(manifest.name, "Chosen");
        assert_eq!(manifest.config.version, 2.5);
        assert!(manifest.fell_back.is_none());

        // a fresh app over the same config dir is the restart
        let restarted = mock_app(config_dir, dir.path().join("cache2"));
        assert_eq!(get_settings(restarted.state()).skin, locator);
        assert_eq!(tauri::async_runtime::block_on(get_skin(restarted.handle().clone(), restarted.state())).unwrap().name, "Chosen");
    }

    #[test]
    fn a_selected_skins_files_are_allowed_on_the_asset_protocol() {
        // the manifest carries absolute paths and the frontend hands them to
        // convertFileSrc, whose urls the protocol refuses unless the runtime
        // scope allows the path -- the static scope in tauri.conf.json is
        // empty. without the widening a user skin's samples fetch 403 and fall
        // silently back to the bundled default, which looks like the skin
        // simply having none. both routes that produce a manifest are checked:
        // set_skin is the pick, get_skin is the startup path a user who never
        // re-picks their skin is the only one to exercise
        let dir = tempfile::tempdir().unwrap();
        let config_dir = dir.path().join("config");
        let app = mock_app(config_dir.clone(), dir.path().join("cache"));
        let install = dir.path().join("osu!");
        let skin = stage_stable_skin(&install, "Audible", b"[General]
Name: Audible
");
        std::fs::write(skin.join("normal-hitnormal.wav"), b"x").unwrap();
        let locator = SkinLocator::Stable {
            path: skin.to_string_lossy().into_owned(),
        };

        let manifest = tauri::async_runtime::block_on(set_skin(app.handle().clone(), app.state(), locator)).unwrap();
        let sample = manifest
            .files
            .get("normal-hitnormal.wav")
            .expect("the skin's sample is in the file map");
        assert!(
            app.asset_protocol_scope().is_allowed(std::path::Path::new(sample)),
            "set_skin widened the scope by the skin's own files"
        );

        let restarted = mock_app(config_dir, dir.path().join("cache2"));
        let hydrated = tauri::async_runtime::block_on(get_skin(restarted.handle().clone(), restarted.state())).unwrap();
        assert!(
            restarted
                .asset_protocol_scope()
                .is_allowed(std::path::Path::new(&hydrated.files["normal-hitnormal.wav"])),
            "get_skin widened it too -- the startup route is the one that must not be missed"
        );
    }

    #[test]
    fn a_skin_folder_deleted_between_sessions_falls_back_and_says_so() {
        let dir = tempfile::tempdir().unwrap();
        let config_dir = dir.path().join("config");
        let app = mock_app(config_dir.clone(), dir.path().join("cache"));
        let install = dir.path().join("osu!");
        let skin = stage_stable_skin(&install, "Doomed", b"[General]\nName: Doomed\n");
        tauri::async_runtime::block_on(set_skin(
            app.handle().clone(),
            app.state(),
            SkinLocator::Stable {
                path: skin.to_string_lossy().into_owned(),
            },
        ))
        .unwrap();

        std::fs::remove_dir_all(&skin).unwrap();
        let restarted = mock_app(config_dir, dir.path().join("cache2"));
        let manifest = tauri::async_runtime::block_on(get_skin(restarted.handle().clone(), restarted.state())).unwrap();

        // a miss, not an error: the app opens on the bundled default and the
        // manifest carries what happened so the surface can say it
        assert_eq!(manifest.locator, SkinLocator::Bundled);
        let fallback = manifest.fell_back.expect("the miss is reported");
        assert!(matches!(fallback.requested, SkinLocator::Stable { .. }));
        // the selection itself is untouched, so restoring the folder restores
        // the skin without the user re-picking it
        assert!(matches!(
            get_settings(restarted.state()).skin,
            SkinLocator::Stable { .. }
        ));
    }

    #[test]
    fn importing_an_osk_selects_it_and_lists_it() {
        let dir = tempfile::tempdir().unwrap();
        let app = mock_app(dir.path().join("config"), dir.path().join("cache"));
        let osk = dir.path().join("downloaded.osk");
        write_osz(
            &osk,
            &[
                ("skin.ini", b"[General]\nName: Imported One\nAuthor: Someone\n"),
                ("cursor.png", b"x"),
            ],
        );

        let manifest =
            tauri::async_runtime::block_on(import_skin(app.handle().clone(), app.state(), osk.to_string_lossy().into_owned())).unwrap();
        assert_eq!(manifest.name, "Imported One");
        assert_eq!(manifest.source, SkinSource::Imported);
        assert!(matches!(get_settings(app.state()).skin, SkinLocator::Imported { .. }));

        let listed = tauri::async_runtime::block_on(list_skins(app.state())).unwrap();
        let imported: Vec<&SkinEntry> = listed
            .iter()
            .filter(|entry| entry.source == SkinSource::Imported)
            .collect();
        assert_eq!(imported.len(), 1);
        assert_eq!(imported[0].name, "Imported One");
    }

    #[test]
    fn a_refused_skin_leaves_the_previous_selection_alone() {
        let dir = tempfile::tempdir().unwrap();
        let app = mock_app(dir.path().join("config"), dir.path().join("cache"));
        let install = dir.path().join("osu!");
        let good = stage_stable_skin(&install, "Good", b"[General]\nName: Good\n");
        set_osu_stable_path(app.state(), Some(install.to_string_lossy().into_owned())).unwrap();
        tauri::async_runtime::block_on(set_skin(
            app.handle().clone(),
            app.state(),
            SkinLocator::Stable {
                path: good.to_string_lossy().into_owned(),
            },
        ))
        .unwrap();

        let refused = install.join("Skins").join("Enormous");
        std::fs::create_dir_all(&refused).unwrap();
        std::fs::write(
            refused.join("cursor.png"),
            vec![0u8; (crate::limits::MAX_SKIN_FILE_BYTES + 1) as usize],
        )
        .unwrap();

        let error = tauri::async_runtime::block_on(set_skin(
            app.handle().clone(),
            app.state(),
            SkinLocator::Stable {
                path: refused.to_string_lossy().into_owned(),
            },
        ))
        .expect_err("refused whole");
        assert!(matches!(&error, IpcError::ResourceLimit { cap, .. } if cap == "MAX_SKIN_FILE_BYTES"));
        // the refusal is whole: the good skin is still what is selected
        assert_eq!(tauri::async_runtime::block_on(get_skin(app.handle().clone(), app.state())).unwrap().name, "Good");
        // and it still LISTS, with its reason, rather than vanishing
        let listed = tauri::async_runtime::block_on(list_skins(app.state())).unwrap();
        let row = listed.iter().find(|entry| entry.name == "Enormous").expect("listed");
        assert!(row.refusal.as_deref().unwrap_or("").contains("MAX_SKIN_FILE_BYTES"));
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
        let editing = EditingPrefs {
            snap_to_lattice: false,
            warn_on_overwrite: false,
        };
        // the master off with granular flags left on: the command stores both
        // halves verbatim, since folding the master in is the frontend's job
        let effects = EffectPrefs {
            enabled: false,
            cursor_trail: false,
            ..EffectPrefs::default()
        };
        let timeline = TimelinePrefs {
            hit_window_bands: false,
            ..TimelinePrefs::default()
        };
        // the overrides travel opaquely: this crate never asks what
        // `selectTool` is or whether two actions want one key
        let keybinds: KeybindOverrides = [(
            "selectTool".to_string(),
            vec![serde_json::json!({ "hotkey": "К", "codes": ["KeyV"] })],
        )]
        .into_iter()
        .collect();
        // volume over 100
        let updated = set_viewer_prefs(
            app.state(),
            250,
            AudioPrefs {
                music_volume: 250,
                hitsound_volume: 40,
                offset_ms: 900.0,
                ignore_beatmap_hitsounds: true,
            },
            GameplayPrefs {
                positional_hitsound_level: 9.0,
                always_play_first_combo_break: false,
                snaking_in_sliders: false,
                snaking_out_sliders: false,
            },
            prefs,
            editing.clone(),
            effects.clone(),
            timeline.clone(),
            keybinds.clone(),
        )
        .unwrap();

        assert_eq!(updated.volume, 100);
        assert_eq!(
            updated.overlays.display_length,
            crate::settings::DISPLAY_LENGTH_MIN
        );
        assert!(updated.overlays.cursor_path);
        assert!(!updated.overlays.key_overlay);
        assert_eq!(updated.editing, editing);
        assert_eq!(updated.effects, effects);
        assert!(
            updated.effects.hit_effects,
            "a granular flag survives a disabled master"
        );
        assert_eq!(updated.timeline, timeline);
        assert!(
            updated.timeline.tethers,
            "an untouched timeline layer stays visible"
        );
        assert_eq!(
            updated.keybinds, keybinds,
            "a rebinding round-trips through the command unchanged"
        );

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
            AudioPrefs::default(),
            GameplayPrefs::default(),
            OverlayPrefs::default(),
            EditingPrefs::default(),
            EffectPrefs::default(),
            TimelinePrefs::default(),
            KeybindOverrides::new(),
        )
        .unwrap();

        assert_eq!(updated.osu_stable_path.as_deref(), Some(r"D:\osu!"));
        assert_eq!(
            crate::settings::load_settings(&config_dir)
                .osu_stable_path
                .as_deref(),
            Some(r"D:\osu!")
        );
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
            AudioPrefs::default(),
            GameplayPrefs::default(),
            OverlayPrefs::default(),
            EditingPrefs::default(),
            EffectPrefs::default(),
            TimelinePrefs::default(),
            KeybindOverrides::new(),
        )
        .unwrap_err();
        assert!(matches!(err, IpcError::Io { .. }));
        assert_eq!(
            get_settings(app.state()).volume,
            100,
            "the rejected volume must not linger"
        );
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
        assert_eq!(
            entry.beatmap_path.as_deref(),
            Some(osu_path.display().to_string().as_str())
        );
        assert_eq!(
            entry.beatmap_dir.as_deref(),
            Some(dir.path().display().to_string().as_str())
        );
        assert_eq!(entry.beatmap_md5.as_deref(), Some(scene.beatmap.md5.as_str()));
        assert!(
            !entry.allow_mismatch,
            "a hash-matched load records no override consent"
        );
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
            session
                .as_ref()
                .unwrap()
                .lease
                .as_ref()
                .unwrap()
                .dir()
                .to_path_buf()
        };
        let settings = get_settings(app.state());
        let entry = &settings.recents[0];
        assert_eq!(
            entry.beatmap_path.as_deref(),
            Some(osz_path.display().to_string().as_str())
        );
        assert_eq!(
            entry.beatmap_dir.as_deref(),
            Some(dir.path().display().to_string().as_str())
        );

        // dropping the session deletes the lease; what was recorded survives
        *state.session.lock().unwrap() = None;
        assert!(!lease_dir.exists());
        assert!(std::path::Path::new(entry.beatmap_dir.as_deref().unwrap()).is_dir());
    }

    #[test]
    fn an_open_resolves_through_the_saved_association_and_refreshes_it() {
        // the plain open command, not a second "reopen" one: after the collapse
        // (docs/adr/0005) a browse, a drop and a recents card are the same call,
        // so the association a hand-paired beatmap left behind answers all three
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

        let scene = tauri::async_runtime::block_on(load_replay(
            app.handle().clone(),
            app.state(),
            osr_path.display().to_string(),
        ))
        .unwrap();
        assert_eq!(scene.beatmap.title, "Stacking Fixture");

        let settings = get_settings(app.state());
        assert_eq!(
            settings.recents.len(),
            1,
            "a reopen moves the entry rather than adding one"
        );
        assert_eq!(
            settings.recents[0].beatmap_path.as_deref(),
            Some(renamed.display().to_string().as_str()),
            "every successful reopen refreshes the origin"
        );
        // persisted, not just published
        assert_eq!(
            crate::settings::load_settings(&config_dir).recents,
            settings.recents
        );
    }

    #[test]
    fn a_consented_override_persists_and_every_later_open_resolves_through_it() {
        // the whole path a user walks when the picked beatmap is not the one
        // the replay was played on: consent once, and every later open must
        // land back on that same map -- through any route, since there is only
        // the one open command. the three legs are covered apart (here,
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
        assert_eq!(
            opened.beatmap.md5, override_md5,
            "the consented map is what opened"
        );

        let settings = get_settings(app.state());
        let entry = &settings.recents[0];
        assert!(
            entry.allow_mismatch,
            "the consent has to be recorded, not just honoured once"
        );
        assert_eq!(
            entry.beatmap_path.as_deref(),
            Some(override_path.display().to_string().as_str())
        );
        assert_eq!(
            entry.beatmap_dir.as_deref(),
            Some(dir.path().display().to_string().as_str())
        );
        assert_eq!(entry.beatmap_md5.as_deref(), Some(override_md5.as_str()));
        // persisted, not just published: a reopen after a restart reads disk
        assert_eq!(
            crate::settings::load_settings(&config_dir).recents,
            settings.recents
        );

        let reopened = tauri::async_runtime::block_on(load_replay(
            app.handle().clone(),
            app.state(),
            osr_path.display().to_string(),
        ))
        .unwrap();
        assert_eq!(
            reopened.beatmap.md5, override_md5,
            "the reopen resolves through the consent"
        );
        assert_ne!(
            reopened.beatmap.md5, played_md5,
            "the hash-matched neighbour must not win"
        );
        // and it comes back in the same shape the consented load did, rather
        // than as an ordinary match
        assert!(matches!(reopened.warnings[0], Warning::BeatmapMismatch { .. }));
        assert!(matches!(
            &reopened.simulation,
            SimulationDto::NotSimulated {
                reason: NotSimulatedReason::BeatmapMismatch
            }
        ));

        let after = get_settings(app.state());
        assert_eq!(
            after.recents.len(),
            1,
            "a reopen moves the entry rather than adding one"
        );
        assert!(
            after.recents[0].allow_mismatch,
            "the refreshed entry keeps the consent"
        );
        assert_eq!(
            after.recents[0].beatmap_path.as_deref(),
            Some(override_path.display().to_string().as_str())
        );
    }

    #[test]
    fn an_open_without_an_association_reports_the_missing_install() {
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

        let err = tauri::async_runtime::block_on(load_replay(
            app.handle().clone(),
            app.state(),
            osr_path.display().to_string(),
        ))
        .unwrap_err();
        assert!(matches!(err, IpcError::OsuDbNotFound { .. }), "got {err:?}");
        assert!(
            get_settings(app.state()).recents.is_empty(),
            "a failed open records nothing"
        );
    }

    #[test]
    fn a_first_open_still_resolves_through_the_stable_install() {
        // the regression that matters most: consulting the association must
        // leave the case where there is none -- every first open of every
        // replay -- resolving exactly as it always did, through osu!.db
        let dir = tempfile::tempdir().unwrap();
        let app = mock_app(dir.path().join("config"), dir.path().join("cache"));
        let install = dir.path().join("install");
        let osu_bytes = std::fs::read(fixtures_dir().join("beatmaps").join("stacking-v14.osu")).unwrap();
        let md5 = crate::testutil::fake_install(&install, "1 fixture", "map.osu", &osu_bytes);
        // the replay sits nowhere near the install, so only the osu!.db lookup
        // can be what finds its beatmap
        let osr_path = dir.path().join("replay.osr");
        std::fs::write(&osr_path, osr_bytes(&md5, 0, None)).unwrap();
        set_osu_stable_path(app.state(), Some(install.display().to_string())).unwrap();

        let scene = tauri::async_runtime::block_on(load_replay(
            app.handle().clone(),
            app.state(),
            osr_path.display().to_string(),
        ))
        .unwrap();
        assert_eq!(scene.beatmap.md5, md5);
        // and the open it just performed is what leaves an association behind
        let settings = get_settings(app.state());
        assert_eq!(
            settings.recents[0].beatmap_path.as_deref(),
            Some(
                install
                    .join("Songs")
                    .join("1 fixture")
                    .join("map.osu")
                    .display()
                    .to_string()
                    .as_str()
            )
        );
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

    #[test]
    fn apply_edit_returns_an_authoritative_delta() {
        let dir = tempfile::tempdir().unwrap();
        let app = mock_app(dir.path().join("config"), dir.path().join("cache"));
        let scene = editable_scene(&app, dir.path(), 0, 20151228);

        let delta = tauri::async_runtime::block_on(apply_edit(
            app.state(),
            scene.epoch,
            0,
            vec![move_op(5, 200.0, 150.0)],
            "move".into(),
        ))
        .unwrap();

        assert_eq!(delta.revision, 1);
        assert!(delta.dirty && delta.can_undo && !delta.can_redo);
        assert_eq!(delta.history.labels, vec!["move".to_string()]);
        assert_eq!(delta.history.cursor, 1);
        match delta.frames.expect("a frame edit ships frame changes") {
            crate::edit::FrameChanges::Delta {
                updated,
                inserted,
                removed,
            } => {
                assert_eq!(updated.len(), 1);
                assert_eq!(updated[0].index, 5);
                assert_eq!(updated[0].frame.x, 200.0);
                assert!(inserted.is_empty() && removed.is_empty());
            }
            other => panic!("expected an index delta, got {other:?}"),
        }
        let sim = delta.simulation.expect("frame edits re-simulate");
        assert!(matches!(sim, crate::scene::SimulationDto::Authoritative { .. }));
    }

    #[test]
    fn metadata_only_edits_skip_resimulation() {
        let dir = tempfile::tempdir().unwrap();
        let app = mock_app(dir.path().join("config"), dir.path().join("cache"));
        let scene = editable_scene(&app, dir.path(), 0, 20151228);

        let delta = tauri::async_runtime::block_on(apply_edit(
            app.state(),
            scene.epoch,
            0,
            vec![crate::edit::EditOp::SetPlayerName {
                name: Some("renamed".into()),
            }],
            "player name".into(),
        ))
        .unwrap();
        assert_eq!(delta.revision, 1);
        assert!(delta.frames.is_none());
        assert!(delta.simulation.is_none());
        assert_eq!(delta.player_name.as_deref(), Some("renamed"));
        assert!(delta.dirty);
        // the dirty split rides every delta: metadata-only leaves frames clean
        assert!(delta.metadata_dirty && !delta.frames_dirty);
    }

    #[test]
    fn the_delta_splits_dirtiness_by_kind() {
        let dir = tempfile::tempdir().unwrap();
        let app = mock_app(dir.path().join("config"), dir.path().join("cache"));
        let scene = editable_scene(&app, dir.path(), 0, 20151228);

        let frame_delta = tauri::async_runtime::block_on(apply_edit(
            app.state(),
            scene.epoch,
            0,
            vec![move_op(5, 200.0, 150.0)],
            "move".into(),
        ))
        .unwrap();
        assert!(frame_delta.frames_dirty && !frame_delta.metadata_dirty);
        assert!(frame_delta.dirty, "dirty stays the union of the split");

        let both = tauri::async_runtime::block_on(apply_edit(
            app.state(),
            scene.epoch,
            1,
            vec![crate::edit::EditOp::SetTimestamp {
                ticks: "638712000000000001".into(),
            }],
            "timestamp".into(),
        ))
        .unwrap();
        assert!(both.frames_dirty && both.metadata_dirty && both.dirty);

        // undoing the metadata edit clears only its half of the split
        let undone = tauri::async_runtime::block_on(undo(app.state(), scene.epoch)).unwrap();
        assert!(undone.frames_dirty && !undone.metadata_dirty && undone.dirty);
    }

    #[test]
    fn identity_edits_change_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let app = mock_app(dir.path().join("config"), dir.path().join("cache"));
        let scene = editable_scene(&app, dir.path(), 0, 20151228);
        // frame 5 sits at (5, 5) per many_actions
        let delta = tauri::async_runtime::block_on(apply_edit(
            app.state(),
            scene.epoch,
            0,
            vec![move_op(5, 5.0, 5.0)],
            "noop".into(),
        ))
        .unwrap();
        assert_eq!(delta.revision, 0, "identity edits do not bump the revision");
        assert!(delta.frames.is_none() && delta.simulation.is_none());
        assert!(delta.history.labels.is_empty());
        assert!(!delta.dirty && !delta.can_undo);
    }

    #[test]
    fn stale_epoch_or_revision_is_rejected_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let app = mock_app(dir.path().join("config"), dir.path().join("cache"));
        let scene = editable_scene(&app, dir.path(), 0, 20151228);

        let err = tauri::async_runtime::block_on(apply_edit(
            app.state(),
            scene.epoch + 1,
            0,
            vec![move_op(5, 200.0, 150.0)],
            "move".into(),
        ))
        .unwrap_err();
        assert!(matches!(err, IpcError::StaleSession));

        let err = tauri::async_runtime::block_on(apply_edit(
            app.state(),
            scene.epoch,
            3,
            vec![move_op(5, 200.0, 150.0)],
            "move".into(),
        ))
        .unwrap_err();
        assert!(matches!(err, IpcError::StaleSession));

        let state = app.state::<AppState>();
        let guard = state.session.lock().unwrap();
        let session = guard.as_ref().unwrap();
        assert_eq!(session.revision, 0);
        assert!(!session.document.dirty());
    }

    #[test]
    fn not_simulated_scenes_refuse_frame_ops_but_allow_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let app = mock_app(dir.path().join("config"), dir.path().join("cache"));
        let scene = editable_scene(&app, dir.path(), 16, 20151228); // hard rock: not simulated

        let err = tauri::async_runtime::block_on(apply_edit(
            app.state(),
            scene.epoch,
            0,
            vec![move_op(5, 200.0, 150.0)],
            "move".into(),
        ))
        .unwrap_err();
        assert!(matches!(err, IpcError::NotEditable { .. }));

        let delta = tauri::async_runtime::block_on(apply_edit(
            app.state(),
            scene.epoch,
            0,
            vec![crate::edit::EditOp::SetPlayerName {
                name: Some("renamed".into()),
            }],
            "player name".into(),
        ))
        .unwrap();
        assert_eq!(delta.revision, 1);
    }

    #[test]
    fn lazer_native_scenes_refuse_frame_ops() {
        let dir = tempfile::tempdir().unwrap();
        let app = mock_app(dir.path().join("config"), dir.path().join("cache"));
        let scene = editable_scene(&app, dir.path(), 0, 30_000_001);
        let err = tauri::async_runtime::block_on(apply_edit(
            app.state(),
            scene.epoch,
            0,
            vec![move_op(5, 200.0, 150.0)],
            "move".into(),
        ))
        .unwrap_err();
        match err {
            IpcError::NotEditable { reason } => assert!(reason.contains("lazer")),
            other => panic!("expected NotEditable, got {other:?}"),
        }
    }

    #[test]
    fn update_and_delete_overlap_reports_the_final_state() {
        let dir = tempfile::tempdir().unwrap();
        let app = mock_app(dir.path().join("config"), dir.path().join("cache"));
        let scene = editable_scene(&app, dir.path(), 0, 20151228);
        let delta = tauri::async_runtime::block_on(apply_edit(
            app.state(),
            scene.epoch,
            0,
            vec![
                move_op(2, 200.0, 150.0),
                crate::edit::EditOp::DeleteFrames { indices: vec![2] },
            ],
            "erase".into(),
        ))
        .unwrap();
        match delta.frames.unwrap() {
            crate::edit::FrameChanges::Delta { updated, removed, .. } => {
                assert_eq!(removed, vec![2]);
                assert!(
                    updated.is_empty(),
                    "removal dominates: no update entry for a deleted frame"
                );
            }
            other => panic!("expected an index delta, got {other:?}"),
        }
    }

    #[test]
    fn label_length_cap_boundary() {
        let dir = tempfile::tempdir().unwrap();
        let app = mock_app(dir.path().join("config"), dir.path().join("cache"));
        let scene = editable_scene(&app, dir.path(), 0, 20151228);

        let at_limit = "x".repeat(crate::limits::MAX_EDIT_LABEL_BYTES);
        assert!(tauri::async_runtime::block_on(apply_edit(
            app.state(),
            scene.epoch,
            0,
            vec![move_op(5, 200.0, 150.0)],
            at_limit,
        ))
        .is_ok());
        let past = "x".repeat(crate::limits::MAX_EDIT_LABEL_BYTES + 1);
        let err = tauri::async_runtime::block_on(apply_edit(
            app.state(),
            scene.epoch,
            1,
            vec![move_op(5, 210.0, 150.0)],
            past,
        ))
        .unwrap_err();
        assert!(matches!(err, IpcError::InvalidEdit { .. }));
    }

    #[test]
    fn undo_redo_move_labels_and_bump_the_revision() {
        let dir = tempfile::tempdir().unwrap();
        let app = mock_app(dir.path().join("config"), dir.path().join("cache"));
        let scene = editable_scene(&app, dir.path(), 0, 20151228);
        let apply = |rev: u64, index: usize, label: &str| {
            tauri::async_runtime::block_on(apply_edit(
                app.state(),
                scene.epoch,
                rev,
                vec![move_op(index, 300.0, 100.0)],
                label.into(),
            ))
            .unwrap()
        };
        apply(0, 4, "first");
        apply(1, 6, "second");

        let delta = tauri::async_runtime::block_on(undo(app.state(), scene.epoch)).unwrap();
        assert_eq!(delta.revision, 3);
        assert_eq!(
            delta.history.labels,
            vec!["first".to_string(), "second".to_string()]
        );
        assert_eq!(delta.history.cursor, 1);
        assert!(delta.can_undo && delta.can_redo);
        assert!(delta.simulation.is_some(), "a frame-affecting undo re-simulates");
        match delta.frames.unwrap() {
            crate::edit::FrameChanges::Delta { updated, .. } => assert_eq!(updated[0].index, 6),
            other => panic!("expected an index delta, got {other:?}"),
        }

        let delta = tauri::async_runtime::block_on(redo(app.state(), scene.epoch)).unwrap();
        assert_eq!(delta.revision, 4);
        assert_eq!(delta.history.cursor, 2);
        assert!(!delta.can_redo);
    }

    #[test]
    fn sync_labels_reconciles_redo_labels_on_a_rollback() {
        // exercises sync_labels's `pushed: None` arm directly, without needing
        // a failing simulation: apply_edit's and revert_all's Err(e) arms run
        // this same rollback_last -> sync_labels(None) sequence so a failed
        // re-simulation doesn't leave redo_labels outliving the document's
        // cleared redo stack
        let dir = tempfile::tempdir().unwrap();
        let app = mock_app(dir.path().join("config"), dir.path().join("cache"));
        let scene = editable_scene(&app, dir.path(), 0, 20151228);
        tauri::async_runtime::block_on(apply_edit(
            app.state(),
            scene.epoch,
            0,
            vec![move_op(4, 300.0, 100.0)],
            "move".into(),
        ))
        .unwrap();
        tauri::async_runtime::block_on(undo(app.state(), scene.epoch)).unwrap();

        let state = app.state::<AppState>();
        let mut guard = state.session.lock().unwrap();
        let session = guard.as_mut().unwrap();
        assert_eq!(
            session.redo_labels,
            vec!["move".to_string()],
            "the undo parked the label on the redo side"
        );

        // the same sequence apply_edit's and revert_all's rollback arms run:
        // mutate, then unwind it without ever reaching the success-path
        // sync_labels
        let members = edit::translate_ops(&[move_op(6, 10.0, 10.0)]).unwrap();
        session.document.apply_edit_batch(members).unwrap();
        session.document.rollback_last();
        sync_labels(session, None);

        assert_eq!(
            session.redo_labels,
            vec!["move".to_string()],
            "the rollback restored the document's redo stack; the mirrored labels must survive"
        );
        assert_eq!(session.undo_labels.len(), session.document.undo_depth());
        assert_eq!(
            session.document.redo_depth(),
            1,
            "the parked step is redoable again"
        );
    }

    #[test]
    fn undo_with_nothing_to_undo_is_invalid() {
        let dir = tempfile::tempdir().unwrap();
        let app = mock_app(dir.path().join("config"), dir.path().join("cache"));
        let scene = editable_scene(&app, dir.path(), 0, 20151228);
        let err = tauri::async_runtime::block_on(undo(app.state(), scene.epoch)).unwrap_err();
        assert!(matches!(err, IpcError::InvalidEdit { .. }));
    }

    #[test]
    fn metadata_undo_skips_resimulation() {
        let dir = tempfile::tempdir().unwrap();
        let app = mock_app(dir.path().join("config"), dir.path().join("cache"));
        let scene = editable_scene(&app, dir.path(), 0, 20151228);
        tauri::async_runtime::block_on(apply_edit(
            app.state(),
            scene.epoch,
            0,
            vec![crate::edit::EditOp::SetPlayerName {
                name: Some("renamed".into()),
            }],
            "player name".into(),
        ))
        .unwrap();
        let delta = tauri::async_runtime::block_on(undo(app.state(), scene.epoch)).unwrap();
        assert!(delta.frames.is_none() && delta.simulation.is_none());
        // the undo restores whatever name the staged replay was built with
        assert_eq!(delta.player_name, scene.replay.player_name);
        assert!(!delta.dirty);
    }

    #[test]
    fn revert_all_is_a_labelled_full_replace() {
        let dir = tempfile::tempdir().unwrap();
        let app = mock_app(dir.path().join("config"), dir.path().join("cache"));
        let scene = editable_scene(&app, dir.path(), 0, 20151228);
        tauri::async_runtime::block_on(apply_edit(
            app.state(),
            scene.epoch,
            0,
            vec![move_op(4, 300.0, 100.0)],
            "move".into(),
        ))
        .unwrap();

        let delta = tauri::async_runtime::block_on(revert_all(app.state(), scene.epoch)).unwrap();
        assert_eq!(delta.revision, 2);
        assert!(matches!(
            delta.frames,
            Some(crate::edit::FrameChanges::Full { .. })
        ));
        assert_eq!(
            delta.history.labels,
            vec!["move".to_string(), "revert all".to_string()]
        );
        assert_eq!(delta.history.cursor, 2);
        assert!(delta.dirty, "the restore op sits on the undo stack");
        assert!(delta.can_undo);

        // and it is itself one undoable step
        let delta = tauri::async_runtime::block_on(undo(app.state(), scene.epoch)).unwrap();
        assert!(matches!(
            delta.frames,
            Some(crate::edit::FrameChanges::Full { .. })
        ));
        assert_eq!(delta.history.cursor, 1);
    }

    #[test]
    fn revert_all_at_baseline_is_a_noop_delta() {
        let dir = tempfile::tempdir().unwrap();
        let app = mock_app(dir.path().join("config"), dir.path().join("cache"));
        let scene = editable_scene(&app, dir.path(), 0, 20151228);
        let delta = tauri::async_runtime::block_on(revert_all(app.state(), scene.epoch)).unwrap();
        assert_eq!(delta.revision, 0);
        assert!(delta.frames.is_none());
        assert!(delta.history.labels.is_empty());
    }

    #[test]
    fn resync_assembles_without_mutating() {
        let dir = tempfile::tempdir().unwrap();
        let app = mock_app(dir.path().join("config"), dir.path().join("cache"));
        let scene = editable_scene(&app, dir.path(), 0, 20151228);
        tauri::async_runtime::block_on(apply_edit(
            app.state(),
            scene.epoch,
            0,
            vec![move_op(4, 300.0, 100.0)],
            "move".into(),
        ))
        .unwrap();

        let delta = resync(app.state(), scene.epoch).unwrap();
        assert_eq!(delta.revision, 1);
        assert!(delta.can_undo && delta.dirty);
        assert!(delta.simulation.is_some(), "resync serves the cached simulation");
        let crate::edit::FrameChanges::Full { full_frames } = delta.frames.unwrap() else {
            panic!("resync always ships the full stream");
        };
        assert_eq!(full_frames.len(), scene.frames.len());
        assert_eq!(full_frames[4].x, 300.0);

        // idempotent: nothing moved
        let again = resync(app.state(), scene.epoch).unwrap();
        assert_eq!(again.revision, 1);

        let err = resync(app.state(), scene.epoch + 1).unwrap_err();
        assert!(matches!(err, IpcError::StaleSession));
    }

    #[test]
    fn large_changes_fall_back_to_full_frames() {
        let dir = tempfile::tempdir().unwrap();
        let app = mock_app(dir.path().join("config"), dir.path().join("cache"));
        let scene = editable_scene(&app, dir.path(), 0, 20151228);
        // 8 of ~30 frames crosses the 20% threshold
        let moves: Vec<crate::edit::FrameMove> = (0..8)
            .map(|i| crate::edit::FrameMove {
                index: i,
                x: 300.0,
                y: 100.0 + i as f32,
            })
            .collect();
        let delta = tauri::async_runtime::block_on(apply_edit(
            app.state(),
            scene.epoch,
            0,
            vec![crate::edit::EditOp::MoveFrames { moves }],
            "big move".into(),
        ))
        .unwrap();
        assert!(matches!(
            delta.frames,
            Some(crate::edit::FrameChanges::Full { .. })
        ));
    }

    fn export_to(
        app: &tauri::App<tauri::test::MockRuntime>,
        epoch: u64,
        dest: &std::path::Path,
        overwrite: bool,
    ) -> Result<crate::scene::ExportResult, IpcError> {
        tauri::async_runtime::block_on(export_replay(
            app.state(),
            epoch,
            dest.display().to_string(),
            overwrite,
        ))
    }

    fn rename_op(name: &str) -> crate::edit::EditOp {
        crate::edit::EditOp::SetPlayerName {
            name: Some(name.into()),
        }
    }

    #[test]
    fn export_matrix_pristine_passthrough_is_byte_identical() {
        let dir = tempfile::tempdir().unwrap();
        let app = mock_app(dir.path().join("config"), dir.path().join("cache"));
        let scene = editable_scene(&app, dir.path(), 0, 20151228);
        let source = std::fs::read(dir.path().join("replay.osr")).unwrap();

        let dest = dir.path().join("out.osr");
        let result = export_to(&app, scene.epoch, &dest, false).unwrap();
        assert!(result.regenerated.is_none());
        assert_eq!(result.bytes, source.len() as u64);
        assert_eq!(result.path, dest.display().to_string());
        assert_eq!(std::fs::read(&dest).unwrap(), source);
    }

    #[test]
    fn export_matrix_carried_reuses_the_payload_under_the_edited_header() {
        let dir = tempfile::tempdir().unwrap();
        let app = mock_app(dir.path().join("config"), dir.path().join("cache"));
        let scene = editable_scene(&app, dir.path(), 0, 20151228);
        let source = engine::formats::osr::decode_osr(&std::fs::read(dir.path().join("replay.osr")).unwrap())
            .unwrap();

        tauri::async_runtime::block_on(apply_edit(
            app.state(),
            scene.epoch,
            0,
            vec![rename_op("renamed")],
            "rename".into(),
        ))
        .unwrap();

        let dest = dir.path().join("out.osr");
        let result = export_to(&app, scene.epoch, &dest, false).unwrap();
        assert!(result.regenerated.is_none(), "carried exports regenerate nothing");

        let out = engine::formats::osr::decode_osr(&std::fs::read(&dest).unwrap()).unwrap();
        assert_eq!(out.header.player_name.as_deref(), Some("renamed"));
        // "i only changed the player name" is literally true of the bytes
        assert_eq!(out.compressed_payload, source.compressed_payload);
        // and the dirty-header rules still applied
        assert_eq!(out.header.life_graph.as_deref(), Some(""));
        assert_eq!(
            out.header.replay_md5,
            Some(engine::score::replay_hash("renamed", out.header.timestamp_ticks).unwrap())
        );
        // the original simulation-derived fields still describe the play
        assert_eq!(out.header.count_300, source.header.count_300);
        assert_eq!(out.header.total_score, source.header.total_score);
    }

    #[test]
    fn export_matrix_regenerating_is_self_consistent() {
        let dir = tempfile::tempdir().unwrap();
        let app = mock_app(dir.path().join("config"), dir.path().join("cache"));
        let scene = editable_scene(&app, dir.path(), 0, 20151228);

        tauri::async_runtime::block_on(apply_edit(
            app.state(),
            scene.epoch,
            0,
            vec![move_op(5, 200.0, 150.0)],
            "move".into(),
        ))
        .unwrap();

        let dest = dir.path().join("out.osr");
        let result = export_to(&app, scene.epoch, &dest, false).unwrap();
        let reported = result.regenerated.expect("a frame-dirty export regenerates");

        // the written header claims exactly what the command reported
        let out = engine::formats::osr::decode_osr(&std::fs::read(&dest).unwrap()).unwrap();
        assert_eq!(out.header.count_300, reported.count_300);
        assert_eq!(out.header.count_100, reported.count_100);
        assert_eq!(out.header.count_50, reported.count_50);
        assert_eq!(out.header.count_geki, reported.count_geki);
        assert_eq!(out.header.count_katsu, reported.count_katsu);
        assert_eq!(out.header.count_miss, reported.count_miss);
        assert_eq!(out.header.max_combo, reported.max_combo);
        assert_eq!(out.header.perfect, reported.perfect);
        assert_eq!(out.header.total_score, reported.total_score);
        assert_eq!(out.header.life_graph.as_deref(), Some(""));

        // the self-consistency property: decode the exported file, simulate
        // it from scratch, and the header must equal the fresh derivation
        let map = engine::formats::beatmap::decode_beatmap_path(&dir.path().join("map.osu")).unwrap();
        let processed = engine::beatmap::process_beatmap(&map).unwrap();
        let frames = engine::replay::frames::convert_frames(&out.actions, map.format_version);
        let timeline = engine::simulation::simulate(&processed, &frames).unwrap();
        let wide = engine::score::derive_score(
            &processed,
            &timeline,
            &engine::score::ScoreContext::from_beatmap(&map),
        )
        .unwrap();
        let fresh = engine::score::DerivedFields::narrow(&wide).unwrap();
        assert_eq!(out.header.count_300, fresh.count_300);
        assert_eq!(out.header.count_100, fresh.count_100);
        assert_eq!(out.header.count_50, fresh.count_50);
        assert_eq!(out.header.count_geki, fresh.count_geki);
        assert_eq!(out.header.count_katsu, fresh.count_katsu);
        assert_eq!(out.header.count_miss, fresh.count_miss);
        assert_eq!(out.header.max_combo, fresh.max_combo);
        assert_eq!(out.header.perfect, fresh.perfect);
        assert_eq!(out.header.total_score, fresh.total_score);
    }

    #[test]
    fn export_matrix_revert_all_takes_the_regenerating_path() {
        let dir = tempfile::tempdir().unwrap();
        let app = mock_app(dir.path().join("config"), dir.path().join("cache"));
        let scene = editable_scene(&app, dir.path(), 0, 20151228);
        let source = std::fs::read(dir.path().join("replay.osr")).unwrap();

        tauri::async_runtime::block_on(apply_edit(
            app.state(),
            scene.epoch,
            0,
            vec![move_op(5, 200.0, 150.0)],
            "move".into(),
        ))
        .unwrap();
        tauri::async_runtime::block_on(revert_all(app.state(), scene.epoch)).unwrap();

        // content-equal to baseline but marker-dirty: deliberately the
        // conservative reserialize, never a silent passthrough
        let dest = dir.path().join("out.osr");
        let result = export_to(&app, scene.epoch, &dest, false).unwrap();
        assert!(result.regenerated.is_some());
        let bytes = std::fs::read(&dest).unwrap();
        assert_ne!(bytes, source);
        let out = engine::formats::osr::decode_osr(&bytes).unwrap();
        assert_eq!(out.header.life_graph.as_deref(), Some(""));
        assert_eq!(out.header.player_name.as_deref(), Some("test"));
    }

    #[test]
    fn not_simulated_scenes_export_carried_but_refuse_the_reverted_marker() {
        let dir = tempfile::tempdir().unwrap();
        let app = mock_app(dir.path().join("config"), dir.path().join("cache"));
        // hard rock: loads fine, simulates as NotSimulated
        let scene = editable_scene(&app, dir.path(), 16, 20151228);

        tauri::async_runtime::block_on(apply_edit(
            app.state(),
            scene.epoch,
            0,
            vec![rename_op("renamed")],
            "rename".into(),
        ))
        .unwrap();
        let dest = dir.path().join("out.osr");
        let result = export_to(&app, scene.epoch, &dest, false).unwrap();
        assert!(result.regenerated.is_none());
        let out = engine::formats::osr::decode_osr(&std::fs::read(&dest).unwrap()).unwrap();
        assert_eq!(out.header.player_name.as_deref(), Some("renamed"));

        // revert_all marks frames dirty on any scene; without an
        // authoritative simulation the regenerating path cannot derive, so
        // the export refuses typed instead of writing fiction
        tauri::async_runtime::block_on(revert_all(app.state(), scene.epoch)).unwrap();
        let err = export_to(&app, scene.epoch, &dir.path().join("out2.osr"), false).unwrap_err();
        assert!(matches!(err, IpcError::NotEditable { .. }));
    }

    #[test]
    fn lazer_native_scenes_export_carried_metadata_edits() {
        let dir = tempfile::tempdir().unwrap();
        let app = mock_app(dir.path().join("config"), dir.path().join("cache"));
        let scene = editable_scene(&app, dir.path(), 0, 30000001);

        tauri::async_runtime::block_on(apply_edit(
            app.state(),
            scene.epoch,
            0,
            vec![rename_op("renamed")],
            "rename".into(),
        ))
        .unwrap();
        let dest = dir.path().join("out.osr");
        let result = export_to(&app, scene.epoch, &dest, false).unwrap();
        assert!(result.regenerated.is_none());
        let out = engine::formats::osr::decode_osr(&std::fs::read(&dest).unwrap()).unwrap();
        assert_eq!(out.header.player_name.as_deref(), Some("renamed"));
        // the lazer score-info framing replaced the stripped trailer
        assert_eq!(out.trailer, 0i32.to_le_bytes());
    }

    #[test]
    fn export_refuses_an_existing_destination_without_consent() {
        let dir = tempfile::tempdir().unwrap();
        let app = mock_app(dir.path().join("config"), dir.path().join("cache"));
        let scene = editable_scene(&app, dir.path(), 0, 20151228);

        let dest = dir.path().join("out.osr");
        export_to(&app, scene.epoch, &dest, false).unwrap();
        let before = std::fs::read(&dest).unwrap();

        let err = export_to(&app, scene.epoch, &dest, false).unwrap_err();
        assert!(matches!(err, IpcError::FileExists { ref path } if path.contains("out.osr")));
        assert_eq!(std::fs::read(&dest).unwrap(), before, "the destination stays untouched");

        // consent overwrites
        export_to(&app, scene.epoch, &dest, true).unwrap();
    }

    #[test]
    fn export_rejects_a_stale_epoch() {
        let dir = tempfile::tempdir().unwrap();
        let app = mock_app(dir.path().join("config"), dir.path().join("cache"));
        let scene = editable_scene(&app, dir.path(), 0, 20151228);
        let err = export_to(&app, scene.epoch + 1, &dir.path().join("out.osr"), false).unwrap_err();
        assert!(matches!(err, IpcError::StaleSession));
    }

    #[test]
    fn overflowing_derived_fields_surface_the_field_name() {
        // the command-layer mapping from the engine's typed overflow; the
        // narrowing boundaries themselves live in score's own tests
        let overflow = engine::score::DerivedFields::narrow(&engine::score::DerivedScore {
            count_300: 70_000,
            count_100: 0,
            count_50: 0,
            count_geki: 0,
            count_katsu: 0,
            count_miss: 0,
            max_combo: 1,
            perfect: false,
            total_score: 0,
            sections: 1,
            sections_without_burst: 0,
        })
        .unwrap_err();
        let mapped = IpcError::ExportOverflow {
            field: overflow.field.into(),
        };
        assert_eq!(
            serde_json::to_value(&mapped).unwrap(),
            serde_json::json!({ "kind": "exportOverflow", "field": "count300" })
        );
    }
}
