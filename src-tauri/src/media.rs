//! media path resolution for the asset protocol. beatmap-referenced
//! filenames must canonicalize to files strictly inside the beatmap's own
//! directory (or its .osz cache dir) before being exposed; traversal and
//! absolute references are treated as missing (spec, tauri layer)

use std::io::Read;
use std::path::{Path, PathBuf};

use crate::error::IpcError;

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
        return Err(IpcError::ResourceLimit { cap: cap_name.to_string(), limit: cap, actual: declared });
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
    use super::{read_file_capped, resolve_media_path};
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
    fn capped_read_boundary() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("f.bin");
        std::fs::write(&path, vec![0u8; 8]).unwrap();
        assert_eq!(read_file_capped(&path, 8, "TEST_CAP").unwrap().len(), 8);
        match read_file_capped(&path, 7, "TEST_CAP") {
            Err(IpcError::ResourceLimit { cap, limit: 7, actual: 8 }) => assert_eq!(cap, "TEST_CAP"),
            other => panic!("expected ResourceLimit, got {other:?}"),
        }
    }
}
