//! the video export seam (spec, video export): a `VideoRenderer` trait a
//! backend implements, and the generic job orchestrator that owns everything
//! around the render -- staging, the temp `.osr` write, the destination
//! move, job-dir cleanup. the consumer side (frontend, ipc surface, core
//! settings) must not care which renderer is behind the trait: danser is the
//! first impl (`danser`), and an in-house exporter remains a possible pivot,
//! which is why a backend receives prepared inputs and owns only the render
//! itself.
//!
//! progress is one event channel (`PROGRESS_EVENT`), payload
//! `{ jobId, stage, percent?, speed?, eta? }`: an export job's stream is
//! `staging` -> `rendering` -> `moving`, and `install_video_renderer` emits
//! `installing` on the same channel under its own job id. terminal
//! success/failure arrives via the command's Result, never the event stream.
//!
//! spawning is backend-side `std::process::Command` only -- no shell plugin,
//! no capability changes, nothing an external page could reach

pub mod danser;
pub mod staging;

#[cfg(test)]
pub mod fake;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;

use crate::error::IpcError;
use crate::settings::{RendererOptionsMap, SkinPolicy};
use crate::skin::SkinLocator;
use staging::ExportSourceRecord;

/// the progress event channel every video operation reports on
pub const PROGRESS_EVENT: &str = "video-export-progress";

/// the conventional per-backend blob key the install flow caches the encoder
/// probe's winner under. the KEY is generic -- "this backend's probed
/// encoder" -- while the value only means something to the backend that
/// probed it, which is why it lives in the blob that dies with the backend
pub const PROBED_ENCODER_KEY: &str = "probedEncoder";

/// what the consent dialog renders, supplied by the backend so nothing
/// backend-specific is hardcoded in the frontend
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RendererMetadata {
    /// the stable id core settings key the per-backend blob by
    pub id: String,
    pub name: String,
    pub version: String,
    /// the release asset's size, for the consent dialog's "~31 MB" line
    pub download_bytes: u64,
    /// where the download comes from, as prose
    pub source: String,
    /// the one-line license notice
    pub notice: String,
    /// the "licenses" expando's entries
    pub licenses: Vec<LicenseNote>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseNote {
    pub name: String,
    pub detail: String,
}

/// the `get_video_renderer_status` answer. `log_path` is the backend's own
/// log file when it keeps one -- the export dialog's "open the renderer log"
/// affordance
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RendererStatus {
    pub installed: bool,
    pub metadata: RendererMetadata,
    pub log_path: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum VideoStage {
    Staging,
    Rendering,
    Moving,
    Installing,
}

/// one progress event. `percent` exists only in the `rendering` and
/// `installing` stages; `speed` and `eta` ride verbatim from the backend's
/// own progress line
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoProgress {
    pub job_id: String,
    pub stage: VideoStage,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub percent: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speed: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub eta: Option<String>,
}

/// what a backend reports mid-render; the orchestrator stamps the job id and
/// stage on the way out
#[derive(Debug, Clone, Default)]
pub struct RenderProgress {
    pub percent: Option<f64>,
    pub speed: Option<String>,
    pub eta: Option<String>,
}

/// the `export_video` answer: where the file landed and how big it is
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoExportResult {
    pub path: String,
    pub bytes: u64,
}

/// which skin the render wears, already resolved from the app's locator so a
/// backend never learns the skin-picker's vocabulary
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SkinSelection {
    RendererDefault,
    Folder { skins_dir: PathBuf, name: String },
}

/// the app's skin selection mapped onto a renderer's terms (spec Q6): a
/// folder-based active skin -- stable, imported, or browsed -- becomes its
/// parent directory plus the folder name; the bundled skin has no on-disk
/// folder a renderer could load, so it means the renderer's own default, as
/// does the explicit rendererDefault policy
pub fn select_skin(policy: SkinPolicy, locator: &SkinLocator) -> SkinSelection {
    if policy == SkinPolicy::RendererDefault {
        return SkinSelection::RendererDefault;
    }
    let path = match locator {
        SkinLocator::Bundled => return SkinSelection::RendererDefault,
        SkinLocator::Stable { path } | SkinLocator::Folder { path } | SkinLocator::Imported { path } => {
            Path::new(path)
        }
    };
    match (path.parent(), path.file_name()) {
        (Some(parent), Some(name)) if !parent.as_os_str().is_empty() => SkinSelection::Folder {
            skins_dir: parent.to_path_buf(),
            name: name.to_string_lossy().into_owned(),
        },
        _ => SkinSelection::RendererDefault,
    }
}

/// everything per-render a backend receives beyond the prepared directories.
/// `encoder` stays the user's choice (`"auto"` or an explicit id) -- a
/// backend resolves `auto` against its own probe cache in the blob, because
/// what `auto` means is a backend question
#[derive(Debug, Clone)]
pub struct ResolvedRenderOptions {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub encoder: String,
    pub skin: SkinSelection,
    /// the staging songs dir the backend's beatmap lookup scans
    pub songs_dir: PathBuf,
    /// this backend's opaque options blob (`Value::Null` when unset)
    pub renderer_options: serde_json::Value,
}

/// the prepared inputs `render` receives: the orchestrator has already
/// staged the beatmap set, created the job dir, and written the temp `.osr`
#[derive(Debug, Clone)]
pub struct RenderInputs {
    pub staged_set_dir: PathBuf,
    pub job_dir: PathBuf,
    /// the temp `.osr` inside `job_dir`
    pub osr_path: PathBuf,
    pub options: ResolvedRenderOptions,
}

/// cooperative cancellation for one job. the backend registers a killer (the
/// process kill) once it has something to kill; `cancel` runs it and flips
/// the flag the orchestrator checks between stages. registering after
/// cancellation runs the killer immediately, so the race between "cancel
/// arrived" and "process just spawned" cannot leak a live process
#[derive(Clone, Default)]
pub struct CancelToken(Arc<CancelInner>);

#[derive(Default)]
struct CancelInner {
    cancelled: AtomicBool,
    killer: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

impl CancelToken {
    pub fn is_cancelled(&self) -> bool {
        self.0.cancelled.load(Ordering::SeqCst)
    }

    pub fn cancel(&self) {
        self.0.cancelled.store(true, Ordering::SeqCst);
        let killer = self.0.killer.lock().expect("cancel killer lock").take();
        if let Some(kill) = killer {
            kill();
        }
    }

    pub fn set_killer(&self, kill: impl FnOnce() + Send + 'static) {
        let mut slot = self.0.killer.lock().expect("cancel killer lock");
        if self.is_cancelled() {
            drop(slot);
            kill();
        } else {
            *slot = Some(Box::new(kill));
        }
    }
}

/// the renderer-agnostic seam. a backend owns exactly the render (and its
/// own acquisition); the orchestrator owns the job lifecycle around it
pub trait VideoRenderer: Send + Sync {
    fn metadata(&self) -> RendererMetadata;

    fn installed(&self) -> bool;

    /// consent-gated download + install. `progress` is 0-100 when the
    /// download's length is known.
    ///
    /// `cancel` is the same token an export's render receives, and for the
    /// same reason: an install holds the one video-operation slot for as long
    /// as it runs, and the dialog it runs behind refuses every dismissal route
    /// while it does. an install that could not be stopped would therefore
    /// pin the user to a modal for the whole of a slow download. a backend
    /// honours it at whatever granularity its work divides into and returns
    /// [`IpcError::Cancelled`]; anything already written must be left in a
    /// state the startup sweep collects, never one `installed()` would trust
    fn install(
        &self,
        progress: &(dyn Fn(Option<f64>) + Sync),
        cancel: &CancelToken,
    ) -> Result<(), IpcError>;

    /// probe the preferred encoder against the installed backend; `None`
    /// for a backend without the concept. re-runnable on demand.
    ///
    /// takes the operation's token for the same reason `install` does: a probe
    /// can be the slowest thing an install does (a sweep of candidates that
    /// each have to actually run), and it runs while the same modal is up. a
    /// backend that stops early answers `None` -- no winner is not an error,
    /// and an empty cache is a state `auto` already falls back from
    fn detect_encoder(&self, cancel: &CancelToken) -> Result<Option<String>, IpcError>;

    /// the backend's own log file, when it keeps one and is installed
    fn log_path(&self) -> Option<std::path::PathBuf> {
        None
    }

    /// render into `inputs.job_dir` and return the produced video file.
    /// stdout parsing, watchdogs and process choreography all live behind
    /// this call; success must never be inferred from an exit code alone
    fn render(
        &self,
        inputs: &RenderInputs,
        progress: &(dyn Fn(RenderProgress) + Sync),
        cancel: &CancelToken,
    ) -> Result<PathBuf, IpcError>;
}

/// reads the probe cache the install flow wrote for `backend_id`
pub fn probed_encoder(options: &RendererOptionsMap, backend_id: &str) -> Option<String> {
    options
        .get(backend_id)?
        .get(PROBED_ENCODER_KEY)?
        .as_str()
        .map(str::to_string)
}

/// writes the probe winner into the backend's blob, creating the blob when
/// absent and preserving every other key when not
pub fn record_probed_encoder(options: &mut RendererOptionsMap, backend_id: &str, encoder: &str) {
    let blob = options
        .entry(backend_id.to_string())
        .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
    if !blob.is_object() {
        *blob = serde_json::Value::Object(serde_json::Map::new());
    }
    blob.as_object_mut().expect("just ensured object").insert(
        PROBED_ENCODER_KEY.into(),
        serde_json::Value::String(encoder.into()),
    );
}

/// the app-wide video state: the chosen backend, the two roots, and the
/// one-video-operation-at-a-time slot (an export or an install; sharing the
/// slot is what stops an install racing a render over the same install dir)
pub struct VideoState {
    pub renderer: Arc<dyn VideoRenderer>,
    /// `app_local_data/danser-jobs`: per-job dirs, swept at startup
    pub jobs_root: PathBuf,
    /// `app_local_data/danser-songs`: the staging sets (`staging`)
    pub songs_root: PathBuf,
    /// arc'd so the guard can clear its own slot from whatever thread drops it
    active: Arc<Mutex<Option<ActiveJob>>>,
    counter: AtomicU64,
}

struct ActiveJob {
    id: String,
    cancel: CancelToken,
}

impl VideoState {
    pub fn new(renderer: Arc<dyn VideoRenderer>, jobs_root: PathBuf, songs_root: PathBuf) -> VideoState {
        VideoState {
            renderer,
            jobs_root,
            songs_root,
            active: Arc::new(Mutex::new(None)),
            counter: AtomicU64::new(0),
        }
    }

    /// claims the slot for one operation, or answers the typed refusal. the
    /// returned guard releases the slot on drop, so no failure path can
    /// leave exports refused forever
    pub fn begin(&self) -> Result<JobGuard, IpcError> {
        let mut active = self.active.lock().expect("video job slot lock");
        if active.is_some() {
            return Err(IpcError::ExportBusy);
        }
        let id = format!("job-{}", self.counter.fetch_add(1, Ordering::Relaxed) + 1);
        let cancel = CancelToken::default();
        *active = Some(ActiveJob {
            id: id.clone(),
            cancel: cancel.clone(),
        });
        Ok(JobGuard {
            id,
            cancel,
            active: Arc::clone(&self.active),
        })
    }

    /// cancels the running operation when `job_id` names it; a stale id --
    /// the job already finished -- is a no-op, never an error
    pub fn cancel(&self, job_id: &str) {
        let active = self.active.lock().expect("video job slot lock");
        if let Some(job) = active.as_ref().filter(|job| job.id == job_id) {
            job.cancel.cancel();
        }
    }
}

pub struct JobGuard {
    pub id: String,
    pub cancel: CancelToken,
    active: Arc<Mutex<Option<ActiveJob>>>,
}

impl Drop for JobGuard {
    fn drop(&mut self) {
        let mut active = self.active.lock().expect("video job slot lock");
        if active.as_ref().is_some_and(|job| job.id == self.id) {
            *active = None;
        }
    }
}

/// everything `run_export_job` needs, gathered before the blocking work so
/// the job owns copies of all of it -- after this point the user can scrub,
/// keep playing, or open another replay
pub struct ExportJobInputs {
    pub job_id: String,
    pub jobs_root: PathBuf,
    pub songs_root: PathBuf,
    pub dest_path: PathBuf,
    pub osr_bytes: Vec<u8>,
    pub source: ExportSourceRecord,
    pub options: ResolvedRenderOptions,
}

/// the generic job lifecycle, entirely blocking (the command layer runs it
/// off-thread): stage the set, write the temp `.osr`, hand the backend its
/// prepared inputs, move the product to the chosen destination, delete the
/// job dir. every failure path cleans the job dir, and a cancellation
/// arriving anywhere before the move reports as `Cancelled` whatever shape
/// the backend's own abort took
pub fn run_export_job(
    renderer: &dyn VideoRenderer,
    inputs: ExportJobInputs,
    emit: impl Fn(VideoProgress) + Sync,
    cancel: &CancelToken,
) -> Result<VideoExportResult, IpcError> {
    let job_dir = inputs.jobs_root.join(&inputs.job_id);
    let result = run_export_stages(renderer, &inputs, &job_dir, &emit, cancel);
    // the job dir is spent on every path: success moved the product out,
    // failure has nothing worth keeping, and startup sweeps whatever a
    // crash leaves
    let _ = std::fs::remove_dir_all(&job_dir);
    match result {
        Err(_) if cancel.is_cancelled() => Err(IpcError::Cancelled),
        other => other,
    }
}

fn run_export_stages(
    renderer: &dyn VideoRenderer,
    inputs: &ExportJobInputs,
    job_dir: &Path,
    emit: &(impl Fn(VideoProgress) + Sync),
    cancel: &CancelToken,
) -> Result<VideoExportResult, IpcError> {
    let stage_event = |stage: VideoStage| VideoProgress {
        job_id: inputs.job_id.clone(),
        stage,
        percent: None,
        speed: None,
        eta: None,
    };
    let staging_failed = |message: String| IpcError::StagingFailed { message };

    emit(stage_event(VideoStage::Staging));
    let staged_set_dir = staging::ensure_staged(&inputs.songs_root, &inputs.source)
        .map_err(|e| staging_failed(format!("staging the beatmap set failed: {e}")))?;
    std::fs::create_dir_all(job_dir)
        .map_err(|e| staging_failed(format!("creating the job dir failed: {e}")))?;
    let osr_path = job_dir.join("replay.osr");
    std::fs::write(&osr_path, &inputs.osr_bytes)
        .map_err(|e| staging_failed(format!("writing the temp replay failed: {e}")))?;
    if cancel.is_cancelled() {
        return Err(IpcError::Cancelled);
    }

    emit(stage_event(VideoStage::Rendering));
    let render_inputs = RenderInputs {
        staged_set_dir,
        job_dir: job_dir.to_path_buf(),
        osr_path,
        options: inputs.options.clone(),
    };
    let job_id = inputs.job_id.clone();
    let produced = renderer.render(
        &render_inputs,
        &move |progress: RenderProgress| {
            emit(VideoProgress {
                job_id: job_id.clone(),
                stage: VideoStage::Rendering,
                percent: progress.percent,
                speed: progress.speed,
                eta: progress.eta,
            });
        },
        cancel,
    )?;
    // a cancel that lost the race against the render finishing still
    // cancels: nothing has touched the destination yet
    if cancel.is_cancelled() {
        return Err(IpcError::Cancelled);
    }

    emit(stage_event(VideoStage::Moving));
    let bytes = std::fs::metadata(&produced).map(|m| m.len()).unwrap_or(0);
    move_into_place(&produced, &inputs.dest_path, cancel)?;
    Ok(VideoExportResult {
        path: inputs.dest_path.display().to_string(),
        bytes,
    })
}

/// publishes the rendered file at the destination without ever exposing a
/// half-written one: a plain rename when the volumes match, and a
/// copy-to-sibling-temp + rename when they do not -- the destination only
/// ever holds a complete file. overwrite is deliberate: the save dialog
/// already collected that consent.
///
/// the cross-volume copy is the one unbounded stretch left after the last
/// cancel check, and it is unbounded in the size of the product: a cancel
/// during a multi-gigabyte copy to another drive has to be honoured here or
/// the job publishes the destination and reports success over the user's
/// stop. checked between the copy and the rename, which is the last instant
/// the destination is still untouched
fn move_into_place(from: &Path, dest: &Path, cancel: &CancelToken) -> Result<(), IpcError> {
    if std::fs::rename(from, dest).is_ok() {
        return Ok(());
    }
    let name = dest
        .file_name()
        .ok_or_else(|| IpcError::Io {
            message: format!("video destination has no file name: {}", dest.display()),
        })?
        .to_string_lossy()
        .into_owned();
    let temp = dest.with_file_name(format!(".{name}.{}.video-tmp", std::process::id()));
    let copied = std::fs::copy(from, &temp);
    if copied.is_err() || cancel.is_cancelled() {
        let _ = std::fs::remove_file(&temp);
        copied?;
        return Err(IpcError::Cancelled);
    }
    if let Err(e) = std::fs::rename(&temp, dest) {
        let _ = std::fs::remove_file(&temp);
        return Err(e.into());
    }
    let _ = std::fs::remove_file(from);
    Ok(())
}

/// startup sweep: no job survives a restart, so every leftover job dir is a
/// crash's and is deleted. failures are ignored on the cache gc's terms -- a
/// dir that cannot go now goes on a later startup
pub fn sweep_job_dirs(jobs_root: &Path) {
    let Ok(entries) = std::fs::read_dir(jobs_root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let _ = std::fs::remove_dir_all(&path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skin_selection_maps_folder_locators_and_falls_back_to_the_renderer_default() {
        // a folder-based skin, whichever locator kind holds it, becomes its
        // parent dir plus folder name
        for locator in [
            SkinLocator::Stable {
                path: r"D:\osu!\Skins\Rafis 2016".into(),
            },
            SkinLocator::Folder {
                path: r"D:\osu!\Skins\Rafis 2016".into(),
            },
            SkinLocator::Imported {
                path: r"D:\osu!\Skins\Rafis 2016".into(),
            },
        ] {
            assert_eq!(
                select_skin(SkinPolicy::FollowApp, &locator),
                SkinSelection::Folder {
                    skins_dir: PathBuf::from(r"D:\osu!\Skins"),
                    name: "Rafis 2016".into(),
                },
                "{locator:?}"
            );
        }

        // the bundled skin has no folder a renderer could load
        assert_eq!(
            select_skin(SkinPolicy::FollowApp, &SkinLocator::Bundled),
            SkinSelection::RendererDefault
        );

        // the explicit policy wins over any locator
        assert_eq!(
            select_skin(
                SkinPolicy::RendererDefault,
                &SkinLocator::Stable {
                    path: r"D:\osu!\Skins\Rafis 2016".into()
                }
            ),
            SkinSelection::RendererDefault
        );

        // a degenerate path with no parent falls back rather than pointing a
        // renderer's skins dir at nothing
        assert_eq!(
            select_skin(SkinPolicy::FollowApp, &SkinLocator::Folder { path: "x".into() }),
            SkinSelection::RendererDefault
        );
    }

    #[test]
    fn progress_events_serialize_camel_case_and_omit_absent_fields() {
        let event = VideoProgress {
            job_id: "job-3".into(),
            stage: VideoStage::Rendering,
            percent: Some(42.0),
            speed: Some("15.2x".into()),
            eta: Some("2s".into()),
        };
        assert_eq!(
            serde_json::to_value(&event).unwrap(),
            serde_json::json!({
                "jobId": "job-3",
                "stage": "rendering",
                "percent": 42.0,
                "speed": "15.2x",
                "eta": "2s",
            })
        );

        let bare = VideoProgress {
            job_id: "job-4".into(),
            stage: VideoStage::Staging,
            percent: None,
            speed: None,
            eta: None,
        };
        assert_eq!(
            serde_json::to_value(&bare).unwrap(),
            serde_json::json!({ "jobId": "job-4", "stage": "staging" })
        );
    }

    #[test]
    fn cancel_tokens_run_a_killer_registered_before_or_after_cancellation() {
        use std::sync::atomic::AtomicU32;

        // registered before: cancel runs it exactly once
        let token = CancelToken::default();
        let killed = Arc::new(AtomicU32::new(0));
        let count = Arc::clone(&killed);
        token.set_killer(move || {
            count.fetch_add(1, Ordering::SeqCst);
        });
        assert!(!token.is_cancelled());
        token.cancel();
        assert!(token.is_cancelled());
        assert_eq!(killed.load(Ordering::SeqCst), 1);
        token.cancel();
        assert_eq!(killed.load(Ordering::SeqCst), 1, "a killer fires once");

        // registered after: the race where cancel lands while the process is
        // spawning must still kill it
        let token = CancelToken::default();
        token.cancel();
        let killed = Arc::new(AtomicU32::new(0));
        let count = Arc::clone(&killed);
        token.set_killer(move || {
            count.fetch_add(1, Ordering::SeqCst);
        });
        assert_eq!(killed.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn probe_cache_reads_and_writes_preserve_the_rest_of_the_blob() {
        let mut options = RendererOptionsMap::new();
        assert_eq!(probed_encoder(&options, "danser"), None);

        options.insert("danser".into(), serde_json::json!({ "motionBlur": true }));
        record_probed_encoder(&mut options, "danser", "h264_nvenc");
        assert_eq!(probed_encoder(&options, "danser"), Some("h264_nvenc".into()));
        assert_eq!(options["danser"]["motionBlur"], serde_json::json!(true));

        // an absent blob is created; re-probing overwrites only its own key
        record_probed_encoder(&mut options, "other", "libx264");
        assert_eq!(probed_encoder(&options, "other"), Some("libx264".into()));
        record_probed_encoder(&mut options, "danser", "libx264");
        assert_eq!(probed_encoder(&options, "danser"), Some("libx264".into()));
        assert_eq!(options["danser"]["motionBlur"], serde_json::json!(true));
    }

    #[test]
    fn move_into_place_replaces_the_destination_and_consumes_the_source() {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("render.mp4");
        let dest = dir.path().join("final.mp4");
        std::fs::write(&from, b"video").unwrap();
        std::fs::write(&dest, b"old").unwrap();

        move_into_place(&from, &dest, &CancelToken::default()).unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"video");
        assert!(!from.exists());
    }

    #[test]
    fn a_cancel_during_the_cross_volume_copy_leaves_the_destination_alone() {
        // the same-volume path renames atomically and has no window worth
        // guarding; the copy path is the one that can run for minutes, so it
        // is the one a cancel has to be able to stop. a sibling temp already
        // at the destination name forces that path without a second volume
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("render.mp4");
        let dest = dir.path().join("final.mp4");
        std::fs::write(&from, b"video").unwrap();
        std::fs::create_dir_all(&dest).unwrap(); // a dir at the dest defeats the fast rename

        let cancel = CancelToken::default();
        cancel.cancel();
        assert!(matches!(
            move_into_place(&from, &dest, &cancel),
            Err(IpcError::Cancelled)
        ));
        // nothing published, and no sibling temp survives the refusal
        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains("video-tmp"))
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
    }

    #[test]
    fn job_dir_sweep_clears_leftovers_and_tolerates_a_missing_root() {
        let root = tempfile::tempdir().unwrap();
        let leftover = root.path().join("job-7");
        std::fs::create_dir_all(&leftover).unwrap();
        std::fs::write(leftover.join("replay.osr"), b"x").unwrap();

        sweep_job_dirs(root.path());
        assert!(!leftover.exists());
        sweep_job_dirs(std::path::Path::new(r"Z:\does\not\exist"));
    }
}
