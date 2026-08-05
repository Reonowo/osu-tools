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
use crate::limits::{
    MAX_OSZ_ENTRIES, MAX_OSZ_EXTRACTED_BYTES, MAX_OSZ_FILE_BYTES, MAX_OSZ_SCAN_BYTES,
};

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
    IpcError::BeatmapParse { message: format!("osz: {what}") }
}

// zip 8's enclosed_name() only rejects a root/prefix component when it
// follows a normal component (e.g. "foo/C:/x"); a bare absolute name like
// "/etc/passwd" or "C:\x" at depth zero comes back Some(relative-path) --
// it strips the root rather than rejecting it, mirroring how many zip tools
// extract absolute paths. the spec calls for rejecting absolute names
// outright, so that case is checked explicitly alongside enclosed_name
fn is_absolute_entry_name(name: &str) -> bool {
    name.starts_with('/')
        || name.starts_with('\\')
        || (name.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
            && name.as_bytes().get(1) == Some(&b':'))
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
        if hit < declared.saturating_mul(CDFH_FIXED_LEN as u64).saturating_add(cd_offset) {
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
    let u32_at =
        |at: usize| u32::from_le_bytes([tail[at], tail[at + 1], tail[at + 2], tail[at + 3]]);
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

        if declared == 0xffff || cd_size == u64::from(u32::MAX) || cd_offset == u64::from(u32::MAX)
        {
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
        if entry.enclosed_name().is_none()
            || has_parent_component
            || is_absolute_entry_name(entry.name())
        {
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

    /// reads member `index` in full, bounded by `cap`; None when it is larger
    fn read_member_capped(&mut self, index: usize, cap: u64) -> Result<Option<Vec<u8>>, IpcError> {
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
        // every decompressed candidate byte is charged against one aggregate
        // budget, so an archive full of maximum-size .osu members cannot
        // force unbounded decompression on the way to not-found. each read
        // is also clamped to what the budget can still afford, so actual
        // decompression never outruns the cap by more than a single byte
        let mut budget = ByteBudget { used: 0, max: scan_budget, cap: "MAX_OSZ_SCAN_BYTES" };
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
            if actual.eq_ignore_ascii_case(md5) {
                return Ok(Some(MatchedOsu { index, bytes, md5: actual }));
            }
        }
        Ok(None)
    }

    /// the deterministic override target: first .osu by entry name
    pub fn first_osu(&mut self) -> Result<Option<MatchedOsu>, IpcError> {
        let Some(&index) = self.osu_indices_by_name().first() else { return Ok(None) };
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
    name.replace('\\', "/").to_ascii_lowercase()
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
        cache_root: &Path,
        label: &str,
    ) -> Result<ExtractedScene, IpcError> {
        self.extract_scene_with_budget(
            osu_index,
            osu_bytes,
            media_names,
            cache_root,
            label,
            MAX_OSZ_EXTRACTED_BYTES,
        )
    }

    /// the budget is a parameter so the boundary test can drive it with tiny
    /// members; the public method passes MAX_OSZ_EXTRACTED_BYTES. on any
    /// error the fresh lease drops with the early return, deleting the
    /// partial directory
    pub fn extract_scene_with_budget(
        &mut self,
        osu_index: usize,
        osu_bytes: &[u8],
        media_names: &[&str],
        cache_root: &Path,
        label: &str,
        max_total: u64,
    ) -> Result<ExtractedScene, IpcError> {
        std::fs::create_dir_all(cache_root)?;
        let lease = create_leased_dir(cache_root, label)?;
        let mut budget = ByteBudget { used: 0, max: max_total, cap: "MAX_OSZ_EXTRACTED_BYTES" };

        let osu_rel = {
            let entry = self.archive.by_index(osu_index).map_err(archive_err)?;
            entry.enclosed_name().expect("open_osz validated every entry name")
        };
        let osu_path = lease.dir().join(&osu_rel);
        budget.charge(osu_bytes.len() as u64)?;
        write_member(&osu_path, osu_bytes)?;

        for media in media_names {
            let want = normalize_entry_name(media);
            let found =
                (0..self.names.len()).find(|&i| normalize_entry_name(&self.names[i]) == want);
            let Some(index) = found else {
                // a beatmap referencing media its archive lacks is common;
                // the scene simply loads without it (AudioMissing warning
                // downstream)
                continue;
            };
            let mut entry = self.archive.by_index(index).map_err(archive_err)?;
            let rel = entry.enclosed_name().expect("open_osz validated every entry name");
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
                // charge before writing so the cap also bounds bytes on disk
                budget.charge(n as u64)?;
                out.write_all(&buf[..n])?;
            }
        }

        let beatmap_dir = lease.dir().to_path_buf();
        Ok(ExtractedScene { lease, osu_path, beatmap_dir })
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

        assert!(archive.find_osu_by_md5("00000000000000000000000000000000").unwrap().is_none());
    }

    #[test]
    fn first_osu_is_deterministic_by_name() {
        let (_dir, path) = temp_osz(&[("z.osu", b"zz".as_slice()), ("a.osu", b"aa".as_slice()), ("audio.mp3", b"x".as_slice())]);
        let mut archive = open_osz(&path).unwrap();
        let first = archive.first_osu().unwrap().unwrap();
        assert_eq!(first.bytes, b"aa");
    }

    #[test]
    fn oversized_candidates_are_skipped_not_fatal() {
        let (_dir, path) = temp_osz(&[("big.osu", b"0123456789".as_slice()), ("small.osu", b"ok".as_slice())]);
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
            Err(IpcError::ResourceLimit { cap, limit: 7, actual: 8 }) => {
                assert_eq!(cap, "MAX_OSZ_SCAN_BYTES");
            }
            other => panic!("expected ResourceLimit, got {other:?}"),
        }
    }

    #[test]
    fn oversized_skipped_candidates_still_charge_the_scan_budget() {
        // big.osu exceeds the 5-byte candidate cap, so its skip charges
        // cap + 1 = 6 bytes; a 7-byte budget then cannot afford small.osu
        let (_dir, path) = temp_osz(&[("big.osu", b"0123456789".as_slice()), ("small.osu", b"ok".as_slice())]);
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
        let names: Vec<String> =
            (0..=crate::limits::MAX_OSZ_ENTRIES).map(|i| format!("f{i}.txt")).collect();
        let entries: Vec<(&str, &[u8])> =
            names.iter().map(|n| (n.as_str(), b"".as_slice())).collect();
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
        zip.start_file("map.osu", zip::write::SimpleFileOptions::default()).unwrap();
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
        zip.set_raw_comment(implausible_fake_eocd(0xfffe).into_boxed_slice()).unwrap();
        zip.start_file("map.osu", zip::write::SimpleFileOptions::default()).unwrap();
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
        zip.start_file("map.osu", zip::write::SimpleFileOptions::default()).unwrap();
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
        let names_at: Vec<String> =
            (0..crate::limits::MAX_OSZ_ENTRIES).map(|i| format!("f{i}.txt")).collect();
        let at: Vec<(&str, &[u8])> = names_at.iter().map(|n| (n.as_str(), b"".as_slice())).collect();
        let (_dir, path) = temp_osz(&at);
        assert!(open_osz(&path).is_ok());

        let names_past: Vec<String> =
            (0..=crate::limits::MAX_OSZ_ENTRIES).map(|i| format!("f{i}.txt")).collect();
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
            .extract_scene(matched.index, &matched.bytes, &["audio.mp3", "sb\\bg.jpg"], cache_root.path(), "test")
            .unwrap();

        assert_eq!(extracted.beatmap_dir, extracted.lease.dir());
        assert_eq!(std::fs::read(&extracted.osu_path).unwrap(), osu);
        assert!(extracted.osu_path.starts_with(extracted.lease.dir()));
        assert_eq!(std::fs::read(extracted.beatmap_dir.join("Audio.MP3")).unwrap(), b"mp3 bytes");
        assert_eq!(std::fs::read(extracted.beatmap_dir.join("sb").join("bg.jpg")).unwrap(), b"jpg bytes");
        assert!(!extracted.beatmap_dir.join("unrelated.wav").exists(), "only required members");

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
            .extract_scene(matched.index, &matched.bytes, &["nope.mp3"], cache_root.path(), "t")
            .unwrap();
        assert!(!extracted.beatmap_dir.join("nope.mp3").exists());
    }

    #[test]
    fn extracted_bytes_cap_boundary() {
        // 4-byte .osu + 6-byte audio = 10 written bytes exactly
        let (_dir, path) = temp_osz(&[("map.osu", b"1234".as_slice()), ("a.mp3", b"123456".as_slice())]);
        let cache_root = tempfile::tempdir().unwrap();

        let mut archive = open_osz(&path).unwrap();
        let matched = archive.first_osu().unwrap().unwrap();
        assert!(archive
            .extract_scene_with_budget(matched.index, &matched.bytes, &["a.mp3"], cache_root.path(), "t", 10)
            .is_ok());

        let mut archive = open_osz(&path).unwrap();
        let matched = archive.first_osu().unwrap().unwrap();
        match archive.extract_scene_with_budget(matched.index, &matched.bytes, &["a.mp3"], cache_root.path(), "t", 9)
        {
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
