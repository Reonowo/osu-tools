//! the second-launch handoff: what a second instance of the app asks of the
//! one already running.
//!
//! the single-instance plugin delivers the second launch's argv and cwd to
//! the running instance and exits it; the running instance focuses its
//! window and, when that argv names a replay (a file-association or shell
//! open), hands the path to the frontend over `OPEN_REPLAY_EVENT`. the
//! frontend routes it through the store's one guarded `openReplay`, which is
//! what gives a second launch the beatmap association walk and the
//! unsaved-edits discard prompt every other route gets -- an argv open can
//! never silently destroy an edited document.

use std::path::{Path, PathBuf};

/// the event carrying a second launch's replay path to the frontend; the
/// payload is the path as one string
pub const OPEN_REPLAY_EVENT: &str = "open-replay";

/// the replay a second launch asks to open: the first `.osr` argument after
/// the executable, its extension compared case-insensitively as the shell
/// hands it over, resolved against that launch's own cwd when relative. none
/// when the launch carried no replay, which is a plain second launch that
/// only wants the window focused
pub fn replay_in_argv(argv: &[String], cwd: &str) -> Option<PathBuf> {
    argv.iter()
        .skip(1)
        .map(PathBuf::from)
        .find(is_replay)
        .map(|path| {
            if path.is_relative() {
                Path::new(cwd).join(path)
            } else {
                path
            }
        })
}

fn is_replay(path: &PathBuf) -> bool {
    path.extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("osr"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(args: &[&str]) -> Vec<String> {
        args.iter().map(|s| s.to_string()).collect()
    }

    /// an absolute path in the host's own syntax: a drive-letter path is
    /// relative on unix, where it would be joined onto the cwd and fail the
    /// assertion the test is making about an absolute argument
    fn absolute(tail: &str) -> PathBuf {
        let root = if cfg!(windows) { "C:\\" } else { "/" };
        Path::new(root).join(tail)
    }

    #[test]
    fn the_first_replay_argument_is_the_request() {
        let (first, second) = (absolute("r/a.osr"), absolute("r/b.osr"));
        let found = replay_in_argv(
            &argv(&[
                "app.exe",
                "--flag",
                &first.to_string_lossy(),
                &second.to_string_lossy(),
            ]),
            "C:\\cwd",
        );
        assert_eq!(found, Some(first));
    }

    #[test]
    fn the_extension_matches_case_insensitively() {
        let upper = absolute("r/play.OSR");
        let found = replay_in_argv(&argv(&["app.exe", &upper.to_string_lossy()]), "C:\\cwd");
        assert_eq!(found, Some(upper));
    }

    #[test]
    fn a_relative_path_resolves_against_the_launch_cwd() {
        let found = replay_in_argv(&argv(&["app.exe", "play.osr"]), "C:\\cwd");
        assert_eq!(found, Some(Path::new("C:\\cwd").join("play.osr")));
    }

    #[test]
    fn a_launch_without_a_replay_asks_nothing() {
        assert_eq!(replay_in_argv(&argv(&["app.exe"]), "C:\\cwd"), None);
        assert_eq!(
            replay_in_argv(&argv(&["app.exe", "map.osu", "--verbose"]), "C:\\cwd"),
            None
        );
        assert_eq!(
            replay_in_argv(&argv(&["app.exe", "notes.osr.txt"]), "C:\\cwd"),
            None
        );
    }

    #[test]
    fn the_executable_itself_is_never_the_request() {
        assert_eq!(replay_in_argv(&argv(&["C:\\odd\\viewer.osr"]), "C:\\cwd"), None);
    }
}
