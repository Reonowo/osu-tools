//! .osz handling. the archive is untrusted input (spec, tauri layer): the
//! file's byte length is capped before anything is read, entry names are
//! validated fail-closed at open -- one traversal or absolute name rejects
//! the whole archive -- the member count is capped before the central
//! directory is parsed (physically confirmed, mirroring zip's own discovery,
//! so a lying declaration can neither evade the cap nor falsely trip it),
//! member reads are size-capped, the md5 candidate scan is charged against a
//! total decompression budget, and extraction (below) is charged against a
//! total byte budget as it writes

use std::fs::File;
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};

use zip::ZipArchive;

use crate::cache::{create_leased_dir, CacheLease};
use crate::error::IpcError;
use crate::limits::{MAX_OSZ_ENTRIES, MAX_OSZ_EXTRACTED_BYTES, MAX_OSZ_FILE_BYTES, MAX_OSZ_SCAN_BYTES};

pub struct OszArchive {
    archive: ZipArchive<BufReader<File>>,
    /// index-aligned entry names, collected during open's validation pass
    names: Vec<String>,
}

// the tests format `Result<OszArchive, IpcError>` in panic messages; the
// wrapped ZipArchive/BufReader/File chain doesn't derive Debug, so this
// prints just the part that matters for diagnosing a test failure
impl std::fmt::Debug for OszArchive {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OszArchive").field("names", &self.names).finish()
    }
}

pub struct MatchedOsu {
    pub index: usize,
    pub bytes: Vec<u8>,
    pub md5: String,
}

// the tests format `Result<Option<MatchedOsu>, IpcError>` in panic messages;
// eliding the raw bytes keeps those messages readable, mirroring the other
// manual Debug impls in this module
impl std::fmt::Debug for MatchedOsu {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MatchedOsu")
            .field("index", &self.index)
            .field("md5", &self.md5)
            .field("bytes_len", &self.bytes.len())
            .finish()
    }
}

fn archive_err(what: impl std::fmt::Display) -> IpcError {
    IpcError::BeatmapParse {
        message: format!("osz: {what}"),
    }
}

// zip 8's enclosed_name() only rejects a root/prefix component when it
// follows a normal component (e.g. "foo/C:/x"); a bare absolute name like
// "/etc/passwd" or "C:\x" at depth zero comes back Some(relative-path) --
// it strips the root rather than rejecting it, mirroring how many zip tools
// extract absolute paths. the spec calls for rejecting absolute names
// outright, so that case is checked explicitly alongside enclosed_name
fn is_absolute_entry_name(name: &str) -> bool {
    name.starts_with('/') || name.starts_with('\\') || name.split(['/', '\\']).any(has_drive_prefix)
}

/// a windows drive-relative segment such as `c:evil.png`.
///
/// checked on EVERY segment rather than only at the start of the name, because
/// a prefix does not have to start the name to reach a join:
/// `Path::new("wrapper/c:evil.png")` parses as two `Normal` components, but
/// pushing that second one onto a `PathBuf` re-parses it alone, finds a disk
/// prefix, and DISCARDS the buffer ("if path has a prefix but no root, it
/// replaces self"). so `staging.join("c:evil.png")` is `c:evil.png` -- the
/// app-owned root is gone and the write lands in the current directory of
/// drive C:. zip's own `enclosed_name` is push-built the same way, so it
/// collapses to the same bare name rather than rejecting it.
///
/// checked on every segment means an archive holding such a member is refused
/// WHOLE, even when nothing references it -- the same fail-closed posture an
/// absolute name already got. that is deliberate: the shape is indistinguishable
/// from the attack, and a member whose name carries a `:` could not be written
/// to a windows filesystem anyway, so nothing legitimate is lost here
fn has_drive_prefix(segment: &str) -> bool {
    let bytes = segment.as_bytes();
    bytes.first().is_some_and(u8::is_ascii_alphabetic) && bytes.get(1) == Some(&b':')
}

/// the entry name as a relative path built from validated components ONLY.
///
/// `enclosed_name()` is not safe to join, for the reason above. this rebuilds
/// from `Component::Normal` alone and refuses anything else, so what comes
/// back can only ever descend
fn safe_relative_path(name: &str) -> Option<std::path::PathBuf> {
    let mut out = std::path::PathBuf::new();
    let mut any = false;
    for component in std::path::Path::new(name).components() {
        match component {
            std::path::Component::Normal(part) if !has_drive_prefix(&part.to_string_lossy()) => {
                out.push(part);
                any = true;
            }
            // a leading `./` is a no-op, not an escape. rust keeps it as a
            // component (only a MID-path `.` is normalized away), and archives
            // written by tools that join on "." carry it, so rejecting it would
            // fail a safe archive that used to load
            std::path::Component::CurDir => {}
            _ => return None,
        }
    }
    any.then_some(out)
}

// end-of-central-directory record: 22 fixed bytes plus up to 65535 comment
// bytes at the very end of the file
const EOCD_SIGNATURE: [u8; 4] = [0x50, 0x4b, 0x05, 0x06];
const EOCD_FIXED_LEN: usize = 22;
const EOCD_MAX_COMMENT: usize = 0xffff;
// zip64: the 20-byte locator sits directly before the eocd and points at the
// zip64 eocd record, whose first 56 bytes carry the counts and geometry
const EOCD64_LOCATOR_SIGNATURE: [u8; 4] = [0x50, 0x4b, 0x06, 0x07];
const EOCD64_LOCATOR_LEN: u64 = 20;
const EOCD64_SIGNATURE: [u8; 4] = [0x50, 0x4b, 0x06, 0x06];
const EOCD64_FIXED_LEN: u64 = 56;
// central directory file header: 46 fixed bytes with the name/extra/comment
// lengths at offsets 28/30/32
const CDFH_SIGNATURE: [u8; 4] = [0x50, 0x4b, 0x01, 0x02];
const CDFH_FIXED_LEN: usize = 46;

fn read_exact_at(file: &mut File, pos: u64, buf: &mut [u8]) -> Option<()> {
    use std::io::{Seek, SeekFrom};
    file.seek(SeekFrom::Start(pos)).ok()?;
    file.read_exact(buf).ok()
}

/// mirrors zip's own zip64 discovery for the eocd candidate at `eocd_pos`:
/// the locator sits exactly 20 bytes before the eocd, and the record is
/// searched forward through the window the locator brackets (prepended data
/// shifts it past its declared offset), validated by the same consistency
/// rules zip applies -- the record must span exactly to the locator, agree
/// with it on the directory disk, and declare entries that physically fit
/// below its own position. that last rule means a validated count is backed
/// by real file bytes, so the cap can be enforced against it directly
fn zip64_declared_entry_count(file: &mut File, eocd_pos: u64) -> Option<u64> {
    use std::io::{Read, Seek, SeekFrom};

    let locator_pos = eocd_pos.checked_sub(EOCD64_LOCATOR_LEN)?;
    let mut locator = [0u8; EOCD64_LOCATOR_LEN as usize];
    read_exact_at(file, locator_pos, &mut locator)?;
    if locator[..4] != EOCD64_LOCATOR_SIGNATURE {
        return None;
    }
    if u32::from_le_bytes(locator[16..20].try_into().unwrap()) > 1 {
        return None;
    }
    let declared_record_pos = u64::from_le_bytes(locator[8..16].try_into().unwrap());
    if declared_record_pos >= locator_pos {
        return None;
    }

    // forward signature scan over the window, collecting a bounded number
    // of candidate positions first so validation reads cannot corrupt the
    // scanning reader's position
    let mut hits: Vec<u64> = Vec::new();
    {
        let mut reader = BufReader::new(&*file);
        reader.seek(SeekFrom::Start(declared_record_pos)).ok()?;
        let mut carry: Vec<u8> = Vec::new();
        let mut chunk = vec![0u8; 64 * 1024];
        let mut base = declared_record_pos;
        let mut remaining = locator_pos - declared_record_pos;
        while remaining > 0 && hits.len() < 64 {
            let want = chunk.len().min(remaining as usize);
            let n = reader.read(&mut chunk[..want]).ok()?;
            if n == 0 {
                break;
            }
            let hay = [carry.as_slice(), &chunk[..n]].concat();
            let hay_base = base - carry.len() as u64;
            for at in 0..hay.len().saturating_sub(3) {
                if hay[at..at + 4] == EOCD64_SIGNATURE {
                    hits.push(hay_base + at as u64);
                }
            }
            carry = hay[hay.len().saturating_sub(3)..].to_vec();
            base += n as u64;
            remaining -= n as u64;
        }
    }

    for hit in hits {
        if hit + EOCD64_FIXED_LEN > locator_pos {
            continue;
        }
        let mut record = [0u8; EOCD64_FIXED_LEN as usize];
        if read_exact_at(file, hit, &mut record).is_none() {
            continue;
        }
        let record_size = u64::from_le_bytes(record[4..12].try_into().unwrap());
        if record_size.checked_add(12) != Some(locator_pos - hit) {
            continue;
        }
        if record[20..24] != locator[4..8] {
            continue;
        }
        let on_this_disk = u64::from_le_bytes(record[24..32].try_into().unwrap());
        let total = u64::from_le_bytes(record[32..40].try_into().unwrap());
        let declared = on_this_disk.max(total);
        let cd_offset = u64::from_le_bytes(record[48..56].try_into().unwrap());
        // zip's fit rule: the declared entries' minimum central-directory
        // bytes must exist between the directory offset and the record
        if hit
            < declared
                .saturating_mul(CDFH_FIXED_LEN as u64)
                .saturating_add(cd_offset)
        {
            continue;
        }
        return Some(declared);
    }
    None
}

/// the central directory's absolute start for a zip32 candidate: offsets
/// are absolute when nothing is prepended (the canonical .osz shape);
/// prepended data shifts everything forward equally, leaving the directory
/// flush against the record. both spots are probed for a real first entry
fn locate_cd_start(file: &mut File, cd_offset: u64, cd_size: u64, eocd_pos: u64) -> Option<u64> {
    let mut sig = [0u8; 4];
    if cd_offset.checked_add(cd_size) == Some(eocd_pos) {
        read_exact_at(file, cd_offset, &mut sig)?;
        return (sig == CDFH_SIGNATURE).then_some(cd_offset);
    }
    let adjacent = eocd_pos.checked_sub(cd_size)?;
    read_exact_at(file, adjacent, &mut sig)?;
    (sig == CDFH_SIGNATURE).then_some(adjacent)
}

/// counts contiguous central-directory records from `cd_start`, stopping at
/// `ceiling`: an over-cap declaration is only acted on when that many
/// records physically exist, never on the declaration alone
fn count_physical_entries(file: &mut File, cd_start: u64, ceiling: u64) -> u64 {
    use std::io::{Read, Seek, SeekFrom};

    let mut reader = BufReader::new(&*file);
    if reader.seek(SeekFrom::Start(cd_start)).is_err() {
        return 0;
    }
    let mut fixed = [0u8; CDFH_FIXED_LEN];
    let mut count = 0u64;
    while count < ceiling {
        if reader.read_exact(&mut fixed).is_err() || fixed[..4] != CDFH_SIGNATURE {
            break;
        }
        let name_len = u16::from_le_bytes([fixed[28], fixed[29]]);
        let extra_len = u16::from_le_bytes([fixed[30], fixed[31]]);
        let comment_len = u16::from_le_bytes([fixed[32], fixed[33]]);
        let skip = i64::from(name_len) + i64::from(extra_len) + i64::from(comment_len);
        if reader.seek_relative(skip).is_err() {
            break;
        }
        count += 1;
    }
    count
}

/// walks end-aligned eocd candidates right to left, mirroring how zip's own
/// discovery treats each one so the precheck never disagrees with the
/// parser on a plausible archive: zip64 sentinels (zip's may_be_zip64 rule)
/// route through the validated zip64 chain; other candidates must show a
/// real first directory entry where their geometry says one lives, and an
/// over-cap count is confirmed against physically present records before it
/// is acted on. eocd-shaped bytes inside a genuine comment fail those
/// probes and fall back to the real record exactly like zip's fallback
fn scan_eocd_candidates(file: &mut File, tail: &[u8], tail_start: u64) -> Option<u64> {
    let u16_at = |at: usize| u16::from_le_bytes([tail[at], tail[at + 1]]);
    let u32_at = |at: usize| u32::from_le_bytes([tail[at], tail[at + 1], tail[at + 2], tail[at + 3]]);
    let cap = MAX_OSZ_ENTRIES as u64;

    for start in (0..=tail.len() - EOCD_FIXED_LEN).rev() {
        if tail[start..start + 4] != EOCD_SIGNATURE {
            continue;
        }
        if start + EOCD_FIXED_LEN + u16_at(start + 20) as usize != tail.len() {
            continue;
        }
        let eocd_pos = tail_start + start as u64;
        let declared = u64::from(u16_at(start + 8).max(u16_at(start + 10)));
        let cd_size = u64::from(u32_at(start + 12));
        let cd_offset = u64::from(u32_at(start + 16));

        if declared == 0xffff || cd_size == u64::from(u32::MAX) || cd_offset == u64::from(u32::MAX) {
            match zip64_declared_entry_count(file, eocd_pos) {
                Some(count) => return Some(count),
                None => continue,
            }
        }
        if declared == 0 {
            // zip trusts an empty archive's record without reading further
            return Some(0);
        }
        let Some(cd_start) = locate_cd_start(file, cd_offset, cd_size, eocd_pos) else {
            continue;
        };
        if declared <= cap {
            return Some(declared);
        }
        if count_physical_entries(file, cd_start, cap + 1) > cap {
            return Some(declared);
        }
        // the over-cap declaration is not physically backed; zip would fail
        // this candidate part-way and fall back, so the scan does too
    }
    None
}

/// best-effort read of the entry count the archive declares, without parsing
/// any central directory. None means no plausible record was found --
/// ZipArchive::new keeps authority over those, and its central directory
/// parse stays bounded by the physical file size (zip refuses a declared
/// count larger than the directory offset), with open_osz's post-parse cap
/// re-check as the backstop
fn declared_entry_count(file: &mut File) -> Result<Option<u64>, IpcError> {
    use std::io::{Seek, SeekFrom};

    let file_len = file.metadata()?.len();
    let tail_len = file_len.min((EOCD_FIXED_LEN + EOCD_MAX_COMMENT) as u64) as usize;
    if tail_len < EOCD_FIXED_LEN {
        return Ok(None);
    }
    let tail_start = file_len - tail_len as u64;
    file.seek(SeekFrom::Start(tail_start))?;
    let mut tail = vec![0u8; tail_len];
    file.read_exact(&mut tail)?;

    let declared = scan_eocd_candidates(file, &tail, tail_start);
    file.seek(SeekFrom::Start(0))?;
    Ok(declared)
}

pub fn open_osz(path: &Path) -> Result<OszArchive, IpcError> {
    open_osz_with_max_len(path, MAX_OSZ_FILE_BYTES)
}

/// the length cap is a parameter so the boundary test can drive it with
/// tiny files, mirroring engine's capped entry points
pub fn open_osz_with_max_len(path: &Path, max_len: u64) -> Result<OszArchive, IpcError> {
    let mut file = File::open(path)?;
    // everything zip retains while opening (central-directory metadata:
    // names, extra fields, comments) and everything the precheck below may
    // scan is carved out of the file's own bytes, so capping the file
    // length bounds all of it at once
    let file_len = file.metadata()?.len();
    if file_len > max_len {
        return Err(IpcError::ResourceLimit {
            cap: "MAX_OSZ_FILE_BYTES".to_string(),
            limit: max_len,
            actual: file_len,
        });
    }
    // the declared count drives how much central directory ZipArchive::new
    // parses and allocates, so the cap is enforced on the raw declaration
    // before that work happens; the re-check on the constructed archive
    // below stays authoritative for anything this precheck cannot see
    if let Some(declared) = declared_entry_count(&mut file)? {
        if declared > MAX_OSZ_ENTRIES as u64 {
            return Err(IpcError::ResourceLimit {
                cap: "MAX_OSZ_ENTRIES".to_string(),
                limit: MAX_OSZ_ENTRIES as u64,
                actual: declared,
            });
        }
    }
    let mut archive = ZipArchive::new(BufReader::new(file)).map_err(archive_err)?;
    if archive.len() > MAX_OSZ_ENTRIES {
        return Err(IpcError::ResourceLimit {
            cap: "MAX_OSZ_ENTRIES".to_string(),
            limit: MAX_OSZ_ENTRIES as u64,
            actual: archive.len() as u64,
        });
    }
    let mut names = Vec::with_capacity(archive.len());
    for i in 0..archive.len() {
        let entry = archive.by_index(i).map_err(archive_err)?;
        // enclosed_name is zip's traversal guard, but zip 8 normalizes
        // interior ".." components away instead of rejecting them, so raw
        // parent components are refused explicitly; paired with the
        // absolute-name check above, a single unsafe name rejects the whole
        // archive outright -- fail closed, per spec
        let has_parent_component = entry.name().split(['/', '\\']).any(|c| c == "..");
        if entry.enclosed_name().is_none() || has_parent_component || is_absolute_entry_name(entry.name()) {
            return Err(archive_err(format!("unsafe entry name {:?}", entry.name())));
        }
        names.push(entry.name().to_string());
    }
    Ok(OszArchive { archive, names })
}

impl OszArchive {
    pub fn names(&self) -> &[String] {
        &self.names
    }

    fn osu_indices_by_name(&self) -> Vec<usize> {
        let mut candidates: Vec<usize> = (0..self.names.len())
            .filter(|&i| self.names[i].to_ascii_lowercase().ends_with(".osu"))
            .collect();
        candidates.sort_by(|&a, &b| self.names[a].cmp(&self.names[b]));
        candidates
    }

    /// reads member `index` in full, bounded by `cap`; None when it is larger.
    ///
    /// public because the `.osk` importer (`crate::osk`) extracts through the
    /// same archive primitive: an `.osk` IS a zip, so the file-length cap, the
    /// entry-count cap and the fail-closed unsafe-name check at [`open_osz`]
    /// all apply to it unchanged, and only the destination policy differs
    pub fn read_member_capped(&mut self, index: usize, cap: u64) -> Result<Option<Vec<u8>>, IpcError> {
        let entry = self.archive.by_index(index).map_err(archive_err)?;
        let mut bytes = Vec::new();
        entry.take(cap + 1).read_to_end(&mut bytes).map_err(archive_err)?;
        Ok((bytes.len() as u64 <= cap).then_some(bytes))
    }

    pub fn find_osu_by_md5(&mut self, md5: &str) -> Result<Option<MatchedOsu>, IpcError> {
        self.find_osu_by_md5_with_caps(md5, engine::limits::MAX_OSU_FILE_BYTES, MAX_OSZ_SCAN_BYTES)
    }

    /// both caps are parameters so the boundary tests can drive them with
    /// small members, mirroring engine's capped entry points
    pub fn find_osu_by_md5_with_caps(
        &mut self,
        md5: &str,
        per_candidate_cap: u64,
        scan_budget: u64,
    ) -> Result<Option<MatchedOsu>, IpcError> {
        let found = self.find_osu_ranked(std::slice::from_ref(&md5), per_candidate_cap, scan_budget)?;
        Ok(found.map(|(_, matched)| matched))
    }

    /// several acceptable hashes in one pass, best first: the match with the
    /// lowest index in `md5s` wins, and the returned rank says which hash
    /// answered. one call is one scan budget, so a caller with a preference
    /// order must come here rather than calling `find_osu_by_md5` per hash --
    /// that would hand the same archive a fresh `MAX_OSZ_SCAN_BYTES` for
    /// every hash it tried
    pub fn find_osu_by_any_md5(&mut self, md5s: &[&str]) -> Result<Option<(usize, MatchedOsu)>, IpcError> {
        self.find_osu_ranked(md5s, engine::limits::MAX_OSU_FILE_BYTES, MAX_OSZ_SCAN_BYTES)
    }

    /// the caps are parameters for the same reason as above
    pub fn find_osu_ranked(
        &mut self,
        md5s: &[&str],
        per_candidate_cap: u64,
        scan_budget: u64,
    ) -> Result<Option<(usize, MatchedOsu)>, IpcError> {
        // every decompressed candidate byte is charged against one aggregate
        // budget, so an archive full of maximum-size .osu members cannot
        // force unbounded decompression on the way to not-found. each read
        // is also clamped to what the budget can still afford, so actual
        // decompression never outruns the cap by more than a single byte
        let mut budget = ByteBudget {
            used: 0,
            max: scan_budget,
            cap: "MAX_OSZ_SCAN_BYTES",
        };
        let mut best: Option<(usize, MatchedOsu)> = None;
        for index in self.osu_indices_by_name() {
            let read_cap = per_candidate_cap.min(budget.remaining());
            let Some(bytes) = self.read_member_capped(index, read_cap)? else {
                // the member outgrew what this scan step could afford to
                // decompress; charge the bytes that were actually read --
                // when the budget was the binding cap this errors, and when
                // the candidate was simply oversized it skips as before
                budget.charge(read_cap + 1)?;
                continue;
            };
            budget.charge(bytes.len() as u64)?;
            let actual = format!("{:x}", md5::compute(&bytes));
            let Some(rank) = md5s.iter().position(|m| actual.eq_ignore_ascii_case(m)) else {
                continue;
            };
            let matched = MatchedOsu {
                index,
                bytes,
                md5: actual,
            };
            // the first hash can never be beaten, so it ends the scan where a
            // single-hash search always did; a lower-ranked hit is only held
            // until a better one turns up
            if rank == 0 {
                return Ok(Some((0, matched)));
            }
            if best.as_ref().is_none_or(|(best_rank, _)| rank < *best_rank) {
                best = Some((rank, matched));
            }
        }
        Ok(best)
    }

    /// the deterministic override target: first .osu by entry name
    pub fn first_osu(&mut self) -> Result<Option<MatchedOsu>, IpcError> {
        let Some(&index) = self.osu_indices_by_name().first() else {
            return Ok(None);
        };
        let Some(bytes) = self.read_member_capped(index, engine::limits::MAX_OSU_FILE_BYTES)? else {
            return Ok(None);
        };
        let md5 = format!("{:x}", md5::compute(&bytes));
        Ok(Some(MatchedOsu { index, bytes, md5 }))
    }
}

pub struct ExtractedScene {
    pub lease: CacheLease,
    pub osu_path: PathBuf,
    /// media resolves from the mapset root, exactly like a songs folder
    pub beatmap_dir: PathBuf,
}

// the boundary test formats `Result<ExtractedScene, IpcError>` in a panic
// message; CacheLease wraps a File and doesn't derive Debug, so this prints
// just the part that matters for diagnosing a test failure, mirroring
// OszArchive's Debug impl above
impl std::fmt::Debug for ExtractedScene {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ExtractedScene")
            .field("osu_path", &self.osu_path)
            .field("beatmap_dir", &self.beatmap_dir)
            .finish()
    }
}

/// case- and separator-insensitive: .osu references and archive entries
/// disagree on both constantly, and stable resolves them on a
/// case-insensitive filesystem
fn normalize_entry_name(name: &str) -> String {
    // keyed the way the extractor WRITES it, so the two sides cannot disagree.
    // a member named `./audio.mp3` is written to `audio.mp3`, and the beatmap
    // asks for `audio.mp3` -- without dropping the no-op `.` here the archive
    // index would key `./audio.mp3`, every media and hitsound lookup would miss,
    // and the map would load silent and background-less instead of failing loudly
    let rebuilt = safe_relative_path(name)
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_else(|| name.to_string());
    rebuilt.replace('\\', "/").to_ascii_lowercase()
}

struct ByteBudget {
    used: u64,
    max: u64,
    cap: &'static str,
}

impl ByteBudget {
    fn remaining(&self) -> u64 {
        self.max - self.used
    }

    fn charge(&mut self, n: u64) -> Result<(), IpcError> {
        self.used += n;
        if self.used > self.max {
            return Err(IpcError::ResourceLimit {
                cap: self.cap.to_string(),
                limit: self.max,
                actual: self.used,
            });
        }
        Ok(())
    }
}

fn write_member(path: &Path, bytes: &[u8]) -> Result<(), IpcError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, bytes)?;
    Ok(())
}

impl OszArchive {
    pub fn extract_scene(
        &mut self,
        osu_index: usize,
        osu_bytes: &[u8],
        media_names: &[&str],
        sample_names: &[&str],
        cache_root: &Path,
        label: &str,
    ) -> Result<ExtractedScene, IpcError> {
        self.extract_scene_with_budget(
            osu_index,
            osu_bytes,
            media_names,
            sample_names,
            cache_root,
            label,
            MAX_OSZ_EXTRACTED_BYTES,
            engine::limits::MAX_SAMPLE_BYTES,
            engine::limits::MAX_BEATMAP_TEXTURE_BYTES,
            crate::limits::MAX_BEATMAP_TEXTURES,
        )
    }

    /// both budgets are parameters so the boundary tests can drive them with
    /// tiny members; the public method passes MAX_OSZ_EXTRACTED_BYTES and
    /// engine::limits::MAX_SAMPLE_BYTES. on any error the fresh lease drops
    /// with the early return, deleting the partial directory.
    ///
    /// `sample_names` is separated from `media_names` because the two are
    /// bounded differently: the media list is one audio file and one image,
    /// while the sample list is derived from the map's own hitsounding and is
    /// charged against the sample budget as well as the archive one.
    ///
    /// the beatmap's own ART has no name list at all: a texture lookup name is
    /// an element name, not something the map declares, so its members are
    /// found by the same prefix filter the folder load runs
    /// (`media::is_beatmap_texture_name`) over the archive's root-level names,
    /// and charged against the texture budget as well as the archive one. the
    /// filter is what keeps this targeted -- extracting every image would hand
    /// an attacker the decompression budget the allow-lists exist to bound
    #[allow(clippy::too_many_arguments)]
    pub fn extract_scene_with_budget(
        &mut self,
        osu_index: usize,
        osu_bytes: &[u8],
        media_names: &[&str],
        sample_names: &[&str],
        cache_root: &Path,
        label: &str,
        max_total: u64,
        max_samples: u64,
        max_texture_bytes: u64,
        max_textures: usize,
    ) -> Result<ExtractedScene, IpcError> {
        std::fs::create_dir_all(cache_root)?;
        let lease = create_leased_dir(cache_root, label)?;
        let mut budget = ByteBudget {
            used: 0,
            max: max_total,
            cap: "MAX_OSZ_EXTRACTED_BYTES",
        };
        let mut sample_budget = ByteBudget {
            used: 0,
            max: max_samples,
            cap: "MAX_SAMPLE_BYTES",
        };
        let mut texture_budget = ByteBudget {
            used: 0,
            max: max_texture_bytes,
            cap: "MAX_BEATMAP_TEXTURE_BYTES",
        };
        // one pass over the entry names rather than a scan per wanted name:
        // the sample allow-list is derived from the map's hitsounding and can
        // reach tens of thousands of candidates, almost none of which exist,
        // so a linear scan each would be quadratic in archive size
        // FIRST wins on a collision, explicitly rather than by `collect`'s
        // last-wins: normalization folds `./x`, `x` and `sb//x` onto one key, so
        // two differently-spelled members can now share one. resolving toward
        // the first keeps the same archive answering the same way every run
        let mut by_name: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
        for (index, name) in self.names.iter().enumerate() {
            by_name.entry(normalize_entry_name(name)).or_insert(index);
        }

        let osu_rel = {
            let entry = self.archive.by_index(osu_index).map_err(archive_err)?;
            // rebuilt from validated components rather than taken from
            // `enclosed_name`, which is push-built and can hand back a
            // drive-relative name that discards the lease on join
            safe_relative_path(entry.name()).ok_or_else(|| archive_err("unsafe entry name"))?
        };
        let osu_path = lease.dir().join(&osu_rel);
        budget.charge(osu_bytes.len() as u64)?;
        write_member(&osu_path, osu_bytes)?;

        // every requested name is folded onto its member BEFORE anything is
        // written, because a member can be reached by several names and the
        // roles those names carry decide which budgets it owes. two names
        // sharing one member must extract it once (a stem and its explicit
        // filename), and a member ANY sample name reached owes the sample
        // budget even when a media name reached it first -- otherwise a map
        // whose `AudioFilename` is also one of its hitsound candidates buys
        // that file past the sample cap on the media budget's much larger
        // allowance
        let mut wanted: Vec<(usize, bool, bool)> = Vec::new();
        let mut position: std::collections::HashMap<usize, usize> = std::collections::HashMap::new();
        for (name, is_sample) in media_names
            .iter()
            .map(|name| (name, false))
            .chain(sample_names.iter().map(|name| (name, true)))
        {
            let want = normalize_entry_name(name);
            let Some(&index) = by_name.get(&want) else {
                // a beatmap referencing media its archive lacks is common --
                // and for the sample allow-list it is the NORM, since the list
                // is every candidate name rather than a manifest. the scene
                // simply loads without it (AudioMissing warning downstream)
                continue;
            };
            match position.get(&index) {
                Some(&at) => wanted[at].1 |= is_sample,
                None => {
                    position.insert(index, wanted.len());
                    wanted.push((index, is_sample, false));
                }
            }
        }

        // the art walk: root-level members only, because the folder scan that
        // will answer lookups reads the extraction root and nothing deeper. the
        // count is capped BEFORE anything is written -- the byte budget cannot
        // see a crafted archive of element-named zero-byte members
        let mut texture_count: usize = 0;
        for (index, name) in self.names.iter().enumerate() {
            let normalized = normalize_entry_name(name);
            if normalized.contains('/') || !crate::media::is_beatmap_texture_name(&normalized) {
                continue;
            }
            // FIRST wins on a collision, the same resolution `by_name` records
            if by_name.get(&normalized) != Some(&index) {
                continue;
            }
            texture_count += 1;
            if texture_count > max_textures {
                return Err(IpcError::ResourceLimit {
                    cap: "MAX_BEATMAP_TEXTURES".to_string(),
                    limit: max_textures as u64,
                    actual: texture_count as u64,
                });
            }
            match position.get(&index) {
                Some(&at) => wanted[at].2 = true,
                None => {
                    position.insert(index, wanted.len());
                    wanted.push((index, false, true));
                }
            }
        }

        for (index, is_sample, is_texture) in wanted {
            let mut entry = self.archive.by_index(index).map_err(archive_err)?;
            let rel = safe_relative_path(entry.name()).ok_or_else(|| archive_err("unsafe entry name"))?;
            let out_path = lease.dir().join(rel);
            if let Some(parent) = out_path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let mut out = std::fs::File::create(&out_path)?;
            let mut buf = [0u8; 64 * 1024];
            loop {
                let n = entry.read(&mut buf).map_err(archive_err)?;
                if n == 0 {
                    break;
                }
                // charge before writing so the caps also bound bytes on disk
                budget.charge(n as u64)?;
                if is_sample {
                    sample_budget.charge(n as u64)?;
                }
                if is_texture {
                    texture_budget.charge(n as u64)?;
                }
                out.write_all(&buf[..n])?;
            }
        }

        let beatmap_dir = lease.dir().to_path_buf();
        Ok(ExtractedScene {
            lease,
            osu_path,
            beatmap_dir,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::IpcError;
    use crate::testutil::write_osz;

    fn temp_osz(entries: &[(&str, &[u8])]) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("set.osz");
        write_osz(&path, entries);
        (dir, path)
    }

    #[test]
    fn finds_the_member_whose_hash_matches() {
        let a = b"osu file format v14 (a)".as_slice();
        let b = b"osu file format v14 (b)".as_slice();
        let (_dir, path) = temp_osz(&[("a.osu", a), ("b [hard].OSU", b), ("audio.mp3", b"mp3")]);
        let mut archive = open_osz(&path).unwrap();

        let want = format!("{:x}", md5::compute(b));
        let hit = archive.find_osu_by_md5(&want).unwrap().unwrap();
        assert_eq!(hit.bytes, b);
        assert_eq!(hit.md5, want);
        // uppercase extension must still count as a candidate
        assert_eq!(archive.names()[hit.index].to_ascii_lowercase(), "b [hard].osu");

        assert!(archive
            .find_osu_by_md5("00000000000000000000000000000000")
            .unwrap()
            .is_none());
    }

    #[test]
    fn first_osu_is_deterministic_by_name() {
        let (_dir, path) = temp_osz(&[
            ("z.osu", b"zz".as_slice()),
            ("a.osu", b"aa".as_slice()),
            ("audio.mp3", b"x".as_slice()),
        ]);
        let mut archive = open_osz(&path).unwrap();
        let first = archive.first_osu().unwrap().unwrap();
        assert_eq!(first.bytes, b"aa");
    }

    #[test]
    fn oversized_candidates_are_skipped_not_fatal() {
        let (_dir, path) = temp_osz(&[
            ("big.osu", b"0123456789".as_slice()),
            ("small.osu", b"ok".as_slice()),
        ]);
        let mut archive = open_osz(&path).unwrap();
        let want = format!("{:x}", md5::compute(b"ok"));
        // cap below big.osu's size: it can never decode, so it is not a
        // candidate; the matching small member must still be found
        let hit = archive
            .find_osu_by_md5_with_caps(&want, 5, crate::limits::MAX_OSZ_SCAN_BYTES)
            .unwrap()
            .unwrap();
        assert_eq!(hit.bytes, b"ok");
        let big = format!("{:x}", md5::compute(b"0123456789"));
        assert!(archive
            .find_osu_by_md5_with_caps(&big, 5, crate::limits::MAX_OSZ_SCAN_BYTES)
            .unwrap()
            .is_none());
    }

    #[test]
    fn scan_budget_boundary() {
        // two 4-byte candidates: an 8-byte budget scans both, a 7-byte
        // budget must die on the second instead of decompressing past it
        let (_dir, path) = temp_osz(&[("a.osu", b"aaaa".as_slice()), ("b.osu", b"bbbb".as_slice())]);
        let want = format!("{:x}", md5::compute(b"bbbb"));

        let mut archive = open_osz(&path).unwrap();
        let hit = archive.find_osu_by_md5_with_caps(&want, 64, 8).unwrap().unwrap();
        assert_eq!(hit.bytes, b"bbbb");

        let mut archive = open_osz(&path).unwrap();
        match archive.find_osu_by_md5_with_caps(&want, 64, 7) {
            Err(IpcError::ResourceLimit {
                cap,
                limit: 7,
                actual: 8,
            }) => {
                assert_eq!(cap, "MAX_OSZ_SCAN_BYTES");
            }
            other => panic!("expected ResourceLimit, got {other:?}"),
        }
    }

    #[test]
    fn a_ranked_scan_spends_one_budget_and_prefers_the_earlier_hash() {
        // searching several acceptable hashes must cost one scan budget, not
        // one per hash: the caller that needs this (load::open_saved_source)
        // used to call find_osu_by_md5 once per hash, handing the same
        // archive a fresh MAX_OSZ_SCAN_BYTES every time
        let (_dir, path) = temp_osz(&[("a.osu", b"aaaa".as_slice()), ("b.osu", b"bbbb".as_slice())]);
        let a_hash = format!("{:x}", md5::compute(b"aaaa"));
        let b_hash = format!("{:x}", md5::compute(b"bbbb"));
        let absent = "0".repeat(32);

        // the preferred hash wins even though the other member matches too,
        // and even though that other member comes first by entry name
        let mut archive = open_osz(&path).unwrap();
        let (rank, hit) = archive
            .find_osu_by_any_md5(&[b_hash.as_str(), a_hash.as_str()])
            .unwrap()
            .unwrap();
        assert_eq!(rank, 0);
        assert_eq!(hit.bytes, b"bbbb");

        // both members are read reaching that better-ranked hash, and both
        // charge the same 8-byte budget
        let mut archive = open_osz(&path).unwrap();
        let ranked = archive.find_osu_ranked(&[b_hash.as_str(), a_hash.as_str()], 64, 8);
        assert_eq!(ranked.unwrap().unwrap().1.bytes, b"bbbb");

        // a 7-byte budget must refuse mid-scan rather than start over for the
        // hash that has not been tried yet
        let mut archive = open_osz(&path).unwrap();
        match archive.find_osu_ranked(&[absent.as_str(), b_hash.as_str()], 64, 7) {
            Err(IpcError::ResourceLimit {
                cap,
                limit: 7,
                actual: 8,
            }) => {
                assert_eq!(cap, "MAX_OSZ_SCAN_BYTES");
            }
            other => panic!("expected ResourceLimit, got {other:?}"),
        }
    }

    #[test]
    fn oversized_skipped_candidates_still_charge_the_scan_budget() {
        // big.osu exceeds the 5-byte candidate cap, so its skip charges
        // cap + 1 = 6 bytes; a 7-byte budget then cannot afford small.osu
        let (_dir, path) = temp_osz(&[
            ("big.osu", b"0123456789".as_slice()),
            ("small.osu", b"ok".as_slice()),
        ]);
        let want = format!("{:x}", md5::compute(b"ok"));

        let mut archive = open_osz(&path).unwrap();
        assert!(archive.find_osu_by_md5_with_caps(&want, 5, 8).unwrap().is_some());

        let mut archive = open_osz(&path).unwrap();
        match archive.find_osu_by_md5_with_caps(&want, 5, 7) {
            Err(IpcError::ResourceLimit { cap, .. }) => assert_eq!(cap, "MAX_OSZ_SCAN_BYTES"),
            other => panic!("expected ResourceLimit, got {other:?}"),
        }
    }

    #[test]
    fn traversal_and_absolute_entry_names_reject_the_archive() {
        let (_dir, path) = temp_osz(&[("ok.osu", b"x".as_slice()), ("../evil.txt", b"x".as_slice())]);
        match open_osz(&path) {
            Err(IpcError::BeatmapParse { message }) => assert!(message.contains("unsafe")),
            other => panic!("expected BeatmapParse, got {other:?}"),
        }

        let (_dir2, path2) = temp_osz(&[("/abs.txt", b"x".as_slice())]);
        assert!(matches!(open_osz(&path2), Err(IpcError::BeatmapParse { .. })));
    }

    #[test]
    fn interior_parent_components_reject_the_archive() {
        // zip's enclosed_name would normalize this to "evil.osu" instead of
        // rejecting it; the fail-closed contract refuses the raw name
        let (_dir, path) = temp_osz(&[("maps/../evil.osu", b"x".as_slice())]);
        match open_osz(&path) {
            Err(IpcError::BeatmapParse { message }) => assert!(message.contains("unsafe")),
            other => panic!("expected BeatmapParse, got {other:?}"),
        }
    }

    /// a bare eocd record declaring `count` entries with an empty central
    /// directory at offset zero (geometry-consistent when the record starts
    /// the file)
    fn bare_eocd(count: u16) -> Vec<u8> {
        let mut eocd = Vec::new();
        eocd.extend([0x50, 0x4b, 0x05, 0x06]); // signature
        eocd.extend([0u8, 0]); // disk number
        eocd.extend([0u8, 0]); // central directory disk
        eocd.extend(count.to_le_bytes()); // entries on this disk
        eocd.extend(count.to_le_bytes()); // total entries
        eocd.extend([0u8, 0, 0, 0]); // central directory size
        eocd.extend([0u8, 0, 0, 0]); // central directory offset
        eocd.extend([0u8, 0]); // comment length
        eocd
    }

    #[test]
    fn an_unbacked_over_cap_declaration_defers_to_the_parser() {
        // a bare eocd declaring 10,001 entries with no physical directory
        // behind it: the precheck must not reject on the declaration alone
        // (zip would fail this candidate and fall back), so the malformed
        // file surfaces as a parse error instead of a false cap hit
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("liar.osz");
        std::fs::write(&path, bare_eocd(10_001)).unwrap();
        assert!(matches!(open_osz(&path), Err(IpcError::BeatmapParse { .. })));
    }

    #[test]
    fn prepended_data_archives_still_open() {
        // self-extractor-style archives carry junk before the zip proper,
        // shifting every declared offset; the precheck must tolerate that
        // instead of deferring into an unchecked parse
        let dir = tempfile::tempdir().unwrap();
        let plain = dir.path().join("plain.osz");
        write_osz(&plain, &[("map.osu", b"osu file format v14".as_slice())]);
        let mut bytes = b"junk before the archive".to_vec();
        bytes.extend(std::fs::read(&plain).unwrap());
        let path = dir.path().join("prefixed.osz");
        std::fs::write(&path, &bytes).unwrap();

        let mut archive = open_osz(&path).unwrap();
        assert!(archive.first_osu().unwrap().is_some());
    }

    #[test]
    fn prepended_over_cap_archives_still_reject() {
        // the prefix shifts every offset, but the physically present
        // directory records must still be found and counted against the cap
        let names: Vec<String> = (0..=crate::limits::MAX_OSZ_ENTRIES)
            .map(|i| format!("f{i}.txt"))
            .collect();
        let entries: Vec<(&str, &[u8])> = names.iter().map(|n| (n.as_str(), b"".as_slice())).collect();
        let (_plain_dir, plain) = temp_osz(&entries);
        let dir = tempfile::tempdir().unwrap();
        let mut bytes = b"junk".to_vec();
        bytes.extend(std::fs::read(&plain).unwrap());
        let path = dir.path().join("prefixed-big.osz");
        std::fs::write(&path, &bytes).unwrap();

        match open_osz(&path) {
            Err(IpcError::ResourceLimit { cap, actual, .. }) => {
                assert_eq!(cap, "MAX_OSZ_ENTRIES");
                assert_eq!(actual, crate::limits::MAX_OSZ_ENTRIES as u64 + 1);
            }
            other => panic!("expected ResourceLimit, got {other:?}"),
        }
    }

    #[test]
    fn file_size_cap_boundary() {
        let (_dir, path) = temp_osz(&[("map.osu", b"osu file format v14".as_slice())]);
        let len = std::fs::metadata(&path).unwrap().len();
        assert!(open_osz_with_max_len(&path, len).is_ok());
        match open_osz_with_max_len(&path, len - 1) {
            Err(IpcError::ResourceLimit { cap, limit, actual }) => {
                assert_eq!(cap, "MAX_OSZ_FILE_BYTES");
                assert_eq!(limit, len - 1);
                assert_eq!(actual, len);
            }
            other => panic!("expected ResourceLimit, got {other:?}"),
        }
    }

    #[test]
    fn a_bare_count_sentinel_defers_to_the_parser() {
        // the count claims zip64 but no zip64 chain exists: the precheck
        // must not take the sentinel at face value; the archive falls to
        // the real parser, which rejects it as malformed rather than as
        // over the cap
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sentinel.osz");
        std::fs::write(&path, bare_eocd(0xffff)).unwrap();
        assert!(matches!(open_osz(&path), Err(IpcError::BeatmapParse { .. })));
    }

    #[test]
    fn a_sentinel_fake_in_the_comment_does_not_reject() {
        // the fake declares the zip64 count sentinel with no zip64 chain
        // behind it; the precheck must fall back to the real record instead
        // of trusting the sentinel's promised >= 65535 entries
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sentinel-comment.osz");
        let file = std::fs::File::create(&path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        zip.set_raw_comment(bare_eocd(0xffff).into_boxed_slice()).unwrap();
        zip.start_file("map.osu", zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"osu file format v14").unwrap();
        zip.finish().unwrap();

        let mut archive = open_osz(&path).unwrap();
        assert!(archive.first_osu().unwrap().is_some());
    }

    /// an end-aligned eocd-shaped byte run declaring `count` entries with a
    /// central directory that could never fit before it
    fn implausible_fake_eocd(count: u16) -> Vec<u8> {
        let mut fake = Vec::new();
        fake.extend([0x50, 0x4b, 0x05, 0x06]); // signature
        fake.extend([0u8, 0]); // disk number
        fake.extend([0u8, 0]); // central directory disk
        fake.extend(count.to_le_bytes()); // entries on this disk
        fake.extend(count.to_le_bytes()); // total entries
        fake.extend(0xfffffff0u32.to_le_bytes()); // central directory size
        fake.extend(0xfffffff0u32.to_le_bytes()); // central directory offset
        fake.extend([0u8, 0]); // comment length
        fake
    }

    #[test]
    fn eocd_shaped_bytes_in_the_archive_comment_do_not_reject() {
        // the fake candidate sits at the end of the real archive comment,
        // end-aligned, declaring far more entries than the cap -- but its
        // central directory could not fit before it, so the precheck must
        // fall back to the real record instead of rejecting a valid archive
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("commented.osz");
        let file = std::fs::File::create(&path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        zip.set_raw_comment(implausible_fake_eocd(0xfffe).into_boxed_slice())
            .unwrap();
        zip.start_file("map.osu", zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"osu file format v14").unwrap();
        zip.finish().unwrap();

        let mut archive = open_osz(&path).unwrap();
        assert_eq!(archive.names(), ["map.osu"]);
        assert!(archive.first_osu().unwrap().is_some());
    }

    #[test]
    fn a_fake_eocd_copying_the_real_geometry_still_falls_back() {
        // the fake copies the genuine record's cd_size/cd_offset while
        // declaring a huge count; it still sits past where a record with
        // that geometry would, so the position equality skips it and the
        // real record governs
        let dir = tempfile::tempdir().unwrap();
        let plain = dir.path().join("plain.osz");
        write_osz(&plain, &[("map.osu", b"osu file format v14".as_slice())]);
        let bytes = std::fs::read(&plain).unwrap();
        let real_eocd = &bytes[bytes.len() - EOCD_FIXED_LEN..];

        let mut fake = Vec::new();
        fake.extend([0x50, 0x4b, 0x05, 0x06]); // signature
        fake.extend([0u8, 0, 0, 0]); // disk fields
        fake.extend(0xfffeu16.to_le_bytes()); // entries on this disk
        fake.extend(0xfffeu16.to_le_bytes()); // total entries
        fake.extend_from_slice(&real_eocd[12..20]); // real cd size + offset
        fake.extend([0u8, 0]); // comment length

        let path = dir.path().join("geometry.osz");
        let file = std::fs::File::create(&path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        zip.set_raw_comment(fake.into_boxed_slice()).unwrap();
        zip.start_file("map.osu", zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"osu file format v14").unwrap();
        zip.finish().unwrap();

        let mut archive = open_osz(&path).unwrap();
        assert!(archive.first_osu().unwrap().is_some());
    }

    /// zip64 eocd record + locator + sentinel eocd, declaring `total`
    /// entries; the file holds no actual central directory
    fn zip64_declaration(total: u64) -> Vec<u8> {
        let mut bytes = Vec::new();
        // zip64 eocd record at offset 0
        bytes.extend([0x50, 0x4b, 0x06, 0x06]); // signature
        bytes.extend(44u64.to_le_bytes()); // size of remaining record
        bytes.extend([0u8, 0, 0, 0]); // version made by / needed
        bytes.extend([0u8, 0, 0, 0]); // disk number
        bytes.extend([0u8, 0, 0, 0]); // central directory disk
        bytes.extend(total.to_le_bytes()); // entries on this disk
        bytes.extend(total.to_le_bytes()); // total entries
        bytes.extend(0u64.to_le_bytes()); // central directory size
        bytes.extend(0u64.to_le_bytes()); // central directory offset
        let locator_pos = bytes.len();
        // locator directly before the eocd
        bytes.extend([0x50, 0x4b, 0x06, 0x07]); // signature
        bytes.extend([0u8, 0, 0, 0]); // disk with the zip64 eocd
        bytes.extend(0u64.to_le_bytes()); // zip64 eocd record offset
        bytes.extend(1u32.to_le_bytes()); // total disks
        assert_eq!(bytes.len(), locator_pos + 20);
        // sentinel eocd
        bytes.extend([0x50, 0x4b, 0x05, 0x06]); // signature
        bytes.extend([0u8, 0]); // disk number
        bytes.extend([0u8, 0]); // central directory disk
        bytes.extend(0xffffu16.to_le_bytes()); // entries on this disk
        bytes.extend(0xffffu16.to_le_bytes()); // total entries
        bytes.extend(u32::MAX.to_le_bytes()); // central directory size
        bytes.extend(u32::MAX.to_le_bytes()); // central directory offset
        bytes.extend([0u8, 0]); // comment length
        bytes
    }

    #[test]
    fn an_unbacked_zip64_declaration_defers_to_the_parser() {
        // the zip64 record declares 20,000 entries that could not
        // physically fit below its own position; zip's fit rule discards
        // such a record, so the precheck must too rather than reject on it
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("liar64.osz");
        std::fs::write(&path, zip64_declaration(20_000)).unwrap();
        assert!(matches!(open_osz(&path), Err(IpcError::BeatmapParse { .. })));
    }

    #[test]
    fn a_real_zip64_entry_count_past_the_cap_rejects_before_parsing() {
        // 65,536 real entries overflow the u16 count and force the writer
        // into zip64; the validated zip64 chain must surface the real count
        // and reject it before the directory is parsed
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("big64.osz");
        let file = std::io::BufWriter::new(std::fs::File::create(&path).unwrap());
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        for i in 0..=u32::from(u16::MAX) {
            zip.start_file(format!("f{i}"), options).unwrap();
        }
        zip.finish().unwrap().flush().unwrap();

        match open_osz(&path) {
            Err(IpcError::ResourceLimit { cap, actual, .. }) => {
                assert_eq!(cap, "MAX_OSZ_ENTRIES");
                assert_eq!(actual, 65_536);
            }
            other => panic!("expected ResourceLimit, got {other:?}"),
        }
    }

    #[test]
    fn a_small_zip64_declaration_is_not_falsely_capped() {
        // the zip64 record declares 3 entries: the precheck must let the
        // archive through to the real parser (which then rejects it as
        // malformed, not as over the cap)
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("small64.osz");
        std::fs::write(&path, zip64_declaration(3)).unwrap();
        assert!(matches!(open_osz(&path), Err(IpcError::BeatmapParse { .. })));
    }

    #[test]
    fn entry_count_cap_boundary() {
        let names_at: Vec<String> = (0..crate::limits::MAX_OSZ_ENTRIES)
            .map(|i| format!("f{i}.txt"))
            .collect();
        let at: Vec<(&str, &[u8])> = names_at.iter().map(|n| (n.as_str(), b"".as_slice())).collect();
        let (_dir, path) = temp_osz(&at);
        assert!(open_osz(&path).is_ok());

        let names_past: Vec<String> = (0..=crate::limits::MAX_OSZ_ENTRIES)
            .map(|i| format!("f{i}.txt"))
            .collect();
        let past: Vec<(&str, &[u8])> = names_past.iter().map(|n| (n.as_str(), b"".as_slice())).collect();
        let (_dir2, path2) = temp_osz(&past);
        match open_osz(&path2) {
            Err(IpcError::ResourceLimit { cap, .. }) => assert_eq!(cap, "MAX_OSZ_ENTRIES"),
            other => panic!("expected ResourceLimit, got {other:?}"),
        }
    }

    #[test]
    fn a_non_zip_file_is_a_beatmap_parse_error() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("not.osz");
        std::fs::write(&path, b"definitely not a zip").unwrap();
        assert!(matches!(open_osz(&path), Err(IpcError::BeatmapParse { .. })));
    }

    #[test]
    fn a_dot_slash_prefixed_archive_extracts_its_media_too() {
        // a leading `./` is a no-op component that some packing tools write.
        // it must neither refuse the archive (it is safe) nor survive into the
        // index key -- the beatmap asks for `audio.mp3`, so an index keyed
        // `./audio.mp3` would load the map silent and background-less
        let osu = b"osu file format v14".as_slice();
        let (_dir, path) = temp_osz(&[
            ("./map.osu", osu),
            ("./audio.mp3", b"mp3 bytes".as_slice()),
            ("./sb/bg.jpg", b"jpg bytes".as_slice()),
        ]);
        let cache_root = tempfile::tempdir().unwrap();
        let mut archive = open_osz(&path).unwrap();
        let matched = archive.first_osu().unwrap().unwrap();

        let extracted = archive
            .extract_scene(
                matched.index,
                &matched.bytes,
                &["audio.mp3", "sb/bg.jpg"],
                &[],
                cache_root.path(),
                "test",
            )
            .unwrap();

        // the `.` is dropped on the way to disk, exactly as the writer drops it
        assert_eq!(std::fs::read(&extracted.osu_path).unwrap(), osu);
        assert_eq!(extracted.osu_path, extracted.beatmap_dir.join("map.osu"));
        assert_eq!(
            std::fs::read(extracted.beatmap_dir.join("audio.mp3")).unwrap(),
            b"mp3 bytes"
        );
        assert_eq!(
            std::fs::read(extracted.beatmap_dir.join("sb").join("bg.jpg")).unwrap(),
            b"jpg bytes"
        );
    }

    #[test]
    fn safe_relative_path_drops_no_op_components_and_refuses_every_escape() {
        // the direct unit pin: the `.osz` extraction path is the only caller,
        // and its own tests reach it through several layers
        assert_eq!(safe_relative_path("map.osu"), Some(std::path::PathBuf::from("map.osu")));
        assert_eq!(safe_relative_path("./map.osu"), Some(std::path::PathBuf::from("map.osu")));
        assert_eq!(safe_relative_path("./sb/./bg.jpg"), Some(std::path::PathBuf::from("sb/bg.jpg")));
        // nothing but no-op components is not a path
        assert_eq!(safe_relative_path("."), None);
        assert_eq!(safe_relative_path("./"), None);
        // and every escape still refused
        assert_eq!(safe_relative_path(".."), None);
        assert_eq!(safe_relative_path("./../evil"), None);
        assert_eq!(safe_relative_path("/abs.txt"), None);
        assert_eq!(safe_relative_path(r"C:\evil.png"), None);
        assert_eq!(safe_relative_path("c:evil.png"), None);
        assert_eq!(safe_relative_path("wrapper/c:evil.png"), None);
    }

    #[test]
    fn extracts_the_osu_and_referenced_media_preserving_paths() {
        let osu = b"osu file format v14".as_slice();
        let (_dir, path) = temp_osz(&[
            ("folder/map.osu", osu),
            // the archive spells the audio name differently than the .osu
            // references it: windows-authored sets do this constantly
            ("Audio.MP3", b"mp3 bytes".as_slice()),
            ("sb/bg.jpg", b"jpg bytes".as_slice()),
            ("unrelated.wav", b"never extracted".as_slice()),
        ]);
        let cache_root = tempfile::tempdir().unwrap();
        let mut archive = open_osz(&path).unwrap();
        let matched = archive.first_osu().unwrap().unwrap();

        let extracted = archive
            .extract_scene(
                matched.index,
                &matched.bytes,
                &["audio.mp3", "sb\\bg.jpg"],
                &[],
                cache_root.path(),
                "test",
            )
            .unwrap();

        assert_eq!(extracted.beatmap_dir, extracted.lease.dir());
        assert_eq!(std::fs::read(&extracted.osu_path).unwrap(), osu);
        assert!(extracted.osu_path.starts_with(extracted.lease.dir()));
        assert_eq!(
            std::fs::read(extracted.beatmap_dir.join("Audio.MP3")).unwrap(),
            b"mp3 bytes"
        );
        assert_eq!(
            std::fs::read(extracted.beatmap_dir.join("sb").join("bg.jpg")).unwrap(),
            b"jpg bytes"
        );
        assert!(
            !extracted.beatmap_dir.join("unrelated.wav").exists(),
            "only required members"
        );

        let dir = extracted.lease.dir().to_path_buf();
        drop(extracted);
        assert!(!dir.exists(), "dropping the scene's lease deletes the cache dir");
    }

    #[test]
    fn missing_media_members_are_skipped_not_fatal() {
        let (_dir, path) = temp_osz(&[("map.osu", b"x".as_slice())]);
        let cache_root = tempfile::tempdir().unwrap();
        let mut archive = open_osz(&path).unwrap();
        let matched = archive.first_osu().unwrap().unwrap();
        let extracted = archive
            .extract_scene(
                matched.index,
                &matched.bytes,
                &["nope.mp3"],
                &[],
                cache_root.path(),
                "t",
            )
            .unwrap();
        assert!(!extracted.beatmap_dir.join("nope.mp3").exists());
    }

    #[test]
    fn sample_members_extract_through_the_allow_list_and_nothing_else() {
        // the allow-list is derived from the map's own hitsounding, so it is
        // mostly names the archive does not have -- a miss is the norm here,
        // not an error. what must NOT happen is a member outside the list
        // riding along just because it is audio
        let (_dir, path) = temp_osz(&[
            ("map.osu", b"osu".as_slice()),
            ("normal-hitnormal.wav", b"wav bytes".as_slice()),
            ("unrelated-loop.wav", b"never asked for".as_slice()),
        ]);
        let cache_root = tempfile::tempdir().unwrap();
        let mut archive = open_osz(&path).unwrap();
        let matched = archive.first_osu().unwrap().unwrap();

        let extracted = archive
            .extract_scene(
                matched.index,
                &matched.bytes,
                &[],
                &["normal-hitnormal.wav", "normal-hitnormal.mp3", "soft-hitclap.wav"],
                cache_root.path(),
                "t",
            )
            .unwrap();

        assert_eq!(
            std::fs::read(extracted.beatmap_dir.join("normal-hitnormal.wav")).unwrap(),
            b"wav bytes"
        );
        assert!(
            !extracted.beatmap_dir.join("unrelated-loop.wav").exists(),
            "an audio member outside the allow-list must not be extracted"
        );
    }

    #[test]
    fn one_member_named_twice_is_extracted_and_charged_once() {
        // a stem and its explicit filename can normalize onto the same
        // member; charging it twice would spend the budget on one file
        let (_dir, path) = temp_osz(&[("map.osu", b"osu".as_slice()), ("kick.wav", b"123456".as_slice())]);
        let cache_root = tempfile::tempdir().unwrap();
        let mut archive = open_osz(&path).unwrap();
        let matched = archive.first_osu().unwrap().unwrap();

        // 3 (.osu) + 6 (kick.wav) = 9 written bytes, even though the name is
        // asked for twice
        assert!(archive
            .extract_scene_with_budget(
                matched.index,
                &matched.bytes,
                &[],
                &["kick.wav", "KICK.WAV"],
                cache_root.path(),
                "t",
                9,
                9,
                u64::MAX,
                usize::MAX,
            )
            .is_ok());
    }

    #[test]
    fn sample_byte_budget_boundary() {
        // engine::limits::MAX_SAMPLE_BYTES on the EXTRACT side. it is charged
        // separately from the archive budget: a mapset whose samples alone
        // exceed it is refused even when the archive budget has room
        let (_dir, path) = temp_osz(&[("map.osu", b"osu".as_slice()), ("kick.wav", b"123456".as_slice())]);
        let cache_root = tempfile::tempdir().unwrap();

        let mut archive = open_osz(&path).unwrap();
        let matched = archive.first_osu().unwrap().unwrap();
        assert!(archive
            .extract_scene_with_budget(
                matched.index,
                &matched.bytes,
                &[],
                &["kick.wav"],
                cache_root.path(),
                "t",
                u64::MAX,
                6,
                u64::MAX,
                usize::MAX,
            )
            .is_ok());

        let mut archive = open_osz(&path).unwrap();
        let matched = archive.first_osu().unwrap().unwrap();
        match archive.extract_scene_with_budget(
            matched.index,
            &matched.bytes,
            &[],
            &["kick.wav"],
            cache_root.path(),
            "t",
            u64::MAX,
            5,
            u64::MAX,
            usize::MAX,
        ) {
            Err(IpcError::ResourceLimit { cap, limit: 5, .. }) => assert_eq!(cap, "MAX_SAMPLE_BYTES"),
            other => panic!("expected ResourceLimit, got {other:?}"),
        }
        // the .osu itself is never charged against the SAMPLE budget, only
        // against the archive one -- otherwise a large difficulty would eat
        // the hitsound allowance
    }

    #[test]
    fn a_member_that_is_both_media_and_a_sample_still_owes_the_sample_budget() {
        // the alias a crafted set would reach for: name the audio file after
        // one of the map's own hitsound candidates and the member is requested
        // twice, as media and as a sample. extracting it under the first role
        // and skipping the second would let it through on the archive budget's
        // much larger allowance, which is the one thing the sample cap exists
        // to stop
        let (_dir, path) = temp_osz(&[
            ("map.osu", b"osu".as_slice()),
            ("normal-hitnormal.wav", b"123456".as_slice()),
        ]);
        let cache_root = tempfile::tempdir().unwrap();

        let mut archive = open_osz(&path).unwrap();
        let matched = archive.first_osu().unwrap().unwrap();
        match archive.extract_scene_with_budget(
            matched.index,
            &matched.bytes,
            &["normal-hitnormal.wav"],
            &["normal-hitnormal.wav"],
            cache_root.path(),
            "t",
            u64::MAX,
            5,
            u64::MAX,
            usize::MAX,
        ) {
            Err(IpcError::ResourceLimit { cap, limit: 5, .. }) => assert_eq!(cap, "MAX_SAMPLE_BYTES"),
            other => panic!("expected ResourceLimit, got {other:?}"),
        }

        // and it is still written exactly ONCE when both budgets have room --
        // the aliasing must not charge the archive budget twice either
        let mut archive = open_osz(&path).unwrap();
        let matched = archive.first_osu().unwrap().unwrap();
        let scene = archive
            .extract_scene_with_budget(
                matched.index,
                &matched.bytes,
                &["normal-hitnormal.wav"],
                &["normal-hitnormal.wav"],
                cache_root.path(),
                "t",
                9,
                6,
                u64::MAX,
                usize::MAX,
            )
            .expect("3 osu bytes + 6 member bytes fits the archive budget exactly");
        assert_eq!(
            std::fs::read(scene.beatmap_dir.join("normal-hitnormal.wav")).unwrap(),
            b"123456"
        );
    }

    #[test]
    fn element_named_textures_are_extracted_and_other_images_are_not() {
        // the art needs no allow-list from the caller: a texture lookup name is
        // an element name, so the extractor runs the same prefix filter the
        // folder walk does. everything outside it -- the background, a
        // storyboard's nested art -- stays in the archive
        let (_dir, path) = temp_osz(&[
            ("map.osu", b"osu".as_slice()),
            ("hitcircle.png", b"png bytes".as_slice()),
            ("bg.jpg", b"never art".as_slice()),
            ("sb/hit0.png", b"not root".as_slice()),
        ]);
        let cache_root = tempfile::tempdir().unwrap();
        let mut archive = open_osz(&path).unwrap();
        let matched = archive.first_osu().unwrap().unwrap();
        let extracted = archive
            .extract_scene(matched.index, &matched.bytes, &[], &[], cache_root.path(), "t")
            .unwrap();
        assert_eq!(
            std::fs::read(extracted.beatmap_dir.join("hitcircle.png")).unwrap(),
            b"png bytes"
        );
        assert!(
            !extracted.beatmap_dir.join("bg.jpg").exists(),
            "an image outside the element prefixes must not be extracted"
        );
        assert!(
            !extracted.beatmap_dir.join("sb").join("hit0.png").exists(),
            "a nested member cannot answer the root-level folder walk and must not be extracted"
        );
    }

    #[test]
    fn texture_byte_budget_boundary() {
        // engine::limits::MAX_BEATMAP_TEXTURE_BYTES on the EXTRACT side,
        // charged separately from the archive budget the way the sample
        // budget is
        let (_dir, path) = temp_osz(&[
            ("map.osu", b"osu".as_slice()),
            ("hitcircle.png", b"123456".as_slice()),
        ]);
        let cache_root = tempfile::tempdir().unwrap();

        let mut archive = open_osz(&path).unwrap();
        let matched = archive.first_osu().unwrap().unwrap();
        assert!(archive
            .extract_scene_with_budget(
                matched.index,
                &matched.bytes,
                &[],
                &[],
                cache_root.path(),
                "t",
                u64::MAX,
                u64::MAX,
                6,
                usize::MAX,
            )
            .is_ok());

        let mut archive = open_osz(&path).unwrap();
        let matched = archive.first_osu().unwrap().unwrap();
        match archive.extract_scene_with_budget(
            matched.index,
            &matched.bytes,
            &[],
            &[],
            cache_root.path(),
            "t",
            u64::MAX,
            u64::MAX,
            5,
            usize::MAX,
        ) {
            Err(IpcError::ResourceLimit { cap, limit: 5, .. }) => {
                assert_eq!(cap, "MAX_BEATMAP_TEXTURE_BYTES");
            }
            other => panic!("expected ResourceLimit, got {other:?}"),
        }
    }

    #[test]
    fn texture_count_cap_boundary() {
        // zero-byte members, deliberately: no byte budget can see these, and
        // the count is checked before anything is written
        let (_dir, path) = temp_osz(&[
            ("map.osu", b"osu".as_slice()),
            ("hitcircle.png", b"".as_slice()),
            ("cursor.png", b"".as_slice()),
        ]);
        let cache_root = tempfile::tempdir().unwrap();

        let mut archive = open_osz(&path).unwrap();
        let matched = archive.first_osu().unwrap().unwrap();
        assert!(archive
            .extract_scene_with_budget(
                matched.index,
                &matched.bytes,
                &[],
                &[],
                cache_root.path(),
                "t",
                u64::MAX,
                u64::MAX,
                u64::MAX,
                2,
            )
            .is_ok());

        let mut archive = open_osz(&path).unwrap();
        let matched = archive.first_osu().unwrap().unwrap();
        match archive.extract_scene_with_budget(
            matched.index,
            &matched.bytes,
            &[],
            &[],
            cache_root.path(),
            "t",
            u64::MAX,
            u64::MAX,
            u64::MAX,
            1,
        ) {
            Err(IpcError::ResourceLimit {
                cap,
                limit: 1,
                actual: 2,
            }) => assert_eq!(cap, "MAX_BEATMAP_TEXTURES"),
            other => panic!("expected ResourceLimit, got {other:?}"),
        }
    }

    #[test]
    fn extracted_bytes_cap_boundary() {
        // 4-byte .osu + 6-byte audio = 10 written bytes exactly
        let (_dir, path) = temp_osz(&[("map.osu", b"1234".as_slice()), ("a.mp3", b"123456".as_slice())]);
        let cache_root = tempfile::tempdir().unwrap();

        let mut archive = open_osz(&path).unwrap();
        let matched = archive.first_osu().unwrap().unwrap();
        assert!(archive
            .extract_scene_with_budget(
                matched.index,
                &matched.bytes,
                &["a.mp3"],
                &[],
                cache_root.path(),
                "t",
                10,
                u64::MAX,
                u64::MAX,
                usize::MAX,
            )
            .is_ok());

        let mut archive = open_osz(&path).unwrap();
        let matched = archive.first_osu().unwrap().unwrap();
        match archive.extract_scene_with_budget(
            matched.index,
            &matched.bytes,
            &["a.mp3"],
            &[],
            cache_root.path(),
            "t",
            9,
            u64::MAX,
            u64::MAX,
            usize::MAX,
        ) {
            Err(IpcError::ResourceLimit { cap, limit: 9, .. }) => {
                assert_eq!(cap, "MAX_OSZ_EXTRACTED_BYTES");
            }
            other => panic!("expected ResourceLimit, got {other:?}"),
        }
        // both leases are gone by now -- the failed extraction dropped its
        // fresh lease on the error return, and the successful one above was
        // never bound, so its ExtractedScene dropped immediately
        assert_eq!(std::fs::read_dir(cache_root.path()).unwrap().count(), 0);
    }
}
