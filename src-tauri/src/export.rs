//! the atomic export write protocol: write to a same-directory temp file,
//! flush it to disk, then rename onto the destination -- with no-replace
//! rename semantics when overwrite consent is absent, so a destination
//! appearing mid-write fails typed instead of being clobbered. any failure
//! deletes the temp file; the destination is only ever a complete file or
//! the untouched original, never truncated or partial

use std::fs::{self, File, OpenOptions};
use std::io::Write as _;
use std::path::{Path, PathBuf};

use crate::error::IpcError;

/// windows maps ERROR_FILE_EXISTS/ERROR_ALREADY_EXISTS onto these raw codes;
/// checked explicitly because older io::ErrorKind mappings left them
/// uncategorized
#[cfg(windows)]
const ERROR_FILE_EXISTS: i32 = 80;
#[cfg(windows)]
const ERROR_ALREADY_EXISTS: i32 = 183;

fn is_already_exists(e: &std::io::Error) -> bool {
    if e.kind() == std::io::ErrorKind::AlreadyExists {
        return true;
    }
    #[cfg(windows)]
    if matches!(e.raw_os_error(), Some(ERROR_FILE_EXISTS) | Some(ERROR_ALREADY_EXISTS)) {
        return true;
    }
    false
}

/// a rename that fails if the destination exists, atomically -- std's rename
/// always replaces on windows (MOVEFILE_REPLACE_EXISTING), so this calls
/// MoveFileExW without the replace flag instead
#[cfg(windows)]
fn rename_no_replace(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
    }

    let wide = |p: &Path| -> Vec<u16> { p.as_os_str().encode_wide().chain(std::iter::once(0)).collect() };
    let (from_w, to_w) = (wide(from), wide(to));
    // flags 0: no MOVEFILE_REPLACE_EXISTING, so an existing destination --
    // even one that appeared after the pre-check -- fails the move itself
    if unsafe { MoveFileExW(from_w.as_ptr(), to_w.as_ptr(), 0) } == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

/// on unix a hard link is the standard no-replace atomic publish: link(2)
/// fails EEXIST if the destination exists, and the temp link is removed by
/// the caller's cleanup
#[cfg(not(windows))]
fn rename_no_replace(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::hard_link(from, to)?;
    fs::remove_file(from)
}

/// creates a uniquely-named sibling of the destination so the final rename
/// never crosses a volume boundary
fn create_sibling_temp(dest: &Path) -> Result<(PathBuf, File), IpcError> {
    let name = dest
        .file_name()
        .ok_or_else(|| IpcError::Io {
            message: format!("export destination has no file name: {}", dest.display()),
        })?
        .to_string_lossy()
        .into_owned();
    let pid = std::process::id();
    for attempt in 0u32..64 {
        let candidate = dest.with_file_name(format!(".{name}.{pid}-{attempt}.export-tmp"));
        match OpenOptions::new().write(true).create_new(true).open(&candidate) {
            Ok(file) => return Ok((candidate, file)),
            Err(e) if is_already_exists(&e) => continue,
            Err(e) => return Err(e.into()),
        }
    }
    Err(IpcError::Io {
        message: "could not create an export temp file after 64 attempts".into(),
    })
}

/// the whole protocol. `overwrite: false` fails [`IpcError::FileExists`] on
/// an existing destination -- checked up front for the common case and
/// enforced again by the no-replace rename, which closes the race against a
/// file appearing mid-write
pub fn atomic_write(dest: &Path, bytes: &[u8], overwrite: bool) -> Result<(), IpcError> {
    let file_exists = || IpcError::FileExists {
        path: dest.display().to_string(),
    };
    if !overwrite && dest.exists() {
        return Err(file_exists());
    }

    let (temp, file) = create_sibling_temp(dest)?;
    let published = write_and_publish(file, bytes, &temp, dest, overwrite);
    if published.is_err() {
        // failure costs nothing: the temp is deleted and any existing
        // destination was never touched
        let _ = fs::remove_file(&temp);
    }
    published.map_err(|e| if is_already_exists(&e) { file_exists() } else { e.into() })
}

fn write_and_publish(
    mut file: File,
    bytes: &[u8],
    temp: &Path,
    dest: &Path,
    overwrite: bool,
) -> std::io::Result<()> {
    file.write_all(bytes)?;
    // flushed to disk before the rename publishes it: a crash between these
    // two steps leaves only a temp file, never a truncated destination
    file.sync_all()?;
    // windows cannot rename a file with an open handle
    drop(file);
    if overwrite {
        fs::rename(temp, dest)
    } else {
        rename_no_replace(temp, dest)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_leftovers(dir: &Path) -> Vec<PathBuf> {
        fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.to_string_lossy().ends_with(".export-tmp"))
            .collect()
    }

    #[test]
    fn writes_a_new_file_and_cleans_its_temp() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("out.osr");
        atomic_write(&dest, b"payload", false).unwrap();
        assert_eq!(fs::read(&dest).unwrap(), b"payload");
        assert!(temp_leftovers(dir.path()).is_empty());
    }

    #[test]
    fn refuses_an_existing_destination_without_consent_and_leaves_it_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("out.osr");
        fs::write(&dest, b"original").unwrap();

        let err = atomic_write(&dest, b"new", false).unwrap_err();
        assert!(matches!(err, IpcError::FileExists { ref path } if path.contains("out.osr")));
        assert_eq!(fs::read(&dest).unwrap(), b"original");
        assert!(temp_leftovers(dir.path()).is_empty());
    }

    #[test]
    fn overwrite_consent_replaces_the_destination() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("out.osr");
        fs::write(&dest, b"original").unwrap();
        atomic_write(&dest, b"replacement", true).unwrap();
        assert_eq!(fs::read(&dest).unwrap(), b"replacement");
        assert!(temp_leftovers(dir.path()).is_empty());
    }

    #[test]
    fn the_no_replace_rename_itself_refuses_a_destination_that_appeared() {
        // the race the pre-check cannot close: a destination existing at
        // rename time fails the move atomically rather than clobbering
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("from.tmp");
        let to = dir.path().join("to.osr");
        fs::write(&from, b"x").unwrap();
        fs::write(&to, b"already here").unwrap();

        let err = rename_no_replace(&from, &to).unwrap_err();
        assert!(is_already_exists(&err));
        assert_eq!(fs::read(&to).unwrap(), b"already here");
    }

    #[test]
    fn a_failed_publish_deletes_the_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        // the destination is a directory, so the rename itself must fail
        let dest = dir.path().join("taken");
        fs::create_dir(&dest).unwrap();

        assert!(atomic_write(&dest, b"bytes", true).is_err());
        assert!(temp_leftovers(dir.path()).is_empty());
        assert!(dest.is_dir(), "the existing destination stays untouched");
    }

    #[test]
    fn a_missing_parent_fails_without_leftovers() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("no-such-dir").join("out.osr");
        assert!(matches!(atomic_write(&dest, b"bytes", false), Err(IpcError::Io { .. })));
        assert!(temp_leftovers(dir.path()).is_empty());
    }
}
