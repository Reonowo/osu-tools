//! the private staging songs dir (spec, beatmap staging): an external
//! renderer resolves beatmaps only by md5-matching a scanned songs dir, so
//! every loaded beatmap -- picked file, saved folder, or stable lookup alike
//! -- is copied into `danser-songs/<md5-8>/` before a render. always a
//! private copy, never the user's osu! install: the renderer scans and
//! indexes whatever it is pointed at, and the one thing this app promises
//! about beatmaps is that it never mutates them.
//!
//! a set lands via a temp sibling dir atomically renamed into place, so the
//! set dir's presence is the completeness marker: a crash mid-copy never
//! leaves a set the re-staging no-op would trust. sets persist across
//! exports keyed by diff md5 (a re-render costs zero copies), capped at
//! [`MAX_STAGED_SETS`]; the startup sweep beside the osz-cache gc deletes
//! unrenamed temps and enforces the cap. staged sets are never lease-held,
//! so the osz cache's lock-probe orphan test does not apply here

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// how many staged sets the songs dir keeps. a set is one diff's files --
/// single-digit megabytes typically -- so the cap bounds disk in the low
/// hundreds of megabytes while keeping every recently rendered diff a
/// zero-copy re-render
pub const MAX_STAGED_SETS: usize = 50;

/// the marker a not-yet-renamed staging dir carries in its name; the sweep
/// identifies temps by it, and a completed set never contains it
const STAGING_MARKER: &str = ".staging-";

static STAGING_COUNTER: AtomicU64 = AtomicU64::new(0);

/// what one render needs from the loaded scene, captured during load from
/// paths the pipeline already resolved (and previously dropped). every path
/// is absolute and valid for the session's lifetime -- for an `.osz` scene
/// they point into the live extraction lease, which is exactly why staging
/// happens synchronously at job start.
///
/// the background is its own field on purpose: the texture list is
/// element-prefix-filtered (`media::resolve_texture_files`) and never
/// enumerates it. storyboard and video files are nowhere in this record,
/// which is what keeps "never staged" true by construction
#[derive(Debug, Clone)]
pub struct ExportSourceRecord {
    pub osu_path: PathBuf,
    pub audio_path: Option<PathBuf>,
    pub background_path: Option<PathBuf>,
    pub sample_files: Vec<PathBuf>,
    pub texture_files: Vec<PathBuf>,
    /// the diff's md5, which is both the set key and what the renderer's
    /// lookup matches the replay against
    pub md5: String,
}

/// one planned copy: an absolute source and its destination relative to the
/// set dir
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StageCopy {
    pub from: PathBuf,
    pub to: PathBuf,
}

/// the exact copy set for one record, uniform across all three beatmap
/// sources -- the record's paths already point wherever that source keeps
/// its files, so no per-source branch exists to get wrong.
///
/// destinations preserve each file's path relative to the `.osu`'s own
/// folder (a background in `sb/` must stay in `sb/` for the map's reference
/// to resolve); a file from elsewhere flattens to its bare name. duplicate
/// destinations collapse to the first plan entry -- the sample map registers
/// one file under several lookup names
pub fn plan_staging(record: &ExportSourceRecord) -> Vec<StageCopy> {
    // both sides are canonicalized before they are compared, because the
    // record carries two different path FORMS: the media paths came back from
    // `media::resolve_media_path` and its siblings, which canonicalize, while
    // the `.osu`'s own path is the raw one the load pipeline was handed -- for
    // an `.osz` scene, the extractor's join against the lease dir. on windows
    // those differ by 8.3 short name or an unresolved junction often enough
    // that the load tests canonicalize both sides before comparing them (see
    // `load.rs`'s "the lease path is the raw temp join"), and a lexical
    // `strip_prefix` across that mismatch simply fails. NOT drive-letter case:
    // Rust compares windows disk prefixes case-insensitively, so that one
    // survives on its own and is not what this guards. the failure is
    // SILENTLY into the bare-name fallback below, which is the damage: a
    // background the beatmap references as `sb/bg.jpg` stages as `bg.jpg` and
    // resolves to nothing, so the render quietly loses it
    let canonical = |path: &Path| dunce::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    // the PARENT is canonicalised, not the `.osu` and then its parent: those
    // answer different questions the moment the `.osu` is itself a symlink.
    // canonicalising the file resolves to where its bytes physically live,
    // which would move the base to the link target's directory -- while the
    // loader resolved every media path against the NAMED path's parent
    // (`load.rs`'s `dir: osu_path.parent()`), so that directory, resolved, is
    // the only base the media can be relative to
    let base = record.osu_path.parent().map(|parent| canonical(parent));
    let mut planned: Vec<StageCopy> = Vec::new();
    let mut seen: Vec<String> = Vec::new();

    let sources = std::iter::once(&record.osu_path)
        .chain(record.audio_path.iter())
        .chain(record.background_path.iter())
        .chain(record.sample_files.iter())
        .chain(record.texture_files.iter());
    for source in sources {
        // only the comparison uses the canonical form; `from` stays the path
        // the record named, which is what the required-file rule identifies
        // the `.osu` and the audio by
        let resolved = canonical(source);
        let relative = base
            .as_deref()
            .and_then(|base| resolved.strip_prefix(base).ok())
            .map(Path::to_path_buf)
            .or_else(|| source.file_name().map(PathBuf::from));
        let Some(to) = relative else { continue };
        // windows paths are case-insensitive, so the dedup key is too
        let key = to.to_string_lossy().to_lowercase();
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        planned.push(StageCopy {
            from: source.clone(),
            to,
        });
    }
    planned
}

/// the set dir for a diff md5 under the staging root
pub fn set_dir(songs_root: &Path, md5: &str) -> PathBuf {
    // md5 is 32 hex chars; the first 8 keep dir names readable, matching the
    // osz cache's label convention
    songs_root.join(&md5[..md5.len().min(8)])
}

/// stages the record's set unless it is already there. presence is the
/// completeness marker, so an existing set dir is trusted without a single
/// copy; otherwise the plan lands in a temp sibling that is renamed into
/// place whole.
///
/// the `.osu` and the audio must copy -- a set without either can never
/// render -- while a missing sample or texture is skipped: the file resolved
/// at load time and vanished since, and a render without one cosmetic asset
/// beats refusing the export over it
pub fn ensure_staged(songs_root: &Path, record: &ExportSourceRecord) -> std::io::Result<PathBuf> {
    let dest = set_dir(songs_root, &record.md5);
    if dest.is_dir() {
        return Ok(dest);
    }
    // a load whose audio never resolved is valid -- the scene carries the
    // warning and plays silent -- but it cannot be staged: the required-file
    // rule below can only enforce what the record names, so a `None` audio
    // would publish a set that presence then certifies as complete forever.
    // refusing here keeps the completeness marker honest, and the export
    // fails with a reason instead of the renderer's late "beatmap not found"
    if record.audio_path.is_none() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "the beatmap's audio file did not resolve when the replay loaded, \
             and a video cannot be rendered without it",
        ));
    }
    std::fs::create_dir_all(songs_root)?;

    let seq = STAGING_COUNTER.fetch_add(1, Ordering::Relaxed);
    let temp = songs_root.join(format!(
        "{}{STAGING_MARKER}{}-{seq}",
        dest.file_name().unwrap_or_default().to_string_lossy(),
        std::process::id()
    ));
    if temp.exists() {
        std::fs::remove_dir_all(&temp)?;
    }
    let staged = stage_into(&temp, record);
    if staged.is_err() {
        let _ = std::fs::remove_dir_all(&temp);
        staged?;
    }
    match std::fs::rename(&temp, &dest) {
        Ok(()) => Ok(dest),
        // single-instance makes a real race impossible, but a rename can
        // still find the dest present (a crashed sweep's leftover landing
        // late); an existing set is by definition complete, so it wins
        Err(_) if dest.is_dir() => {
            let _ = std::fs::remove_dir_all(&temp);
            Ok(dest)
        }
        Err(e) => {
            let _ = std::fs::remove_dir_all(&temp);
            Err(e)
        }
    }
}

fn stage_into(temp: &Path, record: &ExportSourceRecord) -> std::io::Result<()> {
    std::fs::create_dir_all(temp)?;
    let mut skipped_any = false;
    for copy in plan_staging(record) {
        let to = temp.join(&copy.to);
        if let Some(parent) = to.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let required = copy.from == record.osu_path || Some(&copy.from) == record.audio_path.as_ref();
        match std::fs::copy(&copy.from, &to) {
            Ok(_) => {}
            // a cosmetic file that VANISHED since load is the one tolerable
            // loss: the render goes on without it. every other kind is not --
            // a sharing violation, a permission error, a full disk all mean
            // the file is still the beatmap's and this copy simply failed, and
            // tolerating that publishes a set missing an asset the map still
            // references. presence is the completeness marker, so no later
            // render of this diff would ever retry the copy: the loss would be
            // permanent and silent. failing here costs one export instead, and
            // the caller discards the temp whole, so nothing half-copied is
            // ever renamed into place
            Err(e) if required || e.kind() != std::io::ErrorKind::NotFound => return Err(e),
            Err(_) => skipped_any = true,
        }
    }
    if !source_still_intact(record, skipped_any) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "the beatmap's own files disappeared while the set was being staged",
        ));
    }
    Ok(())
}

/// whether a stage that skipped cosmetic files may still be published.
///
/// one file vanishing between load and here is the tolerable loss above, but
/// the very same `NotFound` is what a whole source directory disappearing
/// underneath the copy loop produces -- an `.osz` scene's extraction lease
/// dropped by a replay opened mid-export. the two have to be told apart,
/// because presence certifies this set complete forever: a set staged from a
/// directory that evaporated halfway would be the one every later render of
/// this diff got, cosmetics missing, with no retry anywhere. the beatmap's own
/// file still standing is what says the source is intact rather than gone.
///
/// this NARROWS that window rather than closing it -- the lease can still drop
/// after the check. closing it properly is an ownership question (a shareable
/// lease the job holds until staging returns) and is recorded in `TODO.md`
fn source_still_intact(record: &ExportSourceRecord, skipped_any: bool) -> bool {
    !skipped_any || record.osu_path.exists()
}

/// the startup pass beside the osz-cache orphan gc: unrenamed staging temps
/// are a crash's leftovers and always go; then the newest [`MAX_STAGED_SETS`]
/// complete sets stay and the rest go, oldest first by modified time.
/// failures are ignored on the same terms as the cache gc -- what cannot be
/// deleted now is collected on a later startup
pub fn sweep_staging(songs_root: &Path) {
    sweep_staging_capped(songs_root, MAX_STAGED_SETS);
}

/// the cap is a parameter so the boundary test can drive it small,
/// mirroring every other capped entry point in this crate
pub fn sweep_staging_capped(songs_root: &Path, cap: usize) {
    let Ok(entries) = std::fs::read_dir(songs_root) else {
        return;
    };
    let mut sets: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        if path
            .file_name()
            .is_some_and(|n| n.to_string_lossy().contains(STAGING_MARKER))
        {
            let _ = std::fs::remove_dir_all(&path);
            continue;
        }
        let modified = entry
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(std::time::UNIX_EPOCH);
        sets.push((modified, path));
    }
    if sets.len() <= cap {
        return;
    }
    // newest first; everything past the cap goes
    sets.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, path) in sets.into_iter().skip(cap) {
        let _ = std::fs::remove_dir_all(&path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record_in(dir: &Path) -> ExportSourceRecord {
        ExportSourceRecord {
            osu_path: dir.join("map.osu"),
            audio_path: Some(dir.join("audio.mp3")),
            background_path: Some(dir.join("sb").join("bg.jpg")),
            sample_files: vec![dir.join("soft-hitnormal.wav"), dir.join("soft-hitnormal.wav")],
            texture_files: vec![dir.join("hitcircle@2x.png")],
            md5: "0123456789abcdef0123456789abcdef".into(),
        }
    }

    fn write_record_files(dir: &Path) {
        std::fs::create_dir_all(dir.join("sb")).unwrap();
        for (name, bytes) in [
            ("map.osu", b"osu".as_slice()),
            ("audio.mp3", b"mp3".as_slice()),
            ("sb/bg.jpg", b"jpg".as_slice()),
            ("soft-hitnormal.wav", b"wav".as_slice()),
            ("hitcircle@2x.png", b"png".as_slice()),
        ] {
            std::fs::write(dir.join(name), bytes).unwrap();
        }
    }

    #[test]
    fn the_plan_covers_every_source_kind_preserving_subdirs_and_deduping() {
        let base = Path::new(r"D:\songs\1 fixture");
        let plan = plan_staging(&record_in(base));
        let copies: Vec<(String, String)> = plan
            .iter()
            .map(|c| (c.from.display().to_string(), c.to.display().to_string()))
            .collect();
        assert_eq!(
            copies,
            vec![
                (format!(r"{}\map.osu", base.display()), "map.osu".into()),
                (format!(r"{}\audio.mp3", base.display()), "audio.mp3".into()),
                // the subdir'd background keeps its relative path, or the
                // map's own reference to it would not resolve
                (format!(r"{}\sb\bg.jpg", base.display()), r"sb\bg.jpg".into()),
                // the duplicated sample entry planned once
                (
                    format!(r"{}\soft-hitnormal.wav", base.display()),
                    "soft-hitnormal.wav".into()
                ),
                (
                    format!(r"{}\hitcircle@2x.png", base.display()),
                    "hitcircle@2x.png".into()
                ),
            ]
        );
    }

    #[test]
    fn a_raw_osu_path_against_canonical_media_still_preserves_the_subdirs() {
        // the `.osz` shape, and the reason the planner canonicalizes: the
        // record's `.osu` path is the extractor's raw join against the lease
        // dir while the media paths came back canonicalized, so comparing them
        // lexically fails and every file drops to its bare name. the failure is
        // silent -- the set still stages, the render still runs, and only the
        // background is quietly missing from the video
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source");
        write_record_files(&source);

        let mut record = record_in(&source);
        // media as `resolve_media_path` hands it over: canonical
        record.background_path = Some(dunce::canonicalize(source.join("sb").join("bg.jpg")).unwrap());
        // the `.osu` in a raw, uncanonicalised form. in production the split is
        // an 8.3 short name or a junction in the lease path -- neither of which
        // a test can conjure portably -- so the mismatch is staged with a
        // round-trip through a sibling instead. it exercises the same thing
        // that matters: `Path::components` keeps `..` verbatim, so a base that
        // is not canonical cannot be compared lexically against one that is.
        // (a drive-letter case difference would NOT do: Rust compares windows
        // disk prefixes case-insensitively, so strip_prefix survives it)
        record.osu_path = source.join("sb").join("..").join("map.osu");

        let plan = plan_staging(&record);
        let background = plan
            .iter()
            .find(|copy| Some(&copy.from) == record.background_path.as_ref())
            .expect("the background is planned");
        assert_eq!(
            background.to,
            Path::new("sb").join("bg.jpg"),
            "the subdir the beatmap references must survive the form mismatch"
        );
    }

    #[test]
    fn a_file_outside_the_beatmap_dir_flattens_to_its_bare_name() {
        // not a shape any current source produces, but the planner's answer
        // must stay a path inside the set dir whatever the record holds
        let mut record = record_in(Path::new(r"D:\songs\1 fixture"));
        record.audio_path = Some(PathBuf::from(r"E:\elsewhere\audio.mp3"));
        let plan = plan_staging(&record);
        assert!(plan
            .iter()
            .any(|c| c.from == Path::new(r"E:\elsewhere\audio.mp3") && c.to == Path::new("audio.mp3")));
    }

    #[test]
    fn staging_lands_the_set_and_a_restage_is_a_no_op() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source");
        write_record_files(&source);
        let songs = dir.path().join("danser-songs");
        let record = record_in(&source);

        let set = ensure_staged(&songs, &record).unwrap();
        assert_eq!(set, songs.join("01234567"));
        assert_eq!(std::fs::read(set.join("map.osu")).unwrap(), b"osu");
        assert_eq!(std::fs::read(set.join("sb").join("bg.jpg")).unwrap(), b"jpg");
        let temps: Vec<_> = std::fs::read_dir(&songs)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains(STAGING_MARKER))
            .collect();
        assert!(temps.is_empty(), "no temp survives a successful stage: {temps:?}");

        // presence is the completeness marker: a canary inside the set
        // surviving a re-stage proves not one copy happened
        std::fs::write(set.join("canary"), b"untouched").unwrap();
        let again = ensure_staged(&songs, &record).unwrap();
        assert_eq!(again, set);
        assert_eq!(std::fs::read(set.join("canary")).unwrap(), b"untouched");
    }

    #[test]
    fn a_missing_required_file_fails_and_leaves_no_temp_or_set() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source");
        write_record_files(&source);
        std::fs::remove_file(source.join("audio.mp3")).unwrap();
        let songs = dir.path().join("danser-songs");

        assert!(ensure_staged(&songs, &record_in(&source)).is_err());
        assert!(
            !songs.join("01234567").exists(),
            "a failed stage must not leave a set presence would then trust"
        );
        let leftovers: Vec<_> = std::fs::read_dir(&songs)
            .map(|entries| entries.flatten().map(|e| e.path()).collect())
            .unwrap_or_default();
        assert!(leftovers.is_empty(), "{leftovers:?}");
    }

    #[test]
    fn a_record_with_no_audio_at_all_is_refused_rather_than_staged_incomplete() {
        // the gap the required-file rule cannot see: `None` names no copy, so
        // nothing was required and the set published -- then presence
        // certified it complete and every later re-render trusted it
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source");
        write_record_files(&source);
        let songs = dir.path().join("danser-songs");
        let mut record = record_in(&source);
        record.audio_path = None;

        assert!(ensure_staged(&songs, &record).is_err());
        assert!(
            !songs.join("01234567").exists(),
            "no set may exist for a record that cannot render"
        );
    }

    #[test]
    fn a_missing_cosmetic_file_is_skipped_rather_than_failing_the_stage() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source");
        write_record_files(&source);
        std::fs::remove_file(source.join("hitcircle@2x.png")).unwrap();
        let songs = dir.path().join("danser-songs");

        let set = ensure_staged(&songs, &record_in(&source)).unwrap();
        assert!(set.join("map.osu").is_file());
        assert!(!set.join("hitcircle@2x.png").exists());
    }

    #[test]
    fn a_cosmetic_copy_that_fails_for_any_other_reason_refuses_the_whole_set() {
        // the distinction the skip rule turns on: "vanished since load" is a
        // loss the render survives, but a copy that fails while the file is
        // still THERE (a sharing violation, a permission error, a full disk)
        // would publish a set missing an asset the beatmap still references --
        // and presence then certifies that set complete forever, so no later
        // render of this diff would ever retry it. a directory standing where
        // the texture should be is the portable way to make `fs::copy` fail
        // with something that is not NotFound
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source");
        write_record_files(&source);
        std::fs::remove_file(source.join("hitcircle@2x.png")).unwrap();
        std::fs::create_dir_all(source.join("hitcircle@2x.png")).unwrap();
        let songs = dir.path().join("danser-songs");

        let failed = ensure_staged(&songs, &record_in(&source)).unwrap_err();
        assert_ne!(
            failed.kind(),
            std::io::ErrorKind::NotFound,
            "the point is a failure that is not a vanished file: {failed:?}"
        );
        assert!(
            !songs.join("01234567").exists(),
            "a set missing an asset the map still has must never be published"
        );
        let leftovers: Vec<_> = std::fs::read_dir(&songs)
            .map(|entries| entries.flatten().map(|e| e.path()).collect())
            .unwrap_or_default();
        assert!(leftovers.is_empty(), "and no temp survives the refusal: {leftovers:?}");
    }

    #[test]
    fn skipped_cosmetics_are_only_tolerable_while_the_beatmap_itself_still_stands() {
        // one file vanishing between load and export is the tolerable loss;
        // the same NotFound arriving because the whole source directory went
        // away (an `.osz` lease dropped mid-export) is not, because the
        // degraded set it would publish is what presence then certifies
        // complete forever
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source");
        write_record_files(&source);
        let record = record_in(&source);

        // nothing skipped: the question does not arise
        assert!(source_still_intact(&record, false));
        // something skipped but the beatmap is still there: a real vanished file
        assert!(source_still_intact(&record, true));

        // the source went away underneath the copy loop
        std::fs::remove_dir_all(&source).unwrap();
        assert!(!source_still_intact(&record, true));
        // and with nothing skipped there is nothing to doubt
        assert!(source_still_intact(&record, false));
    }

    #[test]
    fn the_sweep_deletes_staging_temps_and_enforces_the_cap_oldest_first() {
        let dir = tempfile::tempdir().unwrap();
        let songs = dir.path().join("danser-songs");
        std::fs::create_dir_all(&songs).unwrap();

        // a crash's unrenamed temp
        let temp = songs.join("89abcdef.staging-999-0");
        std::fs::create_dir_all(&temp).unwrap();
        std::fs::write(temp.join("map.osu"), b"half").unwrap();

        // five complete sets with distinct mtimes, oldest first
        for i in 0..5u32 {
            let set = songs.join(format!("set{i:05x}"));
            std::fs::create_dir_all(&set).unwrap();
            let t = filetime::FileTime::from_unix_time(1_000_000 + i64::from(i) * 100, 0);
            filetime::set_file_mtime(&set, t).unwrap();
        }

        sweep_staging_capped(&songs, 3);
        assert!(!temp.exists(), "unrenamed temps always go");
        let mut kept: Vec<String> = std::fs::read_dir(&songs)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        kept.sort();
        assert_eq!(
            kept,
            vec!["set00002", "set00003", "set00004"],
            "newest three stay"
        );
    }

    #[test]
    fn the_sweep_under_the_cap_touches_nothing_and_tolerates_a_missing_root() {
        let dir = tempfile::tempdir().unwrap();
        let songs = dir.path().join("danser-songs");
        std::fs::create_dir_all(songs.join("01234567")).unwrap();
        sweep_staging(&songs);
        assert!(songs.join("01234567").is_dir());

        sweep_staging(Path::new(r"Z:\does\not\exist"));
    }
}
