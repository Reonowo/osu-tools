//! the scripted fake backend the command tests drive: it fakes only the
//! render (and the install), which is exactly the seam's ownership split --
//! the orchestrator-owned steps run for real against it

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use crate::error::IpcError;
use crate::video::{CancelToken, LicenseNote, RenderInputs, RenderProgress, RendererMetadata, VideoRenderer};

/// what the next render call should do
pub enum FakeScript {
    /// report these percents, write `render.mp4` into the job dir, succeed
    Succeed {
        percents: Vec<f64>,
    },
    Fail {
        detail: String,
    },
    /// spin until cancelled -- the shape a kill-on-cancel takes here
    HangUntilCancel,
}

pub struct FakeRenderer {
    installed: AtomicBool,
    /// when set, `install` spins until the token is cancelled -- the install
    /// counterpart of [`FakeScript::HangUntilCancel`], and the shape a user's
    /// cancel during a slow download takes
    pub hang_install: AtomicBool,
    pub script: Mutex<FakeScript>,
    /// the prepared inputs the last render received, for asserting the
    /// orchestrator's handoff
    pub last_inputs: Mutex<Option<RenderInputs>>,
}

pub const FAKE_VIDEO_BYTES: &[u8] = b"fake rendered video";

impl FakeRenderer {
    pub fn new(installed: bool) -> FakeRenderer {
        FakeRenderer {
            installed: AtomicBool::new(installed),
            hang_install: AtomicBool::new(false),
            script: Mutex::new(FakeScript::Succeed {
                percents: vec![0.0, 50.0, 100.0],
            }),
            last_inputs: Mutex::new(None),
        }
    }
}

impl VideoRenderer for FakeRenderer {
    fn metadata(&self) -> RendererMetadata {
        RendererMetadata {
            id: "fake".into(),
            name: "Fake Renderer".into(),
            version: "1.2.3".into(),
            download_bytes: 42,
            source: "the test suite".into(),
            notice: "a scripted stand-in".into(),
            licenses: vec![LicenseNote {
                name: "none".into(),
                detail: "test fixture".into(),
            }],
        }
    }

    fn installed(&self) -> bool {
        self.installed.load(Ordering::SeqCst)
    }

    fn install(
        &self,
        progress: &(dyn Fn(Option<f64>) + Sync),
        cancel: &CancelToken,
    ) -> Result<(), IpcError> {
        progress(Some(50.0));
        while self.hang_install.load(Ordering::SeqCst) && !cancel.is_cancelled() {
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        // honoured between the reported steps, which is where a real backend
        // checks it too -- and nothing is marked installed on the way out, so
        // a cancelled install leaves the status exactly as it found it
        if cancel.is_cancelled() {
            return Err(IpcError::Cancelled);
        }
        progress(Some(100.0));
        self.installed.store(true, Ordering::SeqCst);
        Ok(())
    }

    fn detect_encoder(&self, _cancel: &CancelToken) -> Result<Option<String>, IpcError> {
        Ok(Some("fake_hw".into()))
    }

    fn render(
        &self,
        inputs: &RenderInputs,
        progress: &(dyn Fn(RenderProgress) + Sync),
        cancel: &CancelToken,
    ) -> Result<PathBuf, IpcError> {
        *self.last_inputs.lock().expect("fake inputs lock") = Some(inputs.clone());
        match &*self.script.lock().expect("fake script lock") {
            FakeScript::Succeed { percents } => {
                for percent in percents {
                    progress(RenderProgress {
                        percent: Some(*percent),
                        speed: Some("9.99x".into()),
                        eta: Some("1s".into()),
                    });
                }
                let out = inputs.job_dir.join("render.mp4");
                std::fs::write(&out, FAKE_VIDEO_BYTES)?;
                Ok(out)
            }
            FakeScript::Fail { detail } => Err(IpcError::RenderFailed {
                detail: detail.clone(),
            }),
            FakeScript::HangUntilCancel => {
                progress(RenderProgress {
                    percent: Some(0.0),
                    speed: None,
                    eta: None,
                });
                while !cancel.is_cancelled() {
                    std::thread::sleep(std::time::Duration::from_millis(5));
                }
                Err(IpcError::RenderFailed {
                    detail: "killed by cancel".into(),
                })
            }
        }
    }
}
