//! the load pipelines (spec, tauri layer). every pipeline is a pure function
//! over paths and plain data so it tests without a running app; the command
//! layer only clones inputs, spawns, and installs the outcome

use std::path::{Path, PathBuf};

use engine::beatmap::{process_beatmap, ProcessedBeatmap};
use engine::formats::beatmap::{decode_beatmap_bytes, Beatmap};
use engine::formats::osr::{decode_osr, OsrFile};
use engine::mods::{pipeline_for, process_with_mods, LegacyMods};
use engine::render_plan::build_render_plan;
use engine::replay::document::ReplayDocument;
use engine::simulation::simulate;

use crate::cache::CacheLease;
use crate::error::{IpcError, Warning};
use crate::media::{read_file_capped, resolve_media_path};
use crate::osz::open_osz;
use crate::scene::{assemble_scene, LoadedScene, NotSimulatedReason, SimulationDto};
use crate::stable::{detect_install, find_beatmap_by_md5, ListingCache};

pub struct SessionState {
    /// the mutable replay document, retained for the future editor commands
    pub document: ReplayDocument,
    pub processed: ProcessedBeatmap,
    /// present only for .osz scenes; dropping it deletes the cache dir
    pub lease: Option<CacheLease>,
}

// the tests format `Result<LoadOutcome, IpcError>` in panic messages;
// CacheLease wraps a File and doesn't derive Debug, so this prints just the
// parts that matter for diagnosing a test failure, mirroring osz::OszArchive's
// and osz::ExtractedScene's Debug impls
impl std::fmt::Debug for SessionState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SessionState")
            .field("document", &self.document)
            .field("processed", &self.processed)
            .field("has_lease", &self.lease.is_some())
            .finish()
    }
}

#[derive(Debug)]
pub struct LoadOutcome {
    pub scene: LoadedScene,
    pub session: SessionState,
}

pub(crate) fn read_and_decode_osr(osr_path: &Path) -> Result<OsrFile, IpcError> {
    let bytes = read_file_capped(osr_path, engine::limits::MAX_OSR_FILE_BYTES, "MAX_OSR_FILE_BYTES")?;
    Ok(decode_osr(&bytes)?)
}

pub(crate) struct BeatmapSource {
    pub map: Beatmap,
    pub md5: String,
    /// where media filenames resolve from (songs folder or cache dir)
    pub dir: PathBuf,
    pub lease: Option<CacheLease>,
    /// true only on an explicit user override of a failed hash check
    pub mismatch: bool,
}

pub(crate) fn build_outcome(osr: OsrFile, source: BeatmapSource) -> Result<LoadOutcome, IpcError> {
    let document = ReplayDocument::new(osr, source.map.format_version);
    let header = document.header().clone();
    if document.frames().is_empty() {
        return Err(IpcError::ReplayParse { message: "replay contains no gameplay frames".into() });
    }

    let mods = LegacyMods { raw: header.mods };
    let mut warnings = Vec::new();
    if source.mismatch {
        warnings.push(Warning::BeatmapMismatch {
            expected_md5: header.beatmap_md5.clone().unwrap_or_default(),
            actual_md5: source.md5.clone(),
        });
    }
    if !mods.is_nomod() {
        warnings.push(Warning::ModsNotSimulated { mods: mods.raw });
    }

    // mismatch wins as the reason: the geometry may be wrong, so even a
    // nomod timeline would be fiction. unsupported mods still render with
    // nomod geometry -- the spec's persistent-banner path
    let (processed, simulation) = if source.mismatch {
        (process_beatmap(&source.map)?, SimulationDto::NotSimulated { reason: NotSimulatedReason::BeatmapMismatch })
    } else if let Some(pipeline) = pipeline_for(mods) {
        let processed = process_with_mods(&source.map, &*pipeline)?;
        let timeline = simulate(&processed, document.frames())?;
        let simulation = SimulationDto::authoritative(&timeline);
        (processed, simulation)
    } else {
        (process_beatmap(&source.map)?, SimulationDto::NotSimulated { reason: NotSimulatedReason::UnsupportedMods })
    };

    let render_plan = build_render_plan(&source.map, &processed);

    let audio_path = resolve_media_path(&source.dir, &source.map.audio_file);
    if audio_path.is_none() {
        warnings.push(Warning::AudioMissing);
    }
    let background_path = resolve_media_path(&source.dir, &source.map.background_file);

    let scene = assemble_scene(
        &source.map,
        &source.md5,
        &header,
        document.frames(),
        render_plan,
        simulation,
        audio_path,
        background_path,
        warnings,
    );
    Ok(LoadOutcome { scene, session: SessionState { document, processed, lease: source.lease } })
}

/// the manual fallback with a picked .osu: hash it against the replay
/// header; on mismatch the user may explicitly override (spec, tauri layer)
pub fn load_with_osu_file(
    osr_path: &Path,
    osu_path: &Path,
    allow_mismatch: bool,
) -> Result<LoadOutcome, IpcError> {
    let osr = read_and_decode_osr(osr_path)?;
    let expected = osr.header.beatmap_md5.clone().unwrap_or_default();
    let bytes = read_file_capped(osu_path, engine::limits::MAX_OSU_FILE_BYTES, "MAX_OSU_FILE_BYTES")?;
    let actual = format!("{:x}", md5::compute(&bytes));
    let mismatch = !actual.eq_ignore_ascii_case(&expected);
    if mismatch && !allow_mismatch {
        return Err(IpcError::BeatmapMismatch { expected_md5: expected, actual_md5: actual });
    }
    let map = decode_beatmap_bytes(&bytes)?;
    let dir = osu_path.parent().unwrap_or(Path::new(".")).to_path_buf();
    build_outcome(osr, BeatmapSource { map, md5: actual, dir, lease: None, mismatch })
}

/// the manual fallback: a picked .osu is hashed directly; a picked .osz is
/// searched for the member whose hash matches (spec, tauri layer)
pub fn load_with_beatmap(
    osr_path: &Path,
    beatmap_path: &Path,
    allow_mismatch: bool,
    cache_root: &Path,
) -> Result<LoadOutcome, IpcError> {
    let extension = beatmap_path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    match extension.as_str() {
        "osu" => load_with_osu_file(osr_path, beatmap_path, allow_mismatch),
        "osz" => load_with_osz(osr_path, beatmap_path, allow_mismatch, cache_root),
        other => Err(IpcError::BeatmapParse {
            message: format!("unsupported beatmap file extension {other:?} (expected .osu or .osz)"),
        }),
    }
}

fn load_with_osz(
    osr_path: &Path,
    osz_path: &Path,
    allow_mismatch: bool,
    cache_root: &Path,
) -> Result<LoadOutcome, IpcError> {
    let osr = read_and_decode_osr(osr_path)?;
    let expected = osr.header.beatmap_md5.clone().unwrap_or_default();

    let mut archive = open_osz(osz_path)?;
    let (matched, mismatch) = match archive.find_osu_by_md5(&expected)? {
        Some(m) => (m, false),
        None => {
            // override target: the first .osu by entry name, deterministic
            let Some(first) = archive.first_osu()? else {
                return Err(IpcError::BeatmapParse {
                    message: "archive contains no .osu member".into(),
                });
            };
            if !allow_mismatch {
                return Err(IpcError::BeatmapMismatch {
                    expected_md5: expected,
                    actual_md5: first.md5,
                });
            }
            (first, true)
        }
    };

    let map = decode_beatmap_bytes(&matched.bytes)?;
    let media_owned: Vec<String> = [map.audio_file.clone(), map.background_file.clone()]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect();
    let media: Vec<&str> = media_owned.iter().map(String::as_str).collect();
    // md5 is 32 hex chars; the first 8 keep cache dir names readable
    let label = matched.md5[..8].to_string();
    let extracted =
        archive.extract_scene(matched.index, &matched.bytes, &media, cache_root, &label)?;

    build_outcome(
        osr,
        BeatmapSource {
            map,
            md5: matched.md5,
            dir: extracted.beatmap_dir,
            lease: Some(extracted.lease),
            mismatch,
        },
    )
}

/// the primary flow: parse header -> md5 -> osu!.db lookup -> scene (spec,
/// tauri layer). the caller supplies the settings override and the standard
/// candidates so tests can inject a fake install
pub fn load_replay_auto(
    osr_path: &Path,
    override_path: Option<&Path>,
    candidates: &[PathBuf],
    listing_cache: &ListingCache,
) -> Result<LoadOutcome, IpcError> {
    let osr = read_and_decode_osr(osr_path)?;
    let md5 = match osr.header.beatmap_md5.as_deref() {
        Some(m) if !m.is_empty() => m.to_lowercase(),
        _ => {
            return Err(IpcError::ReplayParse {
                message: "replay header carries no beatmap hash".into(),
            })
        }
    };
    let install = detect_install(override_path, candidates)?;
    let (osu_path, bytes) = find_beatmap_by_md5(&install, listing_cache, &md5)?;
    let map = decode_beatmap_bytes(&bytes)?;
    let dir = osu_path.parent().unwrap_or(Path::new(".")).to_path_buf();
    build_outcome(osr, BeatmapSource { map, md5, dir, lease: None, mismatch: false })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::{IpcError, Warning};
    use crate::scene::{NotSimulatedReason, SimulationDto};
    use crate::testutil::{fixtures_dir, osr_bytes};

    /// copies the committed fixture map next to a fresh temp .osr and returns
    /// (dir, osr_path, osu_path, map_md5)
    fn fixture_setup(mods: u32) -> (tempfile::TempDir, std::path::PathBuf, std::path::PathBuf, String) {
        let dir = tempfile::tempdir().unwrap();
        let osu_bytes = std::fs::read(fixtures_dir().join("beatmaps").join("stacking-v14.osu")).unwrap();
        let md5 = format!("{:x}", md5::compute(&osu_bytes));
        let osu_path = dir.path().join("map.osu");
        std::fs::write(&osu_path, &osu_bytes).unwrap();
        let osr_path = dir.path().join("replay.osr");
        std::fs::write(&osr_path, osr_bytes(&md5, mods, None)).unwrap();
        (dir, osr_path, osu_path, md5)
    }

    #[test]
    fn a_matching_osu_loads_an_authoritative_scene() {
        let (_dir, osr_path, osu_path, md5) = fixture_setup(0);
        let outcome = load_with_osu_file(&osr_path, &osu_path, false).unwrap();

        assert_eq!(outcome.scene.beatmap.md5, md5);
        assert_eq!(outcome.scene.beatmap.title, "Stacking Fixture");
        assert_eq!(outcome.scene.frames.len(), 3);
        assert!(matches!(outcome.scene.simulation, SimulationDto::Authoritative { .. }));
        // the fixture map references audio.mp3, which does not exist next to
        // the copied .osu
        assert_eq!(outcome.scene.warnings, vec![Warning::AudioMissing]);
        assert_eq!(outcome.scene.audio_path, None);
        assert_eq!(outcome.scene.background_path, None, "fixture declares no background");
        assert!(!outcome.scene.render_plan.objects.is_empty());
        assert!(outcome.session.lease.is_none(), "a picked .osu has no cache lease");
        assert_eq!(outcome.session.document.frames().len(), 3);
    }

    #[test]
    fn present_audio_resolves_and_clears_the_warning() {
        let (dir, osr_path, osu_path, _md5) = fixture_setup(0);
        // the fixture's [General] says AudioFilename: audio.mp3
        std::fs::write(dir.path().join("audio.mp3"), b"mp3").unwrap();
        let outcome = load_with_osu_file(&osr_path, &osu_path, false).unwrap();
        assert!(outcome.scene.warnings.is_empty());
        assert!(outcome.scene.audio_path.is_some());
    }

    #[test]
    fn a_mismatched_osu_without_override_is_a_typed_error() {
        let (dir, osr_path, _osu_path, _md5) = fixture_setup(0);
        let other = dir.path().join("other.osu");
        std::fs::write(&other, b"osu file format v14\n\n[General]\nMode: 0\n").unwrap();
        let other_md5 = format!("{:x}", md5::compute(&std::fs::read(&other).unwrap()));

        match load_with_osu_file(&osr_path, &other, false) {
            Err(IpcError::BeatmapMismatch { expected_md5, actual_md5 }) => {
                assert_eq!(actual_md5, other_md5);
                assert_ne!(expected_md5, actual_md5);
            }
            other => panic!("expected BeatmapMismatch, got {other:?}"),
        }
    }

    #[test]
    fn an_explicit_override_loads_unsimulated_with_the_warning() {
        // override onto a *valid but different* map: reuse a second committed
        // fixture so decode succeeds while the hash differs
        let (_dir, osr_path, _osu_path, expected) = fixture_setup(0);
        let other_bytes =
            std::fs::read(fixtures_dir().join("beatmaps").join("slider-zoo-v14.osu")).unwrap();
        let dir2 = tempfile::tempdir().unwrap();
        let other = dir2.path().join("other.osu");
        std::fs::write(&other, &other_bytes).unwrap();
        let other_md5 = format!("{:x}", md5::compute(&other_bytes));

        let outcome = load_with_osu_file(&osr_path, &other, true).unwrap();
        assert!(matches!(
            &outcome.scene.simulation,
            SimulationDto::NotSimulated { reason: NotSimulatedReason::BeatmapMismatch }
        ));
        assert_eq!(
            outcome.scene.warnings[0],
            Warning::BeatmapMismatch { expected_md5: expected, actual_md5: other_md5 }
        );
        // mismatch first, then audio -- the deterministic warning order
        assert_eq!(outcome.scene.warnings[1], Warning::AudioMissing);
    }

    #[test]
    fn modded_replays_load_with_nomod_geometry_and_no_timeline() {
        let (_dir, osr_path, osu_path, _md5) = fixture_setup(8); // hidden
        let outcome = load_with_osu_file(&osr_path, &osu_path, false).unwrap();
        assert!(matches!(
            &outcome.scene.simulation,
            SimulationDto::NotSimulated { reason: NotSimulatedReason::UnsupportedMods }
        ));
        assert_eq!(outcome.scene.warnings[0], Warning::ModsNotSimulated { mods: 8 });
        assert_eq!(outcome.scene.replay.mods, 8);
        assert!(!outcome.scene.render_plan.objects.is_empty(), "geometry still renders");
    }

    #[test]
    fn an_empty_replay_is_a_replay_parse_error() {
        let (dir, _osr, osu_path, md5) = fixture_setup(0);
        let empty = dir.path().join("empty.osr");
        std::fs::write(&empty, crate::testutil::osr_bytes(&md5, 0, Some(Vec::new()))).unwrap();
        match load_with_osu_file(&empty, &osu_path, false) {
            Err(IpcError::ReplayParse { message }) => assert!(message.contains("no gameplay frames")),
            other => panic!("expected ReplayParse, got {other:?}"),
        }
    }

    #[test]
    fn non_osu_beatmaps_surface_the_engine_mode_rejection() {
        // engine decode rejects non-osu modes (formats/beatmap.rs:461-463);
        // the pipeline must surface it as the typed UnsupportedMode. hash the
        // taiko file and put its real md5 in the replay so the mode check is
        // what fires, not the mismatch check
        let (dir, _osr, _osu, _md5) = fixture_setup(0);
        let taiko = dir.path().join("taiko.osu");
        std::fs::write(&taiko, b"osu file format v14\n\n[General]\nMode: 1\n").unwrap();
        let taiko_md5 = format!("{:x}", md5::compute(&std::fs::read(&taiko).unwrap()));
        let osr = dir.path().join("taiko.osr");
        std::fs::write(&osr, crate::testutil::osr_bytes(&taiko_md5, 0, None)).unwrap();

        match load_with_osu_file(&osr, &taiko, false) {
            Err(IpcError::UnsupportedMode { mode }) => assert_eq!(mode, "Taiko"),
            other => panic!("expected UnsupportedMode, got {other:?}"),
        }
    }

    fn fixture_osz(entries_extra: &[(&str, &[u8])]) -> (tempfile::TempDir, std::path::PathBuf, String) {
        let dir = tempfile::tempdir().unwrap();
        let osu_bytes = std::fs::read(fixtures_dir().join("beatmaps").join("stacking-v14.osu")).unwrap();
        let md5 = format!("{:x}", md5::compute(&osu_bytes));
        let mut entries: Vec<(&str, &[u8])> = vec![("map.osu", osu_bytes.as_slice())];
        entries.extend_from_slice(entries_extra);
        let osz_path = dir.path().join("set.osz");
        crate::testutil::write_osz(&osz_path, &entries);
        (dir, osz_path, md5)
    }

    #[test]
    fn a_matching_osz_member_loads_with_a_leased_cache_dir() {
        let (dir, osz_path, md5) = fixture_osz(&[("audio.mp3", b"mp3".as_slice())]);
        let osr_path = dir.path().join("replay.osr");
        std::fs::write(&osr_path, osr_bytes(&md5, 0, None)).unwrap();
        let cache_root = dir.path().join("cache");

        let outcome = load_with_beatmap(&osr_path, &osz_path, false, &cache_root).unwrap();
        assert!(matches!(outcome.scene.simulation, SimulationDto::Authoritative { .. }));
        // the fixture references audio.mp3, present in the archive
        assert!(outcome.scene.warnings.is_empty());
        let audio = outcome.scene.audio_path.clone().unwrap();
        let lease_dir = outcome.session.lease.as_ref().unwrap().dir().to_path_buf();
        // canonicalize both sides: the scene path went through dunce while
        // the lease path is the raw temp join, and windows short/long name
        // or case differences would fail a naive starts_with
        assert!(std::path::Path::new(&audio)
            .starts_with(dunce::canonicalize(&lease_dir).unwrap()));

        drop(outcome);
        assert!(!lease_dir.exists(), "dropping the session deletes the cache dir");
    }

    #[test]
    fn a_non_matching_osz_without_override_reports_the_first_members_hash() {
        let (dir, osz_path, _md5) = fixture_osz(&[]);
        let osr_path = dir.path().join("replay.osr");
        // a replay for a map the archive does not contain
        std::fs::write(&osr_path, osr_bytes("00000000000000000000000000000000", 0, None)).unwrap();
        let cache_root = dir.path().join("cache");

        match load_with_beatmap(&osr_path, &osz_path, false, &cache_root) {
            Err(IpcError::BeatmapMismatch { expected_md5, actual_md5 }) => {
                assert_eq!(expected_md5, "00000000000000000000000000000000");
                assert!(!actual_md5.is_empty());
            }
            other => panic!("expected BeatmapMismatch, got {other:?}"),
        }
        // nothing may be left behind by the refused load
        assert!(
            !cache_root.exists() || std::fs::read_dir(&cache_root).unwrap().count() == 0,
            "refused loads must not leak cache dirs"
        );
    }

    #[test]
    fn a_non_matching_osz_with_override_uses_the_first_osu_by_name() {
        let (dir, osz_path, md5) = fixture_osz(&[]);
        let osr_path = dir.path().join("replay.osr");
        std::fs::write(&osr_path, osr_bytes("00000000000000000000000000000000", 0, None)).unwrap();
        let cache_root = dir.path().join("cache");

        let outcome = load_with_beatmap(&osr_path, &osz_path, true, &cache_root).unwrap();
        assert_eq!(outcome.scene.beatmap.md5, md5, "the sole member is the override target");
        assert!(matches!(
            &outcome.scene.simulation,
            SimulationDto::NotSimulated { reason: NotSimulatedReason::BeatmapMismatch }
        ));
        assert!(matches!(outcome.scene.warnings[0], Warning::BeatmapMismatch { .. }));
    }

    #[test]
    fn an_archive_without_osu_members_is_a_beatmap_parse_error() {
        let dir = tempfile::tempdir().unwrap();
        let osz_path = dir.path().join("empty.osz");
        crate::testutil::write_osz(&osz_path, &[("readme.txt", b"nope".as_slice())]);
        let osr_path = dir.path().join("replay.osr");
        std::fs::write(&osr_path, osr_bytes("00000000000000000000000000000000", 0, None)).unwrap();

        match load_with_beatmap(&osr_path, &osz_path, true, &dir.path().join("cache")) {
            Err(IpcError::BeatmapParse { message }) => assert!(message.contains("no .osu")),
            other => panic!("expected BeatmapParse, got {other:?}"),
        }
    }

    #[test]
    fn unknown_beatmap_extensions_are_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let weird = dir.path().join("map.txt");
        std::fs::write(&weird, b"?").unwrap();
        let osr_path = dir.path().join("replay.osr");
        std::fs::write(&osr_path, osr_bytes("00000000000000000000000000000000", 0, None)).unwrap();

        match load_with_beatmap(&osr_path, &weird, false, &dir.path().join("cache")) {
            Err(IpcError::BeatmapParse { message }) => assert!(message.contains("extension")),
            other => panic!("expected BeatmapParse, got {other:?}"),
        }
    }

    #[test]
    fn auto_lookup_loads_through_a_fake_stable_install() {
        let root = tempfile::tempdir().unwrap();
        let osu_bytes = std::fs::read(fixtures_dir().join("beatmaps").join("stacking-v14.osu")).unwrap();
        let md5 = crate::testutil::fake_install(root.path(), "1 fixture", "map.osu", &osu_bytes);
        let osr_path = root.path().join("replay.osr");
        std::fs::write(&osr_path, osr_bytes(&md5, 0, None)).unwrap();

        let cache = crate::stable::ListingCache::default();
        let outcome = load_replay_auto(&osr_path, Some(root.path()), &[], &cache).unwrap();
        assert_eq!(outcome.scene.beatmap.md5, md5);
        assert!(matches!(outcome.scene.simulation, SimulationDto::Authoritative { .. }));
        assert!(outcome.session.lease.is_none());
    }

    #[test]
    fn a_missing_install_is_osu_db_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let osr_path = dir.path().join("replay.osr");
        std::fs::write(&osr_path, osr_bytes("00000000000000000000000000000000", 0, None)).unwrap();
        let empty = tempfile::tempdir().unwrap();

        let cache = crate::stable::ListingCache::default();
        match load_replay_auto(&osr_path, None, &[empty.path().to_path_buf()], &cache) {
            Err(IpcError::OsuDbNotFound { searched }) => assert_eq!(searched.len(), 1),
            other => panic!("expected OsuDbNotFound, got {other:?}"),
        }
    }

    #[test]
    fn an_unknown_hash_is_beatmap_not_found() {
        let root = tempfile::tempdir().unwrap();
        crate::testutil::fake_install(root.path(), "1 fixture", "map.osu", b"some other map");
        let osr_path = root.path().join("replay.osr");
        std::fs::write(&osr_path, osr_bytes("11111111111111111111111111111111", 0, None)).unwrap();

        let cache = crate::stable::ListingCache::default();
        match load_replay_auto(&osr_path, Some(root.path()), &[], &cache) {
            Err(IpcError::BeatmapNotFound { md5 }) => {
                assert_eq!(md5, "11111111111111111111111111111111");
            }
            other => panic!("expected BeatmapNotFound, got {other:?}"),
        }
    }

    #[test]
    fn a_headerless_beatmap_hash_is_replay_parse() {
        let root = tempfile::tempdir().unwrap();
        let osr_path = root.path().join("replay.osr");
        std::fs::write(&osr_path, osr_bytes("", 0, None)).unwrap();
        let cache = crate::stable::ListingCache::default();
        match load_replay_auto(&osr_path, Some(root.path()), &[], &cache) {
            Err(IpcError::ReplayParse { message }) => assert!(message.contains("beatmap hash")),
            other => panic!("expected ReplayParse, got {other:?}"),
        }
    }
}
