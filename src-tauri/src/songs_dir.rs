//! where a stable install keeps its beatmaps.
//!
//! stable lets a user move the Songs folder anywhere through its own
//! options, recording the choice as `BeatmapDirectory` in the per-user
//! `osu!.<user>.cfg` beside the client. this module is the one rule that
//! answers "which directory", ported line for line from lazer's
//! `osu.Game/IO/StableStorage.cs:37-68` (`locateSongsDirectory`), so that any
//! install lazer's own import can read resolves here too, and so that no
//! behaviour of a closed client is guessed at.
//!
//! the port, step for step:
//!
//! - look for `osu!.<user>.cfg` at the install root. lazer's `GetFiles`
//!   matches case-insensitively and may return several, so a case-CORRECT
//!   match is preferred and any other match is the fallback
//!   (`StableStorage.cs:39-45`)
//! - read the first line starting with `BeatmapDirectory`, compared
//!   case-insensitively (`:56`)
//! - the value is the LAST `=`-separated part, trimmed (`:58`)
//! - use it only when it is fully qualified; otherwise stop looking (`:59-62`)
//! - with no file, no line, or a value that is not fully qualified: `Songs`
//!   beside the listing (`:19,67`)
//!
//! two of those are worth stating as decisions rather than steps, because
//! both look like omissions:
//!
//! **a relative value is ignored, not resolved against the install root.**
//! that is lazer's rule exactly. stable's own handling of a relative
//! `BeatmapDirectory` is unverifiable from outside the client, and inventing
//! a resolution would be a guess wearing a port's clothes. the observed real
//! value on a default install is `Songs`, which is relative and lands on the
//! same directory the fallback does.
//!
//! **another account's cfg is never consulted.** stable writes a fresh
//! per-user cfg the first time it runs under a new account, so an install
//! copied between accounts genuinely has no configured directory for the
//! account reading it -- and agreeing with the client beats guessing from a
//! stranger's file.
//!
//! a configured directory that does not exist is returned as configured. the
//! lookup then misses and the user gets the manual picker, which is visible;
//! silently falling back to a different folder is not.

use std::path::{Path, PathBuf};

/// stablestorage.cs:19 -- `STABLE_DEFAULT_SONGS_PATH`
const DEFAULT_SONGS_DIR: &str = "Songs";

/// stablestorage.cs:56 -- the key, matched case-insensitively at the start
/// of a line
const BEATMAP_DIRECTORY_KEY: &str = "beatmapdirectory";

/// the Songs directory for `install_root`, as the account named `user_name`
/// would see it. pure: the only filesystem access is reading the cfg, and the
/// account name is a parameter so the rule is testable without touching the
/// environment
pub fn locate_songs_directory(install_root: &Path, user_name: &str) -> PathBuf {
    let default = || install_root.join(DEFAULT_SONGS_DIR);
    let Some(cfg) = user_config_file(install_root, user_name) else {
        return default();
    };
    let Ok(contents) = std::fs::read_to_string(&cfg) else {
        return default();
    };
    for line in contents.lines() {
        // compared as BYTES, never as a `&str` slice: `line[..16]` panics
        // when byte 16 lands inside a multi-byte character, and a cfg is a
        // file a user can put anything in
        let Some(head) = line.as_bytes().get(..BEATMAP_DIRECTORY_KEY.len()) else {
            continue;
        };
        if !head.eq_ignore_ascii_case(BEATMAP_DIRECTORY_KEY.as_bytes()) {
            continue;
        }
        // stablestorage.cs:58-62 -- the last `=`-separated part, trimmed,
        // and only when fully qualified. `break` either way: lazer reads the
        // FIRST matching line and stops, so a second one is never consulted
        let value = line.rsplit('=').next().unwrap_or_default().trim();
        if is_fully_qualified(value) {
            return PathBuf::from(value);
        }
        break;
    }
    default()
}

/// stablestorage.cs:39-45 -- `osu!.<user>.cfg` at the root. lazer's
/// `GetFiles` matches case-insensitively, so the directory is scanned rather
/// than the name simply joined
fn user_config_file(install_root: &Path, user_name: &str) -> Option<PathBuf> {
    let wanted = format!("osu!.{user_name}.cfg");
    let matches: Vec<PathBuf> = std::fs::read_dir(install_root)
        .ok()?
        .flatten()
        .filter(|entry| {
            // `GetFiles` returns files, so a directory with the cfg's name is
            // not a candidate
            entry.file_type().is_ok_and(|kind| kind.is_file())
                && entry
                    .file_name()
                    .to_str()
                    .is_some_and(|name| name.eq_ignore_ascii_case(&wanted))
        })
        .map(|entry| entry.path())
        .collect();
    prefer_case_correct(&matches, user_name).cloned()
}

/// stablestorage.cs:43-45 -- the case-insensitive match can return several,
/// so prefer one whose name carries the account name exactly
/// (`Contains(UserName, StringComparison.Ordinal)`) and fall back to any.
/// split out from the scan because a case-insensitive filesystem cannot hold
/// two such files at once, so this is the only way to cover the preference
fn prefer_case_correct<'a>(matches: &'a [PathBuf], user_name: &str) -> Option<&'a PathBuf> {
    matches
        .iter()
        .find(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.contains(user_name))
        })
        .or_else(|| matches.first())
}

/// .net's `Path.IsPathFullyQualified`, which on windows is
/// `!PathInternal.IsPartiallyQualified` -- ported branch for branch rather
/// than approximated, because the difference from `Path::is_absolute` is the
/// whole reason lazer calls it: a drive-RELATIVE `D:Songs` and a root-relative
/// `\Songs` are both absolute-ish and neither is fully qualified.
///
/// the windows implementation is the one that matters: stable is a windows
/// client and this rule reads its config
fn is_fully_qualified(value: &str) -> bool {
    // separators are compared as bytes, and every byte this inspects is
    // ascii, so a multi-byte character can only ever fail a comparison
    let bytes = value.as_bytes();
    if bytes.len() < 2 {
        return false;
    }
    if is_directory_separator(bytes[0]) {
        // "there is no valid way to specify a relative path with two initial
        // slashes or \? as ? isn't valid for drive relative paths and \??\ is
        // equivalent to \\?\" -- note this accepts a bare `\\`, length 2
        return bytes[1] == b'?' || is_directory_separator(bytes[1]);
    }
    // the only fixed shape that does not start with two separators is drive,
    // colon, separator. the drive character is checked for validity too,
    // because `=:\` is the `=` file's default data stream rather than a path
    bytes.len() >= 3
        && bytes[1] == b':'
        && is_directory_separator(bytes[2])
        && bytes[0].is_ascii_alphabetic()
}

fn is_directory_separator(byte: u8) -> bool {
    byte == b'\\' || byte == b'/'
}

/// the account the app is running as, which is what stable names its cfg
/// after. `Environment.UserName` on the platform this ships to
pub fn current_user_name() -> String {
    std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn install_with_cfg(name: &str, contents: &str) -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join(name), contents).unwrap();
        root
    }

    #[test]
    fn a_fully_qualified_directory_is_honoured() {
        let root = install_with_cfg(
            "osu!.admin.cfg",
            "Width = 1920\nBeatmapDirectory = D:\\my songs\nVolume = 5\n",
        );
        assert_eq!(
            locate_songs_directory(root.path(), "admin"),
            PathBuf::from("D:\\my songs")
        );
    }

    /// lazer ignores a relative value rather than resolving it, and so does
    /// this: stable's own handling is unverifiable and a guess is not a port.
    /// `BeatmapDirectory = Songs` is what a default install actually writes,
    /// and it lands on the same folder the fallback does anyway
    #[test]
    fn a_relative_directory_is_ignored() {
        for value in ["Songs", "..\\elsewhere", "\\Songs", "D:Songs"] {
            let root = install_with_cfg("osu!.admin.cfg", &format!("BeatmapDirectory = {value}\n"));
            assert_eq!(
                locate_songs_directory(root.path(), "admin"),
                root.path().join("Songs"),
                "{value} must not be resolved"
            );
        }
    }

    #[test]
    fn a_unc_directory_is_fully_qualified() {
        let root = install_with_cfg("osu!.admin.cfg", "BeatmapDirectory = \\\\nas\\osu\\Songs\n");
        assert_eq!(
            locate_songs_directory(root.path(), "admin"),
            PathBuf::from("\\\\nas\\osu\\Songs")
        );
    }

    /// the port's own edges, against .net's `IsPartiallyQualified` branch for
    /// branch. none of these is a `BeatmapDirectory` anyone writes; they are
    /// here because the doc claims an exact port and an approximation of this
    /// function is a different function
    #[test]
    fn is_fully_qualified_matches_dotnets_branches() {
        for qualified in [
            "C:\\", "c:/x", "Z:\\songs", // drive, colon, separator, valid drive char
            "\\\\", "//", "\\/",   // two separators, even with nothing after them
            "\\?", "/?anything",   // the `\?` device-path spelling
            "\\\\?\\C:\\songs",
        ] {
            assert!(is_fully_qualified(qualified), "{qualified} is fully qualified");
        }
        for partial in [
            "", "C", "\\", "/", // shorter than two characters, or exactly one separator
            "C:", "C:songs",  // drive-relative: no separator after the colon
            "=:\\",           // a colon-separator shape whose drive character is not one
            "songs", "..\\up", "Songs\\sub",
        ] {
            assert!(!is_fully_qualified(partial), "{partial:?} is only partially qualified");
        }
    }

    #[test]
    fn an_absent_cfg_and_an_absent_key_both_fall_back() {
        let bare = tempfile::tempdir().unwrap();
        assert_eq!(locate_songs_directory(bare.path(), "admin"), bare.path().join("Songs"));

        let keyless = install_with_cfg("osu!.admin.cfg", "Width = 1920\nVolume = 5\n");
        assert_eq!(
            locate_songs_directory(keyless.path(), "admin"),
            keyless.path().join("Songs")
        );
    }

    /// stable writes a fresh per-user cfg under a new account, so another
    /// account's file is not this account's configuration. lazer never reads
    /// it and neither does this
    #[test]
    fn another_accounts_cfg_is_never_consulted() {
        let root = install_with_cfg("osu!.someoneelse.cfg", "BeatmapDirectory = D:\\theirs\n");
        assert_eq!(locate_songs_directory(root.path(), "admin"), root.path().join("Songs"));
    }

    #[test]
    fn the_key_is_matched_case_insensitively() {
        for key in ["BeatmapDirectory", "beatmapdirectory", "BEATMAPDIRECTORY"] {
            let root = install_with_cfg("osu!.admin.cfg", &format!("{key} = D:\\songs\n"));
            assert_eq!(
                locate_songs_directory(root.path(), "admin"),
                PathBuf::from("D:\\songs"),
                "{key}"
            );
        }
    }

    /// stablestorage.cs:43-45 -- a case-correct match is preferred, whatever
    /// order the directory listing arrives in. tested over the selection
    /// itself: windows cannot hold `osu!.admin.cfg` and `osu!.ADMIN.cfg` at
    /// once, so no temp directory can set this case up
    #[test]
    fn a_case_correct_cfg_is_preferred_over_a_case_variant_one() {
        let variant = PathBuf::from("C:\\osu!\\osu!.ADMIN.cfg");
        let exact = PathBuf::from("C:\\osu!\\osu!.admin.cfg");
        assert_eq!(
            prefer_case_correct(&[variant.clone(), exact.clone()], "admin"),
            Some(&exact)
        );
        assert_eq!(
            prefer_case_correct(&[exact.clone(), variant.clone()], "admin"),
            Some(&exact)
        );
        // with no case-correct match, any of them will do
        assert_eq!(prefer_case_correct(std::slice::from_ref(&variant), "admin"), Some(&variant));
        assert_eq!(prefer_case_correct(&[], "admin"), None);
    }

    /// and the whole route through a real directory, on the one case a
    /// filesystem can actually present
    #[test]
    fn a_case_variant_cfg_is_still_read() {
        let root = install_with_cfg("osu!.ADMIN.cfg", "BeatmapDirectory = D:\\variant\n");
        assert_eq!(
            locate_songs_directory(root.path(), "admin"),
            PathBuf::from("D:\\variant")
        );
    }

    /// only the FIRST matching line is read, as lazer's loop does: it breaks
    /// out on the first `BeatmapDirectory` whatever the value turns out to be
    #[test]
    fn only_the_first_matching_line_is_read() {
        let root = install_with_cfg(
            "osu!.admin.cfg",
            "BeatmapDirectory = Songs\nBeatmapDirectory = D:\\second\n",
        );
        assert_eq!(locate_songs_directory(root.path(), "admin"), root.path().join("Songs"));
    }

    /// a misconfiguration has to be VISIBLE. the configured directory is
    /// returned whether or not it exists, so the lookup misses and the user
    /// reaches the picker rather than silently reading a different library
    #[test]
    fn a_configured_directory_that_does_not_exist_is_still_returned() {
        let root = install_with_cfg("osu!.admin.cfg", "BeatmapDirectory = D:\\gone\\missing\n");
        let resolved = locate_songs_directory(root.path(), "admin");
        assert_eq!(resolved, PathBuf::from("D:\\gone\\missing"));
        assert!(!resolved.exists(), "the test's premise: the directory is absent");
    }

    /// a value with no `=` at all, and one whose key is a longer word that
    /// merely starts with the key: lazer's `StartsWith` accepts the second,
    /// so this does too rather than inventing a stricter rule
    /// a cfg is a file a user can put anything in, and a key checked by
    /// slicing `&line[..16]` panics when byte 16 lands inside a multi-byte
    /// character. compared as bytes, it cannot
    #[test]
    fn a_multi_byte_line_does_not_panic_the_key_check() {
        let root = install_with_cfg(
            "osu!.admin.cfg",
            "Beatmapééééé = D:\\decoy\nBeatmapDirectory = D:\\real\n",
        );
        assert_eq!(locate_songs_directory(root.path(), "admin"), PathBuf::from("D:\\real"));
    }

    #[test]
    fn the_ports_own_loose_edges_are_reproduced() {
        let no_equals = install_with_cfg("osu!.admin.cfg", "BeatmapDirectory\n");
        assert_eq!(
            locate_songs_directory(no_equals.path(), "admin"),
            no_equals.path().join("Songs")
        );

        // `line.Split('=').Last()` on a line with no `=` is the whole line,
        // which is not fully qualified, so the fallback stands
        let prefixed = install_with_cfg("osu!.admin.cfg", "BeatmapDirectoryOther = D:\\x\n");
        assert_eq!(locate_songs_directory(prefixed.path(), "admin"), PathBuf::from("D:\\x"));
    }
}
