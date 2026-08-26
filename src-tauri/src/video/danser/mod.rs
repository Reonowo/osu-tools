//! the danser backend behind the `VideoRenderer` seam: the pinned release,
//! its download-on-first-use install, the settings profile + `-sPatch`
//! plumbing, the stdout-driven render choreography, and the stall watchdog.
//! nothing outside `crate::video` may depend on this module -- the swap seam
//! exists so the consumer never learns danser's name beyond the metadata
//! strings the consent dialog renders

pub mod install;
pub mod probe;
pub mod profile;
pub mod stdout;
pub mod watchdog;

use std::io::BufRead;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::error::IpcError;
use crate::video::{
    CancelToken, LicenseNote, RenderInputs, RenderProgress, RendererMetadata, SkinSelection, VideoRenderer,
};

/// the pin. a bump is a deliberate app change with a re-test pass (the lazer
/// fixture-pin discipline): the settings json schema, the cli flags and the
/// stdout grammar are all version-coupled surfaces, so the new zip's hash
/// lands here beside a re-captured transcript fixture and a fresh manual
/// render pass
pub const DANSER_VERSION: &str = "0.11.0";
pub const DANSER_WIN_ZIP_URL: &str =
    "https://github.com/Wieku/danser-go/releases/download/0.11.0/danser-0.11.0-win.zip";
pub const DANSER_WIN_ZIP_NAME: &str = "danser-0.11.0-win.zip";
/// sha-256 of the release asset, computed from the downloaded zip when the
/// pin was set; `install` refuses to unpack anything that does not hash to it
pub const DANSER_WIN_ZIP_SHA256: &str = "749b2e66e36c3e2217910923802f08de9bc1c0858fcb6ffae861a6787fb21eee";
/// the asset's exact size, for the consent dialog and download progress
pub const DANSER_WIN_ZIP_BYTES: u64 = 30_942_877;

/// the `-out` name every render uses inside its private job dir; danser
/// writes its temp files under `<name>_temp/` beside it
const OUT_NAME: &str = "render";

/// how long a quiet stretch must last before the watchdog takes a
/// file-growth sample
const WATCHDOG_POLL_MS: u64 = 1_000;

/// keeps the spawned processes off the user's screen; record mode already
/// runs against a hidden window, but the console host would still flash
pub(crate) fn hide_console(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW
        command.creation_flags(0x0800_0000);
    }
    #[cfg(not(windows))]
    {
        let _ = command;
    }
}

pub struct DanserRenderer {
    /// `app_local_data/danser`; versioned installs live directly under it
    root: PathBuf,
}

impl DanserRenderer {
    pub fn new(root: PathBuf) -> DanserRenderer {
        DanserRenderer { root }
    }

    pub fn install_dir(&self) -> PathBuf {
        self.root.join(DANSER_VERSION)
    }

    /// startup sweep for this backend's own leftovers
    pub fn sweep_temps(&self) {
        install::sweep_install_temps(&self.root);
    }
}

impl VideoRenderer for DanserRenderer {
    fn metadata(&self) -> RendererMetadata {
        RendererMetadata {
            id: "danser".into(),
            name: "danser".into(),
            version: DANSER_VERSION.into(),
            download_bytes: DANSER_WIN_ZIP_BYTES,
            source: "the Wieku/danser-go GitHub release".into(),
            notice: "danser is GPLv3 free software; it bundles the BASS audio library (free for \
                     non-commercial use) and an ffmpeg GPL build"
                .into(),
            licenses: vec![
                LicenseNote {
                    name: "danser-go (GPL-3.0)".into(),
                    detail: "danser-go is copyright Wieku and contributors, licensed under the GNU \
                             General Public License v3.0. it runs as a separate downloaded program \
                             this app launches, which is mere aggregation -- the GPL does not extend \
                             to this app. source: https://github.com/Wieku/danser-go"
                        .into(),
                },
                LicenseNote {
                    name: "BASS audio library".into(),
                    detail: "the danser release bundles the BASS, BASS FX and BASSmix audio libraries \
                             (un4seen developments), which are free for non-commercial use. \
                             https://www.un4seen.com"
                        .into(),
                },
                LicenseNote {
                    name: "ffmpeg (GPL build)".into(),
                    detail: "the danser release bundles an ffmpeg 7.1 GPL-licensed build used for \
                             video encoding. https://ffmpeg.org"
                        .into(),
                },
            ],
        }
    }

    fn installed(&self) -> bool {
        // presence is the completeness marker: the versioned dir only ever
        // appears by atomic rename of a fully unpacked temp
        self.install_dir().is_dir()
    }

    fn install(
        &self,
        progress: &(dyn Fn(Option<f64>) + Sync),
        cancel: &CancelToken,
    ) -> Result<(), IpcError> {
        install::download_and_install(
            DANSER_WIN_ZIP_URL,
            DANSER_WIN_ZIP_BYTES,
            DANSER_WIN_ZIP_SHA256,
            DANSER_WIN_ZIP_NAME,
            &self.root,
            DANSER_VERSION,
            progress,
            cancel,
        )
    }

    fn detect_encoder(&self, cancel: &CancelToken) -> Result<Option<String>, IpcError> {
        if !self.installed() {
            return Err(IpcError::RendererNotInstalled);
        }
        let ffmpeg = self.install_dir().join("ffmpeg").join("ffmpeg.exe");
        let give_up = || cancel.is_cancelled();
        Ok(probe::probe_encoders(
            |encoder| probe::ffmpeg_can_encode(&ffmpeg, encoder, &give_up),
            give_up,
        ))
    }

    /// danser's own log, written portable-layout beside its exe -- the
    /// export dialog's failure panel points here. a trait method (not an
    /// inherent one shadowing it), or the dyn dispatch every caller uses
    /// would answer the default None and the affordance could never appear
    fn log_path(&self) -> Option<PathBuf> {
        self.installed().then(|| self.install_dir().join("danser.log"))
    }

    fn render(
        &self,
        inputs: &RenderInputs,
        progress: &(dyn Fn(RenderProgress) + Sync),
        cancel: &CancelToken,
    ) -> Result<PathBuf, IpcError> {
        let install = self.install_dir();
        if !install.is_dir() {
            return Err(IpcError::RendererNotInstalled);
        }

        // the profile is regenerated per render: cheap, deterministic, and a
        // pin bump or re-probe can never leave a stale one behind
        let encoder = profile::resolve_encoder(&inputs.options);
        let settings_dir = install.join("settings");
        std::fs::create_dir_all(&settings_dir)?;
        std::fs::write(
            settings_dir.join(format!("{}.json", profile::PROFILE_NAME)),
            serde_json::to_string_pretty(&profile::build_profile(&inputs.options.songs_dir, &encoder))
                .expect("profiles always serialize"),
        )?;
        let patch = profile::build_patch(&inputs.options, &inputs.job_dir);

        let mut command = Command::new(install.join("danser-cli.exe"));
        command
            .current_dir(&install)
            .arg("-replay")
            .arg(&inputs.osr_path)
            .arg("-record")
            .args(["-out", OUT_NAME])
            .args(["-settings", profile::PROFILE_NAME])
            .arg("-sPatch")
            .arg(patch.to_string());
        if let SkinSelection::Folder { name, .. } = &inputs.options.skin {
            command.args(["-skin", name]);
        }
        command
            .args(["-noupdatecheck", "-quickstart", "-preciseprogress"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        hide_console(&mut command);

        let mut child = command.spawn().map_err(|e| IpcError::RenderFailed {
            detail: format!("danser failed to start: {e}"),
        })?;

        // both pipes feed one line channel; the channel closing is how the
        // loop learns the process is done talking
        let (line_tx, line_rx) = mpsc::channel::<String>();
        let stdout = child.stdout.take().expect("stdout was piped");
        let stderr = child.stderr.take().expect("stderr was piped");
        for reader in [
            Box::new(stdout) as Box<dyn std::io::Read + Send>,
            Box::new(stderr) as Box<dyn std::io::Read + Send>,
        ] {
            let tx = line_tx.clone();
            std::thread::spawn(move || {
                for line in std::io::BufReader::new(reader).lines() {
                    let Ok(line) = line else { break };
                    if tx.send(line).is_err() {
                        break;
                    }
                }
            });
        }
        drop(line_tx);

        // the kill has to reach a process the wait below also owns, so the
        // child moves behind a shared slot both sides lock briefly
        let child = Arc::new(Mutex::new(child));
        let kill_handle = Arc::clone(&child);
        cancel.set_killer(move || {
            let _ = kill_handle.lock().expect("child lock").kill();
        });

        let watchdog_dir = inputs.job_dir.join(format!("{OUT_NAME}_temp"));
        let started = Instant::now();
        let now_ms = || u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
        let mut parser = stdout::StdoutParser::default();
        let mut stall_watchdog: Option<watchdog::StallWatchdog> = None;
        let mut last_sample_ms = 0u64;
        let mut killed_for_stall = false;

        loop {
            match line_rx.recv_timeout(Duration::from_millis(WATCHDOG_POLL_MS)) {
                Ok(line) => {
                    if let Some(report) = parser.feed(&line) {
                        // danser reporting a higher percent is the render
                        // saying it advanced, which the watchdog counts
                        // beside the byte growth it infers the same thing from
                        if let (Some(watchdog), Some(percent)) = (stall_watchdog.as_mut(), report.percent) {
                            watchdog.note_percent(percent, now_ms());
                        }
                        progress(report);
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
            // the watchdog arms with encoding and samples at most once per
            // poll interval, whether the quiet was real or lines kept flowing
            if parser.armed() {
                let now = now_ms();
                if stall_watchdog.is_none() {
                    stall_watchdog = Some(watchdog::StallWatchdog::new(watchdog::STALL_THRESHOLD_MS, now));
                    last_sample_ms = now;
                } else if now.saturating_sub(last_sample_ms) >= WATCHDOG_POLL_MS {
                    last_sample_ms = now;
                    let verdict = stall_watchdog.as_mut().expect("just armed").observe(
                        watchdog::render_liveness_total(&inputs.job_dir, &watchdog_dir),
                        now,
                    );
                    if verdict == watchdog::WatchdogVerdict::Kill {
                        // the process goes either way -- a hang is a hang, and
                        // waiting on it forever is not on offer. but past the
                        // success marker the only work left is danser deleting
                        // its intermediates, so a stall there is a slow cleanup
                        // and the finished video still stands: only a stall
                        // BEFORE success is a failed render
                        killed_for_stall = !parser.succeeded();
                        let _ = child.lock().expect("child lock").kill();
                    }
                }
            }
        }
        let _ = child.lock().expect("child lock").wait();

        if killed_for_stall {
            let tail = parser.finish().err().unwrap_or_default();
            return Err(IpcError::RenderFailed {
                detail: format!(
                    "the render stalled: danser wrote nothing for {} s and the \
                     process was killed\n\n{tail}",
                    watchdog::STALL_THRESHOLD_MS / 1000
                ),
            });
        }
        match parser.finish() {
            Ok(reported) => {
                // the reported path stays authoritative -- danser names what it
                // wrote and we take it at its word. the fallback is the name
                // the container is now pinned to: `Recording.Container` is a
                // protected path forced to mp4 every render, so `render.mp4`
                // is the only product a healthy render can leave behind
                let reported = reported.map(PathBuf::from).filter(|p| p.is_file());
                let fallback = inputs.job_dir.join(format!("{OUT_NAME}.mp4"));
                reported
                    .or_else(|| fallback.is_file().then_some(fallback))
                    .ok_or_else(|| IpcError::RenderFailed {
                        detail: "danser reported success but produced no video file".into(),
                    })
            }
            Err(detail) => Err(IpcError::RenderFailed { detail }),
        }
    }
}

/// the startup sweep `lib.rs` runs beside the other gc passes, shaped as a
/// free function so setup does not need a renderer instance for it
pub fn sweep_install_temps(root: &Path) {
    install::sweep_install_temps(root);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_metadata_names_the_pin_the_consent_dialog_renders() {
        let renderer = DanserRenderer::new(PathBuf::from(r"C:\data\danser"));
        let metadata = renderer.metadata();
        assert_eq!(metadata.id, "danser");
        assert_eq!(metadata.version, DANSER_VERSION);
        assert_eq!(metadata.download_bytes, DANSER_WIN_ZIP_BYTES);
        assert_eq!(metadata.licenses.len(), 3, "gplv3, bass, ffmpeg");
        // the pin's three surfaces stay coupled: url and label carry the
        // version string the dir layout uses
        assert!(DANSER_WIN_ZIP_URL.contains(DANSER_VERSION));
        assert!(
            DANSER_WIN_ZIP_URL.ends_with(DANSER_WIN_ZIP_NAME),
            "the download label names the asset the url fetches"
        );
        assert_eq!(DANSER_WIN_ZIP_SHA256.len(), 64);
    }

    #[test]
    fn installed_is_the_versioned_dirs_presence() {
        let dir = tempfile::tempdir().unwrap();
        // through the trait object, because that is the only dispatch the
        // command layer ever uses -- an inherent method would shadow direct
        // calls while dyn calls fell to the trait default, exactly the bug
        // this test exists to keep dead
        let renderer: Box<dyn VideoRenderer> = Box::new(DanserRenderer::new(dir.path().join("danser")));
        assert!(!renderer.installed());
        assert_eq!(renderer.log_path(), None, "no install, no log to point at");
        let install = dir.path().join("danser").join(DANSER_VERSION);
        std::fs::create_dir_all(&install).unwrap();
        assert!(renderer.installed());
        assert_eq!(renderer.log_path(), Some(install.join("danser.log")));
    }

    #[test]
    fn probing_an_absent_install_is_the_typed_refusal() {
        let dir = tempfile::tempdir().unwrap();
        let renderer = DanserRenderer::new(dir.path().join("danser"));
        assert!(matches!(
            renderer.detect_encoder(&CancelToken::default()),
            Err(IpcError::RendererNotInstalled)
        ));
    }
}
