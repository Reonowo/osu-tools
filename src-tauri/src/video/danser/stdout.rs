//! danser's stdout grammar (spec, job lifecycle step 4): success is decided
//! from stdout, never the exit code -- danser exits 0 on "Beatmap not
//! found". `Starting encoding!` arms the percent parser (the star-rating
//! import can log "Progress" lines before that, which must not feed the
//! bar), `Progress: N%, Speed: …, ETA: …` reports, `Finished!` /
//! `Video is available at:` is success, a `panic:` line or "Beatmap not
//! found" is failure. the o!rdr client (MasterIO02/ordr-client, render.ts)
//! is the reference grammar; the committed capture of a real 0.11.0 render
//! (`fixtures/danser/render-transcript-0.11.0.txt`) is the golden input.
//!
//! danser log lines carry a `YYYY/MM/DD HH:MM:SS ` prefix; the bundled
//! ffmpeg's own output interleaves unprefixed and is kept only in the tail
//! this parser retains for failure detail

use std::collections::VecDeque;

use crate::video::RenderProgress;

/// how many raw lines the failure-detail tail keeps. a go panic's goroutine
/// dump alone runs past this, which is why the first failure line is
/// remembered separately rather than trusted to survive the ring
const TAIL_LINES: usize = 12;

#[derive(Debug, Default)]
pub struct StdoutParser {
    armed: bool,
    success: bool,
    video_path: Option<String>,
    failure: Option<String>,
    tail: VecDeque<String>,
}

impl StdoutParser {
    /// feeds one raw line (stdout or stderr alike); the return value is the
    /// progress to report, when the line was an armed progress line
    pub fn feed(&mut self, line: &str) -> Option<RenderProgress> {
        if self.tail.len() == TAIL_LINES {
            self.tail.pop_front();
        }
        self.tail.push_back(line.to_string());

        let content = strip_log_prefix(line)?;
        if content == "Starting encoding!" {
            self.armed = true;
            return None;
        }
        if let Some(path) = content.strip_prefix("Video is available at: ") {
            self.success = true;
            self.video_path = Some(path.to_string());
            return None;
        }
        // exactly "Finished!": the earlier "Finished! Stopping video pipe..."
        // line is pipeline chatter, not the terminal marker
        if content == "Finished!" {
            self.success = true;
            return None;
        }
        if content.starts_with("panic:") || content.starts_with("Beatmap not found") {
            self.failure.get_or_insert_with(|| content.to_string());
            return None;
        }
        if let Some(rest) = content.strip_prefix("Progress: ") {
            // the star-rating import logs "Progress" lines before encoding
            // starts; those never feed the bar
            if self.armed {
                return parse_progress(rest);
            }
        }
        None
    }

    pub fn armed(&self) -> bool {
        self.armed
    }

    /// whether a terminal success marker has already been seen. what happens
    /// after it is cleanup, not rendering, so a stall past this point must
    /// not be allowed to discard a video danser has already finished
    pub fn succeeded(&self) -> bool {
        self.success
    }

    /// the terminal verdict once the process is done: the reported video
    /// path on success, the failure detail (first failure line plus the last
    /// output) otherwise. an exit with neither marker is a failure -- exit
    /// codes prove nothing here
    pub fn finish(self) -> Result<Option<String>, String> {
        let tail = self.tail.iter().cloned().collect::<Vec<_>>().join("\n");
        if let Some(failure) = self.failure {
            return Err(format!("{failure}\n\nlast output:\n{tail}"));
        }
        if self.success {
            return Ok(self.video_path);
        }
        Err(format!(
            "danser exited without reporting success\n\nlast output:\n{tail}"
        ))
    }
}

/// the content after danser's `YYYY/MM/DD HH:MM:SS ` log prefix, or None for
/// an unprefixed line (the bundled ffmpeg's own output)
fn strip_log_prefix(line: &str) -> Option<&str> {
    let bytes = line.as_bytes();
    if bytes.len() < 21 {
        return None;
    }
    let digits = |range: std::ops::Range<usize>| bytes[range].iter().all(u8::is_ascii_digit);
    let shaped = digits(0..4)
        && bytes[4] == b'/'
        && digits(5..7)
        && bytes[7] == b'/'
        && digits(8..10)
        && bytes[10] == b' '
        && digits(11..13)
        && bytes[13] == b':'
        && digits(14..16)
        && bytes[16] == b':'
        && digits(17..19)
        && bytes[19] == b' ';
    shaped.then(|| &line[20..])
}

/// `N%, Speed: X.XXx, ETA: Ns` -- the speed and eta ride verbatim, because
/// they are display strings and reformatting them could only lose
fn parse_progress(rest: &str) -> Option<RenderProgress> {
    let percent_end = rest.find('%')?;
    let percent: f64 = rest[..percent_end].trim().parse().ok()?;
    let speed = rest
        .split("Speed: ")
        .nth(1)
        .and_then(|s| s.split(',').next())
        .map(|s| s.trim().to_string());
    let eta = rest.split("ETA: ").nth(1).map(|s| s.trim().to_string());
    Some(RenderProgress {
        percent: Some(percent.clamp(0.0, 100.0)),
        speed,
        eta,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn transcript() -> String {
        std::fs::read_to_string(
            crate::testutil::fixtures_dir()
                .join("danser")
                .join("render-transcript-0.11.0.txt"),
        )
        .unwrap()
    }

    #[test]
    fn the_captured_transcript_parses_to_full_progress_and_the_video_path() {
        let mut parser = StdoutParser::default();
        let mut reported: Vec<RenderProgress> = Vec::new();
        let mut armed_at_line = None;
        for (index, line) in transcript().lines().enumerate() {
            let was_armed = parser.armed();
            if let Some(progress) = parser.feed(line) {
                assert!(
                    was_armed,
                    "no progress may be reported before arming (line {index})"
                );
                reported.push(progress);
            }
            if !was_armed && parser.armed() {
                armed_at_line = Some(index);
            }
        }
        assert!(armed_at_line.is_some(), "the capture contains Starting encoding!");
        assert!(reported.len() > 50, "the capture carries a full progress run");
        assert_eq!(reported.first().unwrap().percent, Some(0.0));
        assert_eq!(reported.last().unwrap().percent, Some(100.0));
        // the display strings ride verbatim from the first captured line
        assert_eq!(reported[0].speed.as_deref(), Some("7.58x"));
        assert_eq!(reported[0].eta.as_deref(), Some("5s"));

        let path = parser.finish().unwrap().expect("the capture names the video");
        assert!(path.ends_with("transcript-test.mp4"), "{path}");
    }

    #[test]
    fn progress_noise_before_arming_never_feeds_the_bar() {
        // the star-rating import's shape, prefixed like every danser line
        let mut parser = StdoutParser::default();
        assert!(parser
            .feed("2026/08/25 16:42:00 Progress: 50%, Speed: 1.00x, ETA: 1s")
            .is_none());
        parser.feed("2026/08/25 16:42:00 Starting encoding!");
        let progress = parser
            .feed("2026/08/25 16:42:00 Progress: 50%, Speed: 1.00x, ETA: 1s")
            .expect("armed progress reports");
        assert_eq!(progress.percent, Some(50.0));
    }

    #[test]
    fn a_panic_line_is_failure_whatever_else_the_tail_holds() {
        // the real line a missing replay produced against the pinned binary
        let mut parser = StdoutParser::default();
        parser.feed(
            "2026/08/25 16:39:51 panic: open nonexistent.osr: The system cannot find the file specified.",
        );
        // the goroutine dump that follows would rotate the panic line out of
        // the tail; the detail must keep it anyway
        for i in 0..20 {
            parser.feed(&format!("2026/08/25 16:39:51 goroutine dump line {i}"));
        }
        let detail = parser.finish().unwrap_err();
        assert!(detail.contains("panic: open nonexistent.osr"), "{detail}");
        assert!(detail.contains("last output:"), "{detail}");
        assert!(detail.contains("goroutine dump line 19"), "{detail}");
    }

    #[test]
    fn beatmap_not_found_is_failure_despite_danser_exiting_zero() {
        // the real line an unstaged beatmap produced against the pinned
        // binary -- with exit code 0, which is the whole reason stdout decides
        let mut parser = StdoutParser::default();
        parser.feed("2026/08/25 16:40:22 Beatmap not found, closing...");
        let detail = parser.finish().unwrap_err();
        assert!(detail.contains("Beatmap not found"), "{detail}");
    }

    #[test]
    fn an_exit_with_no_terminal_marker_is_failure_not_success() {
        // "Finished! Stopping video pipe..." is chatter; only the exact
        // Finished! / Video is available at: lines conclude a render
        let mut parser = StdoutParser::default();
        parser.feed("2026/08/25 16:42:00 Starting encoding!");
        parser.feed("2026/08/25 16:42:04 Finished! Stopping video pipe...");
        let detail = parser.finish().unwrap_err();
        assert!(detail.contains("without reporting success"), "{detail}");
    }

    #[test]
    fn unprefixed_ffmpeg_lines_are_tail_only() {
        let mut parser = StdoutParser::default();
        parser.feed("2026/08/25 16:42:00 Starting encoding!");
        assert!(parser.feed("frame= 1311 fps=0.0 q=-1.0 Lsize= 4238KiB").is_none());
        assert!(
            parser.feed("Progress: 10%, Speed: 1x, ETA: 1s").is_none(),
            "an unprefixed line is never a danser progress line"
        );
        let detail = parser.finish().unwrap_err();
        assert!(
            detail.contains("frame= 1311"),
            "the ffmpeg line reaches the detail tail"
        );
    }
}
