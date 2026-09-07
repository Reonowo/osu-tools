//! stable-install discovery and the osu!.db md5 lookup (spec, tauri layer:
//! "parse header -> md5 -> osu!.db lookup").
//!
//! the listing itself is read by the engine's own codec
//! (`engine::formats::stable_listing`), under the engine's no-panic guarantee
//! and its `MAX_OSU_DB_BYTES` cap; this module owns the POLICY on top of it --
//! the (path, mtime) cache, the fold to an md5 map, and the re-hash that
//! decides whether an entry still answers. that split is why a listing the
//! reader refuses is a diagnosis about the install (recovery: the manual
//! picker) rather than an app fault. `fixtures/stable/<version>/osu!.db` holds
//! real clients' own bytes on both sides of the 20250107 layout change, so the
//! next one fails a test here before it fails a user's auto lookup

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use engine::formats::stable_listing::{decode_stable_listing, StableListing};

use crate::error::IpcError;
use crate::media::read_file_capped;
use crate::songs_dir::{current_user_name, locate_songs_directory};

#[derive(Debug)]
pub struct StableInstall {
    pub db_path: PathBuf,
    pub songs_dir: PathBuf,
}

/// standard install locations, checked in order. where the songs live is not
/// assumed: `songs_dir` follows the install's own per-user cfg under lazer's
/// rule (`songs_dir`)
pub fn default_candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        out.push(PathBuf::from(local).join("osu!"));
    }
    out.push(PathBuf::from(r"C:\osu!"));
    out.push(PathBuf::from(r"C:\Program Files (x86)\osu!"));
    out
}

pub fn detect_install(
    override_path: Option<&Path>,
    candidates: &[PathBuf],
) -> Result<StableInstall, IpcError> {
    let roots: Vec<PathBuf> = match override_path {
        Some(p) => vec![p.to_path_buf()],
        None => candidates.to_vec(),
    };
    for root in &roots {
        let db_path = root.join("osu!.db");
        if db_path.is_file() {
            return Ok(StableInstall {
                db_path,
                // read on every detection, override root and detected root
                // alike: the cfg is a few hundred lines, and caching it would
                // only buy a second invalidation rule to get wrong
                songs_dir: locate_songs_directory(root, &current_user_name()),
            });
        }
    }
    Err(IpcError::OsuDbNotFound {
        searched: roots.iter().map(|p| p.display().to_string()).collect(),
    })
}

/// where one listing entry says its beatmap lives, relative to the Songs
/// directory. the two halves stay apart because that is how stable stores
/// them, and joining them at the fold would pay a path allocation per entry
/// for a join only the one entry that answers ever needs
#[derive(Debug, Clone, PartialEq)]
pub struct BeatmapLocation {
    pub folder: String,
    pub file: String,
}

/// the listing reduced to the only question a lookup asks it: md5 (always
/// lower-cased) to where the file sits. an entry missing any of md5, folder
/// or file is dropped here -- one odd row can never block the rest of a
/// library, and a row that cannot name a file could not answer anyway
#[derive(Debug)]
pub struct StableListingIndex {
    pub version: i32,
    by_md5: HashMap<String, BeatmapLocation>,
}

impl StableListingIndex {
    /// how many entries survived the fold. named for what it counts rather
    /// than as a container `len`, because this is not one: there is no
    /// iteration and no emptiness to ask about, only the drop rule's own
    /// arithmetic, which is what the tests read it for
    pub fn entry_count(&self) -> usize {
        self.by_md5.len()
    }

    /// hex case is normalised on both sides, here and at the fold, so an
    /// upper-case header hash still finds its lower-case entry
    pub fn get(&self, md5: &str) -> Option<&BeatmapLocation> {
        self.by_md5.get(&md5.to_ascii_lowercase())
    }
}

/// the listing is re-read only when stable rewrites it, keyed by (path,
/// mtime) -- stable bumps the mtime whenever the library changes, so an auto
/// load after the first costs one map lookup.
///
/// what is held is the FOLD, not the listing. measured on a real
/// 20,833-beatmap library (22 MB file, release build): 9 ms to read, 49 ms to
/// parse through the crate this replaced, and ~50 MB resident for the session
/// afterwards; a linear md5 scan over it was 0.7 ms. so the cache was never
/// really buying time -- the map is a few megabytes, and that is what it is
/// for
#[derive(Default)]
pub struct ListingCache(Mutex<Option<(PathBuf, SystemTime, Arc<StableListingIndex>)>>);

impl ListingCache {
    pub fn get(&self, db_path: &Path) -> Result<Arc<StableListingIndex>, IpcError> {
        let modified = std::fs::metadata(db_path)?.modified()?;
        // recovering a poisoned lock is safe here: the slot is only written
        // after a successful parse below, so a panic mid-parse never leaves
        // it pointing at inconsistent state
        let mut slot = self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some((path, mtime, index)) = slot.as_ref() {
            if path == db_path && *mtime == modified {
                return Ok(Arc::clone(index));
            }
        }
        // charged against the file's DECLARED length first, so an oversized
        // listing is refused before a byte of it is allocated
        let bytes = read_file_capped(db_path, engine::limits::MAX_OSU_DB_BYTES, "MAX_OSU_DB_BYTES")
            .map_err(|e| match e {
                // this cap alone is remapped, and only here: a library too
                // large to index is the same event to a user as one that
                // cannot be parsed. every other cap in the app keeps the
                // generic resource-limit kind
                IpcError::ResourceLimit { cap, limit, actual } => unreadable(
                    db_path,
                    format!("the file is {actual} bytes, past {cap}'s limit of {limit}"),
                ),
                // an io failure here reads exactly as the `metadata` call
                // above it does; the file is not unreadable as a LISTING
                other => other,
            })?;
        let listing = decode_stable_listing(&bytes).map_err(|e| unreadable(db_path, e.to_string()))?;
        let index = Arc::new(fold(listing));
        *slot = Some((db_path.to_path_buf(), modified, Arc::clone(&index)));
        Ok(index)
    }
}

/// this seam is the ONLY place a listing failure becomes user-facing, and the
/// only one that still knows which file was being read. it is never an app
/// fault: the install is there, its index cannot be used, and the beatmap can
/// still be picked by hand, which is what the frontend's toast says
fn unreadable(db_path: &Path, reason: String) -> IpcError {
    IpcError::OsuDbUnreadable {
        path: db_path.display().to_string(),
        reason,
    }
}

fn fold(listing: StableListing) -> StableListingIndex {
    let mut by_md5 = HashMap::with_capacity(listing.entries.len());
    for entry in listing.entries {
        let (Some(md5), Some(folder), Some(file)) = (entry.md5, entry.folder_name, entry.file_name)
        else {
            continue;
        };
        // the FIRST row for a hash wins, never the last: a listing can carry
        // the same md5 twice (the same `.osu` imported into two folders), and
        // the linear scan this fold replaced answered with the first such
        // row, so a library whose later duplicate has since been deleted or
        // edited resolves exactly as it did before the fold existed
        by_md5
            .entry(md5.to_ascii_lowercase())
            .or_insert(BeatmapLocation { folder, file });
    }
    StableListingIndex {
        version: listing.version,
        by_md5,
    }
}

/// finds the entry whose db hash matches, then re-hashes the file on disk: a
/// stale listing must surface as not-found (recovery: manual picker), never
/// as a silently mismatched scene
pub fn find_beatmap_by_md5(
    install: &StableInstall,
    cache: &ListingCache,
    md5: &str,
) -> Result<(PathBuf, Vec<u8>), IpcError> {
    let not_found = || IpcError::BeatmapNotFound { md5: md5.to_string() };
    let index = cache.get(&install.db_path)?;
    let located = index.get(md5).ok_or_else(not_found)?;
    let path = install.songs_dir.join(&located.folder).join(&located.file);
    let bytes = read_file_capped(&path, engine::limits::MAX_OSU_FILE_BYTES, "MAX_OSU_FILE_BYTES").map_err(
        |e| match e {
            // an oversized file is reported as the cap breach it is;
            // anything else unreadable is a stale listing
            e @ IpcError::ResourceLimit { .. } => e,
            _ => not_found(),
        },
    )?;
    let actual = format!("{:x}", md5::compute(&bytes));
    if !actual.eq_ignore_ascii_case(md5) {
        return Err(not_found());
    }
    Ok((path, bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::IpcError;
    use crate::testutil::fake_install;

    #[test]
    fn detects_the_first_candidate_with_a_db() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("osu!.db"), b"stub").unwrap();
        let empty = tempfile::tempdir().unwrap();

        let candidates = vec![empty.path().to_path_buf(), root.path().to_path_buf()];
        let install = detect_install(None, &candidates).unwrap();
        assert_eq!(install.db_path, root.path().join("osu!.db"));
        assert_eq!(install.songs_dir, root.path().join("Songs"));
    }

    #[test]
    fn an_override_is_the_only_location_consulted() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("osu!.db"), b"stub").unwrap();
        let override_dir = tempfile::tempdir().unwrap();

        // override set but empty -> not found, even though a candidate has a db
        let candidates = vec![root.path().to_path_buf()];
        match detect_install(Some(override_dir.path()), &candidates) {
            Err(IpcError::OsuDbNotFound { searched }) => {
                assert_eq!(searched, vec![override_dir.path().display().to_string()]);
            }
            other => panic!("expected OsuDbNotFound, got {other:?}"),
        }
        assert!(detect_install(Some(root.path()), &[]).is_ok());
    }

    /// detection reads the install's own per-user cfg, for a settings
    /// override exactly as for a detected root -- an override is meant to
    /// behave like a real install, not like a stripped-down one
    #[test]
    fn detection_honours_a_relocated_songs_directory() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("osu!.db"), b"stub").unwrap();
        assert_eq!(
            detect_install(Some(root.path()), &[]).unwrap().songs_dir,
            root.path().join("Songs"),
            "with no cfg the default stands"
        );

        let cfg = format!("osu!.{}.cfg", crate::songs_dir::current_user_name());
        std::fs::write(root.path().join(cfg), "BeatmapDirectory = D:\\relocated\n").unwrap();
        assert_eq!(
            detect_install(Some(root.path()), &[]).unwrap().songs_dir,
            std::path::PathBuf::from("D:\\relocated")
        );
        // no caching: the same detection call sees an edited cfg
        let candidates = vec![root.path().to_path_buf()];
        assert_eq!(
            detect_install(None, &candidates).unwrap().songs_dir,
            std::path::PathBuf::from("D:\\relocated")
        );
    }

    /// a configured directory that is not there misses and reaches the
    /// picker, rather than quietly reading a different library
    #[test]
    fn a_missing_configured_songs_directory_is_a_lookup_miss() {
        let root = tempfile::tempdir().unwrap();
        let md5 = fake_install(root.path(), "1 fixture", "map.osu", b"the map contents");
        let cfg = format!("osu!.{}.cfg", crate::songs_dir::current_user_name());
        std::fs::write(
            root.path().join(cfg),
            format!("BeatmapDirectory = {}\n", root.path().join("gone").display()),
        )
        .unwrap();

        let install = detect_install(Some(root.path()), &[]).unwrap();
        assert_eq!(install.songs_dir, root.path().join("gone"));
        match find_beatmap_by_md5(&install, &ListingCache::default(), &md5) {
            Err(IpcError::BeatmapNotFound { md5: m }) => assert_eq!(m, md5),
            other => panic!("expected BeatmapNotFound, got {other:?}"),
        }
    }

    #[test]
    fn finds_and_verifies_a_beatmap_by_md5() {
        let root = tempfile::tempdir().unwrap();
        let md5 = fake_install(root.path(), "1 fixture", "map.osu", b"the map contents");
        let install = detect_install(Some(root.path()), &[]).unwrap();
        let cache = ListingCache::default();

        let (path, bytes) = find_beatmap_by_md5(&install, &cache, &md5).unwrap();
        assert_eq!(path, root.path().join("Songs").join("1 fixture").join("map.osu"));
        assert_eq!(bytes, b"the map contents");
        // hex case differences must not matter
        assert!(find_beatmap_by_md5(&install, &cache, &md5.to_uppercase()).is_ok());
    }

    #[test]
    fn stale_listings_surface_as_not_found() {
        // the db says hash x but the file on disk hashes to y: recovery is
        // the manual picker, never a silently mismatched scene
        let root = tempfile::tempdir().unwrap();
        let md5 = fake_install(root.path(), "1 fixture", "map.osu", b"original");
        std::fs::write(
            root.path().join("Songs").join("1 fixture").join("map.osu"),
            b"edited since",
        )
        .unwrap();
        let install = detect_install(Some(root.path()), &[]).unwrap();

        match find_beatmap_by_md5(&install, &ListingCache::default(), &md5) {
            Err(IpcError::BeatmapNotFound { md5: m }) => assert_eq!(m, md5),
            other => panic!("expected BeatmapNotFound, got {other:?}"),
        }
    }

    #[test]
    fn unknown_hashes_surface_as_not_found() {
        let root = tempfile::tempdir().unwrap();
        fake_install(root.path(), "1 fixture", "map.osu", b"content");
        let install = detect_install(Some(root.path()), &[]).unwrap();
        match find_beatmap_by_md5(&install, &ListingCache::default(), "0000") {
            Err(IpcError::BeatmapNotFound { .. }) => {}
            other => panic!("expected BeatmapNotFound, got {other:?}"),
        }
    }

    #[test]
    fn the_listing_cache_reparses_only_when_mtime_changes() {
        let root = tempfile::tempdir().unwrap();
        fake_install(root.path(), "1 fixture", "map.osu", b"content");
        let db = root.path().join("osu!.db");
        let cache = ListingCache::default();
        let first = cache.get(&db).unwrap();
        let second = cache.get(&db).unwrap();
        assert!(
            std::sync::Arc::ptr_eq(&first, &second),
            "unchanged db must hit the cache"
        );
    }

    /// `fixtures/stable/20260711/osu!.db` is a real client's listing cut to
    /// its first entry (that directory's README): the layout whose
    /// star-rating pairs carry the float tag stable switched to at version
    /// 20250107. the engine's codec has its own tests over both slices; what
    /// this one covers is the PRODUCTION path -- the capped read, the cache,
    /// the fold, and the re-hash behind them
    #[test]
    fn a_current_clients_listing_parses_and_resolves() {
        let root = tempfile::tempdir().unwrap();
        let db = root.path().join("osu!.db");
        let slice = crate::testutil::fixtures_dir().join("stable").join("20260711").join("osu!.db");
        std::fs::copy(slice, &db).unwrap();
        let index = ListingCache::default().get(&db).unwrap();
        assert_eq!(index.version, 20260711);
        assert_eq!(index.entry_count(), 1);
        let located = index.get("73dc65db8bf113b5bf21d7ace5ef131b").unwrap();
        assert_eq!(located.folder, "Carnival");
        assert_eq!(located.file, "- Carnival (Pawnables) [Merry Go 'Round].osu");
        // the hex case of a query never matters
        assert!(index.get("73DC65DB8BF113B5BF21D7ACE5EF131B").is_some());

        // the lookup reaches the entry and then re-hashes the file on disk:
        // a folder holding different bytes is a stale listing (not found),
        // never a parse error
        let folder = root.path().join("Songs").join("Carnival");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("- Carnival (Pawnables) [Merry Go 'Round].osu"), b"not the map").unwrap();
        let install = detect_install(Some(root.path()), &[]).unwrap();
        match find_beatmap_by_md5(&install, &ListingCache::default(), "73DC65DB8BF113B5BF21D7ACE5EF131B") {
            Err(IpcError::BeatmapNotFound { .. }) => {}
            other => panic!("expected BeatmapNotFound after the re-hash, got {other:?}"),
        }
    }

    /// stable has shipped three layout changes since 2014 and the production
    /// path has to resolve through every one of them, not just the reader in
    /// isolation. osu-db is dev-only now, and writing these is what it is
    /// still here for
    #[test]
    fn a_fake_install_resolves_at_every_layout_gate() {
        for version in [20140608, 20140609, 20191105, 20191106, 20250107] {
            let root = tempfile::tempdir().unwrap();
            let md5 = crate::testutil::fake_install_versioned(
                root.path(),
                "1 fixture",
                "map.osu",
                b"the map contents",
                version,
            );
            let install = detect_install(Some(root.path()), &[]).unwrap();
            let cache = ListingCache::default();
            assert_eq!(cache.get(&install.db_path).unwrap().version as u32, version);

            let (path, bytes) = find_beatmap_by_md5(&install, &cache, &md5)
                .unwrap_or_else(|e| panic!("version {version}: {e:?}"));
            assert_eq!(path, root.path().join("Songs").join("1 fixture").join("map.osu"));
            assert_eq!(bytes, b"the map contents");
        }
    }

    /// a row that cannot name its file is dropped at the fold rather than
    /// failing the read: one odd entry never blocks the rest of a library
    #[test]
    fn an_entry_missing_a_field_is_dropped_and_the_others_still_resolve() {
        let root = tempfile::tempdir().unwrap();
        let md5 = crate::testutil::fake_install(root.path(), "1 fixture", "map.osu", b"the map contents");
        crate::testutil::mangle_listing(&root.path().join("osu!.db"), |listing| {
            let mut hashless = listing.beatmaps[0].clone();
            hashless.hash = None;
            let mut folderless = listing.beatmaps[0].clone();
            folderless.hash = Some("a".repeat(32));
            folderless.folder_name = None;
            let mut fileless = listing.beatmaps[0].clone();
            fileless.hash = Some("b".repeat(32));
            fileless.file_name = None;
            listing.beatmaps.splice(0..0, [hashless, folderless, fileless]);
        });

        let install = detect_install(Some(root.path()), &[]).unwrap();
        let cache = ListingCache::default();
        assert_eq!(cache.get(&install.db_path).unwrap().entry_count(), 1, "three rows dropped");
        assert!(find_beatmap_by_md5(&install, &cache, &md5).is_ok());
    }

    /// two rows with one md5 -- the same `.osu` imported into two folders --
    /// resolve through the FIRST, as the linear scan this fold replaced did.
    /// the later duplicate here names a folder that is gone, which is the
    /// case a last-row-wins fold would turn from a hit into a miss
    #[test]
    fn a_duplicate_hash_resolves_through_its_first_row() {
        let root = tempfile::tempdir().unwrap();
        let md5 = crate::testutil::fake_install(root.path(), "1 fixture", "map.osu", b"the map contents");
        crate::testutil::mangle_listing(&root.path().join("osu!.db"), |listing| {
            let mut stale_copy = listing.beatmaps[0].clone();
            stale_copy.folder_name = Some("2 deleted copy".into());
            listing.beatmaps.push(stale_copy);
        });

        let install = detect_install(Some(root.path()), &[]).unwrap();
        let cache = ListingCache::default();
        let index = cache.get(&install.db_path).unwrap();
        assert_eq!(index.entry_count(), 1, "one hash, one row");
        assert_eq!(index.get(&md5).unwrap().folder, "1 fixture");
        let (path, _) = find_beatmap_by_md5(&install, &cache, &md5).unwrap();
        assert_eq!(path, root.path().join("Songs").join("1 fixture").join("map.osu"));
    }

    /// a listing the reader refuses is a fact about the install, never an
    /// "internal error": the toast names the file, carries the reader's own
    /// reason, and offers the picker
    #[test]
    fn an_unreadable_listing_carries_the_path_and_the_readers_reason() {
        let root = tempfile::tempdir().unwrap();
        let db = root.path().join("osu!.db");
        // a plausible header followed by garbage, so the reader gets far
        // enough to report a version and an offset
        let mut bytes = 20260711i32.to_le_bytes().to_vec();
        bytes.extend_from_slice(b"not a listing at all");
        std::fs::write(&db, &bytes).unwrap();

        match ListingCache::default().get(&db) {
            Err(IpcError::OsuDbUnreadable { path, reason }) => {
                assert_eq!(path, db.display().to_string());
                assert!(reason.contains("20260711"), "the version belongs in it: {reason}");
                assert!(reason.contains("byte"), "the offset belongs in it: {reason}");
            }
            other => panic!("expected OsuDbUnreadable, got {other:?}"),
        }
    }

    /// the cap is charged against the DECLARED length, so an oversized
    /// listing costs a `metadata` call rather than a 256 MiB read (the sparse
    /// file below never occupies the disk it claims) -- and it surfaces as
    /// the same unreadable outcome, naming the cap, rather than as the
    /// generic limit toast, which offers no way forward
    #[test]
    fn an_over_cap_listing_is_refused_before_it_is_read() {
        let root = tempfile::tempdir().unwrap();
        let db = root.path().join("osu!.db");
        let file = std::fs::File::create(&db).unwrap();
        let over = engine::limits::MAX_OSU_DB_BYTES + 1;
        file.set_len(over).unwrap();
        drop(file);

        match ListingCache::default().get(&db) {
            Err(IpcError::OsuDbUnreadable { path, reason }) => {
                assert_eq!(path, db.display().to_string());
                assert!(reason.contains("MAX_OSU_DB_BYTES"), "{reason}");
                assert!(reason.contains(&over.to_string()), "{reason}");
            }
            other => panic!("expected OsuDbUnreadable, got {other:?}"),
        }
    }
}
