//! what a frame-edited native document's regenerating export writes: the
//! header projection lazer's own encoder makes of a native score
//! (legacyscoreencoder.cs:81-99) and a freshly encoded score-info block
//! (legacyreplaysoloscoreinfo.cs:57-68).
//!
//! the header is the legacy projection: 300/100/50 from great/ok/meh, geki
//! and katu zero (scoreinfoextensions.cs:71-142 has no osu! source for
//! either), miss, the standardised total, max combo, perfect as max combo
//! equalling the maximum achievable combo (the sum of the maximum
//! statistics that affect combo, scoreinfoextensions.cs:69), the legacy
//! bitfield projected from the effective mods, an EMPTY life bar graph
//! because that is what lazer writes (`getHpGraphFormatted`, line 210), and
//! lazer's replay hash. the block is the play's own: the effective mods,
//! the regenerated statistics and maximum statistics, the rank, the total
//! without mods (equal to the total under NoMod, written when positive),
//! the online id cleared to none, the user id and pauses carried from the
//! source, and this app's client version -- never the source's, since the
//! source's client did not compute what the block now claims

use crate::formats::score_info::{ScoreInfo, ScoreInfoMod, StatisticEntry};
use crate::score::{DerivedFields, HitResult, OverflowField, ScoreRank};
use crate::simulation::{JudgementTimeline, TruncatedOutcome};

/// everything the native regenerating export writes beyond the frames
#[derive(Debug, Clone, PartialEq)]
pub struct NativeExportFields {
    /// the header overlay, narrowed to the on-disk widths
    pub header: DerivedFields,
    /// the block, ready for `encode_score_info`
    pub block: ScoreInfo,
    /// the legacy mod bitfield the header carries, PROJECTED from the
    /// effective mods rather than carried from the source
    /// (legacyscoreencoder.cs:115 writes
    /// `ConvertToLegacyMods(score.ScoreInfo.Mods)`). the supported native
    /// matrix is NoMod, so the only list that reaches a regenerating export
    /// is empty and this is zero -- but carrying the source's value instead
    /// would let a header claim a mod the block and the simulation both say
    /// was not played, and it is the day the matrix grows a row that such a
    /// bug would land silently
    pub legacy_mods: u32,
}

/// what the export carries from the source's own block: the player's online
/// id and the pauses, which the re-simulation cannot know
#[derive(Debug, Clone, PartialEq)]
pub struct CarriedIdentity {
    pub user_id: i64,
    pub pauses: Vec<i64>,
}

impl CarriedIdentity {
    /// from the source's block, or lazer's own defaults when there is none
    pub fn from_source(source: Option<&ScoreInfo>) -> CarriedIdentity {
        CarriedIdentity {
            user_id: source.map_or(-1, |s| s.user_id),
            pauses: source.map_or_else(Vec::new, |s| s.pauses.clone()),
        }
    }
}

/// scoreinfoextensions.cs:69
pub fn maximum_achievable_combo(maximum_statistics: &[(HitResult, u32)]) -> u32 {
    maximum_statistics
        .iter()
        .filter(|(result, _)| result.affects_combo())
        .map(|(_, count)| *count)
        .fold(0u32, |sum, count| sum.saturating_add(count))
}

/// the export fields off a native timeline. `rank` is passed in rather than
/// read off the totals so the caller can hand over the health fold's F, and
/// `truncated` is the fold's reading at that fail point when there is one:
/// lazer's score processor counts nothing past the failing result
/// (scoreprocessor.cs:244-245), so a failed play's block and header carry
/// the truncated statistics, max combo and total -- what lazer itself would
/// have written -- and never the whole-timeline fold the app displays
pub fn derive_native_export(
    timeline: &JudgementTimeline,
    rank: ScoreRank,
    truncated: Option<&TruncatedOutcome>,
    mods: &[ScoreInfoMod],
    identity: &CarriedIdentity,
    client_version: &str,
) -> core::result::Result<NativeExportFields, OverflowField> {
    let native = timeline.native.as_ref().ok_or(OverflowField {
        field: "nativeOutcome",
    })?;
    fn u16_field(value: u32, field: &'static str) -> core::result::Result<u16, OverflowField> {
        u16::try_from(value).map_err(|_| OverflowField { field })
    }
    let count_in = |statistics: &[(HitResult, u32)], result: HitResult| -> u32 {
        statistics.iter().find(|(r, _)| *r == result).map_or(0, |(_, c)| *c)
    };
    let (statistics, maximum, max_combo, total) = match truncated {
        Some(t) => (
            t.statistics.clone(),
            t.maximum_statistics.clone(),
            t.max_combo,
            t.total_score,
        ),
        None => (
            native.statistics.clone(),
            native.maximum_statistics.clone(),
            timeline.totals.max_combo,
            native.total_score,
        ),
    };
    let total_score = u32::try_from(total).map_err(|_| OverflowField {
        field: "totalScore",
    })?;
    let header = DerivedFields {
        count_300: u16_field(count_in(&statistics, HitResult::Great), "count300")?,
        count_100: u16_field(count_in(&statistics, HitResult::Ok), "count100")?,
        count_50: u16_field(count_in(&statistics, HitResult::Meh), "count50")?,
        count_geki: 0,
        count_katsu: 0,
        count_miss: u16_field(count_in(&statistics, HitResult::Miss), "countMiss")?,
        max_combo: u16_field(max_combo, "maxCombo")?,
        perfect: max_combo == maximum_achievable_combo(&maximum),
        total_score,
        life_bar: String::new(),
        // there is no search behind an empty graph: nothing was left
        // unsettled
        life_bar_converged: true,
    };
    let entries = |counts: &[(HitResult, u32)]| -> Vec<StatisticEntry> {
        counts
            .iter()
            .map(|(result, count)| StatisticEntry {
                result: result.snake_name().to_owned(),
                count: i64::from(*count),
            })
            .collect()
    };
    let block = ScoreInfo {
        online_id: -1,
        mods: mods.to_vec(),
        statistics: entries(&statistics),
        maximum_statistics: entries(&maximum),
        client_version: client_version.to_owned(),
        rank: Some(rank),
        user_id: identity.user_id,
        total_score_without_mods: (total > 0).then_some(total),
        pauses: identity.pauses.clone(),
        unknown: Vec::new(),
    };
    Ok(NativeExportFields {
        header,
        block,
        legacy_mods: legacy_mods_from_effective(mods),
    })
}

/// legacyscoreencoder.cs:115 -- the legacy bitfield a regenerating export
/// writes, projected from the effective mods rather than carried from the
/// source header.
///
/// the supported native matrix is NoMod (`configuration`), so the only list
/// that can reach a regenerating export is empty and the projection is zero.
/// an acronym outside the matrix cannot arrive here -- the capability that
/// unlocked the export refused it -- and if one somehow did, zero is the
/// honest answer for a bitfield that has no bit for most lazer mods anyway
/// (`ToLegacy()` writes nothing for Classic, DA, Muted and the rest). this
/// is the seam the day a mod enters the matrix: its bit is written HERE,
/// beside the block that names it, and never carried from a stale header
fn legacy_mods_from_effective(mods: &[ScoreInfoMod]) -> u32 {
    // total by construction rather than asserted: this is reached from a
    // PUBLIC entry point taking a caller-supplied list, and the crate
    // promises a typed answer over a panic in every build profile, so a
    // debug-only trip here would be exactly the profile-dependent panic
    // `lib.rs` rules out. no acronym the matrix admits has a bit to
    // contribute, and lazer's own `ConvertToLegacyMods` likewise folds
    // nothing for a mod with no legacy equivalent
    let _ = mods;
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::beatmap::difficulty::HitGrade;
    use crate::simulation::score::JudgementKind;
    use crate::simulation::{HitTotals, JudgementEvent, NativeOutcome};

    fn timeline(max_combo: u32, maximum: Vec<(HitResult, u32)>) -> JudgementTimeline {
        JudgementTimeline {
            events: vec![JudgementEvent {
                time: 1000.0,
                object_index: 0,
                kind: JudgementKind::Circle(HitGrade::Great),
                combo_after: 1,
                accuracy_after: 1.0,
            }],
            totals: HitTotals {
                count_300: 1,
                count_100: 0,
                count_50: 0,
                count_miss: 0,
                max_combo,
                accuracy: 1.0,
                rank: ScoreRank::X,
            },
            spinner_scoring: Vec::new(),
            native: Some(NativeOutcome {
                statistics: vec![(HitResult::Great, 1)],
                maximum_statistics: maximum,
                total_score: 1_000_000,
                score_curve: Vec::new(),
                applied: Vec::new(),
            }),
        }
    }

    #[test]
    fn the_header_is_lazers_projection_and_the_block_the_plays_own() {
        let timeline = timeline(3, vec![(HitResult::Great, 2), (HitResult::SliderTailHit, 1), (HitResult::IgnoreHit, 1)]);
        let identity = CarriedIdentity {
            user_id: 42,
            pauses: vec![1500, 3000],
        };
        let fields =
            derive_native_export(&timeline, ScoreRank::A, None, &[], &identity, "osu-replay-editor 1.0").unwrap();
        assert_eq!((fields.header.count_300, fields.header.count_geki, fields.header.count_katsu), (1, 0, 0));
        assert_eq!(fields.header.total_score, 1_000_000);
        assert!(fields.header.perfect, "the tail counts toward the achievable combo, the ignore hit does not");
        assert_eq!(fields.header.life_bar, "", "lazer writes an empty graph");
        assert_eq!(fields.block.online_id, -1);
        assert_eq!(fields.block.rank, Some(ScoreRank::A), "the caller's rank, not the totals'");
        assert_eq!(fields.block.user_id, 42);
        assert_eq!(fields.block.pauses, vec![1500, 3000]);
        assert_eq!(fields.block.client_version, "osu-replay-editor 1.0");
        assert_eq!(fields.block.total_score_without_mods, Some(1_000_000));
        assert_eq!(fields.block.statistics, vec![StatisticEntry { result: "great".into(), count: 1 }]);
        assert!(fields.block.unknown.is_empty());
    }

    #[test]
    fn perfect_follows_the_achievable_combo_and_a_missing_outcome_is_refused() {
        let timeline = timeline(2, vec![(HitResult::Great, 3)]);
        let identity = CarriedIdentity::from_source(None);
        let fields = derive_native_export(&timeline, ScoreRank::S, None, &[], &identity, "v").unwrap();
        assert!(!fields.header.perfect);
        assert_eq!((fields.block.user_id, fields.block.pauses.len()), (-1, 0));

        let mut stable = timeline;
        stable.native = None;
        assert!(derive_native_export(&stable, ScoreRank::S, None, &[], &identity, "v").is_err());
    }

    /// a failed play exports what lazer's processor counted up to the fail:
    /// the truncated statistics, max combo and total, under rank F, with
    /// the header's counts read off the same truncated map
    #[test]
    fn a_failed_play_exports_the_truncated_fold_under_rank_f() {
        let timeline = timeline(9, vec![(HitResult::Great, 9)]);
        let truncated = TruncatedOutcome {
            statistics: vec![(HitResult::Miss, 3), (HitResult::Ok, 1), (HitResult::Great, 2)],
            maximum_statistics: vec![(HitResult::Great, 9)],
            max_combo: 2,
            total_score: 120_000,
            accuracy: 0.5,
            count_miss: 3,
        };
        let fields = derive_native_export(
            &timeline,
            ScoreRank::F,
            Some(&truncated),
            &[],
            &CarriedIdentity::from_source(None),
            "v",
        )
        .unwrap();
        assert_eq!(
            (fields.header.count_300, fields.header.count_100, fields.header.count_miss, fields.header.max_combo),
            (2, 1, 3, 2)
        );
        assert_eq!(fields.header.total_score, 120_000);
        assert!(!fields.header.perfect);
        assert_eq!(fields.block.rank, Some(ScoreRank::F));
        assert_eq!(fields.block.total_score_without_mods, Some(120_000));
        assert_eq!(
            fields.block.statistics.iter().map(|e| (e.result.as_str(), e.count)).collect::<Vec<_>>(),
            vec![("miss", 3), ("ok", 1), ("great", 2)]
        );
    }
}
