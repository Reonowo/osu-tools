//! the stall watchdog (spec, job lifecycle step 6): danser's failure mode
//! under a broken encoder config is a silent hang, so once encoding has
//! started the render loop watches for evidence the render is still moving
//! and kills the process when none arrives for [`STALL_THRESHOLD_MS`]. two
//! independent signals count as evidence -- the files danser writes growing
//! ([`render_liveness_total`], which spans both writing phases: the temps
//! under `<OutputDir>/<name>_temp/` during encoding and the muxed product in
//! the job dir during the closing pass), and danser's own reported percent
//! climbing -- because a render that is telling us it
//! advanced is not stalled whatever the filesystem answers. the decision is
//! a pure function of those observations and injected time, so the threshold
//! tests without a process or a clock anywhere

use std::path::Path;

/// how long the temp files may stop growing before the render is declared
/// hung. real encoder stalls are indefinite; real slow encodes still grow
/// every second, so ~30 s is generous
pub const STALL_THRESHOLD_MS: u64 = 30_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WatchdogVerdict {
    Continue,
    Kill,
}

/// tracks the highest observation of each signal and when either last
/// advanced, in caller-supplied milliseconds
#[derive(Debug)]
pub struct StallWatchdog {
    threshold_ms: u64,
    last_total: u64,
    last_percent: f64,
    advanced_at_ms: u64,
}

impl StallWatchdog {
    pub fn new(threshold_ms: u64, now_ms: u64) -> StallWatchdog {
        StallWatchdog {
            threshold_ms,
            last_total: 0,
            // no percent reported yet, so the first one counts as advancement
            last_percent: f64::NEG_INFINITY,
            advanced_at_ms: now_ms,
        }
    }

    /// a percent from the renderer's own progress line. the byte total is an
    /// inference about the process; this is the process saying it advanced,
    /// so it resets the clock on its own. a repeat of the same percent is
    /// not advancement -- a renderer reprinting one number forever is the
    /// stall this exists to catch
    pub fn note_percent(&mut self, percent: f64, now_ms: u64) {
        if percent > self.last_percent {
            self.last_percent = percent;
            self.advanced_at_ms = now_ms;
        }
    }

    /// one observation of the temp files' total size. any growth resets the
    /// clock; `Kill` once the standstill has lasted the threshold with
    /// neither signal advancing
    pub fn observe(&mut self, total_bytes: u64, now_ms: u64) -> WatchdogVerdict {
        if total_bytes > self.last_total {
            self.last_total = total_bytes;
            self.advanced_at_ms = now_ms;
            return WatchdogVerdict::Continue;
        }
        if now_ms.saturating_sub(self.advanced_at_ms) >= self.threshold_ms {
            return WatchdogVerdict::Kill;
        }
        WatchdogVerdict::Continue
    }
}

/// the observed quantity: every file's size directly inside `dir`, 0 while
/// the dir does not exist yet (danser creates it when encoding starts, and
/// "not created yet" is itself a standstill the threshold should measure).
///
/// the size comes from `fs::metadata` on each path, never `DirEntry::metadata`:
/// on windows the latter answers from the enumeration's cached
/// `WIN32_FIND_DATA`, and ntfs does not update a file's directory entry while
/// its writer still holds it open -- ffmpeg's growing `video.mp4` reads back
/// at its creation size (0) for the whole render, which the threshold then
/// takes for a hang and kills a perfectly healthy encode over. opening a
/// handle per file is the query that sees the live size
/// what one watchdog sample observes: danser's temp video/audio under
/// `temp_dir` PLUS the job dir's own files. both halves are needed because a
/// render has two writing phases -- encoding grows the temps, and the closing
/// pass muxes them into `<job>/render.mp4` and stops touching the temps
/// entirely (the transcript's "Starting second pass: moving the moov atom",
/// which rewrites the whole file). watching only the temps would read that
/// closing pass as a standstill and kill a healthy render at the finish line,
/// after minutes of work, on exactly the large outputs whose mux is slowest.
/// the job dir's constant members (the temp `.osr`) only offset the total,
/// which a growth test does not care about
pub fn render_liveness_total(job_dir: &Path, temp_dir: &Path) -> u64 {
    temp_files_total(job_dir) + temp_files_total(temp_dir)
}

pub fn temp_files_total(dir: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    entries
        .flatten()
        .filter_map(|entry| std::fs::metadata(entry.path()).ok())
        .filter(|metadata| metadata.is_file())
        .map(|metadata| metadata.len())
        .sum()
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use super::*;

    #[test]
    fn growth_resets_the_clock_and_a_standstill_kills_at_the_threshold() {
        let mut watchdog = StallWatchdog::new(30_000, 0);
        assert_eq!(watchdog.observe(100, 1_000), WatchdogVerdict::Continue);
        // stalls under the threshold survive
        assert_eq!(watchdog.observe(100, 30_000), WatchdogVerdict::Continue);
        // growth at the brink resets the clock entirely
        assert_eq!(watchdog.observe(200, 30_999), WatchdogVerdict::Continue);
        assert_eq!(watchdog.observe(200, 60_998), WatchdogVerdict::Continue);
        // the boundary: exactly threshold ms after the last growth
        assert_eq!(watchdog.observe(200, 60_999), WatchdogVerdict::Kill);
    }

    #[test]
    fn a_render_that_never_writes_a_byte_still_trips() {
        // the broken-encoder hang: the temp dir stays empty forever
        let mut watchdog = StallWatchdog::new(30_000, 5_000);
        assert_eq!(watchdog.observe(0, 10_000), WatchdogVerdict::Continue);
        assert_eq!(watchdog.observe(0, 35_000), WatchdogVerdict::Kill);
    }

    #[test]
    fn shrinking_totals_do_not_read_as_growth() {
        // danser deleting a temp file mid-cleanup must not feed the clock
        let mut watchdog = StallWatchdog::new(1_000, 0);
        watchdog.observe(500, 100);
        assert_eq!(watchdog.observe(300, 200), WatchdogVerdict::Continue);
        assert_eq!(watchdog.observe(300, 1_100), WatchdogVerdict::Kill);
    }

    #[test]
    fn temp_totals_sum_files_and_answer_zero_for_a_missing_dir() {
        let dir = tempfile::tempdir().unwrap();
        let temp = dir.path().join("render_temp");
        assert_eq!(temp_files_total(&temp), 0);
        std::fs::create_dir_all(temp.join("nested")).unwrap();
        std::fs::write(temp.join("video.mp4"), vec![0u8; 100]).unwrap();
        std::fs::write(temp.join("audio.mp4"), vec![0u8; 40]).unwrap();
        // only files directly inside count; danser writes no nested files
        assert_eq!(temp_files_total(&temp), 140);
    }

    #[test]
    fn a_file_its_writer_still_holds_open_totals_at_its_live_size() {
        // ffmpeg holds video.mp4 open for the whole render, and on windows a
        // directory entry keeps the size the file was created at until the
        // writer lets go -- reading the enumeration's cached size answered 0
        // for a 200 MB file and killed the render as a hang
        let dir = tempfile::tempdir().unwrap();
        let temp = dir.path().join("render_temp");
        std::fs::create_dir_all(&temp).unwrap();
        let mut writing = std::fs::File::create(temp.join("video.mp4")).unwrap();
        writing.write_all(&[0u8; 4096]).unwrap();
        writing.flush().unwrap();
        assert_eq!(temp_files_total(&temp), 4096, "the live size, not the entry's");
        writing.write_all(&[0u8; 2048]).unwrap();
        writing.flush().unwrap();
        assert_eq!(temp_files_total(&temp), 6144, "and it keeps tracking the growth");
    }

    #[test]
    fn the_closing_mux_counts_as_liveness_though_the_temps_have_stopped() {
        // the regression: encoding ends, danser stops writing render_temp and
        // spends the next stretch muxing into <job>/render.mp4. sampling only
        // the temps froze the clock here and killed the render at 100%
        let dir = tempfile::tempdir().unwrap();
        let job = dir.path().join("job-1");
        let temp = job.join("render_temp");
        std::fs::create_dir_all(&temp).unwrap();
        std::fs::write(job.join("replay.osr"), vec![0u8; 500]).unwrap();
        std::fs::write(temp.join("video.mp4"), vec![0u8; 1_000]).unwrap();

        let mut watchdog = StallWatchdog::new(30_000, 0);
        assert_eq!(
            watchdog.observe(render_liveness_total(&job, &temp), 1_000),
            WatchdogVerdict::Continue
        );

        // the closing pass: the temps stand still while the product grows,
        // for longer than the threshold
        for second in 2..=45u64 {
            std::fs::write(job.join("render.mp4"), vec![0u8; (second as usize) * 10_000]).unwrap();
            assert_eq!(
                watchdog.observe(render_liveness_total(&job, &temp), second * 1_000),
                WatchdogVerdict::Continue,
                "the mux is writing at {second}s"
            );
        }

        // and a mux that genuinely stops still trips
        assert_eq!(
            watchdog.observe(render_liveness_total(&job, &temp), 75_100),
            WatchdogVerdict::Kill
        );
    }

    #[test]
    fn a_climbing_percent_is_liveness_on_its_own() {
        // the render whose bytes we cannot see but which is plainly working:
        // every second danser reports one percent more
        let mut watchdog = StallWatchdog::new(30_000, 0);
        for second in 1..=60u64 {
            watchdog.note_percent(second as f64, second * 1_000);
            assert_eq!(
                watchdog.observe(0, second * 1_000),
                WatchdogVerdict::Continue,
                "at {second}s"
            );
        }
        // and once it stops climbing the threshold runs again from the last
        // percent that did
        assert_eq!(watchdog.observe(0, 89_999), WatchdogVerdict::Continue);
        assert_eq!(watchdog.observe(0, 90_000), WatchdogVerdict::Kill);
    }

    #[test]
    fn a_percent_reprinted_forever_is_not_advancement() {
        // danser stuck on one number is the hang, not liveness
        let mut watchdog = StallWatchdog::new(30_000, 0);
        watchdog.note_percent(26.0, 1_000);
        for second in 2..=30u64 {
            watchdog.note_percent(26.0, second * 1_000);
        }
        assert_eq!(watchdog.observe(0, 31_000), WatchdogVerdict::Kill);
    }
}
