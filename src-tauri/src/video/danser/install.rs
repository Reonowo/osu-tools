//! the download-on-first-use install (spec, danser acquisition): fetch the
//! pinned release zip, verify its hardcoded sha-256 before a byte is
//! unpacked, unpack into a temp sibling of the versioned dir, and atomically
//! rename it into place -- the versioned dir's presence is the completeness
//! marker, so a crash mid-unpack never reads as installed. a failed download
//! keeps no resume state and never touches disk (the zip is buffered whole;
//! the next attempt simply re-downloads), older version dirs are deleted
//! only after a successful new-version install, and unrenamed unpack temps
//! are swept at startup

use std::io::Read;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use sha2::{Digest, Sha256};

use crate::error::IpcError;
use crate::video::CancelToken;

/// the marker every not-yet-renamed unpack dir carries; the sweep identifies
/// temps by it, and a completed install never contains it
const UNPACK_MARKER: &str = ".unpack-";

/// the marker a replaced-but-not-yet-deleted install carries while a
/// re-install publishes over it. deliberately NOT [`UNPACK_MARKER`]: an
/// unpack temp is half-written and always expendable, while a retired dir is
/// a COMPLETE install that was working a moment ago, so a crash mid-replace
/// makes it the only copy left. the sweep restores it rather than deleting it
const RETIRE_MARKER: &str = ".retired-";

/// the whole request/response deadline. bounding the LENGTH stops a runaway
/// body from exhausting memory, but not a server that stalls or drips the
/// pinned ~31 MB forever -- and while it drips it holds the one video
/// operation slot, so no export can run again until the app restarts.
/// generous enough for the asset over a slow link, finite either way
const DOWNLOAD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(600);

static INSTALL_COUNTER: AtomicU64 = AtomicU64::new(0);

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// reads the whole payload, reporting 0-100 progress against `expected_len`
/// when it is known. the pinned asset is ~31 MB, so buffering it whole is
/// cheaper than a resumable protocol nothing needs.
///
/// the pin records that asset's EXACT size, which makes the length a cap and
/// not merely a hint: the body is untrusted until the sha-256 runs, so a
/// chunked or simply wrong response would otherwise grow this buffer until
/// the process died -- with the install slot held and the dialog stuck. a
/// body longer than the pin is refused the moment it passes it, and one
/// shorter is refused at eof rather than handed to a hash that will reject
/// it anyway with a less useful message
fn read_with_progress(
    mut reader: impl Read,
    expected_len: Option<u64>,
    progress: &(dyn Fn(Option<f64>) + Sync),
    cancel: &CancelToken,
) -> std::io::Result<Vec<u8>> {
    let mut bytes = Vec::with_capacity(expected_len.unwrap_or(0).min(256 * 1024 * 1024) as usize);
    let mut chunk = [0u8; 64 * 1024];
    loop {
        // between chunks is every point this loop is not blocked in the
        // socket: a cancel raised while bytes are flowing is honoured within
        // one 64 KB read. a server that has stopped sending entirely is the
        // one case this cannot reach, because the thread is then parked inside
        // `read` -- that stretch stays bounded by the request timeout instead
        if cancel.is_cancelled() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                "the download was cancelled",
            ));
        }
        let read = reader.read(&mut chunk)?;
        if read == 0 {
            if let Some(total) = expected_len {
                if (bytes.len() as u64) < total {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::UnexpectedEof,
                        format!("the download ended at {} bytes, short of the pinned {total}", bytes.len()),
                    ));
                }
            }
            return Ok(bytes);
        }
        bytes.extend_from_slice(&chunk[..read]);
        if let Some(total) = expected_len {
            if (bytes.len() as u64) > total {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("the download ran past the pinned {total} bytes"),
                ));
            }
        }
        progress(
            expected_len.and_then(|total| {
                (total > 0).then(|| (bytes.len() as f64 / total as f64 * 100.0).min(100.0))
            }),
        );
    }
}

/// verify + unpack + publish, split from the download so the whole install
/// protocol tests against a crafted zip with no network anywhere
pub fn install_zip_bytes(
    zip_bytes: &[u8],
    expected_sha256: &str,
    zip_label: &str,
    root: &Path,
    version: &str,
    cancel: &CancelToken,
) -> Result<(), IpcError> {
    let actual = hex(&Sha256::digest(zip_bytes));
    if !actual.eq_ignore_ascii_case(expected_sha256) {
        // the hard fail the spec calls for, showing both hashes -- nothing
        // is unpacked past this point
        return Err(IpcError::Io {
            message: format!("checksum mismatch for {zip_label}: expected {expected_sha256}, got {actual}"),
        });
    }

    std::fs::create_dir_all(root)?;
    let seq = INSTALL_COUNTER.fetch_add(1, Ordering::Relaxed);
    let temp = root.join(format!("{version}{UNPACK_MARKER}{}-{seq}", std::process::id()));
    if temp.exists() {
        std::fs::remove_dir_all(&temp)?;
    }
    let unpacked = unpack_into(zip_bytes, &temp, cancel);
    if unpacked.is_err() {
        // the temp goes whichever way it failed, so a cancel mid-unpack
        // leaves nothing behind at all -- and even a crash before this line
        // leaves only a marker-named dir the startup sweep collects, never
        // one `installed()` would read as a version
        let _ = std::fs::remove_dir_all(&temp);
        unpacked?;
    }
    // the publication cutoff, and the reason it is a line of its own: the
    // unpack loop checks the token per member, so a cancel arriving while the
    // LAST member was still extracting returns Ok from a loop that had nothing
    // left to check. nothing is published yet at this point, so that cancel is
    // still a cancel. past the rename below the install stands and the caller
    // keeps it (skipping only the probe) -- so this is the exact instant the
    // race between the two policies is decided, rather than an accident of
    // which member happened to be last
    if cancel.is_cancelled() {
        let _ = std::fs::remove_dir_all(&temp);
        return Err(IpcError::Cancelled);
    }

    let dest = root.join(version);
    // a re-install over a present version replaces it whole, and the old
    // install is renamed ASIDE rather than deleted in place: a delete that
    // stops partway -- a crash, an antivirus hold, one locked dll -- leaves
    // `dest` present but gutted, and presence is the very thing
    // `installed()` trusts, so the wreckage would certify as a
    // checksum-verified install forever. both steps are renames, so `dest`
    // only ever names a complete install: the old one or the new one
    let retired = dest
        .exists()
        .then(|| root.join(format!("{version}{RETIRE_MARKER}{}-{seq}", std::process::id())));
    if let Some(retired) = &retired {
        if let Err(e) = std::fs::rename(&dest, retired) {
            let _ = std::fs::remove_dir_all(&temp);
            return Err(e.into());
        }
    }
    if let Err(e) = std::fs::rename(&temp, &dest) {
        let _ = std::fs::remove_dir_all(&temp);
        // the publish failed, so put the working install back rather than
        // leaving the user with nothing installed
        if let Some(retired) = &retired {
            let _ = std::fs::rename(retired, &dest);
        }
        return Err(e.into());
    }
    if let Some(retired) = &retired {
        // best effort by design: the marker name means a leftover this could
        // not delete is swept at the next startup, and never read as a version
        let _ = std::fs::remove_dir_all(retired);
    }

    remove_other_versions(root, version);
    Ok(())
}

fn unpack_into(zip_bytes: &[u8], temp: &Path, cancel: &CancelToken) -> Result<(), IpcError> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(zip_bytes)).map_err(|e| IpcError::Io {
        message: format!("the downloaded archive did not open: {e}"),
    })?;
    std::fs::create_dir_all(temp)?;
    for index in 0..archive.len() {
        // per member: the release is hundreds of files and unpacking them all
        // is the slowest stretch after the download itself
        if cancel.is_cancelled() {
            return Err(IpcError::Cancelled);
        }
        let mut member = archive.by_index(index).map_err(|e| IpcError::Io {
            message: format!("archive member {index} did not read: {e}"),
        })?;
        // the checksum makes a hostile member name a supply-chain event
        // rather than an input-handling one, but the extraction boundary is
        // held to the same rule every other archive boundary here is:
        // `osz::safe_relative_path` rebuilds the name from validated
        // components, because `enclosed_name()` is push-built and can hand
        // back a windows drive-relative name like `c:evil.dll` that DISCARDS
        // the root it is joined to (osz.rs documents the case at length).
        // fail closed on the whole archive, never skip the member: skipping
        // would install a danser missing whichever file was named unsafely
        let Some(relative) = crate::osz::safe_relative_path(member.name()) else {
            return Err(IpcError::Io {
                message: format!("unsafe archive entry name {:?}", member.name()),
            });
        };
        let out = temp.join(relative);
        if member.is_dir() {
            std::fs::create_dir_all(&out)?;
            continue;
        }
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut file = std::fs::File::create(&out)?;
        std::io::copy(&mut member, &mut file)?;
    }
    Ok(())
}

/// deletes every sibling version dir after a successful install: the pin is
/// singular, and a superseded install is dead weight the settings can never
/// point at
fn remove_other_versions(root: &Path, keep: &str) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if path.is_dir() && name != keep && !name.contains(UNPACK_MARKER) {
            let _ = std::fs::remove_dir_all(&path);
        }
    }
}

/// the pinned download, streamed with progress and handed to the offline
/// protocol above. `expected_len` prefers the pin's recorded size so the
/// progress bar is honest even when the server omits a content length
pub fn download_and_install(
    url: &str,
    expected_len: u64,
    expected_sha256: &str,
    zip_label: &str,
    root: &Path,
    version: &str,
    progress: &(dyn Fn(Option<f64>) + Sync),
    cancel: &CancelToken,
) -> Result<(), IpcError> {
    if cancel.is_cancelled() {
        return Err(IpcError::Cancelled);
    }
    let response = ureq::get(url)
        .timeout(DOWNLOAD_TIMEOUT)
        .call()
        .map_err(|e| IpcError::Io {
            message: format!("downloading {zip_label} failed: {e}"),
        })?;
    let bytes = read_with_progress(response.into_reader(), Some(expected_len), progress, cancel)
        .map_err(|e| {
            // a cancelled download is the user's own act, not a network
            // failure, and must not reach them worded as one
            if cancel.is_cancelled() {
                return IpcError::Cancelled;
            }
            IpcError::Io {
                message: format!("downloading {zip_label} failed: {e}"),
            }
        })?;
    install_zip_bytes(&bytes, expected_sha256, zip_label, root, version, cancel)
}

/// startup sweep beside the other gc passes: unrenamed unpack temps are a
/// crash's and always go. version dirs are never touched here -- presence is
/// the completeness marker this sweep exists to keep truthful.
///
/// a RETIRED dir is the other case, and it is not garbage: a re-install
/// renames the working install aside before publishing the new one, so a
/// crash in that window leaves the retired copy as the only complete install
/// on disk. deleting it the way an unpack temp is deleted would turn a
/// crashed re-install into "your renderer is gone, download it again", so the
/// version it names is restored when nothing occupies it, and only dropped
/// once a complete install already stands there
pub fn sweep_install_temps(root: &Path) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if !path.is_dir() {
            continue;
        }
        // a name that is all marker leaves an empty version, and `root.join("")`
        // is `root` itself -- which `is_dir()` always answers true for, so such
        // a dir would be treated as a spent retired copy and deleted on a
        // reading of the root that means nothing. malformed marker names are
        // left alone instead; only a name that actually carries a version is
        // acted on. (the version this splits on is `DANSER_VERSION`, a const,
        // so a version string containing either marker is not reachable today
        // -- a pin bump that introduced one would need this parser revisited)
        if let Some((version, _)) = name.split_once(RETIRE_MARKER).filter(|(v, _)| !v.is_empty()) {
            let dest = root.join(version);
            if dest.is_dir() {
                // the publish did land; the retired copy is spent
                let _ = std::fs::remove_dir_all(&path);
            } else {
                // the crash window: put the working install back
                let _ = std::fs::rename(&path, &dest);
            }
            continue;
        }
        if name.contains(UNPACK_MARKER) {
            let _ = std::fs::remove_dir_all(&path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// a tiny zip holding the members `entries` names, plus its sha-256
    fn test_zip(entries: &[(&str, &[u8])]) -> (Vec<u8>, String) {
        let mut cursor = std::io::Cursor::new(Vec::new());
        let mut writer = zip::ZipWriter::new(&mut cursor);
        for (name, bytes) in entries {
            writer
                .start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            writer.write_all(bytes).unwrap();
        }
        writer.finish().unwrap();
        let bytes = cursor.into_inner();
        let sha = hex(&Sha256::digest(&bytes));
        (bytes, sha)
    }

    // the install protocol's own tests are about the protocol, not about
    // cancellation, so they call through these: a locally defined item wins
    // over the glob import above, which keeps every existing case reading as
    // it did while the real entry points carry the token. the cancellation
    // cases below reach past them to `super::` deliberately
    fn install_zip_bytes(
        zip_bytes: &[u8],
        expected_sha256: &str,
        zip_label: &str,
        root: &Path,
        version: &str,
    ) -> Result<(), IpcError> {
        super::install_zip_bytes(
            zip_bytes,
            expected_sha256,
            zip_label,
            root,
            version,
            &CancelToken::default(),
        )
    }

    fn read_with_progress(
        reader: impl Read,
        expected_len: Option<u64>,
        progress: &(dyn Fn(Option<f64>) + Sync),
    ) -> std::io::Result<Vec<u8>> {
        super::read_with_progress(reader, expected_len, progress, &CancelToken::default())
    }

    #[test]
    fn a_cancelled_unpack_publishes_no_version_and_leaves_no_temp() {
        // the user's cancel during the slowest stretch of an install: nothing
        // may land under a name `installed()` would trust, and nothing may be
        // left for the startup sweep to have to collect either
        let root = tempfile::tempdir().unwrap();
        let (bytes, sha) = test_zip(&[
            ("danser-cli.exe", b"exe".as_slice()),
            ("ffmpeg/ffmpeg.exe", b"ff".as_slice()),
        ]);
        let cancel = CancelToken::default();
        cancel.cancel();

        let failed =
            super::install_zip_bytes(&bytes, &sha, "test.zip", root.path(), "0.11.0", &cancel).unwrap_err();
        assert!(matches!(failed, IpcError::Cancelled), "{failed:?}");
        assert!(
            !root.path().join("0.11.0").exists(),
            "a cancelled install must never publish a version dir"
        );
        let leftovers: Vec<_> = std::fs::read_dir(root.path())
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
    }

    #[test]
    fn a_cancelled_download_stops_reading_rather_than_buffering_the_asset() {
        // the cancel is checked before each chunk, so a download already in
        // flight stops at the next one instead of running to the pinned length
        let cancel = CancelToken::default();
        cancel.cancel();
        let payload = vec![7u8; 256 * 1024];
        let len = Some(payload.len() as u64);
        let failed = super::read_with_progress(payload.as_slice(), len, &|_| {}, &cancel).unwrap_err();
        assert_eq!(failed.kind(), std::io::ErrorKind::Interrupted, "{failed:?}");
    }

    #[test]
    fn a_verified_zip_lands_as_the_versioned_dir_with_no_temp_left() {
        let root = tempfile::tempdir().unwrap();
        let (bytes, sha) = test_zip(&[
            ("danser-cli.exe", b"exe".as_slice()),
            ("ffmpeg/ffmpeg.exe", b"ff".as_slice()),
        ]);

        install_zip_bytes(&bytes, &sha, "test.zip", root.path(), "0.11.0").unwrap();
        let install = root.path().join("0.11.0");
        assert_eq!(std::fs::read(install.join("danser-cli.exe")).unwrap(), b"exe");
        assert_eq!(
            std::fs::read(install.join("ffmpeg").join("ffmpeg.exe")).unwrap(),
            b"ff"
        );
        let temps: Vec<_> = std::fs::read_dir(root.path())
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains(UNPACK_MARKER))
            .collect();
        assert!(temps.is_empty(), "{temps:?}");
    }

    #[test]
    fn a_hash_mismatch_hard_fails_showing_both_hashes_and_unpacks_nothing() {
        let root = tempfile::tempdir().unwrap();
        let (bytes, real_sha) = test_zip(&[("danser-cli.exe", b"exe".as_slice())]);
        let pinned = "0".repeat(64);

        let err = install_zip_bytes(&bytes, &pinned, "test.zip", root.path(), "0.11.0").unwrap_err();
        let IpcError::Io { message } = err else {
            panic!("expected Io, got {err:?}");
        };
        assert!(message.contains(&pinned), "{message}");
        assert!(message.contains(&real_sha), "{message}");
        assert!(
            !root.path().join("0.11.0").exists(),
            "nothing may be unpacked from an unverified archive"
        );
    }

    #[test]
    fn older_version_dirs_are_removed_only_by_a_successful_install() {
        let root = tempfile::tempdir().unwrap();
        let old = root.path().join("0.10.0");
        std::fs::create_dir_all(&old).unwrap();

        // a failed install (bad hash) leaves the old version alone
        let (bytes, _) = test_zip(&[("danser-cli.exe", b"exe".as_slice())]);
        assert!(install_zip_bytes(&bytes, &"0".repeat(64), "z", root.path(), "0.11.0").is_err());
        assert!(old.is_dir(), "a failed install must not delete the working one");

        // a successful one supersedes it
        let (bytes, sha) = test_zip(&[("danser-cli.exe", b"exe".as_slice())]);
        install_zip_bytes(&bytes, &sha, "z", root.path(), "0.11.0").unwrap();
        assert!(!old.exists());
        assert!(root.path().join("0.11.0").is_dir());
    }

    #[test]
    fn reinstalling_over_a_present_version_replaces_it_whole() {
        let root = tempfile::tempdir().unwrap();
        let (bytes, sha) = test_zip(&[("danser-cli.exe", b"new".as_slice())]);
        let install = root.path().join("0.11.0");
        std::fs::create_dir_all(&install).unwrap();
        std::fs::write(install.join("stale.dll"), b"old").unwrap();

        install_zip_bytes(&bytes, &sha, "z", root.path(), "0.11.0").unwrap();
        assert_eq!(std::fs::read(install.join("danser-cli.exe")).unwrap(), b"new");
        assert!(
            !install.join("stale.dll").exists(),
            "the previous contents are gone"
        );
        // the old install is renamed aside rather than deleted in place, so
        // the replacement leaves no marked leftover behind either -- and
        // whatever a locked file did leave could only be a marked dir the
        // startup sweep collects, never something `installed()` would trust
        let leftovers: Vec<String> = std::fs::read_dir(root.path())
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains(UNPACK_MARKER) || name.contains(RETIRE_MARKER))
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
    }

    #[test]
    fn a_name_that_is_all_marker_is_left_alone_rather_than_acted_on() {
        // `root.join("")` is `root` itself, which `is_dir()` always answers
        // true for -- so an unguarded empty version would read the root as
        // "the install already landed" and delete the stray dir on the
        // strength of a check that never looked at anything real
        let root = tempfile::tempdir().unwrap();
        let install = root.path().join("0.11.0");
        std::fs::create_dir_all(&install).unwrap();
        std::fs::write(install.join("danser-cli.exe"), b"working").unwrap();
        let stray = root.path().join(format!("{RETIRE_MARKER}odd"));
        std::fs::create_dir_all(&stray).unwrap();

        sweep_install_temps(root.path());

        assert!(install.is_dir(), "the real install is untouched");
        assert_eq!(std::fs::read(install.join("danser-cli.exe")).unwrap(), b"working");
        assert!(stray.is_dir(), "an unparseable name is left alone, not acted on");
    }

    #[test]
    fn a_crash_between_retiring_and_publishing_gets_the_working_install_back() {
        // the window the retire marker exists to survive: the old install has
        // been renamed aside and the new one has not landed yet. the retired
        // copy is the only COMPLETE install on disk at that instant, so the
        // startup sweep must restore it -- treating it like an unpack temp
        // would turn a crashed re-install into a lost renderer
        let root = tempfile::tempdir().unwrap();
        let retired = root.path().join(format!("0.11.0{RETIRE_MARKER}999-0"));
        std::fs::create_dir_all(&retired).unwrap();
        std::fs::write(retired.join("danser-cli.exe"), b"working").unwrap();
        // and a genuine unpack temp beside it, which always goes
        let temp = root.path().join(format!("0.11.0{UNPACK_MARKER}999-1"));
        std::fs::create_dir_all(&temp).unwrap();

        sweep_install_temps(root.path());

        let restored = root.path().join("0.11.0");
        assert!(restored.is_dir(), "the retired install is back under its version");
        assert_eq!(
            std::fs::read(restored.join("danser-cli.exe")).unwrap(),
            b"working"
        );
        assert!(!retired.exists(), "and no longer under the marker");
        assert!(!temp.exists(), "the unpack temp still goes");
    }

    #[test]
    fn a_retired_copy_is_dropped_once_a_complete_install_stands_in_its_place() {
        // the crash-after-publish half: the new install landed and only the
        // best-effort delete was missed, so the retired copy is spent
        let root = tempfile::tempdir().unwrap();
        let install = root.path().join("0.11.0");
        std::fs::create_dir_all(&install).unwrap();
        std::fs::write(install.join("danser-cli.exe"), b"new").unwrap();
        let retired = root.path().join(format!("0.11.0{RETIRE_MARKER}999-0"));
        std::fs::create_dir_all(&retired).unwrap();
        std::fs::write(retired.join("danser-cli.exe"), b"old").unwrap();

        sweep_install_temps(root.path());

        assert!(!retired.exists(), "the spent copy goes");
        assert_eq!(
            std::fs::read(install.join("danser-cli.exe")).unwrap(),
            b"new",
            "and never overwrites the install that did land"
        );
    }

    #[test]
    fn a_failed_replacement_leaves_the_working_install_rather_than_a_gutted_one() {
        // the window the rename-aside exists to close: presence is the whole
        // completeness marker, so an install that fails while replacing must
        // leave `dest` either untouched or complete -- never present-but-empty.
        // a hostile member fails the unpack, which is the reachable failure
        // between "an install exists" and "the new one is published"
        let root = tempfile::tempdir().unwrap();
        let install = root.path().join("0.11.0");
        std::fs::create_dir_all(&install).unwrap();
        std::fs::write(install.join("danser-cli.exe"), b"working").unwrap();

        let (bytes, sha) = test_zip(&[("../escape.dll", b"evil".as_slice())]);
        assert!(install_zip_bytes(&bytes, &sha, "z", root.path(), "0.11.0").is_err());

        assert!(install.is_dir(), "the working install still stands");
        assert_eq!(
            std::fs::read(install.join("danser-cli.exe")).unwrap(),
            b"working",
            "and it is the complete one, not a gutted survivor"
        );
    }

    #[test]
    fn the_sweep_clears_unpack_temps_but_never_a_version_dir() {
        let root = tempfile::tempdir().unwrap();
        let version = root.path().join("0.11.0");
        let temp = root.path().join("0.11.0.unpack-123-0");
        std::fs::create_dir_all(&version).unwrap();
        std::fs::create_dir_all(&temp).unwrap();

        sweep_install_temps(root.path());
        assert!(
            version.is_dir(),
            "presence is the completeness marker; the sweep keeps it true"
        );
        assert!(!temp.exists());

        sweep_install_temps(Path::new(r"Z:\does\not\exist"));
    }

    #[test]
    fn a_body_longer_than_the_pin_is_refused_before_it_can_exhaust_memory() {
        // the body is untrusted until the sha-256 runs, and the pin records
        // the asset's exact size -- so a response that keeps going is refused
        // the moment it passes it, not buffered until the process dies
        let payload = vec![7u8; 300 * 1024];
        let err = read_with_progress(payload.as_slice(), Some(100 * 1024), &|_| {}).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidData, "{err}");
    }

    #[test]
    fn a_truncated_body_is_refused_rather_than_hashed() {
        let payload = vec![7u8; 50 * 1024];
        let err = read_with_progress(payload.as_slice(), Some(100 * 1024), &|_| {}).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::UnexpectedEof, "{err}");
    }

    #[test]
    fn an_unsafe_member_name_rejects_the_whole_archive() {
        // the case osz.rs documents: a drive-relative segment survives
        // enclosed_name's push-built path and DISCARDS the root it is joined
        // to. the install boundary fails closed on it, like every other
        // archive boundary in this crate
        let root = tempfile::tempdir().unwrap();
        for name in ["wrapper/c:evil.dll", "../escape.dll", "/absolute.dll"] {
            let (bytes, sha) = test_zip(&[(name, b"x".as_slice())]);
            let err = install_zip_bytes(&bytes, &sha, "z", root.path(), "0.11.0").unwrap_err();
            let IpcError::Io { message } = err else {
                panic!("expected Io for {name}");
            };
            assert!(message.contains("unsafe archive entry name"), "{name}: {message}");
            assert!(
                !root.path().join("0.11.0").exists(),
                "{name} must leave no install behind"
            );
        }
    }

    #[test]
    fn download_progress_reports_against_the_pinned_length() {
        let payload = vec![7u8; 200 * 1024];
        let reported = std::sync::Mutex::new(Vec::new());
        let bytes = read_with_progress(payload.as_slice(), Some(payload.len() as u64), &|p| {
            if let Some(p) = p {
                reported.lock().unwrap().push(p);
            }
        })
        .unwrap();
        assert_eq!(bytes, payload);
        let reported = reported.into_inner().unwrap();
        assert!(!reported.is_empty());
        assert!(reported.windows(2).all(|w| w[0] <= w[1]), "monotonic");
        assert_eq!(*reported.last().unwrap(), 100.0);
    }
}
