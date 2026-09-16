//! the native profile's score fold: lazer's `ScoreProcessor` over the
//! result vocabulary in [`crate::score::HitResult`], ported from
//! scoreprocessor.cs (`ApplyResultInternal` lines 239-289, the base score
//! table at 346-380, `updateScore` at 391-401 and `ComputeTotalScore` at
//! 427-432) with osuscoreprocessor.cs adding nothing but the rank demotion
//! already ported in `score::rank`.
//!
//! the fold keeps what lazer keeps: the running combo and its high-water
//! mark, one count per result, the base-score pair accuracy is read from,
//! the combo and bonus portions the standardised total is read from, and
//! the play's own maxima -- what a perfect play of the same map scores --
//! simulated once up front exactly as `ScoreProcessor.ApplyBeatmap` does
//! (nested elements before their parent, every element at its maximum
//! result). NoMod only: the score multiplier is 1, so the total with and
//! without mods coincide

use crate::beatmap::{ProcessedBeatmap, ProcessedKind, ProcessedSlider, ProcessedSpinner};
use crate::score::HitResult;

/// scoreprocessor.cs:52 -- the exponent the combo portion grows with
const COMBO_EXPONENT: f64 = 0.5;

#[derive(Debug, Clone)]
pub(crate) struct NativeScore {
    pub combo: u32,
    pub highest_combo: u32,
    counts: Vec<u32>,
    base_score: f64,
    maximum_base_score: f64,
    accuracy_judgements: u32,
    combo_portion: f64,
    bonus_portion: f64,
    maxima: Maxima,
}

/// what a perfect play of the map scores, read once so the running
/// progress fractions have a denominator (scoreprocessor.cs:443-460)
#[derive(Debug, Clone, Default)]
struct Maxima {
    combo_portion: f64,
    accuracy_judgements: u32,
    counts: Vec<u32>,
}

impl NativeScore {
    /// a fold whose maxima are the perfect play of `beatmap`
    pub fn for_beatmap(beatmap: &ProcessedBeatmap) -> NativeScore {
        let mut perfect = NativeScore::empty();
        for obj in &beatmap.objects {
            for (result, max_result, count) in perfect_play_results(&obj.kind) {
                perfect.apply_repeated(result, max_result, count);
            }
        }
        let mut fold = NativeScore::empty();
        fold.maxima = Maxima {
            combo_portion: perfect.combo_portion,
            accuracy_judgements: perfect.accuracy_judgements,
            counts: perfect.counts,
        };
        fold
    }

    fn empty() -> NativeScore {
        NativeScore {
            combo: 0,
            highest_combo: 0,
            counts: vec![0; HitResult::ALL.len()],
            base_score: 0.0,
            maximum_base_score: 0.0,
            accuracy_judgements: 0,
            combo_portion: 0.0,
            bonus_portion: 0.0,
            maxima: Maxima::default(),
        }
    }

    /// scoreprocessor.cs:239-273 -- one judgement, with the element's own
    /// maximum result deciding what it could have been worth
    pub fn apply(&mut self, result: HitResult, max_result: HitResult) {
        self.counts[result.ordinal()] = self.counts[result.ordinal()].saturating_add(1);

        if result.increases_combo() {
            self.combo = self.combo.saturating_add(1);
        } else if result.breaks_combo() {
            self.combo = 0;
        }
        self.highest_combo = self.highest_combo.max(self.combo);

        if max_result.affects_accuracy() {
            self.maximum_base_score += f64::from(max_result.base_score());
            self.accuracy_judgements = self.accuracy_judgements.saturating_add(1);
        }
        if result.affects_accuracy() {
            self.base_score += f64::from(result.base_score());
        }

        if result.is_bonus() {
            // scoreprocessor.cs:338 -- the bonus portion takes the result's
            // own value
            self.bonus_portion += f64::from(result.base_score());
        } else if result.is_scorable() {
            // scoreprocessor.cs:344 -- the combo portion takes the maximum
            // result's value, scaled by the combo the judgement left
            self.combo_portion += f64::from(max_result.base_score()) * f64::from(self.combo).powf(COMBO_EXPONENT);
        }
    }

    /// `apply` folded `count` times in one step, for a result that neither
    /// moves the combo nor scores through it -- the bonus and ignore results
    /// a spinner's ticks are, whose number is bounded by nothing but the
    /// spinner's duration; any other result folds one application at a time,
    /// since its combo portion reads the combo each one leaves
    pub fn apply_repeated(&mut self, result: HitResult, max_result: HitResult, count: u32) {
        let reads_the_combo =
            result.increases_combo() || result.breaks_combo() || (result.is_scorable() && !result.is_bonus());
        if reads_the_combo {
            for _ in 0..count {
                self.apply(result, max_result);
            }
            return;
        }
        if count == 0 {
            return;
        }
        // every term below is a sum of integers, so the one step is exact
        let times = f64::from(count);
        self.counts[result.ordinal()] = self.counts[result.ordinal()].saturating_add(count);
        if max_result.affects_accuracy() {
            self.maximum_base_score += f64::from(max_result.base_score()) * times;
            self.accuracy_judgements = self.accuracy_judgements.saturating_add(count);
        }
        if result.affects_accuracy() {
            self.base_score += f64::from(result.base_score()) * times;
        }
        if result.is_bonus() {
            self.bonus_portion += f64::from(result.base_score()) * times;
        }
    }

    /// scoreprocessor.cs:393 -- the standardised accuracy, 1 before any
    /// accuracy-affecting judgement
    pub fn accuracy(&self) -> f64 {
        if self.maximum_base_score > 0.0 {
            self.base_score / self.maximum_base_score
        } else {
            1.0
        }
    }

    /// scoreprocessor.cs:397-400,427-432 -- the standardised total, rounded
    /// as .net's `Math.Round` rounds (half to even). NoMod, so the score
    /// multiplier is 1 and this is also the total without mods
    pub fn total_score(&self) -> i64 {
        let combo_progress = if self.maxima.combo_portion > 0.0 {
            self.combo_portion / self.maxima.combo_portion
        } else {
            1.0
        };
        let accuracy_progress = if self.maxima.accuracy_judgements > 0 {
            f64::from(self.accuracy_judgements) / f64::from(self.maxima.accuracy_judgements)
        } else {
            1.0
        };
        let accuracy = self.accuracy();
        let total = 500_000.0 * accuracy * combo_progress
            + 500_000.0 * accuracy.powi(5) * accuracy_progress
            + self.bonus_portion;
        total.round_ties_even() as i64
    }

    pub fn count(&self, result: HitResult) -> u32 {
        self.counts[result.ordinal()]
    }

    /// the non-zero counts in the order lazer writes a score's statistics
    /// map: `PopulateScore` walks `HitResultExtensions.ALL_TYPES`, the enum's
    /// own order (scoreprocessor.cs:488-494), and the block keeps that
    /// order with the zeros dropped -- what the real lazer export in the
    /// corpus pins, and what the integrity comparison and the regenerated
    /// block read
    pub fn statistics(&self) -> Vec<(HitResult, u32)> {
        ordered_counts(&self.counts)
    }

    /// the perfect play's non-zero counts, the same shape
    pub fn maximum_statistics(&self) -> Vec<(HitResult, u32)> {
        ordered_counts(&self.maxima.counts)
    }
}

fn ordered_counts(counts: &[u32]) -> Vec<(HitResult, u32)> {
    HitResult::ALL
        .iter()
        .map(|&result| (result, counts[result.ordinal()]))
        .filter(|(_, count)| *count != 0)
        .collect()
}

/// scoreprocessor.cs `simulate`: every element at its maximum result, nested
/// elements before the object that holds them, in the nested list's order;
/// a spinner's ticks as their two counted groups, which fold the same
/// because a bonus result never reads the combo
fn perfect_play_results(kind: &ProcessedKind) -> Vec<(HitResult, HitResult, u32)> {
    match kind {
        ProcessedKind::Circle => vec![(HitResult::Great, HitResult::Great, 1)],
        ProcessedKind::Slider(slider) => {
            let mut results: Vec<(HitResult, HitResult, u32)> = slider_element_maxima(slider)
                .into_iter()
                .map(|max| (max, max, 1))
                .collect();
            results.push((HitResult::IgnoreHit, HitResult::IgnoreHit, 1));
            results
        }
        ProcessedKind::Spinner(spinner) => {
            let total = spinner_tick_count(spinner);
            let small = u32::try_from(spinner.spins_required_for_bonus())
                .unwrap_or(0)
                .min(total);
            vec![
                (HitResult::SmallBonus, HitResult::SmallBonus, small),
                (HitResult::LargeBonus, HitResult::LargeBonus, total - small),
                (HitResult::Great, HitResult::Great, 1),
            ]
        }
    }
}

/// each nested element's maximum result in list order: the head a great,
/// ticks and repeats large ticks, the tail its own result
/// (sliderheadcircle.cs, slidertick.cs:34, sliderendcircle.cs:53,
/// slidertailcircle.cs:32)
pub(crate) fn slider_element_maxima(slider: &ProcessedSlider) -> Vec<HitResult> {
    use crate::beatmap::NestedKind;
    slider
        .nested
        .iter()
        .map(|nested| match nested.kind {
            NestedKind::Head => HitResult::Great,
            NestedKind::Tick | NestedKind::Repeat => HitResult::LargeTickHit,
            NestedKind::Tail => HitResult::SliderTailHit,
        })
        .collect()
}

/// spinner.cs:84-95 -- the nested tick count, and which of them are the
/// small bonuses awarded up to the bonus threshold
pub(crate) fn spinner_tick_count(spinner: &ProcessedSpinner) -> u32 {
    let for_bonus = spinner.spins_required_for_bonus();
    let total = for_bonus.wrapping_add(spinner.max_bonus_spins);
    u32::try_from(total).unwrap_or(0)
}

pub(crate) fn spinner_tick_maximum(spinner: &ProcessedSpinner, index: u32) -> HitResult {
    let for_bonus = u32::try_from(spinner.spins_required_for_bonus()).unwrap_or(0);
    if index < for_bonus {
        HitResult::SmallBonus
    } else {
        HitResult::LargeBonus
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// a fold with no maxima: the progress fractions read 1, so the total
    /// is the accuracy terms alone
    fn bare() -> NativeScore {
        NativeScore::empty()
    }

    #[test]
    fn combo_follows_the_hit_result_table() {
        let mut fold = bare();
        fold.apply(HitResult::Great, HitResult::Great);
        fold.apply(HitResult::LargeTickHit, HitResult::LargeTickHit);
        fold.apply(HitResult::SliderTailHit, HitResult::SliderTailHit);
        assert_eq!(fold.combo, 3, "the native tail increments combo");
        fold.apply(HitResult::SmallBonus, HitResult::SmallBonus);
        fold.apply(HitResult::IgnoreHit, HitResult::IgnoreHit);
        assert_eq!(fold.combo, 3, "bonus and ignore results leave combo alone");
        fold.apply(HitResult::IgnoreMiss, HitResult::SliderTailHit);
        assert_eq!(fold.combo, 3, "a dropped tail breaks nothing");
        fold.apply(HitResult::LargeTickMiss, HitResult::LargeTickHit);
        assert_eq!(fold.combo, 0, "a dropped tick breaks combo");
        assert_eq!(fold.highest_combo, 3);
    }

    #[test]
    fn accuracy_is_the_base_score_over_the_maximum_base_score() {
        let mut fold = bare();
        assert_eq!(fold.accuracy(), 1.0, "nothing judged reads 1");
        fold.apply(HitResult::Ok, HitResult::Great);
        assert_eq!(fold.accuracy(), 100.0 / 300.0);
        fold.apply(HitResult::LargeTickHit, HitResult::LargeTickHit);
        assert_eq!(fold.accuracy(), 130.0 / 330.0);
        fold.apply(HitResult::LargeBonus, HitResult::LargeBonus);
        assert_eq!(fold.accuracy(), 130.0 / 330.0, "bonus never touches accuracy");
        fold.apply(HitResult::IgnoreMiss, HitResult::SliderTailHit);
        assert_eq!(fold.accuracy(), 130.0 / 480.0, "a dropped tail still counts its maximum");
    }

    #[test]
    fn a_perfect_play_scores_the_million() {
        let map = crate::beatmap::process_beatmap(
            &crate::formats::beatmap::decode_beatmap_bytes(
                b"osu file format v14\n\n[Difficulty]\nHPDrainRate:5\nCircleSize:4\nOverallDifficulty:5\nApproachRate:9\nSliderMultiplier:1\nSliderTickRate:2\n\n[TimingPoints]\n0,500,4,2,1,60,1,0\n\n[HitObjects]\n100,100,1000,5,0,0:0:0:0:\n100,200,2000,2,0,L|300:200,1,200\n256,192,4000,12,0,6000,0:0:0:0:\n",
            )
            .expect("decodes"),
        )
        .expect("processes");
        let mut fold = NativeScore::for_beatmap(&map);
        for obj in &map.objects {
            for (result, max, count) in perfect_play_results(&obj.kind) {
                for _ in 0..count {
                    fold.apply(result, max);
                }
            }
        }
        assert_eq!(fold.accuracy(), 1.0);
        let bonus: u32 = fold
            .statistics()
            .iter()
            .filter(|(r, _)| r.is_bonus())
            .map(|(r, c)| r.base_score() * c)
            .sum();
        assert_eq!(fold.total_score(), 1_000_000 + i64::from(bonus));
        assert_eq!(fold.statistics(), fold.maximum_statistics());
    }

    #[test]
    fn a_repeated_application_folds_as_the_same_results_one_at_a_time() {
        let mut one_at_a_time = NativeScore::empty();
        let mut at_once = NativeScore::empty();
        let groups = [
            (HitResult::Great, HitResult::Great, 3),
            (HitResult::SmallBonus, HitResult::SmallBonus, 5),
            (HitResult::LargeBonus, HitResult::LargeBonus, 2),
            (HitResult::IgnoreMiss, HitResult::SmallBonus, 4),
            (HitResult::Miss, HitResult::Great, 1),
            (HitResult::IgnoreHit, HitResult::IgnoreHit, 2),
        ];
        for (result, max, count) in groups {
            for _ in 0..count {
                one_at_a_time.apply(result, max);
            }
            at_once.apply_repeated(result, max, count);
        }
        assert_eq!(at_once.statistics(), one_at_a_time.statistics());
        assert_eq!(at_once.combo, one_at_a_time.combo);
        assert_eq!(at_once.highest_combo, one_at_a_time.highest_combo);
        assert_eq!(at_once.accuracy(), one_at_a_time.accuracy());
        assert_eq!(at_once.total_score(), one_at_a_time.total_score());
        assert_eq!(at_once.bonus_portion, one_at_a_time.bonus_portion);
        assert_eq!(at_once.combo_portion, one_at_a_time.combo_portion);
    }
}
