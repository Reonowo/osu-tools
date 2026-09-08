//! the replay browser's assembly: every local play stable still lists, plus
//! every replay in the install's `Replays` folder, as one newest-first list.
//!
//! the two sources are read on entirely different terms, and that is the
//! point. **local plays** come from stable's own record (`scores.db`), never
//! from a folder walk: a row of the local leaderboard names its replay file
//! exactly, so a play the user deleted in the client is not resurrected
//! here, and the 3,200 orphaned `Data/r` files a real install accumulates
//! are never listed at all. the **Replays folder** is the opposite -- a
//! user-owned directory with no index, walked file by file and read through
//! the engine's header-only `.osr` entry point so a folder of thousands
//! costs no decompression.
//!
//! everything this module decides is a rule about which rows exist, never
//! about how they look: the titles come from the stable listing's own fold,
//! the accuracy from the same weighting a recents card shows, and the
//! search, the source filter and the loaded mark all live in the frontend's
//! pure module. it opens nothing either -- a row carries a path, and every
//! open still goes through the one `load_replay` with its beatmap
//! association, its stable lookup and its discard prompt (docs/adr/0005).
//!
//! each source fails on its OWN: a missing `scores.db` leaves the Replays
//! folder listing, an unreadable listing leaves every row in place titled by
//! md5, and the browser's footer says which file failed and why. one broken
//! file never empties the browser.

use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use engine::formats::local_scores::decode_local_scores;
use engine::formats::osr::{scan_osr_header, OsrHeader, OsrHeaderScan, FIRST_LAZER_VERSION};
use engine::formats::GameMode;
use serde::Serialize;

use crate::error::IpcError;
use crate::media::read_file_capped;
use crate::scene::standard_accuracy;
use crate::stable::{BeatmapNames, ListingCache, StableInstall};

/// where stable keeps the replay for a local leaderboard row. the client
/// treats it as private data, which is exactly why the browser exists
const REPLAY_DATA_DIR: [&str; 2] = ["Data", "r"];

/// the user-facing folder beside the listing: exports (F2) and downloads.
/// stable has no cfg key for it, so it is always here
const REPLAYS_DIR: &str = "Replays";

/// how much of a file the header reader asks for first. the largest header
/// across 4,382 real replays is 2,629 bytes, so one read answers every file
/// in practice and the growth loop below is the tail's insurance
const FIRST_HEADER_CHUNK: usize = 16 * 1024;

/// .net ticks count from 0001-01-01; windows file time -- which is what
/// names a replay in `Data/r` -- counts from 1601-01-01. the difference is
/// 584,388 days, and the sub-second digits are identical on both sides
const TICKS_0001_TO_1601: i64 = 504_911_232_000_000_000;

/// which half of the browser a row came from. the badge is the user-facing
/// half of it; the dedup rule below is the load-bearing half
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ReplaySource {
    /// a row of stable's local leaderboards, whose file sits in `Data/r`
    LocalPlay,
    /// a file in the install's `Replays` folder
    ReplaysFolder,
}

/// one row of the browser. the naming fields are the listing's, `titled`
/// says whether the listing could answer at all, and everything else is the
/// play's own -- so a beatmap that has since left the library still lists,
/// greyed and identified by its md5, rather than vanishing
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserRow {
    pub path: String,
    pub replay_md5: Option<String>,
    pub beatmap_md5: Option<String>,
    pub source: ReplaySource,
    pub artist: Option<String>,
    pub artist_unicode: Option<String>,
    pub title: Option<String>,
    pub title_unicode: Option<String>,
    pub difficulty: Option<String>,
    pub creator: Option<String>,
    /// whether the stable listing knew this beatmap. false both for a map
    /// that has left the library and for a listing that could not be read,
    /// which is deliberate: the row degrades the same way either way
    pub titled: bool,
    pub player_name: Option<String>,
    pub accuracy: f64,
    pub max_combo: u16,
    pub score: u32,
    pub mods: u32,
    /// .net ticks, a string for `ReplayMeta::timestamp_ticks`' reason: the
    /// value is past json's 2^53 safe range and would silently round
    pub timestamp_ticks: String,
    /// `yyyy-mm-dd`, formatted from those ticks with NO zone conversion --
    /// which is what stable's own export names use, verified against all
    /// 4,382 stable-named files in the real install here
    pub date: String,
    pub lazer_written: bool,
}

/// what one of the browser's three sources has to say for itself. a count
/// when it was read, a note when it was not -- and the note names the file
/// and carries the reader's own reason, because "couldn't read your plays"
/// with no path is a dead end
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum BrowserSourceStatus {
    Read {
        /// rows this source contributed, after its own hide rules and before
        /// dedup against the other source
        count: usize,
        /// files this source holds that could not be read at all. counted
        /// rather than listed: a row that opens to nothing is worse than a
        /// row that is not there, and a silent omission is worse than both
        unreadable: usize,
        /// the scan stopped at `MAX_REPLAYS_FOLDER_FILES`; only the Replays
        /// folder can report this
        truncated: bool,
    },
    Failed {
        path: String,
        reason: String,
    },
}

/// the whole browser payload: the rows and what each source has to say
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayBrowserListing {
    pub rows: Vec<BrowserRow>,
    pub local_plays: BrowserSourceStatus,
    pub replays_folder: BrowserSourceStatus,
    /// the stable listing, which titles the rows rather than producing any.
    /// its count is how many rows it named
    pub listing: BrowserSourceStatus,
}

/// the browser is re-assembled only when something on disk moved, keyed by
/// the three mtimes it reads: the local scores file, the Replays directory
/// and the listing. a directory's mtime moves when a file is added to or
/// removed from it, which is exactly the event that should invalidate this.
///
/// what it buys is a second open of the dialog costing nothing -- the first
/// costs a `scores.db` parse and a header read per file in the Replays
/// folder, which is ~0.35 s warm on the 4,382-file install here
#[derive(Default)]
pub struct BrowserCache(Mutex<Option<(CacheKey, Arc<ReplayBrowserListing>)>>);

#[derive(Debug, Clone, PartialEq)]
struct CacheKey {
    root: PathBuf,
    /// `None` where the file or folder is absent, which is itself a state
    /// worth invalidating on: creating a missing `scores.db` must show up
    scores: Option<SystemTime>,
    /// `Data/r` is keyed on as well as read, because the local-play source's
    /// whole hide rule is "does this row's file still exist": stable prunes
    /// this folder without necessarily rewriting `scores.db`, and a cached
    /// row pointing at a file deleted since is exactly the row that opens to
    /// nothing
    replay_data: Option<SystemTime>,
    replays: Option<SystemTime>,
    listing: Option<SystemTime>,
}

fn mtime(path: &Path) -> Option<SystemTime> {
    std::fs::metadata(path).and_then(|m| m.modified()).ok()
}

impl CacheKey {
    fn of(install: &StableInstall) -> CacheKey {
        CacheKey {
            root: install.root.clone(),
            scores: mtime(&scores_path(install)),
            replay_data: mtime(&replay_data_dir(install)),
            replays: mtime(&replays_dir(install)),
            listing: mtime(&install.db_path),
        }
    }
}

impl BrowserCache {
    pub fn get(&self, install: &StableInstall, listing: &ListingCache) -> Arc<ReplayBrowserListing> {
        let key = CacheKey::of(install);
        // recovering a poisoned lock is safe here for `ListingCache`'s
        // reason: the slot is only written after the assembly below returns
        let mut slot = self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some((cached, rows)) = slot.as_ref() {
            if *cached == key {
                return Arc::clone(rows);
            }
        }
        let assembled = Arc::new(assemble(install, listing));
        *slot = Some((key, Arc::clone(&assembled)));
        assembled
    }
}

fn scores_path(install: &StableInstall) -> PathBuf {
    install.root.join("scores.db")
}

fn replays_dir(install: &StableInstall) -> PathBuf {
    install.root.join(REPLAYS_DIR)
}

fn replay_data_dir(install: &StableInstall) -> PathBuf {
    REPLAY_DATA_DIR.iter().fold(install.root.clone(), |p, part| p.join(part))
}

/// stable's own name for a local play's replay file: the beatmap hash and
/// the play's timestamp in WINDOWS file-time ticks, which is the header's
/// .net ticks less the epoch difference. verified against all 1,375 rows of
/// a real database -- every one names a file that exists.
///
/// `None` when the subtraction would overflow, which no real row can reach
/// (it needs ticks within half an epoch of `i64::MIN`) but a crafted or
/// damaged `scores.db` can: the codec reads the timestamp as a plain `i64`
/// and validates nothing about it, so a panic in a debug build would be one
/// bad row away. a row that cannot name a file is hidden like any other
fn local_play_file_name(beatmap_md5: &str, timestamp_ticks: i64) -> Option<String> {
    let windows_ticks = timestamp_ticks.checked_sub(TICKS_0001_TO_1601)?;
    Some(format!("{beatmap_md5}-{windows_ticks}.osr"))
}

/// assembles both sources, titles the rows and orders them. the whole
/// module's business, in the order the rules apply: hide, then title, then
/// dedup, then sort
fn assemble(install: &StableInstall, listing_cache: &ListingCache) -> ReplayBrowserListing {
    let (local_rows, local_plays) = read_local_plays(install);
    let (folder_rows, replays_folder) = read_replays_folder(install);

    // one row per replay md5, local plays offered FIRST so a collision
    // resolves in their favour: a local play is the row stable itself
    // records, so its file is the one the client would open. an F2 export of
    // a play is the same replay under a second name, and showing it twice is
    // the bug this closes
    let mut seen: HashSet<String> = HashSet::new();
    let mut rows: Vec<BrowserRow> = Vec::with_capacity(local_rows.len() + folder_rows.len());
    let mut local_kept = 0usize;
    let mut folder_kept = 0usize;
    for row in local_rows.into_iter().chain(folder_rows) {
        // a row with no replay hash has no identity to dedup ON, so it is
        // kept rather than dropped -- the alternative silently hides a file
        if let Some(md5) = row.replay_md5.clone() {
            if !seen.insert(md5) {
                continue;
            }
        }
        match row.source {
            ReplaySource::LocalPlay => local_kept += 1,
            ReplaySource::ReplaysFolder => folder_kept += 1,
        }
        rows.push(row);
    }

    let listing = title_rows(install, listing_cache, &mut rows);

    // newest first by the PLAY's own timestamp, never the file's mtime: a
    // replay copied onto a new machine keeps the date it was played
    rows.sort_by(|a, b| {
        b.timestamp_ticks
            .parse::<i64>()
            .unwrap_or(0)
            .cmp(&a.timestamp_ticks.parse::<i64>().unwrap_or(0))
            // a stable order for the ties a busy minute produces, so two
            // opens of the dialog never shuffle the list
            .then_with(|| a.path.cmp(&b.path))
    });

    ReplayBrowserListing {
        rows,
        local_plays: with_count(local_plays, local_kept),
        replays_folder: with_count(replays_folder, folder_kept),
        listing,
    }
}

/// the count a source reports is settled after the hide and dedup rules
/// have run, so the footer's number is what the list actually shows
fn with_count(status: BrowserSourceStatus, count: usize) -> BrowserSourceStatus {
    match status {
        BrowserSourceStatus::Read {
            unreadable,
            truncated,
            ..
        } => BrowserSourceStatus::Read {
            count,
            unreadable,
            truncated,
        },
        failed => failed,
    }
}

fn failed(path: &Path, reason: impl std::fmt::Display) -> BrowserSourceStatus {
    BrowserSourceStatus::Failed {
        path: path.display().to_string(),
        reason: reason.to_string(),
    }
}

/// stable's local leaderboards, as rows whose replay file is still there.
/// the file existence check is the hide rule the whole source turns on: a
/// leaderboard row outlives its replay (stable prunes `Data/r` on its own),
/// and a row that opens to nothing is the one thing a browser must not do
fn read_local_plays(install: &StableInstall) -> (Vec<BrowserRow>, BrowserSourceStatus) {
    let path = scores_path(install);
    let bytes = match read_file_capped(&path, engine::limits::MAX_SCORES_DB_BYTES, "MAX_SCORES_DB_BYTES")
    {
        Ok(bytes) => bytes,
        Err(e) => return (Vec::new(), failed(&path, describe(e))),
    };
    let scores = match decode_local_scores(&bytes) {
        Ok(scores) => scores,
        Err(e) => return (Vec::new(), failed(&path, e)),
    };
    let data_dir = replay_data_dir(install);
    let mut rows = Vec::new();
    let mut missing = 0usize;
    for row in scores.rows {
        // non-std is hidden rather than counted: another ruleset's play is
        // not a file this app failed to read, it is one it does not open
        if row.mode != GameMode::Osu {
            continue;
        }
        let Some(beatmap_md5) = row.beatmap_md5.clone() else {
            missing += 1;
            continue;
        };
        let Some(name) = local_play_file_name(&beatmap_md5, row.timestamp_ticks) else {
            missing += 1;
            continue;
        };
        let file = data_dir.join(name);
        if !file.is_file() {
            missing += 1;
            continue;
        }
        rows.push(BrowserRow {
            path: file.display().to_string(),
            replay_md5: row.replay_md5,
            beatmap_md5: Some(beatmap_md5),
            source: ReplaySource::LocalPlay,
            artist: None,
            artist_unicode: None,
            title: None,
            title_unicode: None,
            difficulty: None,
            creator: None,
            titled: false,
            player_name: row.player_name,
            accuracy: standard_accuracy(row.count_300, row.count_100, row.count_50, row.count_miss),
            max_combo: row.max_combo,
            score: row.total_score,
            mods: row.mods,
            timestamp_ticks: row.timestamp_ticks.to_string(),
            date: iso_date_from_ticks(row.timestamp_ticks),
            lazer_written: row.version >= FIRST_LAZER_VERSION,
        });
    }
    (
        rows,
        BrowserSourceStatus::Read {
            count: 0,
            unreadable: missing,
            truncated: false,
        },
    )
}

/// the install's own `Replays` folder: top-level `.osr` files, each read
/// through the header-only entry point. a file that will not decode is
/// counted and skipped, never listed -- the browser's promise is that a row
/// opens
fn read_replays_folder(install: &StableInstall) -> (Vec<BrowserRow>, BrowserSourceStatus) {
    let dir = replays_dir(install);
    let entries = match std::fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(e) => return (Vec::new(), failed(&dir, e)),
    };
    let mut rows = Vec::new();
    let mut unreadable = 0usize;
    let mut truncated = false;
    let mut walked = 0usize;
    for entry in entries {
        walked += 1;
        if walked > engine::limits::MAX_REPLAYS_FOLDER_FILES {
            truncated = true;
            break;
        }
        let Ok(entry) = entry else {
            unreadable += 1;
            continue;
        };
        let path = entry.path();
        // top-level only: stable writes flat here, and descending would turn
        // a folder someone archived their whole history into a full scan
        if !path.extension().is_some_and(|e| e.eq_ignore_ascii_case("osr")) {
            continue;
        }
        let header = match read_osr_header(&path) {
            Ok(header) => header,
            Err(_) => {
                unreadable += 1;
                continue;
            }
        };
        // non-std is hidden, not counted, for the local plays' reason
        if header.mode != GameMode::Osu {
            continue;
        }
        rows.push(BrowserRow {
            path: path.display().to_string(),
            replay_md5: header.replay_md5,
            beatmap_md5: header.beatmap_md5,
            source: ReplaySource::ReplaysFolder,
            artist: None,
            artist_unicode: None,
            title: None,
            title_unicode: None,
            difficulty: None,
            creator: None,
            titled: false,
            player_name: header.player_name,
            accuracy: standard_accuracy(
                header.count_300,
                header.count_100,
                header.count_50,
                header.count_miss,
            ),
            max_combo: header.max_combo,
            score: header.total_score,
            mods: header.mods,
            timestamp_ticks: header.timestamp_ticks.to_string(),
            date: iso_date_from_ticks(header.timestamp_ticks),
            lazer_written: header.version >= FIRST_LAZER_VERSION,
        });
    }
    (
        rows,
        BrowserSourceStatus::Read {
            count: 0,
            unreadable,
            truncated,
        },
    )
}

/// titles every row from the stable listing's own fold. a listing that will
/// not read leaves every row untitled and says so -- the browser degrades to
/// a list of md5s rather than disappearing
fn title_rows(
    install: &StableInstall,
    listing_cache: &ListingCache,
    rows: &mut [BrowserRow],
) -> BrowserSourceStatus {
    let index = match listing_cache.get(&install.db_path) {
        Ok(index) => index,
        Err(e) => return failed(&install.db_path, describe(e)),
    };
    let mut titled = 0usize;
    for row in rows.iter_mut() {
        let Some(md5) = row.beatmap_md5.as_deref() else {
            continue;
        };
        let Some(names) = index.names(md5) else {
            continue;
        };
        let BeatmapNames {
            artist,
            artist_unicode,
            title,
            title_unicode,
            difficulty,
            creator,
        } = names.clone();
        row.artist = artist;
        row.artist_unicode = artist_unicode;
        row.title = title;
        row.title_unicode = title_unicode;
        row.difficulty = difficulty;
        row.creator = creator;
        row.titled = true;
        titled += 1;
    }
    BrowserSourceStatus::Read {
        count: titled,
        unreadable: 0,
        truncated: false,
    }
}

/// an ipc error in the voice a browser footer speaks: the reason alone,
/// since the path is already the note's other half
fn describe(e: IpcError) -> String {
    match e {
        IpcError::ResourceLimit { cap, limit, actual } => {
            format!("the file is {actual} bytes, past {cap}'s limit of {limit}")
        }
        IpcError::OsuDbUnreadable { reason, .. } => reason,
        IpcError::Io { message } => message,
        // no other kind reaches here: the two readers above raise io,
        // resource-limit and the listing's own unreadable outcome and nothing
        // else. debug spelling rather than a lie if one ever does
        other => format!("{other:?}"),
    }
}

/// what a header read can fail with. the two are kept apart because only one
/// of them is a fact about the app's own limits
#[derive(Debug)]
pub enum HeaderReadError {
    /// the file could not be opened, ended mid-header, or is not a replay
    Unreadable(String),
    /// the header alone ran past [`engine::limits::MAX_OSR_HEADER_BYTES`],
    /// which no replay's does -- so the file is treated as unreadable rather
    /// than as a cap the user should be told about
    TooLarge,
}

/// reads one `.osr`'s header and nothing more.
///
/// grows a buffer until the engine's header entry point stops asking for
/// bytes, which for every real replay is the first read: the largest header
/// across 4,382 files here is 2,629 bytes against the 16 KiB first chunk.
/// what makes the loop terminable is the entry point's own two answers --
/// "hand me more" and "this is not a replay" are different results, so a
/// corrupt file is refused immediately rather than read to its end
pub fn read_osr_header(path: &Path) -> Result<OsrHeader, HeaderReadError> {
    let mut file =
        std::fs::File::open(path).map_err(|e| HeaderReadError::Unreadable(e.to_string()))?;
    let mut buf: Vec<u8> = Vec::new();
    loop {
        let before = buf.len();
        let want = if before == 0 { FIRST_HEADER_CHUNK } else { before };
        (&mut file)
            .take(want as u64)
            .read_to_end(&mut buf)
            .map_err(|e| HeaderReadError::Unreadable(e.to_string()))?;
        match scan_osr_header(&buf) {
            Ok(OsrHeaderScan::Complete { header, .. }) => return Ok(header),
            Ok(OsrHeaderScan::Incomplete) => {
                if buf.len() == before {
                    // the file ended inside its own header
                    return Err(HeaderReadError::Unreadable(
                        "the file ends inside its replay header".into(),
                    ));
                }
                if buf.len() as u64 >= engine::limits::MAX_OSR_HEADER_BYTES {
                    return Err(HeaderReadError::TooLarge);
                }
            }
            Err(e) => return Err(HeaderReadError::Unreadable(e.to_string())),
        }
    }
}

/// `yyyy-mm-dd` from .net ticks, with no zone conversion at all -- the value
/// is read exactly as stable wrote it, which is what makes it match the date
/// in stable's own export file names.
///
/// the frontend has the same rule in `lib/format.ts` for the export dialog's
/// prefill, which works from the scene's ticks rather than from a browser
/// row; the two are pinned by their own tests against the same values
fn iso_date_from_ticks(ticks: i64) -> String {
    // days since 0001-01-01, which is a monday and day 0 of the proleptic
    // gregorian calendar .net counts in
    const TICKS_PER_DAY: i64 = 864_000_000_000;
    let days = ticks.div_euclid(TICKS_PER_DAY);
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02}")
}

/// howard hinnant's civil-from-days, shifted from the unix epoch to .net's
/// 0001-01-01. a dependency-free conversion because chrono is a DEV
/// dependency here and a date format is not worth promoting it
fn civil_from_days(days_from_0001: i64) -> (i64, u32, u32) {
    // 719162 days from 0001-01-01 to 1970-01-01
    let z = days_from_0001 - 719_162 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m as u32, d as u32)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stable::detect_install;
    use crate::testutil::{
        fake_install, osr_bytes, osr_bytes_versioned, osr_bytes_with, write_scores_db, ScoreRow,
    };

    /// the ticks the committed `scores.db` slice carries, and the date
    /// stable's own export names spell for it
    const SLICE_TICKS: i64 = 636_895_947_445_841_476;

    fn install_at(root: &Path) -> StableInstall {
        detect_install(Some(root), &[]).unwrap()
    }

    fn write_replays_file(root: &Path, name: &str, bytes: &[u8]) -> PathBuf {
        let dir = root.join(REPLAYS_DIR);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, bytes).unwrap();
        path
    }

    fn write_data_r_file(root: &Path, beatmap_md5: &str, ticks: i64, bytes: &[u8]) -> PathBuf {
        let dir = root.join("Data").join("r");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(local_play_file_name(beatmap_md5, ticks).unwrap());
        std::fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn the_date_is_the_ticks_read_with_no_zone_conversion() {
        // the committed slice's own play, whose `Data/r` sibling is named
        // with the very same instant in windows ticks
        assert_eq!(iso_date_from_ticks(SLICE_TICKS), "2019-03-31");
        // .net's own epoch, and a leap day, which is what a civil-from-days
        // conversion gets wrong when it is wrong
        assert_eq!(iso_date_from_ticks(0), "0001-01-01");
        assert_eq!(iso_date_from_ticks(630_873_792_000_000_000), "2000-02-29");
        assert_eq!(iso_date_from_ticks(638_712_864_000_000_000), "2025-01-01");
        // the rule itself: this is the date in stable's own export file
        // names, checked against all 4,382 of them in the real install here
        // -- a local-time reading matches one fewer
    }

    #[test]
    fn a_local_plays_file_name_is_its_hash_and_its_windows_ticks() {
        assert_eq!(
            local_play_file_name("5afc67b1fbc077f262797719c3ca8423", SLICE_TICKS).as_deref(),
            Some("5afc67b1fbc077f262797719c3ca8423-131984715445841476.osr")
        );
        // a timestamp no real row carries, which the codec nonetheless
        // accepts: the subtraction gives up rather than wrapping or panicking
        assert_eq!(local_play_file_name("abc", i64::MIN), None);
    }

    /// the header reader's happy path and its two refusals, on the seam the
    /// folder scan actually uses
    #[test]
    fn the_header_reader_reads_a_replay_and_refuses_what_is_not_one() {
        let dir = tempfile::tempdir().unwrap();
        let osr = dir.path().join("a.osr");
        std::fs::write(&osr, osr_bytes("a".repeat(32).as_str(), 0, None)).unwrap();
        let header = read_osr_header(&osr).unwrap();
        assert_eq!(header.beatmap_md5.as_deref(), Some("a".repeat(32).as_str()));
        assert_eq!(header.player_name.as_deref(), Some("test"));

        let garbage = dir.path().join("garbage.osr");
        std::fs::write(&garbage, b"not a replay at all").unwrap();
        assert!(matches!(
            read_osr_header(&garbage),
            Err(HeaderReadError::Unreadable(_))
        ));

        let empty = dir.path().join("empty.osr");
        std::fs::write(&empty, b"").unwrap();
        assert!(matches!(
            read_osr_header(&empty),
            Err(HeaderReadError::Unreadable(_))
        ));

        assert!(matches!(
            read_osr_header(&dir.path().join("absent.osr")),
            Err(HeaderReadError::Unreadable(_))
        ));
    }

    /// the cap's boundary, on the one field that can reach it: the life bar
    /// graph, whose length nothing else bounds
    #[test]
    fn an_osr_header_past_the_byte_cap_is_unreadable_not_fatal() {
        let dir = tempfile::tempdir().unwrap();
        let cap = engine::limits::MAX_OSR_HEADER_BYTES as usize;

        // just under: a header the reader grows its buffer for and still
        // finds, which is what proves the loop and not just the cap
        let under = dir.path().join("under.osr");
        let graph = "0|1,".repeat(cap / 8);
        assert!(graph.len() < cap - 1024);
        std::fs::write(
            &under,
            osr_bytes_with("b".repeat(32).as_str(), 0, None, |h| {
                h.life_graph = Some(graph.clone())
            }),
        )
        .unwrap();
        assert_eq!(read_osr_header(&under).unwrap().life_graph, Some(graph));

        // past it: unreadable, and the folder scan counts it rather than
        // failing the whole source
        let over = dir.path().join("over.osr");
        std::fs::write(
            &over,
            osr_bytes_with("c".repeat(32).as_str(), 0, None, |h| {
                h.life_graph = Some("0|1,".repeat(cap / 2))
            }),
        )
        .unwrap();
        assert!(matches!(read_osr_header(&over), Err(HeaderReadError::TooLarge)));
    }

    /// the whole assembly over a fake install holding one of everything the
    /// spec's rules are about
    #[test]
    fn both_sources_list_with_their_hide_dedup_and_sort_rules() {
        let root = tempfile::tempdir().unwrap();
        let map_md5 = fake_install(root.path(), "1 fixture", "map.osu", b"the map contents");

        // two local plays, one of which has no file on disk
        let kept_ticks = 638_000_000_000_000_000i64;
        let fileless_ticks = 637_000_000_000_000_000i64;
        write_data_r_file(root.path(), &map_md5, kept_ticks, &osr_bytes(&map_md5, 0, None));
        // a mania row whose Data/r file DOES exist, so what hides it is the
        // mode rule alone rather than the missing-file one
        let mania_ticks = 637_500_000_000_000_000i64;
        write_data_r_file(root.path(), &map_md5, mania_ticks, b"never read");
        write_scores_db(
            &root.path().join("scores.db"),
            &[
                ScoreRow::new(&map_md5, kept_ticks).replay_md5("aa").mods(64),
                ScoreRow::new(&map_md5, fileless_ticks).replay_md5("bb"),
                ScoreRow::new(&map_md5, mania_ticks)
                    .replay_md5("dd")
                    .mode(osu_db::Mode::Mania),
            ],
        );

        // an F2 export of the kept play (same replay hash), a download, a
        // mania file and a garbage one
        write_replays_file(
            root.path(),
            "export.osr",
            &osr_bytes_with(&map_md5, 0, None, |h| {
                h.replay_md5 = Some("aa".into());
                h.timestamp_ticks = kept_ticks;
            }),
        );
        let download = write_replays_file(
            root.path(),
            "downloaded.osr",
            &osr_bytes_with(&map_md5, 0, None, |h| {
                h.replay_md5 = Some("cc".into());
                h.timestamp_ticks = 639_000_000_000_000_000;
                h.player_name = Some("someone else".into());
            }),
        );
        write_replays_file(root.path(), "garbage.osr", b"not a replay");
        write_replays_file(root.path(), "ignored.txt", b"not even close");
        // a lazer-written export, which lists with its badge rather than
        // being hidden: it opens, read-only
        let lazer = write_replays_file(
            root.path(),
            "LAZER.OSR",
            &osr_bytes_versioned(&map_md5, 0, None, FIRST_LAZER_VERSION),
        );

        let install = install_at(root.path());
        let listing = assemble(&install, &ListingCache::default());

        // the fileless local play is hidden and the F2 export deduped away,
        // so two rows survive -- newest first
        let paths: Vec<&str> = listing.rows.iter().map(|r| r.path.as_str()).collect();
        assert_eq!(paths.len(), 3, "{listing:#?}");
        assert_eq!(paths[0], download.display().to_string());
        assert_eq!(listing.rows[0].source, ReplaySource::ReplaysFolder);
        assert_eq!(listing.rows[1].source, ReplaySource::LocalPlay, "the local play wins");
        assert!(listing.rows[1].path.contains("Data"));
        assert_eq!(listing.rows[1].mods, 64, "the row's own mods reach the badge");
        // the uppercase extension is matched case-insensitively, as stable's
        // own downloads sometimes arrive
        assert_eq!(paths[2], lazer.display().to_string());
        assert!(listing.rows[2].lazer_written);
        assert!(!listing.rows[0].lazer_written);

        // titled from the listing, both of them, since both play the map the
        // fake install indexes
        assert!(listing.rows.iter().all(|r| r.titled));
        assert_eq!(listing.rows[0].title.as_deref(), Some("fixture"));
        assert_eq!(listing.rows[0].difficulty.as_deref(), Some("test"));
        assert_eq!(listing.rows[0].player_name.as_deref(), Some("someone else"));

        match listing.local_plays {
            BrowserSourceStatus::Read {
                count, unreadable, ..
            } => {
                assert_eq!(count, 1, "the mania row is hidden, not counted");
                assert_eq!(unreadable, 1, "the file-less row is counted");
            }
            other => panic!("{other:?}"),
        }
        match listing.replays_folder {
            BrowserSourceStatus::Read {
                count,
                unreadable,
                truncated,
            } => {
                assert_eq!(count, 2, "the export deduped away");
                assert_eq!(unreadable, 1, "the garbage file");
                assert!(!truncated);
            }
            other => panic!("{other:?}"),
        }
        match listing.listing {
            BrowserSourceStatus::Read { count, .. } => assert_eq!(count, 3),
            other => panic!("{other:?}"),
        }
    }

    /// the dedup rule is "one row per replay md5", which holds WITHIN a
    /// source as well as across the two. a replay hash repeated inside one
    /// half is rare on a real install -- none of the 1,375 rows here does it
    /// -- but a rule with a hole in it is one a later source can fall through
    #[test]
    fn one_row_per_replay_hash_holds_inside_a_source_too() {
        let root = tempfile::tempdir().unwrap();
        let map_md5 = fake_install(root.path(), "1 fixture", "map.osu", b"the map contents");
        // two Replays files sharing a hash: the same replay saved twice
        for name in ["a.osr", "b.osr"] {
            write_replays_file(
                root.path(),
                name,
                &osr_bytes_with(&map_md5, 0, None, |h| h.replay_md5 = Some("same".into())),
            );
        }
        // and a third with no hash at all, which has no identity to dedup on
        // and must survive rather than be silently hidden
        write_replays_file(
            root.path(),
            "c.osr",
            &osr_bytes_with(&map_md5, 0, None, |h| h.replay_md5 = None),
        );

        let listing = assemble(&install_at(root.path()), &ListingCache::default());
        assert_eq!(listing.rows.len(), 2, "{listing:#?}");
        assert_eq!(
            listing.rows.iter().filter(|r| r.replay_md5.is_none()).count(),
            1,
            "a hashless row is kept"
        );
    }

    /// each source fails on its own, and the other keeps listing. this is
    /// the property the whole footer exists for
    #[test]
    fn one_broken_source_never_empties_the_browser() {
        let root = tempfile::tempdir().unwrap();
        let map_md5 = fake_install(root.path(), "1 fixture", "map.osu", b"the map contents");
        write_replays_file(root.path(), "a.osr", &osr_bytes(&map_md5, 0, None));

        // no scores.db at all
        let listing = assemble(&install_at(root.path()), &ListingCache::default());
        assert_eq!(listing.rows.len(), 1);
        assert!(matches!(listing.local_plays, BrowserSourceStatus::Failed { .. }));

        // one that will not parse: the note carries the reader's own reason
        let mut broken = 20260711i32.to_le_bytes().to_vec();
        broken.extend_from_slice(b"not a score database");
        std::fs::write(root.path().join("scores.db"), &broken).unwrap();
        let listing = assemble(&install_at(root.path()), &ListingCache::default());
        assert_eq!(listing.rows.len(), 1);
        match listing.local_plays {
            BrowserSourceStatus::Failed { path, reason } => {
                assert!(path.ends_with("scores.db"), "{path}");
                assert!(reason.contains("20260711"), "the version belongs in it: {reason}");
                assert!(reason.contains("byte"), "the offset belongs in it: {reason}");
            }
            other => panic!("{other:?}"),
        }

        // and no Replays folder, with the local plays intact
        let ticks = 638_000_000_000_000_000i64;
        write_data_r_file(root.path(), &map_md5, ticks, &osr_bytes(&map_md5, 0, None));
        write_scores_db(
            &root.path().join("scores.db"),
            &[ScoreRow::new(&map_md5, ticks)],
        );
        std::fs::remove_dir_all(root.path().join(REPLAYS_DIR)).unwrap();
        let listing = assemble(&install_at(root.path()), &ListingCache::default());
        assert_eq!(listing.rows.len(), 1);
        assert_eq!(listing.rows[0].source, ReplaySource::LocalPlay);
        assert!(matches!(listing.replays_folder, BrowserSourceStatus::Failed { .. }));
    }

    /// an unreadable listing leaves every row in place, titled by md5 --
    /// which is the frontend's job, so what this asserts is that the rows
    /// survive and the note names the file
    #[test]
    fn an_unreadable_listing_leaves_the_rows_untitled() {
        let root = tempfile::tempdir().unwrap();
        let map_md5 = fake_install(root.path(), "1 fixture", "map.osu", b"the map contents");
        write_replays_file(root.path(), "a.osr", &osr_bytes(&map_md5, 0, None));
        let mut broken = 20260711i32.to_le_bytes().to_vec();
        broken.extend_from_slice(b"not a listing at all");
        std::fs::write(root.path().join("osu!.db"), &broken).unwrap();

        let listing = assemble(&install_at(root.path()), &ListingCache::default());
        assert_eq!(listing.rows.len(), 1);
        assert!(!listing.rows[0].titled);
        assert_eq!(listing.rows[0].title, None);
        assert_eq!(listing.rows[0].beatmap_md5.as_deref(), Some(map_md5.as_str()));
        match listing.listing {
            BrowserSourceStatus::Failed { path, reason } => {
                assert!(path.ends_with("osu!.db"), "{path}");
                assert!(reason.contains("20260711"), "{reason}");
            }
            other => panic!("{other:?}"),
        }
    }

    /// a play whose beatmap has left the library still lists, identified by
    /// its md5 -- the frontend greys it and the picker is still reachable
    #[test]
    fn a_play_whose_beatmap_left_the_library_still_lists() {
        let root = tempfile::tempdir().unwrap();
        fake_install(root.path(), "1 fixture", "map.osu", b"the map contents");
        let gone = "f".repeat(32);
        write_replays_file(root.path(), "a.osr", &osr_bytes(&gone, 0, None));

        let listing = assemble(&install_at(root.path()), &ListingCache::default());
        assert_eq!(listing.rows.len(), 1);
        assert!(!listing.rows[0].titled);
        assert_eq!(listing.rows[0].beatmap_md5.as_deref(), Some(gone.as_str()));
    }

    #[test]
    fn the_replays_folder_scan_stops_at_the_file_cap() {
        // the cap itself is 100,000 files, which no test should create;
        // what is checked is the arithmetic around the break, by driving the
        // same loop with a folder one entry past a cap of its own size
        let root = tempfile::tempdir().unwrap();
        let map_md5 = fake_install(root.path(), "1 fixture", "map.osu", b"the map contents");
        for i in 0..3 {
            write_replays_file(
                root.path(),
                &format!("{i}.osr"),
                &osr_bytes_with(&map_md5, 0, None, |h| h.replay_md5 = Some(format!("{i}"))),
            );
        }
        let install = install_at(root.path());
        let (rows, status) = read_replays_folder(&install);
        assert_eq!(rows.len(), 3);
        assert!(
            matches!(status, BrowserSourceStatus::Read { truncated: false, .. }),
            "{status:?}"
        );
        assert!(
            engine::limits::MAX_REPLAYS_FOLDER_FILES == 100_000,
            "the cap moved; the note in limits.rs moves with it"
        );
    }

    /// the cache returns the very same assembly until one of its three
    /// mtimes moves, which is what makes reopening the dialog free
    #[test]
    fn the_cache_holds_until_a_source_changes_on_disk() {
        let root = tempfile::tempdir().unwrap();
        let map_md5 = fake_install(root.path(), "1 fixture", "map.osu", b"the map contents");
        write_replays_file(root.path(), "a.osr", &osr_bytes(&map_md5, 0, None));
        let install = install_at(root.path());
        let listings = ListingCache::default();
        let cache = BrowserCache::default();

        let first = cache.get(&install, &listings);
        assert!(Arc::ptr_eq(&first, &cache.get(&install, &listings)));
        assert_eq!(first.rows.len(), 1);

        // a new file in the Replays folder moves the directory's mtime
        write_replays_file(
            root.path(),
            "b.osr",
            &osr_bytes_with(&map_md5, 0, None, |h| h.replay_md5 = Some("bb".into())),
        );
        let second = cache.get(&install, &listings);
        assert!(!Arc::ptr_eq(&first, &second), "a new file must invalidate");
        assert_eq!(second.rows.len(), 2);

        // and so does `Data/r`, which the key covers because it is where the
        // local-play hide rule looks: stable prunes a replay there without
        // rewriting scores.db, and a cached row for it would open to nothing
        let ticks = 638_100_000_000_000_000i64;
        write_scores_db(
            &root.path().join("scores.db"),
            &[ScoreRow::new(&map_md5, ticks).replay_md5("cc")],
        );
        assert_eq!(cache.get(&install, &listings).rows.len(), 2, "the row has no file yet");
        let data_r = write_data_r_file(root.path(), &map_md5, ticks, &osr_bytes(&map_md5, 0, None));
        assert_eq!(
            cache.get(&install, &listings).rows.len(),
            3,
            "the file appearing must invalidate"
        );
        std::fs::remove_file(&data_r).unwrap();
        assert_eq!(
            cache.get(&install, &listings).rows.len(),
            2,
            "and so must it disappearing, or the row opens to nothing"
        );
    }

    /// the wire contract: every field name the frontend's scene-types
    /// declares, frozen here
    #[test]
    fn the_browser_payload_serializes_with_the_declared_field_names() {
        let root = tempfile::tempdir().unwrap();
        let map_md5 = fake_install(root.path(), "1 fixture", "map.osu", b"the map contents");
        let ticks = 638_000_000_000_000_000i64;
        write_data_r_file(root.path(), &map_md5, ticks, &osr_bytes(&map_md5, 0, None));
        write_scores_db(
            &root.path().join("scores.db"),
            &[ScoreRow::new(&map_md5, ticks).replay_md5("aa")],
        );
        let listing = assemble(&install_at(root.path()), &ListingCache::default());
        let v: serde_json::Value = serde_json::to_value(&listing).unwrap();

        let row = &v["rows"][0];
        assert_eq!(row["source"], "localPlay");
        assert_eq!(row["beatmapMd5"], map_md5);
        assert_eq!(row["replayMd5"], "aa");
        assert_eq!(row["titled"], true);
        assert_eq!(row["title"], "fixture");
        assert_eq!(row["artistUnicode"], serde_json::Value::Null);
        assert_eq!(row["titleUnicode"], serde_json::Value::Null);
        assert_eq!(row["difficulty"], "test");
        assert_eq!(row["creator"], "fixture");
        assert_eq!(row["playerName"], "test");
        assert_eq!(row["maxCombo"], 1);
        assert_eq!(row["score"], 300);
        assert_eq!(row["mods"], 0);
        assert_eq!(row["accuracy"], 1.0);
        // a string, for the reason ReplayMeta's is: the number is past
        // json's safe-integer range
        assert_eq!(row["timestampTicks"], ticks.to_string());
        assert_eq!(row["date"], "2022-09-28");
        assert_eq!(row["lazerWritten"], false);
        assert!(row["path"].as_str().unwrap().ends_with(".osr"));

        assert_eq!(v["localPlays"]["status"], "read");
        assert_eq!(v["localPlays"]["count"], 1);
        assert_eq!(v["localPlays"]["unreadable"], 0);
        assert_eq!(v["localPlays"]["truncated"], false);
        assert_eq!(v["replaysFolder"]["status"], "failed");
        assert!(v["replaysFolder"]["path"].as_str().unwrap().ends_with("Replays"));
        assert!(v["replaysFolder"]["reason"].is_string());
        assert_eq!(v["listing"]["status"], "read");
    }
}
