//! the one-time encoder auto-pick (spec Q21): a tiny null-source test
//! encode per candidate via danser's bundled ffmpeg, in a pinned order,
//! first success wins. `ffmpeg -encoders` alone is insufficient -- it lists
//! compiled-in encoders regardless of whether the GPU behind one exists --
//! so each candidate has to actually encode a second of nothing

use std::path::Path;
use std::time::{Duration, Instant};

/// hardware first, in the pinned order, software last -- the fallback that
/// cannot depend on a GPU
pub const ENCODER_CANDIDATES: [&str; 4] = ["h264_nvenc", "h264_qsv", "h264_amf", "libx264"];

/// how long one candidate gets to prove itself. encoding one second of
/// nothing is near-instant even in software, so this is generous -- what it
/// bounds is the driver-level hang a broken hardware encoder produces, which
/// is the same silent hang the render watchdog exists for. without a
/// deadline that hang blocks the caller forever while it holds the single
/// video-operation slot, and no export can run again until the app restarts
const PROBE_TIMEOUT: Duration = Duration::from_secs(20);

/// how often the deadline is checked while a candidate runs
const PROBE_POLL: Duration = Duration::from_millis(50);

/// the first candidate the runner can actually encode with. the runner is
/// injected so the pick order tests without an ffmpeg anywhere.
///
/// `give_up` is asked between candidates and answers "stop probing" -- the
/// whole sweep is four candidates each with its own deadline, so a run against
/// broken hardware encoders can hold the caller for over a minute, and it runs
/// inside the install, behind a modal whose cancel button would otherwise be
/// telling the truth about everything except this stretch
pub fn probe_encoders(can_encode: impl Fn(&str) -> bool, give_up: impl Fn() -> bool) -> Option<String> {
    for candidate in ENCODER_CANDIDATES {
        if give_up() {
            return None;
        }
        if can_encode(candidate) {
            return Some(candidate.to_string());
        }
    }
    None
}

/// the real runner: a one-second 256x256 null-source encode to the null
/// muxer, success meaning exit 0. lavfi and rawvideo are compiled into
/// danser's bundled build (its own recording pipeline depends on them)
pub fn ffmpeg_can_encode(ffmpeg: &Path, encoder: &str, give_up: &(dyn Fn() -> bool + Sync)) -> bool {
    let mut command = std::process::Command::new(ffmpeg);
    command
        .args([
            "-hide_banner",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "nullsrc=s=256x256:d=1",
        ])
        .args(["-c:v", encoder, "-f", "null", "-"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    crate::video::danser::hide_console(&mut command);

    let Ok(mut child) = command.spawn() else {
        return false;
    };
    let deadline = Instant::now() + PROBE_TIMEOUT;
    loop {
        // a candidate that hangs is not a candidate, and neither is one whose
        // status cannot be queried. neither gets to outlive the probe either:
        // both exits kill and reap, or a stray ffmpeg sits on the gpu for the
        // rest of the session
        // the caller's stop answer rides in the same test as the deadline: a
        // cancelled probe is abandoned exactly the way a hung one is, killed
        // and reaped rather than left on the gpu
        let stop = match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) => Instant::now() >= deadline || give_up(),
            Err(_) => true,
        };
        if stop {
            let _ = child.kill();
            let _ = child.wait();
            return false;
        }
        std::thread::sleep(PROBE_POLL);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // the pick-order cases are about the order, not about stopping; a local
    // item shadows the glob import so each reads as it did. the stop cases
    // below reach past this to `super::` deliberately
    fn probe_encoders(can_encode: impl Fn(&str) -> bool) -> Option<String> {
        super::probe_encoders(can_encode, || false)
    }

    #[test]
    fn a_sweep_told_to_stop_probes_nothing_further_and_names_no_winner() {
        // the cancel landing mid-install: the remaining candidates are not
        // started, and no winner is cached from a sweep that never finished.
        // `None` rather than an error, because an empty probe cache is a state
        // `auto` already falls back from
        let asked = std::cell::RefCell::new(Vec::new());
        let picked = super::probe_encoders(
            |e| {
                asked.borrow_mut().push(e.to_string());
                false
            },
            || asked.borrow().len() >= 2,
        );
        assert_eq!(picked, None);
        assert_eq!(
            asked.into_inner(),
            vec!["h264_nvenc", "h264_qsv"],
            "the sweep stops where it was told to, not at the end of the list"
        );
    }

    #[test]
    fn a_stop_raised_before_the_first_candidate_starts_nothing_at_all() {
        let asked = std::cell::RefCell::new(Vec::new());
        let picked = super::probe_encoders(
            |e| {
                asked.borrow_mut().push(e.to_string());
                true
            },
            || true,
        );
        assert_eq!(picked, None);
        assert!(asked.into_inner().is_empty(), "not one candidate is run");
    }

    #[test]
    fn the_first_working_candidate_wins_in_the_pinned_order() {
        // an nvidia machine: nvenc answers first even though libx264 works too
        let picked = probe_encoders(|e| e == "h264_nvenc" || e == "libx264");
        assert_eq!(picked.as_deref(), Some("h264_nvenc"));

        // an intel igpu machine: qsv outranks amf and software
        let picked = probe_encoders(|e| e == "h264_qsv" || e == "h264_amf" || e == "libx264");
        assert_eq!(picked.as_deref(), Some("h264_qsv"));

        // no gpu at all: software still wins over nothing
        let picked = probe_encoders(|e| e == "libx264");
        assert_eq!(picked.as_deref(), Some("libx264"));
    }

    #[test]
    fn a_runner_that_can_encode_nothing_yields_no_winner() {
        // a broken ffmpeg must cache nothing rather than a wrong id
        assert_eq!(probe_encoders(|_| false), None);
    }

    #[test]
    fn every_candidate_is_probed_at_most_once_and_in_order() {
        let asked = std::cell::RefCell::new(Vec::new());
        probe_encoders(|e| {
            asked.borrow_mut().push(e.to_string());
            false
        });
        assert_eq!(asked.into_inner(), ENCODER_CANDIDATES.map(String::from).to_vec());
    }
}
