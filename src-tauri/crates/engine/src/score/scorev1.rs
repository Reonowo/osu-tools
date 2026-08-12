//! achieved scorev1 total score, folded over the judgement timeline.
//!
//! ports the per-element rules of `osulegacyscoresimulator.cs` (the pinned
//! stable-score reference): slider parts score a flat 30/10 with no combo
//! bonus, spinner ticks 100 and bonus spins 1100, and every object-level
//! judgement scores `base + max(0, combo - 1) * (base / 25) * peppyStars *
//! modMultiplier` with the combo read before the element's own increment
//! (osulegacyscoresimulator.cs:162-177). lazer's simulator computes the
//! theoretical maximum; this fold walks the achieved timeline instead, so
//! the same rules run over what the play actually did.

use crate::beatmap::difficulty::HitGrade;
use crate::simulation::score::{JudgementKind, ScoreState};
use crate::simulation::JudgementTimeline;

fn base_value(grade: HitGrade) -> u64 {
    match grade {
        HitGrade::Great => 300,
        HitGrade::Ok => 100,
        HitGrade::Meh => 50,
        HitGrade::Miss => 0,
    }
}

/// osulegacyscoresimulator.cs:165 -- `(int)(Math.Max(0, combo - 1) *
/// (scoreIncrease / 25 * scoreMultiplier))`. under the NoMod multiplier of
/// 1.0 every operand is a small exact integer, so the double arithmetic is
/// exact integer arithmetic; the truncating cast is stable's own shape and
/// becomes observable only once fractional mod multipliers land
fn combo_bonus(combo_before: u64, base: u64, peppy_stars: i32, mod_multiplier: f64) -> u64 {
    let elements = combo_before.saturating_sub(1) as f64;
    let scaled = (base / 25) as f64 * f64::from(peppy_stars.max(0)) * mod_multiplier;
    (elements * scaled) as u64
}

/// the achieved scorev1 total. accumulates in u64 -- stable itself wraps a
/// 32-bit int on degenerate maps, but a wrapped header field is exactly the
/// lie export refuses to write, so the wide fold feeds checked narrowing
/// instead (`ExportOverflow` at the export boundary).
///
/// `mod_multiplier` is the mod seam: NoMod passes 1.0, and the multiplier
/// table stays gated with mod simulation itself (TODO.md)
pub fn total_score(timeline: &JudgementTimeline, peppy_stars: i32, mod_multiplier: f64) -> u64 {
    // replaying the combo fold through ScoreState keeps the bonus multiplier
    // consistent with the exact combo semantics the simulator emitted,
    // including the classic tail divergence
    let mut state = ScoreState::default();
    let mut total: u64 = 0;

    for event in &timeline.events {
        match event.kind {
            JudgementKind::SliderHead { hit }
            | JudgementKind::SliderRepeat { hit }
            | JudgementKind::SliderTail { hit } => {
                if hit {
                    total = total.saturating_add(30);
                }
            }
            JudgementKind::SliderTick { hit } => {
                if hit {
                    total = total.saturating_add(10);
                }
            }
            JudgementKind::SpinnerSpin => total = total.saturating_add(100),
            JudgementKind::SpinnerBonus => total = total.saturating_add(1100),
            JudgementKind::Circle(grade)
            | JudgementKind::SpinnerFinal(grade)
            | JudgementKind::SliderAggregate(grade) => {
                let base = base_value(grade);
                if base > 0 {
                    let bonus = combo_bonus(u64::from(state.combo), base, peppy_stars, mod_multiplier);
                    total = total.saturating_add(base).saturating_add(bonus);
                }
            }
        }
        state.apply(&event.kind);
    }

    total
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::simulation::{HitTotals, JudgementEvent};

    fn timeline_of(kinds: &[JudgementKind]) -> JudgementTimeline {
        JudgementTimeline {
            events: kinds
                .iter()
                .enumerate()
                .map(|(i, &kind)| JudgementEvent {
                    time: i as f64 * 1000.0,
                    object_index: i,
                    kind,
                    combo_after: 0,
                    accuracy_after: 1.0,
                })
                .collect(),
            totals: HitTotals::default(),
        }
    }

    #[test]
    fn combo_bonus_reads_the_combo_before_each_hit() {
        // stable's multiplier is max(0, combo - 1): the first two hits of a
        // run earn no bonus, the third earns one element's worth
        let timeline = timeline_of(&[
            JudgementKind::Circle(HitGrade::Great),
            JudgementKind::Circle(HitGrade::Great),
            JudgementKind::Circle(HitGrade::Great),
        ]);
        // 300*3 + (0 + 0 + 1*12*4)
        assert_eq!(total_score(&timeline, 4, 1.0), 948);
    }

    #[test]
    fn lesser_grades_scale_their_own_base() {
        let timeline = timeline_of(&[
            JudgementKind::Circle(HitGrade::Great),
            JudgementKind::Circle(HitGrade::Great),
            JudgementKind::Circle(HitGrade::Ok),
            JudgementKind::Circle(HitGrade::Meh),
        ]);
        // 300 + 300 + (100 + 1*4*4) + (50 + 2*2*4)
        assert_eq!(total_score(&timeline, 4, 1.0), 782);
    }

    #[test]
    fn a_miss_scores_nothing_and_resets_the_bonus_run() {
        let timeline = timeline_of(&[
            JudgementKind::Circle(HitGrade::Great),
            JudgementKind::Circle(HitGrade::Great),
            JudgementKind::Circle(HitGrade::Miss),
            JudgementKind::Circle(HitGrade::Great),
            JudgementKind::Circle(HitGrade::Great),
            JudgementKind::Circle(HitGrade::Great),
        ]);
        // two runs: (300 + 300) + 0 + (300 + 300 + 300+1*12*4)
        assert_eq!(total_score(&timeline, 4, 1.0), 1548);
    }

    #[test]
    fn slider_parts_score_flat_and_feed_the_aggregate_combo() {
        let timeline = timeline_of(&[
            JudgementKind::SliderHead { hit: true },
            JudgementKind::SliderTick { hit: true },
            JudgementKind::SliderRepeat { hit: true },
            JudgementKind::SliderTail { hit: true },
            JudgementKind::SliderAggregate(HitGrade::Great),
        ]);
        // 30 + 10 + 30 + 30 flat, then the aggregate's 300 with the combo
        // the four parts built: max(0, 4-1) * 12 * 4 = 144
        assert_eq!(total_score(&timeline, 4, 1.0), 100 + 300 + 144);
    }

    #[test]
    fn missed_slider_parts_score_nothing() {
        let timeline = timeline_of(&[
            JudgementKind::SliderHead { hit: false },
            JudgementKind::SliderTick { hit: false },
            JudgementKind::SliderTail { hit: false },
            JudgementKind::SliderAggregate(HitGrade::Miss),
        ]);
        assert_eq!(total_score(&timeline, 4, 1.0), 0);
    }

    #[test]
    fn spinner_elements_score_flat_and_the_final_scales() {
        let timeline = timeline_of(&[
            JudgementKind::Circle(HitGrade::Great),
            JudgementKind::Circle(HitGrade::Great),
            JudgementKind::SpinnerSpin,
            JudgementKind::SpinnerSpin,
            JudgementKind::SpinnerBonus,
            JudgementKind::SpinnerFinal(HitGrade::Great),
        ]);
        // 600 + 100 + 100 + 1100, then the final's 300 with combo 2 built by
        // the circles (spins never touch combo): max(0, 2-1) * 12 * 4 = 48
        assert_eq!(total_score(&timeline, 4, 1.0), 600 + 1300 + 300 + 48);
    }

    #[test]
    fn the_mod_multiplier_seam_scales_the_combo_bonus_truncating() {
        let timeline = timeline_of(&[
            JudgementKind::Circle(HitGrade::Great),
            JudgementKind::Circle(HitGrade::Great),
            JudgementKind::Circle(HitGrade::Great),
        ]);
        // same fold at multiplier 0.5: bonus 1*12*4*0.5 = 24, truncated
        // exactly like the c# (int) cast would
        assert_eq!(total_score(&timeline, 4, 0.5), 924);
        // and the NoMod fold is byte-identical to multiplier 1.0
        assert_eq!(total_score(&timeline, 4, 1.0), 948);
    }
}
