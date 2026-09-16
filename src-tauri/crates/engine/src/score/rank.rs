//! the letter rank and the displayed accuracy, computed in one place so the
//! two layers that show them can never disagree.
//!
//! the rank rule is lazer's `ScoreProcessor.RankFromScore`
//! (scoreprocessor.cs:34-39, 559-573) with the osu! ruleset's override
//! (osuscoreprocessor.cs:19-33): X at exactly 100%, then the S/A/B/C cutoffs
//! at 95/90/80/70, and an S or X with any miss demoted to A. lazer applies
//! this same rule to legacy scores too (legacyscoreencoder.cs version
//! 30000013: "all local scores will use lazer definitions of ranks"), which
//! is why the stable profile shares it rather than porting stable's own
//! grade table. the hidden/flashlight variants (SH, XH) come from
//! `ModHidden.AdjustRank` and friends, which are outside the supported mod
//! matrix -- the enum carries them because a score-info block can spell them

use crate::score::HitResult;
use serde::Serialize;

/// `ScoreRank` (scorerank.cs), spelled on the wire in lowercase and in a
/// score-info block as `StringEnumConverter` spells it
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ScoreRank {
    F,
    D,
    C,
    B,
    A,
    S,
    SH,
    X,
    XH,
}

impl ScoreRank {
    /// the block's spelling
    pub fn as_str(self) -> &'static str {
        match self {
            ScoreRank::F => "F",
            ScoreRank::D => "D",
            ScoreRank::C => "C",
            ScoreRank::B => "B",
            ScoreRank::A => "A",
            ScoreRank::S => "S",
            ScoreRank::SH => "SH",
            ScoreRank::X => "X",
            ScoreRank::XH => "XH",
        }
    }

    pub fn from_name(name: &str) -> Option<ScoreRank> {
        Some(match name {
            "F" => ScoreRank::F,
            "D" => ScoreRank::D,
            "C" => ScoreRank::C,
            "B" => ScoreRank::B,
            "A" => ScoreRank::A,
            "S" => ScoreRank::S,
            "SH" => ScoreRank::SH,
            "X" => ScoreRank::X,
            "XH" => ScoreRank::XH,
            _ => return None,
        })
    }

    /// scorerank.cs's integer values, which `StringEnumConverter` also
    /// accepts on read (`AllowIntegerValues` defaults true)
    pub fn from_integer(value: i64) -> Option<ScoreRank> {
        Some(match value {
            -1 => ScoreRank::F,
            0 => ScoreRank::D,
            1 => ScoreRank::C,
            2 => ScoreRank::B,
            3 => ScoreRank::A,
            4 => ScoreRank::S,
            5 => ScoreRank::SH,
            6 => ScoreRank::X,
            7 => ScoreRank::XH,
            _ => return None,
        })
    }
}

/// the displayed accuracy over the four basic counts: weighted hit value
/// over the total judged, 0 when nothing was judged. the weighting every
/// surface shows -- the recents card, the browser row, the replay panel --
/// and the stable profile's accuracy for a simulated timeline, so a header
/// and a simulation are compared on the same terms
pub fn standard_accuracy(count_300: u32, count_100: u32, count_50: u32, count_miss: u32) -> f64 {
    let judged = u64::from(count_300) + u64::from(count_100) + u64::from(count_50) + u64::from(count_miss);
    if judged == 0 {
        return 0.0;
    }
    let weighted = 300.0 * f64::from(count_300) + 100.0 * f64::from(count_100) + 50.0 * f64::from(count_50);
    weighted / (300.0 * judged as f64)
}

/// standardisedscoremigrationtools.cs:441-452 (`ComputeAccuracy`) -- lazer's
/// own accuracy recovered from a pair of statistics maps, which is exactly
/// the job here: the achieved base score over the maximum base score,
/// counting only the results that affect accuracy. a score-info block stores
/// the two maps and not the fraction they imply, so this is how the FILE's
/// own accuracy is read back -- the native counterpart to
/// [`standard_accuracy`] over a stable header's four counts, and the reason
/// neither layer above has to fold a statistics map itself.
///
/// a result name the enum does not know weighs nothing in either sum: it
/// carries no base score, and skipping it is the only reading available. a
/// negative count is read as zero, since a count is a tally and a crafted
/// block is the only way to spell one.
///
/// DELIBERATE DIVERGENCE: lazer answers 1 for a zero maximum
/// (standardisedscoremigrationtools.cs:451's
/// `maxBaseScore == 0 ? 1 : baseScore / (double)maxBaseScore`)
/// because it is computing a score's accuracy and has nowhere to say "no
/// answer". this returns `None` instead, because the caller is reading a
/// FILE's record and a block that weighs nothing recorded no accuracy rather
/// than a perfect play -- and the panel's "was" reference must not invent a
/// 100% the file never claimed
pub fn accuracy_from_statistics(statistics: &[(&str, i64)], maximum_statistics: &[(&str, i64)]) -> Option<f64> {
    let maximum = weigh_for_accuracy(maximum_statistics);
    if maximum <= 0.0 {
        return None;
    }
    Some(weigh_for_accuracy(statistics) / maximum)
}

fn weigh_for_accuracy(entries: &[(&str, i64)]) -> f64 {
    entries
        .iter()
        .filter_map(|(name, count)| {
            let result = HitResult::from_snake_name(name)?;
            if !result.affects_accuracy() {
                return None;
            }
            Some(f64::from(result.base_score()) * (*count).max(0) as f64)
        })
        .sum()
}

/// scoreprocessor.cs:559-573 plus osuscoreprocessor.cs:19-33
pub fn rank_from_accuracy(accuracy: f64, count_miss: u32) -> ScoreRank {
    let rank = if accuracy == 1.0 {
        ScoreRank::X
    } else if accuracy >= 0.95 {
        ScoreRank::S
    } else if accuracy >= 0.9 {
        ScoreRank::A
    } else if accuracy >= 0.8 {
        ScoreRank::B
    } else if accuracy >= 0.7 {
        ScoreRank::C
    } else {
        ScoreRank::D
    };
    match rank {
        ScoreRank::S | ScoreRank::X if count_miss > 0 => ScoreRank::A,
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accuracy_is_the_weighted_share_and_zero_when_nothing_judged() {
        assert_eq!(standard_accuracy(0, 0, 0, 0), 0.0);
        assert_eq!(standard_accuracy(1, 0, 0, 0), 1.0);
        assert_eq!(standard_accuracy(0, 1, 0, 0), 100.0 / 300.0);
        assert_eq!(standard_accuracy(1, 1, 1, 1), 450.0 / 1200.0);
        // saturating counts stay finite
        assert!(standard_accuracy(u32::MAX, u32::MAX, u32::MAX, u32::MAX).is_finite());
    }

    #[test]
    fn block_accuracy_weighs_the_two_maps_by_base_score() {
        // a perfect map's own maximum: every result at its maximum weighs the
        // same in both sums, so the fraction is exactly 1
        let maximum = [("great", 2_i64), ("slider_tail_hit", 1), ("large_tick_hit", 1)];
        assert_eq!(
            accuracy_from_statistics(&[("great", 2), ("slider_tail_hit", 1), ("large_tick_hit", 1)], &maximum),
            Some(1.0)
        );
        // the native rule counts the tail and the large tick, which is the whole
        // reason a stable header's four counts cannot answer for a lazer play
        let dropped_tail = accuracy_from_statistics(&[("great", 2), ("large_tick_hit", 1)], &maximum).unwrap();
        assert!(dropped_tail < 1.0);
        let by_hand = (2.0 * f64::from(HitResult::Great.base_score())
            + f64::from(HitResult::LargeTickHit.base_score()))
            / (2.0 * f64::from(HitResult::Great.base_score())
                + f64::from(HitResult::SliderTailHit.base_score())
                + f64::from(HitResult::LargeTickHit.base_score()));
        assert_eq!(dropped_tail, by_hand);
        // a bonus result affects no accuracy and weighs in neither sum
        assert_eq!(
            accuracy_from_statistics(&[("great", 2), ("slider_tail_hit", 1), ("large_tick_hit", 1)], &maximum),
            accuracy_from_statistics(
                &[
                    ("great", 2),
                    ("slider_tail_hit", 1),
                    ("large_tick_hit", 1),
                    ("large_bonus", 9)
                ],
                &maximum
            )
        );
        // a name the enum does not know weighs nothing rather than erroring
        assert_eq!(accuracy_from_statistics(&[("gr8", 5)], &maximum), Some(0.0));
        // a maximum map that weighs nothing says nothing, which is not 100%
        assert_eq!(accuracy_from_statistics(&[("great", 1)], &[("large_bonus", 3)]), None);
        assert_eq!(accuracy_from_statistics(&[], &[]), None);
        // a crafted negative count is read as the zero tally it should be
        assert_eq!(accuracy_from_statistics(&[("great", -5)], &maximum), Some(0.0));
    }

    #[test]
    fn ranks_follow_lazers_cutoffs_with_the_osu_miss_demotion() {
        assert_eq!(rank_from_accuracy(1.0, 0), ScoreRank::X);
        assert_eq!(rank_from_accuracy(0.95, 0), ScoreRank::S);
        assert_eq!(rank_from_accuracy(0.9499, 0), ScoreRank::A);
        assert_eq!(rank_from_accuracy(0.9, 0), ScoreRank::A);
        assert_eq!(rank_from_accuracy(0.8, 0), ScoreRank::B);
        assert_eq!(rank_from_accuracy(0.7, 0), ScoreRank::C);
        assert_eq!(rank_from_accuracy(0.69, 0), ScoreRank::D);
        assert_eq!(rank_from_accuracy(0.0, 0), ScoreRank::D);
        // a miss always costs at least S, whatever the count-share accuracy
        // says: 97x300 over 100 judged clears 0.95 and still lands on A
        assert_eq!(rank_from_accuracy(0.97, 3), ScoreRank::A);
        assert_eq!(rank_from_accuracy(1.0, 1), ScoreRank::A);
        // below S a miss changes nothing
        assert_eq!(rank_from_accuracy(0.85, 5), ScoreRank::B);
    }

    #[test]
    fn ranks_serialize_lowercase_and_spell_lazers_names() {
        assert_eq!(serde_json::to_value(ScoreRank::XH).unwrap(), "xh");
        assert_eq!(serde_json::to_value(ScoreRank::F).unwrap(), "f");
        for rank in [
            ScoreRank::F,
            ScoreRank::D,
            ScoreRank::C,
            ScoreRank::B,
            ScoreRank::A,
            ScoreRank::S,
            ScoreRank::SH,
            ScoreRank::X,
            ScoreRank::XH,
        ] {
            assert_eq!(ScoreRank::from_name(rank.as_str()), Some(rank));
        }
        assert_eq!(ScoreRank::from_integer(-1), Some(ScoreRank::F));
        assert_eq!(ScoreRank::from_integer(7), Some(ScoreRank::XH));
        assert_eq!(ScoreRank::from_integer(8), None);
    }
}
