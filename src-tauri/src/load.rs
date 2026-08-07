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
use crate::limits::MAX_RECENT_DIR_OSU_FILES;
use crate::media::{read_file_capped, resolve_media_path};
use crate::osz::{open_osz, MatchedOsu, OszArchive};
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
    pub origin: BeatmapOrigin,
}

/// where a scene's beatmap came from, in terms that outlive the session, so a
/// recents entry can reopen straight into it. `dir` is the folder `path`
/// itself sits in -- deliberately not `BeatmapSource::dir`, which for an
/// `.osz` is the extraction lease that is deleted as soon as this scene is
/// replaced (`cache::CacheLease`)
#[derive(Debug)]
pub struct BeatmapOrigin {
    pub path: PathBuf,
    pub dir: PathBuf,
    pub md5: String,
    /// true only on an explicit user override of a failed hash check
    pub mismatch: bool,
}

/// the beatmap association a recents entry carries. every part is optional:
/// entries written before the association existed have none, and the settings
/// file is user-editable. an absent or stale part is a lookup miss that falls
/// through to the next resolution step, never an error
#[derive(Debug, Clone, Default)]
pub struct SavedBeatmap {
    pub path: Option<PathBuf>,
    pub dir: Option<PathBuf>,
    pub md5: Option<String>,
    /// the consent recorded when this entry last loaded against a beatmap
    /// that is not the one the replay was played on
    pub allow_mismatch: bool,
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
    /// the file this load names as the beatmap: the picked or resolved `.osu`,
    /// or the `.osz` itself. `BeatmapOrigin` is built from it, so it must be a
    /// path that still exists once the cache lease is gone
    pub origin_path: PathBuf,
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
    Ok(LoadOutcome {
        scene,
        session: SessionState { document, processed, lease: source.lease },
        origin: BeatmapOrigin {
            dir: source.origin_path.parent().unwrap_or(Path::new(".")).to_path_buf(),
            path: source.origin_path,
            md5: source.md5,
            mismatch: source.mismatch,
        },
    })
}

/// a picked or resolved `.osu`, whose own folder is both where its media
/// resolves from and what a recents entry remembers
fn osu_file_source(
    osu_path: &Path,
    bytes: &[u8],
    md5: String,
    mismatch: bool,
) -> Result<BeatmapSource, IpcError> {
    let map = decode_beatmap_bytes(bytes)?;
    Ok(BeatmapSource {
        map,
        md5,
        dir: osu_path.parent().unwrap_or(Path::new(".")).to_path_buf(),
        lease: None,
        mismatch,
        origin_path: osu_path.to_path_buf(),
    })
}

/// extracts the matched member plus the media its map references into a fresh
/// cache lease. media resolves from that lease, but the origin stays the
/// archive: the lease directory is deleted when the session is replaced
fn osz_source(
    archive: &mut OszArchive,
    osz_path: &Path,
    matched: MatchedOsu,
    mismatch: bool,
    cache_root: &Path,
) -> Result<BeatmapSource, IpcError> {
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

    Ok(BeatmapSource {
        map,
        md5: matched.md5,
        dir: extracted.beatmap_dir,
        lease: Some(extracted.lease),
        mismatch,
        origin_path: osz_path.to_path_buf(),
    })
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
    build_outcome(osr, osu_file_source(osu_path, &bytes, actual, mismatch)?)
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

    build_outcome(osr, osz_source(&mut archive, osz_path, matched, mismatch, cache_root)?)
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
    build_outcome(osr, stable_source(&md5, override_path, candidates, listing_cache)?)
}

/// the osu!.db lookup on its own: parse the listing, verify the file on disk
/// still hashes to `md5`, decode it
fn stable_source(
    md5: &str,
    override_path: Option<&Path>,
    candidates: &[PathBuf],
    listing_cache: &ListingCache,
) -> Result<BeatmapSource, IpcError> {
    let install = detect_install(override_path, candidates)?;
    let (osu_path, bytes) = find_beatmap_by_md5(&install, listing_cache, md5)?;
    osu_file_source(&osu_path, &bytes, md5.to_string(), false)
}

/// a hash a reopen is allowed to load, and whether loading it counts as an
/// override. hashes are what the reopen matches on, never paths: a file that
/// moved is still the same beatmap, and a file edited in place is not
struct AcceptedMd5 {
    md5: String,
    mismatch: bool,
}

/// best first: the remembered hash reproduces the exact scene the entry was
/// written from, and the replay's own hash is the plain match every other
/// load path looks for. an override's remembered hash is admitted only with
/// the consent that was recorded alongside it, which is what keeps a reopen
/// from silently overriding on the user's behalf
fn accepted_hashes(saved: &SavedBeatmap, header_md5: &str) -> Vec<AcceptedMd5> {
    let mut accepted: Vec<AcceptedMd5> = Vec::new();
    if let Some(md5) = saved.md5.as_deref().filter(|m| !m.is_empty()) {
        let md5 = md5.to_lowercase();
        let mismatch = md5 != header_md5;
        if !mismatch || saved.allow_mismatch {
            accepted.push(AcceptedMd5 { md5, mismatch });
        }
    }
    if !header_md5.is_empty() && !accepted.iter().any(|a| a.md5 == header_md5) {
        accepted.push(AcceptedMd5 { md5: header_md5.to_string(), mismatch: false });
    }
    accepted
}

/// a step's failure, classified. a resource cap is the typed refusal the user
/// has to see -- reporting it as "beatmap not found" would name the wrong
/// problem, and it is the same carve-out `stable::find_beatmap_by_md5` makes.
/// anything else (gone, unreadable, a corrupt archive) is the stale
/// association it looks like, so it falls through to the next step
fn miss_unless_capped<T>(result: Result<T, IpcError>) -> Result<Option<T>, IpcError> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(e @ IpcError::ResourceLimit { .. }) => Err(e),
        Err(_) => Ok(None),
    }
}

/// the remembered source, accepted only while it still holds one of the
/// hashes this reopen may load. gone or changed since is a miss (`Ok(None)`)
/// that falls through to the next step -- the association is a shortcut, not
/// a load path of its own. once a hash *has* matched the content is the
/// beatmap, so a failure past that point is a real error
fn open_saved_source(
    path: &Path,
    accepted: &[AcceptedMd5],
    cache_root: &Path,
) -> Result<Option<BeatmapSource>, IpcError> {
    let extension = path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase());
    match extension.as_deref() {
        Some("osu") => {
            let read = read_file_capped(path, engine::limits::MAX_OSU_FILE_BYTES, "MAX_OSU_FILE_BYTES");
            let Some(bytes) = miss_unless_capped(read)? else { return Ok(None) };
            let md5 = format!("{:x}", md5::compute(&bytes));
            let Some(accept) = accepted.iter().find(|a| a.md5 == md5) else { return Ok(None) };
            Ok(Some(osu_file_source(path, &bytes, md5, accept.mismatch)?))
        }
        Some("osz") => {
            let Some(mut archive) = miss_unless_capped(open_osz(path))? else { return Ok(None) };
            // one ranked scan for the whole accepted set, never one call per
            // hash: find_osu_by_any_md5 builds a fresh MAX_OSZ_SCAN_BYTES
            // budget per call, so a hash-per-call loop would let a single
            // reopen of a single archive decompress the cap twice over -- and
            // would swallow the very refusal that fired
            let hashes: Vec<&str> = accepted.iter().map(|a| a.md5.as_str()).collect();
            let found = miss_unless_capped(archive.find_osu_by_any_md5(&hashes))?.flatten();
            let Some((rank, matched)) = found else { return Ok(None) };
            let source = osz_source(&mut archive, path, matched, accepted[rank].mismatch, cache_root)?;
            Ok(Some(source))
        }
        _ => Ok(None),
    }
}

struct ScanHit {
    /// index into the accepted hashes, so a better-ranked file later in the
    /// listing still wins
    rank: usize,
    path: PathBuf,
    bytes: Vec<u8>,
    md5: String,
}

/// non-recursive scan of the folder the association remembers, for the map
/// that is still there under a different file name (a re-download renames the
/// difficulty). `max_files` caps the .osu files hashed
/// (`limits::MAX_RECENT_DIR_OSU_FILES`); exhausting it gives up in favour of
/// the stable lookup rather than failing the load
fn scan_dir_for_beatmap(
    dir: &Path,
    accepted: &[AcceptedMd5],
    max_files: usize,
) -> Result<Option<BeatmapSource>, IpcError> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Ok(None) };
    let mut best: Option<ScanHit> = None;
    let mut examined = 0usize;
    for entry in entries.flatten() {
        if examined >= max_files {
            break;
        }
        let path = entry.path();
        if !path.extension().is_some_and(|e| e.eq_ignore_ascii_case("osu")) {
            continue;
        }
        examined += 1;
        // a folder entry is a candidate, not a named source, so an oversized
        // or unreadable one is skipped rather than propagated the way
        // open_saved_source treats the file the entry actually points at.
        // this mirrors osz's per-candidate skip (limits.rs): a .osu past the
        // cap could never decode, so it cannot be the map being looked for
        let Ok(bytes) =
            read_file_capped(&path, engine::limits::MAX_OSU_FILE_BYTES, "MAX_OSU_FILE_BYTES")
        else {
            continue;
        };
        let md5 = format!("{:x}", md5::compute(&bytes));
        let Some(rank) = accepted.iter().position(|a| a.md5 == md5) else { continue };
        if rank == 0 {
            return Ok(Some(osu_file_source(&path, &bytes, md5, accepted[0].mismatch)?));
        }
        let hit = ScanHit { rank, path, bytes, md5 };
        if best.as_ref().is_none_or(|b| hit.rank < b.rank) {
            best = Some(hit);
        }
    }
    match best {
        Some(hit) => Ok(Some(osu_file_source(
            &hit.path,
            &hit.bytes,
            hit.md5,
            accepted[hit.rank].mismatch,
        )?)),
        None => Ok(None),
    }
}

/// reopening from the recents list: the remembered association is tried
/// first, so a manually paired beatmap survives a restart and an installed
/// one costs no osu!.db parse. the walk is the exact saved source, then the
/// saved folder, then the normal stable lookup, and every miss falls through
/// silently -- only the replay itself being unreadable, or a beatmap that
/// matched by hash and then failed to load, stops it early
pub fn load_recent_replay(
    osr_path: &Path,
    saved: &SavedBeatmap,
    override_path: Option<&Path>,
    candidates: &[PathBuf],
    listing_cache: &ListingCache,
    cache_root: &Path,
) -> Result<LoadOutcome, IpcError> {
    // the replay being gone is not a stale association: it stays the io error
    // every other load path reports for it
    let osr = read_and_decode_osr(osr_path)?;
    let header_md5 = osr.header.beatmap_md5.clone().unwrap_or_default().to_lowercase();
    let accepted = accepted_hashes(saved, &header_md5);
    let tried_association = saved.path.is_some() || saved.dir.is_some();

    if let Some(path) = saved.path.as_deref() {
        if let Some(source) = open_saved_source(path, &accepted, cache_root)? {
            return build_outcome(osr, source);
        }
    }
    if let Some(dir) = saved.dir.as_deref() {
        if let Some(source) = scan_dir_for_beatmap(dir, &accepted, MAX_RECENT_DIR_OSU_FILES)? {
            return build_outcome(osr, source);
        }
    }
    if header_md5.is_empty() {
        // nothing left to look the beatmap up by; same diagnosis
        // load_replay_auto gives such a replay
        return Err(IpcError::ReplayParse {
            message: "replay header carries no beatmap hash".into(),
        });
    }
    match stable_source(&header_md5, override_path, candidates, listing_cache) {
        Ok(source) => build_outcome(osr, source),
        // an association was tried and could not answer, so the walk ends on
        // beatmapNotFound (the frontend's beatmap picker) rather than on
        // "osu! stable install not found": naming an install this reopen was
        // never going to need points the user at the wrong setting when what
        // actually went stale is the beatmap they paired by hand.
        //
        // with no association there was nothing but the install, so its own
        // diagnosis -- the one that lists where it looked and says to set the
        // path in settings -- is both honest and the more actionable of the
        // two, and both kinds reach the same picker anyway (state/errors.ts).
        // anything else (a resource cap, an unparseable osu!.db) keeps its
        // own diagnosis regardless
        Err(IpcError::OsuDbNotFound { .. }) if tried_association => {
            Err(IpcError::BeatmapNotFound { md5: header_md5 })
        }
        Err(other) => Err(other),
    }
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

    /// a reopen with no osu! stable install reachable at all, so only the
    /// saved association can answer it
    fn reopen(
        osr_path: &std::path::Path,
        saved: &SavedBeatmap,
        cache_root: &std::path::Path,
    ) -> Result<LoadOutcome, IpcError> {
        load_recent_replay(osr_path, saved, None, &[], &ListingCache::default(), cache_root)
    }

    /// writes the slider-zoo fixture (a valid map that is not the one
    /// `fixture_setup`'s replay was played on) and returns (path, md5)
    fn override_map(dir: &std::path::Path) -> (std::path::PathBuf, String) {
        let bytes = std::fs::read(fixtures_dir().join("beatmaps").join("slider-zoo-v14.osu")).unwrap();
        let path = dir.join("override.osu");
        std::fs::write(&path, &bytes).unwrap();
        (path, format!("{:x}", md5::compute(&bytes)))
    }

    #[test]
    fn reopening_from_the_saved_osu_skips_the_stable_lookup() {
        let (dir, osr_path, osu_path, md5) = fixture_setup(0);
        let saved = SavedBeatmap {
            path: Some(osu_path.clone()),
            dir: Some(dir.path().to_path_buf()),
            md5: Some(md5.clone()),
            ..SavedBeatmap::default()
        };

        let outcome = reopen(&osr_path, &saved, &dir.path().join("cache")).unwrap();
        assert_eq!(outcome.scene.beatmap.md5, md5);
        assert!(matches!(outcome.scene.simulation, SimulationDto::Authoritative { .. }));
        assert_eq!(outcome.origin.path, osu_path);
        assert_eq!(outcome.origin.dir, dir.path());
        assert!(!outcome.origin.mismatch);
    }

    #[test]
    fn reopening_from_the_saved_osz_remembers_the_archive_not_its_cache_lease() {
        let (dir, osz_path, md5) = fixture_osz(&[("audio.mp3", b"mp3".as_slice())]);
        let osr_path = dir.path().join("replay.osr");
        std::fs::write(&osr_path, osr_bytes(&md5, 0, None)).unwrap();
        let saved = SavedBeatmap {
            path: Some(osz_path.clone()),
            dir: Some(dir.path().to_path_buf()),
            md5: Some(md5.clone()),
            ..SavedBeatmap::default()
        };

        let outcome = reopen(&osr_path, &saved, &dir.path().join("cache")).unwrap();
        assert_eq!(outcome.scene.beatmap.md5, md5);
        let lease_dir = outcome.session.lease.as_ref().unwrap().dir().to_path_buf();
        assert_eq!(outcome.origin.path, osz_path);
        assert_eq!(outcome.origin.dir, dir.path());
        assert_ne!(outcome.origin.dir, lease_dir, "the lease dir must never be the remembered folder");

        // which is the whole point: the lease dies with the session, so an
        // entry that remembered it would resolve to nothing next time
        drop(outcome);
        assert!(!lease_dir.exists());
        assert!(osz_path.is_file(), "what the entry remembers outlives the lease");
    }

    #[test]
    fn the_saved_source_is_also_accepted_on_the_replays_own_hash() {
        // the one deviation from "step 1 validates against the stored md5":
        // the entry remembers a consented override, and the archive still at
        // that path has since been replaced by the map the replay was
        // actually played on. no folder scan can look inside an archive, so
        // without this the user would be sent to the picker for a beatmap
        // sitting right where the entry says it is. consent does not travel
        // here -- the hash that answered is the replay's own, so the scene
        // loads as the plain match it is
        let (dir, osz_path, md5) = fixture_osz(&[]);
        let osr_path = dir.path().join("replay.osr");
        std::fs::write(&osr_path, osr_bytes(&md5, 0, None)).unwrap();
        let saved = SavedBeatmap {
            path: Some(osz_path.clone()),
            dir: Some(dir.path().to_path_buf()),
            // the overridden map that used to be in the archive
            md5: Some("0".repeat(32)),
            allow_mismatch: true,
        };

        // nothing else could answer: the folder holds no loose .osu and no
        // install is reachable
        let outcome = reopen(&osr_path, &saved, &dir.path().join("cache")).unwrap();
        assert_eq!(outcome.scene.beatmap.md5, md5);
        assert_eq!(outcome.origin.path, osz_path);
        assert!(!outcome.origin.mismatch, "the replay's own map is a match, not an override");
        assert!(matches!(outcome.scene.simulation, SimulationDto::Authoritative { .. }));
    }

    #[test]
    fn a_renamed_beatmap_is_found_by_scanning_the_saved_folder() {
        let (dir, osr_path, osu_path, md5) = fixture_setup(0);
        // a re-download renames the difficulty file but leaves it in place
        let renamed = dir.path().join("Fixture - Stacking (tester) [Insane].osu");
        std::fs::rename(&osu_path, &renamed).unwrap();
        let saved = SavedBeatmap {
            path: Some(osu_path),
            dir: Some(dir.path().to_path_buf()),
            md5: Some(md5.clone()),
            ..SavedBeatmap::default()
        };

        let outcome = reopen(&osr_path, &saved, &dir.path().join("cache")).unwrap();
        assert_eq!(outcome.scene.beatmap.md5, md5);
        assert_eq!(outcome.origin.path, renamed, "the reopen resolves the file it actually found");
    }

    #[test]
    fn the_folder_scan_prefers_the_remembered_hash_and_falls_back_to_the_replays_own() {
        // both maps sit in the saved folder: the one the entry remembers
        // (consented to as an override) and the one the replay was played on
        let (dir, osr_path, osu_path, header_md5) = fixture_setup(0);
        let (other, other_md5) = override_map(dir.path());
        let cache_root = dir.path().join("cache");
        let saved = SavedBeatmap {
            dir: Some(dir.path().to_path_buf()),
            md5: Some(other_md5.clone()),
            allow_mismatch: true,
            ..SavedBeatmap::default()
        };

        let outcome = reopen(&osr_path, &saved, &cache_root).unwrap();
        assert_eq!(outcome.scene.beatmap.md5, other_md5, "the remembered hash is the one to reproduce");
        assert!(outcome.origin.mismatch);

        // with the remembered map gone, the replay's own hash answers instead
        std::fs::remove_file(&other).unwrap();
        let outcome = reopen(&osr_path, &saved, &cache_root).unwrap();
        assert_eq!(outcome.scene.beatmap.md5, header_md5);
        assert_eq!(outcome.origin.path, osu_path);
        assert!(!outcome.origin.mismatch);
    }

    #[test]
    fn an_unusable_association_falls_through_to_the_stable_lookup() {
        let root = tempfile::tempdir().unwrap();
        let osu_bytes = std::fs::read(fixtures_dir().join("beatmaps").join("stacking-v14.osu")).unwrap();
        let md5 = crate::testutil::fake_install(root.path(), "1 fixture", "map.osu", &osu_bytes);
        let osr_path = root.path().join("replay.osr");
        std::fs::write(&osr_path, osr_bytes(&md5, 0, None)).unwrap();
        // the whole folder the entry remembers is gone
        let moved_away = root.path().join("moved away");
        let saved = SavedBeatmap {
            path: Some(moved_away.join("map.osu")),
            dir: Some(moved_away),
            md5: Some(md5.clone()),
            ..SavedBeatmap::default()
        };

        let outcome = load_recent_replay(
            &osr_path,
            &saved,
            Some(root.path()),
            &[],
            &ListingCache::default(),
            &root.path().join("cache"),
        )
        .unwrap();
        assert_eq!(outcome.scene.beatmap.md5, md5);
        let songs_map = root.path().join("Songs").join("1 fixture").join("map.osu");
        assert_eq!(outcome.origin.path, songs_map, "the refreshed origin is where it was found");
        assert_eq!(outcome.origin.dir, songs_map.parent().unwrap());
    }

    #[test]
    fn an_exhausted_walk_ends_on_the_picker_recoverable_error() {
        let (dir, osr_path, osu_path, md5) = fixture_setup(0);
        std::fs::remove_file(&osu_path).unwrap();
        let cache_root = dir.path().join("cache");
        let saved = SavedBeatmap {
            path: Some(osu_path),
            dir: Some(dir.path().to_path_buf()),
            md5: Some(md5.clone()),
            ..SavedBeatmap::default()
        };

        // a stale association with no install to fall back on: the walk ends
        // on beatmapNotFound (the frontend's beatmap picker), not on whichever
        // step failed last
        match reopen(&osr_path, &saved, &cache_root) {
            Err(IpcError::BeatmapNotFound { md5: m }) => assert_eq!(m, md5),
            other => panic!("expected BeatmapNotFound, got {other:?}"),
        }
    }

    #[test]
    fn a_reopen_with_no_association_keeps_the_missing_install_diagnosis() {
        // an entry from before the association existed has nothing but the
        // stable lookup, so the install's own error -- which lists where it
        // looked and says to set the path in settings -- is the actionable
        // one. only an association that was tried and failed folds into
        // beatmapNotFound, where naming the install would be a red herring
        let (dir, osr_path, _osu_path, md5) = fixture_setup(0);
        let elsewhere = tempfile::tempdir().unwrap();
        let cache_root = dir.path().join("cache");
        let candidates = vec![elsewhere.path().to_path_buf()];
        let reopen_without_install = |saved: &SavedBeatmap| {
            load_recent_replay(
                &osr_path,
                saved,
                None,
                &candidates,
                &ListingCache::default(),
                &cache_root,
            )
        };

        match reopen_without_install(&SavedBeatmap::default()) {
            Err(IpcError::OsuDbNotFound { searched }) => assert_eq!(searched.len(), 1),
            other => panic!("expected OsuDbNotFound, got {other:?}"),
        }

        // the same failure, but this time an association was consulted first
        let stale = SavedBeatmap {
            dir: Some(elsewhere.path().to_path_buf()),
            md5: Some(md5.clone()),
            ..SavedBeatmap::default()
        };
        match reopen_without_install(&stale) {
            Err(IpcError::BeatmapNotFound { md5: m }) => assert_eq!(m, md5),
            other => panic!("expected BeatmapNotFound, got {other:?}"),
        }
    }

    #[test]
    fn a_missing_replay_stays_an_io_error() {
        // the replay being gone is the one failure that is not a stale
        // association, so it must not be dressed up as a lookup miss
        let dir = tempfile::tempdir().unwrap();
        let cache_root = dir.path().join("cache");
        match reopen(&dir.path().join("gone.osr"), &SavedBeatmap::default(), &cache_root) {
            Err(IpcError::Io { .. }) => {}
            other => panic!("expected Io, got {other:?}"),
        }
    }

    #[test]
    fn override_consent_reopens_the_remembered_map_but_never_a_changed_one() {
        let (dir, osr_path, _osu_path, header_md5) = fixture_setup(0);
        // its own folder, so nothing but the override map can answer the scan
        let override_dir = tempfile::tempdir().unwrap();
        let (other, other_md5) = override_map(override_dir.path());
        let cache_root = dir.path().join("cache");
        let saved = SavedBeatmap {
            path: Some(other.clone()),
            dir: Some(override_dir.path().to_path_buf()),
            md5: Some(other_md5.clone()),
            allow_mismatch: true,
        };

        // unchanged: the consent recorded for these bytes still stands, and
        // the scene comes back in the same unsimulated shape as the override
        // load that recorded it
        let outcome = reopen(&osr_path, &saved, &cache_root).unwrap();
        assert_eq!(outcome.scene.beatmap.md5, other_md5);
        assert!(outcome.origin.mismatch);
        assert!(matches!(
            &outcome.scene.simulation,
            SimulationDto::NotSimulated { reason: NotSimulatedReason::BeatmapMismatch }
        ));
        assert_eq!(
            outcome.scene.warnings[0],
            Warning::BeatmapMismatch {
                expected_md5: header_md5.clone(),
                actual_md5: other_md5.clone()
            }
        );

        // no recorded consent: the same association resolves nothing rather
        // than overriding on the user's behalf
        let withheld = SavedBeatmap { allow_mismatch: false, ..saved.clone() };
        match reopen(&osr_path, &withheld, &cache_root) {
            Err(IpcError::BeatmapNotFound { md5: m }) => assert_eq!(m, header_md5),
            other => panic!("expected BeatmapNotFound, got {other:?}"),
        }

        // changed since: consent belongs to the bytes it was given for, so an
        // edited file is a miss even though the path and the flag still agree
        let edited = [std::fs::read(&other).unwrap().as_slice(), b"\n\n"].concat();
        std::fs::write(&other, edited).unwrap();
        match reopen(&osr_path, &saved, &cache_root) {
            Err(IpcError::BeatmapNotFound { md5: m }) => assert_eq!(m, header_md5),
            other => panic!("expected BeatmapNotFound, got {other:?}"),
        }
    }

    #[test]
    fn a_capped_step_refuses_where_anything_else_is_a_miss() {
        // the resolution steps swallow their own failures so the walk can go
        // on, with one carve-out: a resource cap is the typed refusal the
        // user has to see. reporting it as "beatmap not found" would name the
        // wrong problem, and (for the .osz scan budget) inviting the next
        // step to try the same archive again would spend the cap twice
        let capped: Result<(), IpcError> =
            Err(IpcError::ResourceLimit { cap: "MAX_OSZ_SCAN_BYTES".into(), limit: 1, actual: 2 });
        assert!(matches!(miss_unless_capped(capped), Err(IpcError::ResourceLimit { .. })));

        let corrupt: Result<(), IpcError> = Err(IpcError::BeatmapParse { message: "osz".into() });
        assert_eq!(miss_unless_capped(corrupt).unwrap(), None);
        assert_eq!(miss_unless_capped(Ok(7)).unwrap(), Some(7));
    }

    #[test]
    fn recent_dir_scan_file_cap_boundary() {
        // the cap counts .osu files hashed; a scan that cannot afford to hash
        // one finds nothing, which is a miss like any other
        let dir = tempfile::tempdir().unwrap();
        let osu_bytes = std::fs::read(fixtures_dir().join("beatmaps").join("stacking-v14.osu")).unwrap();
        std::fs::write(dir.path().join("map.osu"), &osu_bytes).unwrap();
        let accepted =
            vec![AcceptedMd5 { md5: format!("{:x}", md5::compute(&osu_bytes)), mismatch: false }];

        assert!(scan_dir_for_beatmap(dir.path(), &accepted, 1).unwrap().is_some());
        assert!(scan_dir_for_beatmap(dir.path(), &accepted, 0).unwrap().is_none());
    }
}
