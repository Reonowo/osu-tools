//! leased .osz cache directories (spec, tauri layer): each extraction gets a
//! unique directory whose .lock file this process holds open and exclusively
//! locked for the lease's lifetime. the single-instance plugin is the
//! primary guard against cross-process races; the lock is the crash
//! backstop -- startup gc deletes exactly the directories nobody holds, so a
//! crash's leftovers are collected without ever racing a live instance

use std::fs::{self, File, TryLockError};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

const LOCK_FILE: &str = ".lock";
static LEASE_COUNTER: AtomicU64 = AtomicU64::new(0);

pub struct CacheLease {
    dir: PathBuf,
    lock: Option<File>,
}

impl CacheLease {
    pub fn dir(&self) -> &Path {
        &self.dir
    }
}

impl Drop for CacheLease {
    fn drop(&mut self) {
        // close (thereby unlocking) before deleting; a failed delete is left
        // for the next startup's gc rather than surfaced -- drop cannot fail
        drop(self.lock.take());
        let _ = fs::remove_dir_all(&self.dir);
    }
}

/// pid + a process-wide counter keeps names unique without wall-clock or
/// rng; a same-named leftover from a dead pid is unlocked by definition, so
/// it is deleted and replaced
pub fn create_leased_dir(root: &Path, label: &str) -> io::Result<CacheLease> {
    let seq = LEASE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let dir = root.join(format!("{label}-{}-{seq}", std::process::id()));
    if dir.exists() {
        fs::remove_dir_all(&dir)?;
    }
    fs::create_dir_all(&dir)?;
    let lock = File::create(dir.join(LOCK_FILE))?;
    lock.try_lock()
        .map_err(|e| io::Error::other(format!("fresh lock file already locked: {e}")))?;
    Ok(CacheLease {
        dir,
        lock: Some(lock),
    })
}

/// deletes every cache directory whose lock nobody holds. failures are
/// ignored on purpose: a directory that cannot be deleted right now (e.g. a
/// media handle still closing) is collected on a later startup
pub fn collect_orphans(root: &Path) {
    let Ok(entries) = fs::read_dir(root) else { return };
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let held_by_someone = match File::open(dir.join(LOCK_FILE)) {
            // the probe handle drops (and unlocks) at the end of this arm
            Ok(f) => matches!(f.try_lock(), Err(TryLockError::WouldBlock)),
            // no lock file: pre-scheme junk or a partially created dir
            Err(_) => false,
        };
        if !held_by_someone {
            let _ = fs::remove_dir_all(&dir);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_dropped_lease_deletes_its_directory() {
        let root = tempfile::tempdir().unwrap();
        let lease = create_leased_dir(root.path(), "abc").unwrap();
        let dir = lease.dir().to_path_buf();
        assert!(dir.is_dir());
        assert!(dir.join(".lock").is_file());
        drop(lease);
        assert!(!dir.exists());
    }

    #[test]
    fn lease_directories_are_unique_per_call() {
        let root = tempfile::tempdir().unwrap();
        let a = create_leased_dir(root.path(), "abc").unwrap();
        let b = create_leased_dir(root.path(), "abc").unwrap();
        assert_ne!(a.dir(), b.dir());
    }

    #[test]
    fn gc_collects_unlocked_leftovers_and_spares_held_leases() {
        let root = tempfile::tempdir().unwrap();

        // a live lease: lock held by this process
        let held = create_leased_dir(root.path(), "live").unwrap();

        // a crash leftover: lock file exists but nobody holds it
        let stale = root.path().join("stale-1-0");
        std::fs::create_dir_all(&stale).unwrap();
        std::fs::write(stale.join(".lock"), b"").unwrap();
        std::fs::write(stale.join("data.bin"), b"x").unwrap();

        // pre-lock-scheme junk: no lock file at all
        let junk = root.path().join("junk");
        std::fs::create_dir_all(&junk).unwrap();

        collect_orphans(root.path());

        assert!(held.dir().is_dir(), "a held lease must survive gc");
        assert!(!stale.exists(), "an unlocked leftover must be collected");
        assert!(!junk.exists(), "a lockless directory must be collected");
    }

    #[test]
    fn gc_tolerates_a_missing_root() {
        collect_orphans(std::path::Path::new(r"Z:\does\not\exist"));
    }
}
