//! stable-install discovery and the osu!.db md5 lookup (spec, tauri layer:
//! "parse header -> md5 -> osu!.db lookup"). osu-db is the production crate
//! for the listing, per the plan-1 standing decision; .osr framing stayed
//! engine-side

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use osu_db::listing::Listing;

use crate::error::IpcError;
use crate::media::read_file_capped;

#[derive(Debug)]
pub struct StableInstall {
    pub db_path: PathBuf,
    pub songs_dir: PathBuf,
}

/// standard install locations, checked in order. the songs directory is
/// assumed at <install>\songs; a custom beatmapdirectory from
/// osu!.<user>.cfg is deferred (todo.md)
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
            return Ok(StableInstall { db_path, songs_dir: root.join("Songs") });
        }
    }
    Err(IpcError::OsuDbNotFound {
        searched: roots.iter().map(|p| p.display().to_string()).collect(),
    })
}

/// a large library's osu!.db is tens of megabytes and its parse dominates an
/// auto load, so the parsed listing is cached and keyed by (path, mtime) --
/// stable rewrites the file (bumping mtime) whenever the library changes
#[derive(Default)]
pub struct ListingCache(Mutex<Option<(PathBuf, SystemTime, Arc<Listing>)>>);

impl ListingCache {
    pub fn get(&self, db_path: &Path) -> Result<Arc<Listing>, IpcError> {
        let modified = std::fs::metadata(db_path)?.modified()?;
        // recovering a poisoned lock is safe here: the slot is only written
        // after a successful parse below, so a panic mid-parse never leaves
        // it pointing at inconsistent state
        let mut slot = self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some((path, mtime, listing)) = slot.as_ref() {
            if path == db_path && *mtime == modified {
                return Ok(Arc::clone(listing));
            }
        }
        let listing = Listing::from_file(db_path)
            .map_err(|e| IpcError::Internal { message: format!("osu!.db parse: {e}") })?;
        let listing = Arc::new(listing);
        *slot = Some((db_path.to_path_buf(), modified, Arc::clone(&listing)));
        Ok(listing)
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
    let listing = cache.get(&install.db_path)?;
    let entry = listing
        .beatmaps
        .iter()
        .find(|b| b.hash.as_deref().is_some_and(|h| h.eq_ignore_ascii_case(md5)))
        .ok_or_else(not_found)?;
    let (Some(folder), Some(file)) = (entry.folder_name.as_deref(), entry.file_name.as_deref())
    else {
        return Err(not_found());
    };
    let path = install.songs_dir.join(folder).join(file);
    let bytes = read_file_capped(&path, engine::limits::MAX_OSU_FILE_BYTES, "MAX_OSU_FILE_BYTES")
        .map_err(|e| match e {
            // an oversized file is reported as the cap breach it is;
            // anything else unreadable is a stale listing
            e @ IpcError::ResourceLimit { .. } => e,
            _ => not_found(),
        })?;
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
        std::fs::write(root.path().join("Songs").join("1 fixture").join("map.osu"), b"edited since")
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
        assert!(std::sync::Arc::ptr_eq(&first, &second), "unchanged db must hit the cache");
    }
}
