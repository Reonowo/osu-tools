//! managed app state. the session outlives its command so the future editor
//! commands can mutate the document instead of reloading, and so the .osz
//! cache lease stays held exactly as long as its scene is the current one

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use crate::load::SessionState;
use crate::settings::{load_settings, Settings};
use crate::stable::ListingCache;

/// session identity for the editor commands: bumped at every scene install,
/// echoed on every editor call, so an edit aimed at a replaced session fails
/// StaleSession instead of silently applying to the new document
pub fn next_epoch() -> u64 {
    static EPOCH: AtomicU64 = AtomicU64::new(0);
    EPOCH.fetch_add(1, Ordering::Relaxed) + 1
}

pub struct AppState {
    pub config_dir: PathBuf,
    pub cache_root: PathBuf,
    /// where imported skins live. PERMANENT, unlike `cache_root`: a skin
    /// selection outlives the session, and orphan collection would eventually
    /// delete the directory the persisted locator points at (see `crate::osk`)
    pub skins_root: PathBuf,
    pub settings: Mutex<Settings>,
    /// arc so commands can hand the cache to spawn_blocking without holding
    /// the state borrow across an await
    pub listing_cache: Arc<ListingCache>,
    pub session: Mutex<Option<SessionState>>,
    /// orders the skin-selection writes against each other.
    ///
    /// the skin commands are async, because their disk work is unbounded and a
    /// sync command would run it on the webview thread. that costs the implicit
    /// ordering a sync command had for free: two overlapping picks now race, and
    /// without a ticket the SLOWER one persists last -- so the settings file
    /// would name a skin the user has already moved off, while the picker shows
    /// the newer one. the frontend's own sequence guard cannot fix this: by the
    /// time it drops the stale publication, the stale WRITE has landed
    pub skin_writes: Mutex<SkinWriteOrder>,
    /// serializes `.osk` imports against each other.
    ///
    /// the staging, retiring and destination directories are all derived from
    /// the skin's DECLARED name, so two imports of same-named archives share
    /// every path they touch: one would delete the other's extracted staging
    /// mid-swap and install the remains over the user's existing copy. a sync
    /// command got this exclusion for free from the ipc thread; an async one
    /// has to say it. an `Arc` so the blocking closure can hold it without a
    /// `State` borrow crossing the await, as `listing_cache` already does
    pub import_lock: Arc<Mutex<()>>,
}

/// hands out a ticket per skin-selection write and lets only the newest-issued
/// one that reaches the write actually persist
#[derive(Debug, Default)]
pub struct SkinWriteOrder {
    issued: u64,
    persisted: u64,
}

impl SkinWriteOrder {
    /// claimed BEFORE the load, so the ticket records call order rather than
    /// completion order -- which is the ordering a sync command used to give
    pub fn issue(&mut self) -> u64 {
        self.issued += 1;
        self.issued
    }

    /// whether this ticket may still write. false once a newer one has, so an
    /// older pick finishing late leaves the newer selection standing
    pub fn claim(&mut self, ticket: u64) -> bool {
        if ticket <= self.persisted {
            return false;
        }
        self.persisted = ticket;
        true
    }
}

impl AppState {
    pub fn new(config_dir: PathBuf, cache_root: PathBuf, skins_root: PathBuf) -> AppState {
        let settings = load_settings(&config_dir);
        AppState {
            config_dir,
            cache_root,
            skins_root,
            settings: Mutex::new(settings),
            listing_cache: Arc::new(ListingCache::default()),
            session: Mutex::new(None),
            skin_writes: Mutex::new(SkinWriteOrder::default()),
            import_lock: Arc::new(Mutex::new(())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::SkinWriteOrder;

    #[test]
    fn only_the_newest_issued_ticket_persists() {
        // the shape the async commands race in: a slow pick is issued first, a
        // fast one second, and the fast one reaches the write first. the slow
        // one must NOT then overwrite it -- the user moved off that skin
        let mut order = SkinWriteOrder::default();
        let slow = order.issue();
        let fast = order.issue();

        assert!(order.claim(fast), "the newer pick writes");
        assert!(!order.claim(slow), "the older pick, finishing late, does not");
    }

    #[test]
    fn writes_that_do_not_overlap_all_persist() {
        // the ordinary case: one pick at a time, each writing in turn
        let mut order = SkinWriteOrder::default();
        for _ in 0..3 {
            let ticket = order.issue();
            assert!(order.claim(ticket));
        }
    }

    #[test]
    fn a_ticket_cannot_write_twice() {
        let mut order = SkinWriteOrder::default();
        let ticket = order.issue();
        assert!(order.claim(ticket));
        assert!(!order.claim(ticket), "replaying a ticket is not a second write");
    }
}
