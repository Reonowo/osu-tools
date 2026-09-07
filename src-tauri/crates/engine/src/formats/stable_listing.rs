//! `osu!.db`, osu! stable's own beatmap listing: the index the app's stable
//! lookup answers "which installed `.osu` has this md5" from.
//!
//! not a port of a lazer source file -- lazer never reads this listing at
//! all; its stable import walks the Songs directory instead. the byte
//! framing is stable's own, read through the shared
//! `formats::binary` primitives (which do port
//! `SerializationReader.cs`) and pinned by real client bytes in
//! `fixtures/stable/<version>/`, one slice on each side of the one layout
//! change stable has made to this file since 2019.
//!
//! # what it keeps
//!
//! md5, folder name and file name, per entry, and the listing's version.
//! that is the whole question a beatmap lookup asks. every other field --
//! the metadata, the star ratings, the timing points, the play data, and the
//! player name in the header -- is WALKED and discarded, so a large string
//! or a fat rating table pads the file without costing a byte of memory. no
//! lookup policy lives here: which entry answers a hash, and what a stale
//! one means, is the app's own rule.
//!
//! # the three layout gates
//!
//! - before **20140609**: the four difficulty values are single bytes rather
//!   than floats, there are no star-rating pairs at all, and an extra short
//!   trails the entry
//! - before **20191106**: each entry is preceded by its own byte size
//! - at **20250107** the star-rating pairs changed from int-double to
//!   int-float. this reader does not gate on that version: a pair's width is
//!   read off the **value's own tag byte** (`0x0d` double, `0x0c` float),
//!   because the wire self-describes it. that is the one change stable has
//!   already made here once, and gating on the version is exactly what left
//!   the third-party crate this replaces unable to read a current client's
//!   listing for four months
//!
//! # strictness
//!
//! the walk must consume the file exactly: it ends at the trailing
//! user-permissions int and nothing may follow. a truncated file, trailing
//! surplus, an unexpected string tag or an unexpected rating tag is an
//! [`EngineError::StableListingParse`] whose message carries the listing
//! version and the byte the walk stopped at. that is deliberate and it is
//! the reader's early-warning system: the next layout change fails a fixture
//! test here rather than silently resolving half a library.

use crate::error::{resource_limit, EngineError, Result};
use crate::formats::binary::Reader;
use crate::limits;

/// the version at which the four difficulty values became floats and the
/// per-mod star-rating pairs appeared
const CHANGE_20140609: i32 = 20140609;

/// the version at which stable stopped prefixing each entry with its size
const CHANGE_20191106: i32 = 20191106;

/// a star-rating pair opens with .net's `int` type tag
const PAIR_INT_TAG: u8 = 0x08;

/// the pair's value tag before 20250107
const PAIR_DOUBLE_TAG: u8 = 0x0d;

/// the pair's value tag from 20250107
const PAIR_FLOAT_TAG: u8 = 0x0c;

/// how many bytes one timing point occupies: bpm, offset, and the inherited
/// flag. walked as a block rather than field by field, since none of it is
/// kept
const TIMING_POINT_BYTES: usize = 8 + 8 + 1;

#[derive(Debug, Clone, PartialEq)]
pub struct StableListing {
    pub version: i32,
    pub entries: Vec<StableListingEntry>,
}

/// one beatmap's row, cut to the three fields a lookup resolves through. all
/// three are optional because the wire's string tag has a null spelling and
/// stable does write it -- an entry missing any of them simply cannot answer
/// a lookup, which is the reading app's call to make, not this codec's
#[derive(Debug, Clone, PartialEq)]
pub struct StableListingEntry {
    pub md5: Option<String>,
    pub folder_name: Option<String>,
    pub file_name: Option<String>,
}

/// decodes a whole `osu!.db`. the byte length is charged against
/// [`limits::MAX_OSU_DB_BYTES`] before anything is read.
pub fn decode_stable_listing(bytes: &[u8]) -> Result<StableListing> {
    decode_stable_listing_capped(bytes, limits::MAX_OSU_DB_BYTES)
}

/// [`decode_stable_listing`] with the byte cap supplied, so the boundary test
/// can prove the check without allocating 256 MiB (same shape as
/// `path::approximator`'s capped entry points)
fn decode_stable_listing_capped(bytes: &[u8], max_bytes: u64) -> Result<StableListing> {
    if bytes.len() as u64 > max_bytes {
        return Err(resource_limit(
            "MAX_OSU_DB_BYTES",
            max_bytes,
            bytes.len() as u64,
        ));
    }
    let mut r = Reader::new(bytes, EngineError::StableListingParse);
    // the version governs every gate below it, so it is read before the walk
    // and reported by every message the walk raises
    let version = r.i32("version")?;
    match walk(&mut r, version) {
        Ok(entries) => Ok(StableListing { version, entries }),
        Err(e) => Err(annotate(e, version, r.pos())),
    }
}

/// every failure inside the walk gains the two facts that make it
/// actionable: which layout was being read, and where the walk gave up. a
/// cap breach or an io error passes through untouched -- neither is about
/// the layout
fn annotate(e: EngineError, version: i32, pos: usize) -> EngineError {
    match e {
        EngineError::StableListingParse(message) => EngineError::StableListingParse(format!(
            "osu!.db version {version} (walk stopped at byte {pos}): {message}"
        )),
        other => other,
    }
}

fn walk(r: &mut Reader, version: i32) -> Result<Vec<StableListingEntry>> {
    r.skip(4, "header.folder_count")?;
    r.skip(1, "header.account_unlocked")?;
    r.skip(8, "header.unlock_date")?;
    r.skip_osu_string("header.player_name")?;

    let declared = declared_count(r, "header.beatmap_count")?;
    // never `with_capacity`: the count is untrusted and an entry costs over a
    // hundred wire bytes, so growth is bounded by the file the cap already
    // bounded, where a reservation is bounded by nothing
    let mut entries = Vec::new();
    for _ in 0..declared {
        entries.push(entry(r, version)?);
    }

    r.skip(4, "footer.user_permissions")?;
    let trailing = r.remaining().len();
    if trailing > 0 {
        return Err(r.error(format!(
            "{trailing} trailing bytes after the user-permissions int; \
             the walk did not consume the file exactly"
        )));
    }
    Ok(entries)
}

/// a length prefix, refused rather than saturated when it is negative: a
/// negative count means the walk is already reading the wrong bytes, and
/// silently treating it as zero would resynchronise onto garbage
fn declared_count(r: &mut Reader, what: &'static str) -> Result<usize> {
    let declared = r.i32(what)?;
    usize::try_from(declared).map_err(|_| r.error(format!("negative {what} ({declared})")))
}

fn entry(r: &mut Reader, version: i32) -> Result<StableListingEntry> {
    if version < CHANGE_20191106 {
        // the entry's own byte size. deliberately not used to skip the
        // entry: walking every field is what makes a layout change fail here
        // instead of resolving half a library from misread bytes
        r.skip(4, "entry.size")?;
    }
    r.skip_osu_string("entry.artist")?;
    r.skip_osu_string("entry.artist_unicode")?;
    r.skip_osu_string("entry.title")?;
    r.skip_osu_string("entry.title_unicode")?;
    r.skip_osu_string("entry.creator")?;
    r.skip_osu_string("entry.difficulty")?;
    r.skip_osu_string("entry.audio")?;
    let md5 = r.osu_string("entry.md5")?;
    let file_name = r.osu_string("entry.file_name")?;
    // ranked status, circle/slider/spinner counts, last-modified ticks
    r.skip(1 + 2 + 2 + 2 + 8, "entry.counts")?;
    // approach rate, circle size, hp drain, overall difficulty
    let difficulty_width = if version < CHANGE_20140609 { 1 } else { 4 };
    r.skip(4 * difficulty_width, "entry.difficulty_values")?;
    r.skip(8, "entry.slider_velocity")?;
    if version >= CHANGE_20140609 {
        for what in [
            "entry.std_ratings",
            "entry.taiko_ratings",
            "entry.ctb_ratings",
            "entry.mania_ratings",
        ] {
            skip_star_ratings(r, what)?;
        }
    }
    // drain time, total time, preview time
    r.skip(12, "entry.times")?;
    let timing_points = declared_count(r, "entry.timing_point_count")?;
    let span = timing_points
        .checked_mul(TIMING_POINT_BYTES)
        .ok_or_else(|| r.error(format!("timing point count {timing_points} overflows the file")))?;
    r.skip(span, "entry.timing_points")?;
    // beatmap/set/thread ids, the four per-mode grades, local offset,
    // stack leniency, mode
    r.skip(12 + 4 + 2 + 4 + 1, "entry.ids_and_grades")?;
    r.skip_osu_string("entry.source")?;
    r.skip_osu_string("entry.tags")?;
    r.skip(2, "entry.online_offset")?;
    r.skip_osu_string("entry.title_font")?;
    // unplayed flag, last-played ticks, osz2 flag
    r.skip(1 + 8 + 1, "entry.play_data")?;
    let folder_name = r.osu_string("entry.folder_name")?;
    // last online check, then the five per-map override toggles
    r.skip(8 + 5, "entry.toggles")?;
    if version < CHANGE_20140609 {
        r.skip(2, "entry.unknown_short")?;
    }
    // last modification time, mania scroll speed
    r.skip(4 + 1, "entry.tail")?;

    Ok(StableListingEntry {
        md5,
        folder_name,
        file_name,
    })
}

/// walks one mode's per-mod star ratings. each pair is an int-tagged mod
/// bitfield followed by a value whose OWN tag gives its width -- the point of
/// this whole module (see the module doc's third gate)
fn skip_star_ratings(r: &mut Reader, what: &'static str) -> Result<()> {
    for _ in 0..declared_count(r, what)? {
        let int_tag = r.u8(what)?;
        if int_tag != PAIR_INT_TAG {
            return Err(r.error(format!(
                "{what}: pair opened with tag 0x{int_tag:02x}, expected 0x{PAIR_INT_TAG:02x}"
            )));
        }
        r.skip(4, what)?;
        // the value is dropped -- no lookup asks about star ratings -- but it
        // is READ at its own width rather than skipped by a byte count, so
        // the tag branch says which of stable's two layouts this pair is in
        // rather than merely how far to jump
        match r.u8(what)? {
            PAIR_DOUBLE_TAG => {
                r.f64(what)?;
            }
            PAIR_FLOAT_TAG => {
                r.f32(what)?;
            }
            other => {
                return Err(r.error(format!(
                    "{what}: rating value carried tag 0x{other:02x}, expected \
                     0x{PAIR_DOUBLE_TAG:02x} (double) or 0x{PAIR_FLOAT_TAG:02x} (float)"
                )))
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    const CARNIVAL_MD5: &str = "73dc65db8bf113b5bf21d7ace5ef131b";
    const CARNIVAL_FOLDER: &str = "Carnival";
    const CARNIVAL_FILE: &str = "- Carnival (Pawnables) [Merry Go 'Round].osu";

    fn slice_bytes(version: &str) -> Vec<u8> {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../fixtures/stable")
            .join(version)
            .join("osu!.db");
        std::fs::read(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
    }

    /// both slices are the SAME beatmap written by two clients four format
    /// years apart (`fixtures/stable/*/README.md`): 20260711 carries
    /// float-tagged star ratings, 20231102 double-tagged ones. that they read
    /// identically is the whole point of reading the pair off its own tag
    #[test]
    fn both_real_slices_decode_field_exact() {
        for (version, expected_version) in [("20260711", 20260711), ("20231102", 20231102)] {
            let listing = decode_stable_listing(&slice_bytes(version)).unwrap();
            assert_eq!(listing.version, expected_version, "{version}");
            assert_eq!(listing.entries.len(), 1, "{version}");
            let entry = &listing.entries[0];
            assert_eq!(entry.md5.as_deref(), Some(CARNIVAL_MD5), "{version}");
            assert_eq!(entry.folder_name.as_deref(), Some(CARNIVAL_FOLDER), "{version}");
            assert_eq!(entry.file_name.as_deref(), Some(CARNIVAL_FILE), "{version}");
        }
    }

    /// the no-panic guarantee at this codec's boundary, in both profiles.
    /// prior art: `formats::osr::tests::truncation_at_every_offset_never_panics`
    #[test]
    fn truncation_at_every_offset_never_panics() {
        for version in ["20260711", "20231102"] {
            let bytes = slice_bytes(version);
            for cut in 0..bytes.len() {
                match decode_stable_listing(&bytes[..cut]) {
                    Err(EngineError::StableListingParse(_)) => {}
                    other => panic!("{version} cut at {cut}: expected a listing-parse error, got {other:?}"),
                }
            }
            // and the uncut file still decodes, so the loop above was not
            // passing for the wrong reason
            assert!(decode_stable_listing(&bytes).is_ok(), "{version}");
        }
    }

    #[test]
    fn one_byte_past_the_permissions_int_is_refused() {
        let mut bytes = slice_bytes("20260711");
        bytes.push(0);
        match decode_stable_listing(&bytes) {
            Err(EngineError::StableListingParse(msg)) => {
                assert!(msg.contains("1 trailing bytes"), "{msg}");
                assert!(msg.contains("20260711"), "the version belongs in the message: {msg}");
            }
            other => panic!("expected a listing-parse error, got {other:?}"),
        }
    }

    /// the two tag families the walk reads rather than assumes. both messages
    /// have to carry the version and the byte offset, because the next layout
    /// change is diagnosed from exactly those two facts
    #[test]
    fn an_unexpected_string_tag_and_an_unexpected_pair_tag_are_refused_with_the_offset() {
        let bytes = slice_bytes("20260711");

        // the player-name string is the header's only tagged string, at a
        // fixed offset: version, folder count, unlocked byte, unlock date
        let name_tag = 4 + 4 + 1 + 8;
        assert_eq!(bytes[name_tag], 0x0b, "fixture layout moved");
        let mut broken = bytes.clone();
        broken[name_tag] = 0x0c;
        match decode_stable_listing(&broken) {
            Err(EngineError::StableListingParse(msg)) => {
                assert!(msg.contains("invalid string prefix 0x0c"), "{msg}");
                assert!(msg.contains("header.player_name"), "{msg}");
                assert!(msg.contains("20260711") && msg.contains("byte"), "{msg}");
            }
            other => panic!("expected a listing-parse error, got {other:?}"),
        }

        // the first rating value tag: the float tag this slice was written
        // with, corrupted to a width the reader has never seen
        let value_tag = first_rating_value_tag_offset(&bytes, 36);
        assert_eq!(bytes[value_tag], PAIR_FLOAT_TAG, "fixture layout moved");
        let mut broken = bytes.clone();
        broken[value_tag] = 0x0e;
        match decode_stable_listing(&broken) {
            Err(EngineError::StableListingParse(msg)) => {
                assert!(msg.contains("tag 0x0e"), "{msg}");
                assert!(msg.contains("entry.std_ratings"), "{msg}");
                assert!(msg.contains("20260711") && msg.contains("byte"), "{msg}");
            }
            other => panic!("expected a listing-parse error, got {other:?}"),
        }

        // the pair's opening int tag, on the same pair
        let mut broken = bytes.clone();
        broken[value_tag - 5] = 0x09;
        match decode_stable_listing(&broken) {
            Err(EngineError::StableListingParse(msg)) => {
                assert!(msg.contains("pair opened with tag 0x09"), "{msg}")
            }
            other => panic!("expected a listing-parse error, got {other:?}"),
        }
    }

    /// finds the first std rating pair's VALUE tag by locating the `0x08`
    /// that opens the pair list, recognised by the pair count immediately in
    /// front of it. done by scan rather than by hardcoding, so the test
    /// survives a fixture whose metadata strings are a different length
    fn first_rating_value_tag_offset(bytes: &[u8], pair_count: i32) -> usize {
        // the pair list is preceded by its i32 count; the first pair is
        // `0x08 <i32 mods> <tag> <value>`
        for i in 4..bytes.len() - 6 {
            if bytes[i] == PAIR_INT_TAG
                && matches!(bytes[i + 5], PAIR_DOUBLE_TAG | PAIR_FLOAT_TAG)
                && i32::from_le_bytes(bytes[i - 4..i].try_into().unwrap()) == pair_count
            {
                return i + 5;
            }
        }
        panic!("no star-rating pair found in the fixture");
    }

    #[test]
    fn osu_db_byte_size_cap_boundary() {
        let bytes = slice_bytes("20260711");
        let exact = bytes.len() as u64;
        assert!(
            decode_stable_listing_capped(&bytes, exact).is_ok(),
            "a file exactly at the cap must be accepted"
        );
        match decode_stable_listing_capped(&bytes, exact - 1) {
            Err(EngineError::ResourceLimit { cap, limit, actual }) => {
                assert_eq!(cap, "MAX_OSU_DB_BYTES");
                assert_eq!(limit, exact - 1);
                assert_eq!(actual, exact);
            }
            other => panic!("expected a ResourceLimit, got {other:?}"),
        }
    }

    #[test]
    fn max_osu_db_bytes_constant_matches_limits_module() {
        assert_eq!(limits::MAX_OSU_DB_BYTES, 256 * 1024 * 1024);
    }

    /// a negative length prefix is the wire saying the walk is lost. treating
    /// it as zero would resynchronise onto garbage and hand back a listing
    /// that resolves nothing while claiming to have read the file
    #[test]
    fn a_negative_count_is_refused_rather_than_saturated() {
        let mut bytes = slice_bytes("20260711");
        let count_at = 4 + 4 + 1 + 8 + 2; // past the empty player name
        bytes[count_at..count_at + 4].copy_from_slice(&(-1i32).to_le_bytes());
        match decode_stable_listing(&bytes) {
            Err(EngineError::StableListingParse(msg)) => {
                assert!(msg.contains("negative header.beatmap_count"), "{msg}")
            }
            other => panic!("expected a listing-parse error, got {other:?}"),
        }
    }

    /// the header's player name is walked, never kept: a listing whose owner
    /// has a megabyte-long name costs nothing to read
    #[test]
    fn the_player_name_is_walked_and_never_retained() {
        let bytes = slice_bytes("20260711");
        let name_tag = 4 + 4 + 1 + 8;
        let mut padded = bytes[..name_tag].to_vec();
        let long = "n".repeat(100_000);
        padded.push(0x0b);
        // uleb128 of 100_000
        padded.extend_from_slice(&[0xa0, 0x8d, 0x06]);
        padded.extend_from_slice(long.as_bytes());
        padded.extend_from_slice(&bytes[name_tag + 2..]);

        let listing = decode_stable_listing(&padded).unwrap();
        assert_eq!(listing.entries.len(), 1);
        assert_eq!(listing.entries[0].md5.as_deref(), Some(CARNIVAL_MD5));
    }

    /// the osu-db crate is a DEV-only oracle now (it left the production path
    /// with this reader), and this is what it is for: an independent
    /// implementation reading the same real bytes. it also asserts the star
    /// rating counts and tags, which this reader discards -- so the property
    /// each slice exists for stays pinned in code rather than only in a
    /// README
    #[test]
    fn osu_db_agrees_on_both_real_slices() {
        for (version, pairs, is_float) in [("20260711", 36usize, true), ("20231102", 9, false)] {
            let bytes = slice_bytes(version);
            let theirs = osu_db::listing::Listing::from_bytes(&bytes).unwrap();
            let ours = decode_stable_listing(&bytes).unwrap();

            assert_eq!(u32::try_from(ours.version).unwrap(), theirs.version, "{version}");
            assert_eq!(ours.entries.len(), theirs.beatmaps.len(), "{version}");
            for (ours, theirs) in ours.entries.iter().zip(&theirs.beatmaps) {
                assert_eq!(ours.md5, theirs.hash, "{version}");
                assert_eq!(ours.folder_name, theirs.folder_name, "{version}");
                assert_eq!(ours.file_name, theirs.file_name, "{version}");
            }
            // the tag layout each slice was captured for: the count osu-db
            // read, and the value tag stable actually wrote in front of it
            assert_eq!(theirs.beatmaps[0].std_ratings.len(), pairs, "{version}");
            let value_tag = first_rating_value_tag_offset(&bytes, pairs as i32);
            let expected_tag = if is_float { PAIR_FLOAT_TAG } else { PAIR_DOUBLE_TAG };
            assert_eq!(bytes[value_tag], expected_tag, "{version} tag family");
        }
    }

    /// osu-db's writer emits every gate this reader branches on, which is the
    /// only way to cover the pre-2014 layouts -- no real file here is that
    /// old. seeded from a real slice so the entry is a client's own row
    /// rather than a synthesised one
    #[test]
    fn osu_db_written_listings_decode_at_every_gate() {
        let seed = osu_db::listing::Listing::from_bytes(&slice_bytes("20260711")).unwrap();
        for version in [20140608, 20140609, 20191105, 20191106, 20250107] {
            let mut listing = seed.clone();
            listing.version = version;
            // a second entry, so a per-entry gate that mis-sizes one row is
            // caught by the next row rather than by the trailing int alone
            let mut second = listing.beatmaps[0].clone();
            second.hash = Some("0".repeat(32));
            second.folder_name = Some("second folder".into());
            listing.beatmaps.push(second);

            let mut written = Vec::new();
            listing.to_writer(&mut written).unwrap();
            let ours = decode_stable_listing(&written)
                .unwrap_or_else(|e| panic!("version {version}: {e}"));

            assert_eq!(u32::try_from(ours.version).unwrap(), version);
            assert_eq!(ours.entries.len(), 2, "version {version}");
            for (ours, theirs) in ours.entries.iter().zip(&listing.beatmaps) {
                assert_eq!(ours.md5, theirs.hash, "version {version}");
                assert_eq!(ours.folder_name, theirs.folder_name, "version {version}");
                assert_eq!(ours.file_name, theirs.file_name, "version {version}");
            }
        }
    }

    /// an entry may legitimately carry a null string where a lookup needs a
    /// value. the codec reports the null; deciding what it means is the
    /// app's fold, not this layer's
    #[test]
    fn a_null_string_survives_as_none_rather_than_failing_the_walk() {
        let mut listing = osu_db::listing::Listing::from_bytes(&slice_bytes("20260711")).unwrap();
        listing.beatmaps[0].hash = None;
        listing.beatmaps[0].folder_name = None;
        let mut written = Vec::new();
        listing.to_writer(&mut written).unwrap();

        let ours = decode_stable_listing(&written).unwrap();
        assert_eq!(ours.entries[0].md5, None);
        assert_eq!(ours.entries[0].folder_name, None);
        assert_eq!(ours.entries[0].file_name.as_deref(), Some(CARNIVAL_FILE));
    }
}
