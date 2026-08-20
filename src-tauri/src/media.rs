//! media path resolution for the asset protocol. beatmap-referenced
//! filenames must canonicalize to files strictly inside the beatmap's own
//! directory (or its .osz cache dir) before being exposed; traversal and
//! absolute references are treated as missing (spec, tauri layer)

use std::collections::{BTreeMap, BTreeSet};
use std::io::Read;
use std::path::{Path, PathBuf};

use crate::error::IpcError;

/// the extensions osu! accepts for a sample, in the order a store tries them.
/// `.wav` first is osu-framework's own preference and matters when a folder
/// ships the same stem twice
pub const SAMPLE_EXTENSIONS: [&str; 3] = ["wav", "mp3", "ogg"];

/// the extensions a texture lookup tries, in the order the framework's texture
/// store registers them (textureloaderstore.cs:27-28). the frontend's chain
/// applies the same order; this list only decides which files are enumerated
pub const TEXTURE_EXTENSIONS: [&str; 2] = ["png", "jpg"];

/// which of a beatmap folder's images can ever answer a texture lookup.
///
/// a mapset folder holds its background, its video frames and often a whole
/// storyboard's art, none of which any element name can reach. enumerating
/// everything would put hundreds of megabytes into a file map the frontend
/// would never read -- and, worse, would let an ordinary storyboard-heavy map
/// breach [`engine::limits::MAX_BEATMAP_TEXTURE_BYTES`] and fail to load a map
/// that loads fine today. so the walk is filtered to the ruleset's own element
/// names, by prefix.
///
/// prefixes rather than exact names deliberately: `hitcircle` and
/// `hitcircleoverlay`, `sliderb0`..`sliderb9` and `sliderfollowcircle`, the ten
/// `default-N` digits and every `spinner-*` layer are all reached by a handful
/// of stems, and stable's element names have not changed in a decade. this
/// mirrors the inventory in `src/skin/pieces.ts`, which is the frontend's own
/// statement of what it can ask for.
///
/// the one gap, and it is deliberate: a beatmap that renames its combo digit
/// font through `HitCirclePrefix` is not enumerated. that key is a SKIN
/// configuration and a beatmap skin declaring one is vanishingly rare, while
/// admitting arbitrary prefixes would defeat the filter's whole purpose
pub const BEATMAP_SKIN_PREFIXES: [&str; 9] = [
    "approachcircle",
    "cursor",
    "default-",
    "followpoint",
    // covers `hitcircle`, `hitcircleoverlay` and the four `hitN` judgements
    "hit",
    "lighting",
    "reversearrow",
    // covers every `sliderb*`, `sliderfollowcircle`, `sliderscorepoint` and the
    // dedicated `sliderstartcircle`/`sliderendcircle` pair
    "slider",
    "spinner-",
];

/// every image file in the beatmap's own folder that could answer a texture
/// lookup, keyed by its lowercased file NAME (extension included).
///
/// keyed by file name rather than by lookup name, unlike the sample map: which
/// of `hitcircle@2x.png` and `hitcircle.png` answers a `hitcircle` lookup is an
/// era rule, and era rules live in the frontend's lookup chain -- the same
/// shape a skin manifest's own file map has, for the same reason.
///
/// as with the sample walk, this needs no new path handling: `read_dir` over
/// the canonicalized directory yields only its own entries, so the "strictly
/// inside" property `resolve_media_path` enforces for a named file holds by
/// construction
pub fn resolve_texture_files(dir: &Path) -> Result<BTreeMap<String, PathBuf>, IpcError> {
    resolve_texture_files_with_budget(
        dir,
        engine::limits::MAX_BEATMAP_TEXTURE_BYTES,
        crate::limits::MAX_BEATMAP_TEXTURES,
    )
}

/// whether a lowercased file name could ever answer a texture lookup: one of
/// the ruleset element prefixes under one of the extensions the loader tries.
/// shared with the `.osz` extractor's member filter, so the archive and folder
/// paths cannot disagree about which files are the beatmap's own art
pub fn is_beatmap_texture_name(name: &str) -> bool {
    let Some((stem, extension)) = name.rsplit_once('.') else {
        return false;
    };
    TEXTURE_EXTENSIONS.contains(&extension)
        && BEATMAP_SKIN_PREFIXES
            .iter()
            .any(|prefix| stem.starts_with(prefix))
}

/// both budgets are parameters so the boundary tests can drive them with tiny
/// inputs, mirroring every other capped entry point in this crate. the count
/// cap exists because the byte budget alone cannot bound the walk: a folder of
/// element-named zero-byte files charges nothing while growing both maps and
/// the scene that crosses ipc, so the entry count is checked as names are
/// collected
pub fn resolve_texture_files_with_budget(
    dir: &Path,
    max_bytes: u64,
    max_files: usize,
) -> Result<BTreeMap<String, PathBuf>, IpcError> {
    let mut found: BTreeMap<String, PathBuf> = BTreeMap::new();
    let Ok(dir) = dunce::canonicalize(dir) else {
        return Ok(found);
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(found);
    };
    let mut used: u64 = 0;
    // sizes are collected into the map first and charged in NAME order, so
    // which file tips the budget does not depend on readdir order
    let mut sizes: BTreeMap<String, u64> = BTreeMap::new();
    for entry in entries.flatten() {
        if !entry.file_type().is_ok_and(|kind| kind.is_file()) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
        if !is_beatmap_texture_name(&name) {
            continue;
        }
        sizes.insert(name.clone(), entry.metadata().map(|m| m.len()).unwrap_or(0));
        found.insert(name, entry.path());
        if found.len() > max_files {
            return Err(IpcError::ResourceLimit {
                cap: "MAX_BEATMAP_TEXTURES".to_string(),
                limit: max_files as u64,
                actual: found.len() as u64,
            });
        }
    }
    for size in sizes.values() {
        used = used.saturating_add(*size);
        if used > max_bytes {
            return Err(IpcError::ResourceLimit {
                cap: "MAX_BEATMAP_TEXTURE_BYTES".to_string(),
                limit: max_bytes,
                actual: used,
            });
        }
    }
    Ok(found)
}

/// every hit-sample file the beatmap's own folder holds, keyed by the LOOKUP
/// NAME the frontend's chain will ask for.
///
/// keyed both ways on purpose: a default sample is asked for by stem
/// (`normal-hitnormal`) while an object's explicit `hitSample` is asked for
/// by full file name first and by stem second
/// (converthitobjectparser.cs:693-697), so both forms are registered when the
/// engine's stem set contains them.
///
/// this needs no new path handling: `read_dir` over the canonicalized
/// directory yields only its own entries, so the "strictly inside" property
/// `resolve_media_path` enforces for a named file holds here by construction.
/// names are compared case-insensitively, which is what osu! itself does.
///
/// the total is charged against `engine::limits::MAX_SAMPLE_BYTES`, the same
/// budget the `.osz` extractor charges as it writes. a folder load has no
/// extraction step to bound it, so without this a folder holding gigabytes of
/// sample files would surface as the frontend quietly declining to decode --
/// a silence with no explanation, where the archive path gets a typed error
pub fn resolve_sample_files(
    dir: &Path,
    stems: &BTreeSet<String>,
) -> Result<BTreeMap<String, PathBuf>, IpcError> {
    resolve_sample_files_with_budget(dir, stems, engine::limits::MAX_SAMPLE_BYTES)
}

/// the budget is a parameter so the boundary test can drive it with tiny
/// files, mirroring every other capped entry point in this crate
pub fn resolve_sample_files_with_budget(
    dir: &Path,
    stems: &BTreeSet<String>,
    max_bytes: u64,
) -> Result<BTreeMap<String, PathBuf>, IpcError> {
    let mut found: BTreeMap<String, PathBuf> = BTreeMap::new();
    let Ok(dir) = dunce::canonicalize(dir) else {
        return Ok(found);
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(found);
    };
    // RESOLUTION FIRST, BUDGET SECOND. extension precedence decides which file
    // a stem resolves to, and only that winner is ever fetched and decoded --
    // so charging as the walk goes would bill an `.mp3` a `.wav` then beat,
    // and a folder could be refused over bytes nothing would ever read. sizes
    // are collected here and spent below, once the winners are known
    let mut sizes: BTreeMap<PathBuf, u64> = BTreeMap::new();
    // the keys an exact filename has claimed, which no stem-inferred candidate
    // may take back -- see the branch below
    let mut exact: BTreeSet<String> = BTreeSet::new();
    for entry in entries.flatten() {
        if !entry.file_type().is_ok_and(|kind| kind.is_file()) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
        let Some((stem, extension)) = name.rsplit_once('.') else {
            continue;
        };
        if !SAMPLE_EXTENSIONS.contains(&extension) {
            continue;
        }
        let wanted = stems.contains(&name) || stems.contains(stem);
        if !wanted {
            continue;
        }
        let path = entry.path();
        sizes.insert(path.clone(), entry.metadata().map(|m| m.len()).unwrap_or(0));
        // the full name answers an explicit hitSample; the stem answers every
        // default lookup. a stem already claimed by an earlier extension keeps
        // it, which is what makes SAMPLE_EXTENSIONS an order rather than a set.
        //
        // an EXACT name match outranks an inferred one unconditionally, and
        // that is not hypothetical tidiness: `foo.wav.mp3` carries the stem
        // `foo.wav`, so a map whose hitSample names `foo.wav` would resolve to
        // whichever of the two `read_dir` happened to reach first -- the same
        // folder answering differently on different machines
        if stems.contains(&name) && exact.insert(name.clone()) {
            found.insert(name.clone(), path.clone());
        }
        if stems.contains(stem) && !exact.contains(stem) {
            let existing = found.get(stem).and_then(|path| sample_extension_rank(path));
            let rank = SAMPLE_EXTENSIONS.iter().position(|e| *e == extension);
            if existing.is_none() || rank < existing {
                found.insert(stem.to_string(), path);
            }
        }
    }

    // charged per RESOLVED SOURCE PATH, which is the identity the frontend's
    // decode cache keys on too: several lookup names legitimately resolve to
    // one file (a stem and the explicit full name beside it), and that is one
    // file to decode and one charge to make. the set also fixes the order, so
    // which file tips the budget no longer depends on readdir order
    let mut used: u64 = 0;
    for path in found.values().collect::<BTreeSet<_>>() {
        used = used.saturating_add(sizes.get(path).copied().unwrap_or(0));
        if used > max_bytes {
            return Err(IpcError::ResourceLimit {
                cap: "MAX_SAMPLE_BYTES".to_string(),
                limit: max_bytes,
                actual: used,
            });
        }
    }
    Ok(found)
}

fn sample_extension_rank(path: &Path) -> Option<usize> {
    let extension = path.extension()?.to_string_lossy().to_ascii_lowercase();
    SAMPLE_EXTENSIONS.iter().position(|e| *e == extension)
}

/// dunce instead of std: std's canonicalize returns \\?\-verbatim windows
/// paths, which break the asset protocol url round-trip; dunce resolves
/// identically but keeps drive-letter form
pub fn resolve_media_path(dir: &Path, file_name: &str) -> Option<PathBuf> {
    if file_name.is_empty() {
        return None;
    }
    let dir = dunce::canonicalize(dir).ok()?;
    let candidate = dunce::canonicalize(dir.join(file_name)).ok()?;
    (candidate.is_file() && candidate.starts_with(&dir)).then_some(candidate)
}

/// mirrors engine::formats::beatmap::decode_beatmap_path's precheck: the
/// declared length is refused before a buffer is allocated, and the read
/// itself is take-bounded so a file that grows between the two steps still
/// cannot outrun the cap
pub fn read_file_capped(path: &Path, cap: u64, cap_name: &'static str) -> Result<Vec<u8>, IpcError> {
    let file = std::fs::File::open(path)?;
    let declared = file.metadata()?.len();
    if declared > cap {
        return Err(IpcError::ResourceLimit {
            cap: cap_name.to_string(),
            limit: cap,
            actual: declared,
        });
    }
    let mut bytes = Vec::new();
    file.take(cap + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > cap {
        return Err(IpcError::ResourceLimit {
            cap: cap_name.to_string(),
            limit: cap,
            actual: bytes.len() as u64,
        });
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::{
        read_file_capped, resolve_media_path, resolve_sample_files, resolve_sample_files_with_budget,
        resolve_texture_files, resolve_texture_files_with_budget,
    };
    use crate::error::IpcError;

    #[test]
    fn resolves_files_inside_the_directory() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("audio.mp3"), b"x").unwrap();
        std::fs::create_dir(dir.path().join("sb")).unwrap();
        std::fs::write(dir.path().join("sb").join("bg.jpg"), b"x").unwrap();

        let audio = resolve_media_path(dir.path(), "audio.mp3").unwrap();
        assert!(audio.is_file());
        assert!(resolve_media_path(dir.path(), "sb/bg.jpg").is_some());
        // windows resolves case-insensitively; the reference and the file on
        // disk rarely agree on case in real mapsets
        assert!(resolve_media_path(dir.path(), "AUDIO.MP3").is_some());
    }

    #[test]
    fn rejects_everything_that_leaves_the_directory() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("map");
        std::fs::create_dir(&dir).unwrap();
        std::fs::write(root.path().join("outside.mp3"), b"x").unwrap();

        assert_eq!(resolve_media_path(&dir, "../outside.mp3"), None);
        let absolute = root.path().join("outside.mp3").display().to_string();
        assert_eq!(resolve_media_path(&dir, &absolute), None);
        assert_eq!(resolve_media_path(&dir, ""), None);
        assert_eq!(resolve_media_path(&dir, "missing.mp3"), None);
        assert_eq!(resolve_media_path(&dir, "."), None, "a directory is not media");
    }

    #[test]
    fn canonical_results_avoid_the_verbatim_prefix() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("audio.mp3"), b"x").unwrap();
        let resolved = resolve_media_path(dir.path(), "audio.mp3").unwrap();
        // the \\?\ prefix breaks the asset protocol url round-trip
        assert!(!resolved.display().to_string().starts_with(r"\\?\"));
    }

    #[test]
    fn resolves_a_maps_own_art_by_file_name() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["hitcircle@2x.png", "hitcircleoverlay.png", "SLIDERB0.PNG", "default-3.jpg"] {
            std::fs::write(dir.path().join(name), b"x").unwrap();
        }
        let found = resolve_texture_files(dir.path()).unwrap();
        // keyed by lowercased FILE NAME, extension included: which of an `@2x`
        // and a plain file answers a lookup is the frontend chain's rule
        assert!(found.contains_key("hitcircle@2x.png"));
        assert!(found.contains_key("hitcircleoverlay.png"));
        assert!(found.contains_key("sliderb0.png"));
        assert!(found.contains_key("default-3.jpg"));
    }

    #[test]
    fn a_maps_background_and_storyboard_art_are_not_enumerated() {
        // the whole point of the prefix filter: a mapset's own art can answer
        // no element lookup, and enumerating it would charge the byte cap
        // against images nothing would ever draw
        let dir = tempfile::tempdir().unwrap();
        for name in ["bg.jpg", "storyboard-flash.png", "video-frame-1.png", "menu-background.jpg"] {
            std::fs::write(dir.path().join(name), b"x").unwrap();
        }
        assert!(resolve_texture_files(dir.path()).unwrap().is_empty());
    }

    #[test]
    fn only_image_extensions_are_enumerated() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["hitcircle.png", "hitnormal.wav", "hitcircle.psd"] {
            std::fs::write(dir.path().join(name), b"x").unwrap();
        }
        let found = resolve_texture_files(dir.path()).unwrap();
        assert_eq!(found.keys().collect::<Vec<_>>(), vec!["hitcircle.png"]);
    }

    #[test]
    fn a_missing_directory_is_no_art_rather_than_an_error() {
        assert!(resolve_texture_files(std::path::Path::new("does/not/exist"))
            .unwrap()
            .is_empty());
    }

    #[test]
    fn beatmap_texture_byte_budget_boundary() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("hitcircle.png"), vec![0u8; 4]).unwrap();
        std::fs::write(dir.path().join("cursor.png"), vec![0u8; 4]).unwrap();
        assert_eq!(resolve_texture_files_with_budget(dir.path(), 8, 16).unwrap().len(), 2);
        match resolve_texture_files_with_budget(dir.path(), 7, 16) {
            Err(IpcError::ResourceLimit {
                cap,
                limit: 7,
                actual: 8,
            }) => assert_eq!(cap, "MAX_BEATMAP_TEXTURE_BYTES"),
            other => panic!("expected ResourceLimit, got {other:?}"),
        }
    }

    #[test]
    fn beatmap_texture_count_cap_boundary() {
        // zero-byte files, deliberately: the byte budget cannot see these, and
        // the count cap is what bounds the maps they would grow
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("hitcircle.png"), b"").unwrap();
        std::fs::write(dir.path().join("cursor.png"), b"").unwrap();
        assert_eq!(resolve_texture_files_with_budget(dir.path(), 8, 2).unwrap().len(), 2);
        match resolve_texture_files_with_budget(dir.path(), 8, 1) {
            Err(IpcError::ResourceLimit {
                cap,
                limit: 1,
                actual: 2,
            }) => assert_eq!(cap, "MAX_BEATMAP_TEXTURES"),
            other => panic!("expected ResourceLimit, got {other:?}"),
        }
    }

    #[test]
    fn capped_read_boundary() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("f.bin");
        std::fs::write(&path, vec![0u8; 8]).unwrap();
        assert_eq!(read_file_capped(&path, 8, "TEST_CAP").unwrap().len(), 8);
        match read_file_capped(&path, 7, "TEST_CAP") {
            Err(IpcError::ResourceLimit {
                cap,
                limit: 7,
                actual: 8,
            }) => assert_eq!(cap, "TEST_CAP"),
            other => panic!("expected ResourceLimit, got {other:?}"),
        }
    }

    fn stems<const N: usize>(names: [&str; N]) -> std::collections::BTreeSet<String> {
        names.into_iter().map(str::to_string).collect()
    }

    #[test]
    fn resolves_a_folders_own_sample_files_by_lookup_name() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("normal-hitnormal.wav"), b"x").unwrap();
        std::fs::write(dir.path().join("Kick.WAV"), b"x").unwrap();
        std::fs::write(dir.path().join("unrelated.wav"), b"x").unwrap();
        std::fs::write(dir.path().join("bg.jpg"), b"x").unwrap();

        let found = resolve_sample_files(dir.path(), &stems(["normal-hitnormal", "kick.wav", "kick"])).unwrap();

        // a default lookup asks by stem; an explicit hitSample asks by full
        // name first and by stem second, so both are registered
        assert!(found.contains_key("normal-hitnormal"));
        assert!(found.contains_key("kick.wav"));
        assert!(found.contains_key("kick"));
        // nothing the engine's resolution never asks for
        assert!(!found.contains_key("unrelated"));
        // and nothing that is not a sample at all
        assert!(!found.contains_key("bg"));
    }

    #[test]
    fn a_stem_shipped_twice_takes_the_extension_a_sample_store_prefers() {
        // osu-framework tries .wav before .mp3; a folder holding both must
        // resolve the same way whichever order read_dir happens to yield
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("soft-hitclap.mp3"), b"x").unwrap();
        std::fs::write(dir.path().join("soft-hitclap.wav"), b"x").unwrap();

        let found = resolve_sample_files(dir.path(), &stems(["soft-hitclap"])).unwrap();
        assert_eq!(
            found.get("soft-hitclap").unwrap().extension().unwrap(),
            "wav"
        );
    }

    #[test]
    fn a_missing_or_unreadable_directory_resolves_nothing_rather_than_failing() {
        // a map whose folder vanished between load and scan is a scene without
        // custom hitsounds, not a failed load
        let found = resolve_sample_files(std::path::Path::new("does/not/exist"), &stems(["normal-hitnormal"])).unwrap();
        assert!(found.is_empty());
    }

    #[test]
    fn folder_sample_byte_budget_boundary() {
        // engine::limits::MAX_SAMPLE_BYTES on the folder side. the archive path
        // is charged by the extractor as it writes; a folder load has no such
        // step, so without this the cap would be reached only at decode time
        // and surface as an unexplained silence
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("normal-hitnormal.wav"), vec![0u8; 6]).unwrap();
        let wanted = stems(["normal-hitnormal"]);

        assert!(resolve_sample_files_with_budget(dir.path(), &wanted, 6).is_ok());
        match resolve_sample_files_with_budget(dir.path(), &wanted, 5) {
            Err(IpcError::ResourceLimit { cap, limit: 5, .. }) => assert_eq!(cap, "MAX_SAMPLE_BYTES"),
            other => panic!("expected ResourceLimit, got {other:?}"),
        }
    }

    #[test]
    fn a_file_registered_under_two_keys_is_charged_once() {
        // an explicit hitSample registers its file under both its full name
        // and its stem; charging twice would halve the real allowance
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("kick.wav"), vec![0u8; 6]).unwrap();
        let found = resolve_sample_files_with_budget(dir.path(), &stems(["kick.wav", "kick"]), 6).unwrap();
        assert_eq!(found.len(), 2);
    }

    #[test]
    fn an_extension_that_loses_precedence_is_not_charged() {
        // SAMPLE_EXTENSIONS is an ORDER: a stem holding both a .wav and a .mp3
        // resolves to the .wav, and the .mp3 is never fetched or decoded.
        // charging it anyway would refuse a folder over bytes nothing reads
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("soft-hitnormal.wav"), vec![0u8; 6]).unwrap();
        std::fs::write(dir.path().join("soft-hitnormal.mp3"), vec![0u8; 20]).unwrap();
        let wanted = stems(["soft-hitnormal"]);

        let found = resolve_sample_files_with_budget(dir.path(), &wanted, 6)
            .expect("the winning .wav fits; the losing .mp3 is not the budget's business");
        assert_eq!(found.len(), 1);
        assert_eq!(
            found["soft-hitnormal"].extension().unwrap().to_string_lossy(),
            "wav"
        );

        // and the winner is still charged: one byte under and it is refused
        match resolve_sample_files_with_budget(dir.path(), &wanted, 5) {
            Err(IpcError::ResourceLimit { cap, limit: 5, .. }) => assert_eq!(cap, "MAX_SAMPLE_BYTES"),
            other => panic!("expected ResourceLimit, got {other:?}"),
        }
    }

    #[test]
    fn an_exact_filename_outranks_a_file_that_merely_stems_to_it() {
        // `foo.wav.mp3` carries the stem `foo.wav`, so both files answer the
        // key an explicit `hitSample: foo.wav` asks for. without exact
        // matches outranking inferred ones the winner is whichever `read_dir`
        // reached first -- the same folder resolving differently on different
        // machines, which is the failure mode this repo refuses everywhere else
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("foo.wav"), vec![0u8; 4]).unwrap();
        std::fs::write(dir.path().join("foo.wav.mp3"), vec![0u8; 4]).unwrap();

        let found = resolve_sample_files_with_budget(dir.path(), &stems(["foo.wav"]), u64::MAX).unwrap();
        assert_eq!(found["foo.wav"], dir.path().join("foo.wav"));
    }
}
