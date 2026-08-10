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
    pub settings: Mutex<Settings>,
    /// arc so commands can hand the cache to spawn_blocking without holding
    /// the state borrow across an await
    pub listing_cache: Arc<ListingCache>,
    pub session: Mutex<Option<SessionState>>,
}

impl AppState {
    pub fn new(config_dir: PathBuf, cache_root: PathBuf) -> AppState {
        let settings = load_settings(&config_dir);
        AppState {
            config_dir,
            cache_root,
            settings: Mutex::new(settings),
            listing_cache: Arc::new(ListingCache::default()),
            session: Mutex::new(None),
        }
    }
}
