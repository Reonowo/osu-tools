//! `scores.db`, osu! stable's own local leaderboards: the record of every
//! play the client still lists, and the only honest answer to "which of my
//! plays does stable still have a replay for".
//!
//! not a port of a lazer source file -- lazer never reads this database at
//! all, and has no equivalent of it. what IS ported is the framing
//! underneath: the shared `formats::binary` primitives port
//! `SerializationReader.cs`, which is the reader stable's own writer was
//! built against. the field order is stable's own, pinned by real client
//! bytes in `fixtures/stable/<version>/scores.db`.
//!
//! # what it keeps
//!
//! one row per local play, cut to what a browser row and a replay lookup
//! need: the mode, the beatmap md5, the player, the replay md5, the six
//! counts, the score, the max combo, the perfect flag, the mods, the
//! timestamp and the online score id. the per-group beatmap key is WALKED
//! and discarded -- every row repeats it, verified across all 1,375 rows of
//! a real database -- as is the life-bar string stable writes empty here and
//! the null-array sentinel where a standalone `.osr` carries its payload.
//!
//! no policy lives here: which row still has a file on disk, how a row names
//! that file, and what a duplicate means are the app's rules, not this
//! codec's.
//!
//! # the one conditional field
//!
//! a row whose mods carry [`MOD_TARGET_PRACTICE`] is followed by a `double`
//! holding that mod's own accuracy setting. it is read off the MOD BIT, not
//! off a version gate, for the reason `stable_listing` reads a star-rating
//! pair off its own tag: the wire says which shape it is, and a version gate
//! is what leaves a reader unable to open a current client's file.
//!
//! # strictness
//!
//! the walk must consume the file exactly: it ends at the last row's last
//! byte and nothing may follow. a truncated file, trailing surplus or an
//! unexpected string tag is a [`EngineError::LocalScoresParse`] whose
//! message carries the database version and the byte the walk stopped at.
//! that is the early-warning system: stable's next layout change fails a
//! fixture test here rather than silently listing half a player's history.

use crate::error::{resource_limit, EngineError, Result};
use crate::formats::binary::Reader;
use crate::formats::GameMode;
use crate::limits;

/// osu!'s mod bitfield: the one mod whose presence lengthens a row
pub const MOD_TARGET_PRACTICE: u32 = 1 << 23;

#[derive(Debug, Clone, PartialEq)]
pub struct LocalScores {
    pub version: i32,
    pub rows: Vec<LocalScore>,
}

/// one local play, as stable's leaderboard records it. every string is
/// optional because the wire's string tag has a null spelling; what a null
/// means -- a row that cannot name its replay file, say -- is the reading
/// app's call, not this codec's
#[derive(Debug, Clone, PartialEq)]
pub struct LocalScore {
    pub mode: GameMode,
    /// the row's own framing version, which stable stamps per row and which
    /// is NOT the database version above it: an old play keeps the version
    /// its client wrote it with
    pub version: u32,
    pub beatmap_md5: Option<String>,
    pub player_name: Option<String>,
    pub replay_md5: Option<String>,
    pub count_300: u16,
    pub count_100: u16,
    pub count_50: u16,
    pub count_geki: u16,
    pub count_katsu: u16,
    pub count_miss: u16,
    pub total_score: u32,
    pub max_combo: u16,
    pub perfect: bool,
    pub mods: u32,
    /// .net ticks (epoch 0001-01-01), exactly as the header of a standalone
    /// `.osr` carries them
    pub timestamp_ticks: i64,
    pub online_score_id: u64,
}

/// decodes a whole `scores.db`. the byte length is charged against
/// [`limits::MAX_SCORES_DB_BYTES`] before anything is read.
pub fn decode_local_scores(bytes: &[u8]) -> Result<LocalScores> {
    decode_local_scores_capped(bytes, limits::MAX_SCORES_DB_BYTES)
}

/// [`decode_local_scores`] with the byte cap supplied, so the boundary test
/// can prove the check without allocating 64 MiB (same shape as
/// `stable_listing`'s capped entry point)
fn decode_local_scores_capped(bytes: &[u8], max_bytes: u64) -> Result<LocalScores> {
    if bytes.len() as u64 > max_bytes {
        return Err(resource_limit(
            "MAX_SCORES_DB_BYTES",
            max_bytes,
            bytes.len() as u64,
        ));
    }
    let mut r = Reader::new(bytes, EngineError::LocalScoresParse);
    // read before the walk and reported by every message it raises, exactly
    // as the listing's version is
    let version = r.i32("version")?;
    match walk(&mut r) {
        Ok(rows) => Ok(LocalScores { version, rows }),
        Err(e) => Err(annotate(e, version, r.pos())),
    }
}

/// every failure inside the walk gains the two facts that make it
/// actionable: which layout was being read, and where the walk gave up
fn annotate(e: EngineError, version: i32, pos: usize) -> EngineError {
    match e {
        EngineError::LocalScoresParse(message) => EngineError::LocalScoresParse(format!(
            "scores.db version {version} (walk stopped at byte {pos}): {message}"
        )),
        other => other,
    }
}

fn walk(r: &mut Reader) -> Result<Vec<LocalScore>> {
    let groups = declared_count(r, "header.beatmap_count")?;
    // never `with_capacity`, for `stable_listing`'s reason: the count is
    // untrusted and growth is already bounded by the file the cap bounded,
    // where a reservation is bounded by nothing
    let mut rows = Vec::new();
    for _ in 0..groups {
        // the group's beatmap md5. walked, never kept: every row inside it
        // repeats the same hash in its own field, and a browser reads the
        // row rather than the group
        r.skip_osu_string("group.beatmap_md5")?;
        for _ in 0..declared_count(r, "group.score_count")? {
            rows.push(row(r)?);
        }
    }
    let trailing = r.remaining().len();
    if trailing > 0 {
        return Err(r.error(format!(
            "{trailing} trailing bytes after the last score; \
             the walk did not consume the file exactly"
        )));
    }
    Ok(rows)
}

/// a length prefix, refused rather than saturated when negative: a negative
/// count means the walk is already reading the wrong bytes, and treating it
/// as zero would resynchronise onto garbage
fn declared_count(r: &mut Reader, what: &'static str) -> Result<usize> {
    let declared = r.i32(what)?;
    usize::try_from(declared).map_err(|_| r.error(format!("negative {what} ({declared})")))
}

fn row(r: &mut Reader) -> Result<LocalScore> {
    let mode = match r.u8("score.mode")? {
        0 => GameMode::Osu,
        1 => GameMode::Taiko,
        2 => GameMode::Catch,
        3 => GameMode::Mania,
        // NOT `UnsupportedMode`: one row in another ruleset is ordinary in a
        // player's database and the caller filters it, so an unknown byte
        // here means the walk is lost rather than that the file is a mode
        // this app declines
        other => return Err(r.error(format!("unknown game mode byte {other}"))),
    };
    let version = r.u32("score.version")?;
    let beatmap_md5 = r.osu_string("score.beatmap_md5")?;
    let player_name = r.osu_string("score.player_name")?;
    let replay_md5 = r.osu_string("score.replay_md5")?;
    let count_300 = r.u16("score.count_300")?;
    let count_100 = r.u16("score.count_100")?;
    let count_50 = r.u16("score.count_50")?;
    let count_geki = r.u16("score.count_geki")?;
    let count_katsu = r.u16("score.count_katsu")?;
    let count_miss = r.u16("score.count_miss")?;
    let total_score = r.u32("score.total_score")?;
    let max_combo = r.u16("score.max_combo")?;
    let perfect = r.u8("score.perfect")? != 0;
    let mods = r.u32("score.mods")?;
    // stable writes the empty string here for every row -- the life bar
    // belongs to the `.osr` on disk, not to the leaderboard entry
    r.skip_osu_string("score.life_graph")?;
    let timestamp_ticks = r.i64("score.timestamp")?;
    // serializationreader.cs:37-43 -- the byte array a standalone `.osr`
    // carries its frames in. every row of every real database writes the
    // null-array sentinel (-1) here, but the length is honoured rather than
    // asserted, because that is what stable's own reader does and a reader
    // that assumes cannot resynchronise if stable ever fills it
    let payload_length = r.i32("score.payload_length")?;
    if payload_length > 0 {
        let len = usize::try_from(payload_length).expect("a positive i32 always fits usize");
        r.skip(len, "score.payload")?;
    }
    let online_score_id = r.u64("score.online_score_id")?;
    if mods & MOD_TARGET_PRACTICE != 0 {
        // target practice's own accuracy setting; read at its width and
        // discarded, so the branch says which shape the row is rather than
        // merely how far to jump (the module doc's conditional field)
        r.f64("score.target_practice_accuracy")?;
    }

    Ok(LocalScore {
        mode,
        version,
        beatmap_md5,
        player_name,
        replay_md5,
        count_300,
        count_100,
        count_50,
        count_geki,
        count_katsu,
        count_miss,
        total_score,
        max_combo,
        perfect,
        mods,
        timestamp_ticks,
        online_score_id,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    const SLICE_MD5: &str = "5afc67b1fbc077f262797719c3ca8423";
    const SLICE_REPLAY_MD5: &str = "218bf1b8050b63ea470d4e62555ec715";
    const SLICE_TICKS: i64 = 636_895_947_445_841_476;

    fn slice_bytes() -> Vec<u8> {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../fixtures/stable/20260711/scores.db");
        std::fs::read(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
    }

    /// the committed slice is a real client's own bytes (that directory's
    /// README): one beatmap group holding one standard-mode NoMod play whose
    /// `Data/r` file existed at capture
    #[test]
    fn the_real_slice_decodes_field_exact() {
        let scores = decode_local_scores(&slice_bytes()).unwrap();
        assert_eq!(scores.version, 20260711);
        assert_eq!(scores.rows.len(), 1);
        let row = &scores.rows[0];
        assert_eq!(row.mode, GameMode::Osu);
        // the ROW's version, not the database's: an old play keeps the
        // version the client of the day stamped on it
        assert_eq!(row.version, 20190410);
        assert_eq!(row.beatmap_md5.as_deref(), Some(SLICE_MD5));
        // blanked by the slicer, and an empty string is not a null one --
        // which is exactly the distinction the wire's two string tags draw
        assert_eq!(row.player_name.as_deref(), Some(""));
        assert_eq!(row.replay_md5.as_deref(), Some(SLICE_REPLAY_MD5));
        assert_eq!(
            (
                row.count_300,
                row.count_100,
                row.count_50,
                row.count_geki,
                row.count_katsu,
                row.count_miss
            ),
            (76, 26, 7, 13, 5, 14)
        );
        assert_eq!(row.total_score, 50_240);
        assert_eq!(row.max_combo, 30);
        assert!(!row.perfect);
        assert_eq!(row.mods, 0);
        assert_eq!(row.timestamp_ticks, SLICE_TICKS);
        assert_eq!(row.online_score_id, 0);
    }

    /// the no-panic guarantee at this codec's boundary, in both profiles.
    /// prior art: `formats::stable_listing::tests::truncation_at_every_offset_never_panics`
    #[test]
    fn truncation_at_every_offset_never_panics() {
        let bytes = slice_bytes();
        for cut in 0..bytes.len() {
            match decode_local_scores(&bytes[..cut]) {
                Err(EngineError::LocalScoresParse(_)) => {}
                other => panic!("cut at {cut}: expected a scores-parse error, got {other:?}"),
            }
        }
        assert!(decode_local_scores(&bytes).is_ok());
    }

    #[test]
    fn one_byte_past_the_last_row_is_refused() {
        let mut bytes = slice_bytes();
        bytes.push(0);
        match decode_local_scores(&bytes) {
            Err(EngineError::LocalScoresParse(msg)) => {
                assert!(msg.contains("1 trailing bytes"), "{msg}");
                assert!(msg.contains("20260711"), "the version belongs in the message: {msg}");
                assert!(msg.contains("byte"), "the offset belongs in the message: {msg}");
            }
            other => panic!("expected a scores-parse error, got {other:?}"),
        }
    }

    /// the tag family the walk reads rather than assumes, and the mode byte
    /// beside it. both messages carry the version and the offset, because
    /// the next layout change is diagnosed from exactly those two facts
    #[test]
    fn an_unexpected_string_tag_and_an_unknown_mode_are_refused_with_the_offset() {
        let bytes = slice_bytes();

        // the group key: version, group count, then the first string
        let key_tag = 4 + 4;
        assert_eq!(bytes[key_tag], 0x0b, "fixture layout moved");
        let mut broken = bytes.clone();
        broken[key_tag] = 0x0c;
        match decode_local_scores(&broken) {
            Err(EngineError::LocalScoresParse(msg)) => {
                assert!(msg.contains("invalid string prefix 0x0c"), "{msg}");
                assert!(msg.contains("group.beatmap_md5"), "{msg}");
                assert!(msg.contains("20260711") && msg.contains("byte"), "{msg}");
            }
            other => panic!("expected a scores-parse error, got {other:?}"),
        }

        // the row's mode byte: past the key's tag, its one-byte length and
        // its 32 hex characters, and past the score count
        let mode_at = key_tag + 2 + 32 + 4;
        assert_eq!(bytes[mode_at], 0, "fixture layout moved");
        let mut broken = bytes.clone();
        broken[mode_at] = 7;
        match decode_local_scores(&broken) {
            Err(EngineError::LocalScoresParse(msg)) => {
                assert!(msg.contains("unknown game mode byte 7"), "{msg}");
                assert!(msg.contains("20260711") && msg.contains("byte"), "{msg}");
            }
            other => panic!("expected a scores-parse error, got {other:?}"),
        }
    }

    /// a negative length prefix is the wire saying the walk is lost
    #[test]
    fn a_negative_count_is_refused_rather_than_saturated() {
        let mut bytes = slice_bytes();
        bytes[4..8].copy_from_slice(&(-1i32).to_le_bytes());
        match decode_local_scores(&bytes) {
            Err(EngineError::LocalScoresParse(msg)) => {
                assert!(msg.contains("negative header.beatmap_count"), "{msg}")
            }
            other => panic!("expected a scores-parse error, got {other:?}"),
        }
    }

    #[test]
    fn scores_db_byte_size_cap_boundary() {
        let bytes = slice_bytes();
        let exact = bytes.len() as u64;
        assert!(
            decode_local_scores_capped(&bytes, exact).is_ok(),
            "a file exactly at the cap must be accepted"
        );
        match decode_local_scores_capped(&bytes, exact - 1) {
            Err(EngineError::ResourceLimit { cap, limit, actual }) => {
                assert_eq!(cap, "MAX_SCORES_DB_BYTES");
                assert_eq!(limit, exact - 1);
                assert_eq!(actual, exact);
            }
            other => panic!("expected a ResourceLimit, got {other:?}"),
        }
    }

    #[test]
    fn max_scores_db_bytes_constant_matches_limits_module() {
        assert_eq!(limits::MAX_SCORES_DB_BYTES, 64 * 1024 * 1024);
    }

    /// the osu-db crate is a DEV-only oracle (it left the production path
    /// with the listing reader), and this is what it is for: an independent
    /// implementation reading the same real bytes
    #[test]
    fn osu_db_agrees_on_the_real_slice() {
        let bytes = slice_bytes();
        let theirs = osu_db::score::ScoreList::from_bytes(&bytes).unwrap();
        let ours = decode_local_scores(&bytes).unwrap();

        assert_eq!(u32::try_from(ours.version).unwrap(), theirs.version);
        let their_rows: Vec<_> = theirs.beatmaps.iter().flat_map(|b| &b.scores).collect();
        assert_eq!(ours.rows.len(), their_rows.len());
        for (ours, theirs) in ours.rows.iter().zip(their_rows) {
            assert_eq!(ours.beatmap_md5, theirs.beatmap_hash);
            assert_eq!(ours.player_name, theirs.player_name);
            assert_eq!(ours.replay_md5, theirs.replay_hash);
            assert_eq!(ours.count_300, theirs.count_300);
            assert_eq!(ours.count_miss, theirs.count_miss);
            assert_eq!(ours.total_score, theirs.score);
            assert_eq!(ours.max_combo, theirs.max_combo);
            assert_eq!(ours.perfect, theirs.perfect_combo);
            assert_eq!(ours.mods, theirs.mods.bits());
            assert_eq!(ours.online_score_id, theirs.online_score_id);
        }
        // and the group key this reader walks past really is the row's own
        // hash, which is what makes walking it safe
        assert_eq!(theirs.beatmaps[0].hash.as_deref(), Some(SLICE_MD5));
    }

    /// osu-db's writer is the only way to cover a shape no real database
    /// here has: several groups, several rows in one group, a null player
    /// name, and every ruleset byte. seeded from the real slice so each row
    /// is a client's own row rather than a synthesised one
    #[test]
    fn osu_db_written_databases_decode_row_for_row() {
        let mut list = osu_db::score::ScoreList::from_bytes(&slice_bytes()).unwrap();
        let seed = list.beatmaps[0].scores[0].clone();
        let mut second = seed.clone();
        second.player_name = None;
        second.mode = osu_db::Mode::Mania;
        second.count_300 = 4242;
        let mut third = seed.clone();
        third.online_score_id = u64::MAX;
        list.beatmaps[0].scores.push(second);
        list.beatmaps.push(osu_db::score::BeatmapScores {
            hash: Some("0".repeat(32)),
            scores: vec![third],
        });

        let mut written = Vec::new();
        list.to_writer(&mut written).unwrap();
        let ours = decode_local_scores(&written).unwrap();

        assert_eq!(ours.rows.len(), 3);
        assert_eq!(ours.rows[0].player_name.as_deref(), Some(""));
        assert_eq!(ours.rows[1].player_name, None, "a null string survives as None");
        assert_eq!(ours.rows[1].mode, GameMode::Mania);
        assert_eq!(ours.rows[1].count_300, 4242);
        // the second group's rows keep their own hash, which is why the
        // group key is walked rather than folded onto its rows
        assert_eq!(ours.rows[2].beatmap_md5.as_deref(), Some(SLICE_MD5));
        assert_eq!(ours.rows[2].online_score_id, u64::MAX);
    }

    /// the conditional field, at the gate and one step either side of it.
    /// osu-db's writer does not know about it, so the row is built by hand
    /// from the real slice's own bytes: the trailing double is appended and
    /// the mod bit set, and the walk has to end exactly at the file's end in
    /// both directions
    #[test]
    fn a_target_practice_row_consumes_its_trailing_double() {
        let bytes = slice_bytes();
        // the mods int: back from the file's end past the online score id
        // (8), the null-array sentinel (4), the timestamp (8), the empty
        // life graph (2)
        let mods_at = bytes.len() - (8 + 4 + 8 + 2 + 4);
        assert_eq!(
            u32::from_le_bytes(bytes[mods_at..mods_at + 4].try_into().unwrap()),
            0,
            "fixture layout moved"
        );

        let mut with_mod = bytes.clone();
        with_mod[mods_at..mods_at + 4].copy_from_slice(&MOD_TARGET_PRACTICE.to_le_bytes());
        // the bit alone, with no double behind it, must not read as a
        // complete row
        match decode_local_scores(&with_mod) {
            Err(EngineError::LocalScoresParse(_)) => {}
            other => panic!("expected a scores-parse error, got {other:?}"),
        }

        let mut complete = with_mod.clone();
        complete.extend_from_slice(&0.95f64.to_le_bytes());
        let scores = decode_local_scores(&complete).unwrap();
        assert_eq!(scores.rows.len(), 1);
        assert_eq!(scores.rows[0].mods, MOD_TARGET_PRACTICE);

        // and without the bit the same trailing eight bytes are surplus,
        // which is what proves the branch reads the bit rather than the
        // file's remaining length
        let mut unmodded = bytes.clone();
        unmodded.extend_from_slice(&0.95f64.to_le_bytes());
        match decode_local_scores(&unmodded) {
            Err(EngineError::LocalScoresParse(msg)) => assert!(msg.contains("8 trailing bytes"), "{msg}"),
            other => panic!("expected a scores-parse error, got {other:?}"),
        }
    }
}
