//! judgement result kinds and the combo/accuracy fold.
//!
//! combo semantics are lazer's hitresult.cs table with one deliberate
//! deviation: the classic slider tail increments combo on hit. lazer's
//! smalltickhit affects combo not at all, which is exactly why legacy scores
//! need LegacyComboIncrease padding to reach their stable max combo
//! (legacyscoredecoder.cs:245-254); lazer's own stable-score simulator counts
//! the tail among the combo-increasing elements
//! (osulegacyscoresimulator.cs:92-96). the oracle for this crate is the
//! stable .osr header, so the stable rule wins. tail misses break nothing in
//! either system.
//!
//! accuracy is stable's displayed formula over object-level (basic) results:
//! (300*c300 + 100*c100 + 50*c50) / (300 * total), 100% before any result

use crate::beatmap::difficulty::HitGrade;

/// one judgement on the timeline. the slider kinds carry the IDENTITY of
/// the element they judged -- the head its timing grade, every nested
/// element its index in the slider's lazer nested list -- so a consumer
/// joins by identity and never by the nearest time, which the two
/// generators (stable's score points, lazer's nested objects) can disagree
/// on by more than a tick spacing. `nested_index` is `None` only for a
/// stable score point with no lazer counterpart (the recorded tick-count
/// divergence); the native profile always has one
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum JudgementKind {
    Circle(HitGrade),
    /// the head's timing grade. the stable profile emits great or miss --
    /// stable scores the head as a hit or not, and the timing grade it
    /// computed is folded into the aggregate -- while the native profile
    /// emits the grade lazer gave, like a circle
    SliderHead {
        grade: HitGrade,
    },
    SliderTick {
        hit: bool,
        nested_index: Option<u32>,
    },
    /// `repeat_index` is 0-based and identifies WHICH repeat this is, which
    /// is what picks the node samples the repeat sounds with (lazer's
    /// `Slider.cs`: repeat *n* takes `GetNodeSamples(n + 1)`). carried rather
    /// than recovered by counting repeat events, because a positional join
    /// over emission order goes silently wrong the first time that order
    /// changes -- see `beatmap::stable_points::StablePointKind`
    SliderRepeat {
        hit: bool,
        repeat_index: u32,
        nested_index: Option<u32>,
    },
    SliderTail {
        hit: bool,
        nested_index: Option<u32>,
    },
    /// the slider's own lifecycle end, in both profiles: `complete` when any
    /// nested element was hit (drawableslider.cs:317-320 arms the slider
    /// `Hit` on that condition, and it is what gates the end sound). no
    /// grade, no count, no combo: the anchor the renderer and the hitsound
    /// plan hang on without depending on the stable-only aggregate. under
    /// the stable profile it follows the aggregate at the aggregate's time,
    /// complete exactly when the aggregate is not a miss
    SliderEnd {
        complete: bool,
    },
    /// stable's whole-slider result, folded from the scored rate; the stable
    /// profile only, since lazer computes no such aggregate
    SliderAggregate(HitGrade),
    SpinnerSpin,
    SpinnerBonus,
    SpinnerFinal(HitGrade),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ScoreState {
    pub combo: u32,
    pub max_combo: u32,
    pub count_300: u32,
    pub count_100: u32,
    pub count_50: u32,
    pub count_miss: u32,
}

impl ScoreState {
    pub fn apply(&mut self, kind: &JudgementKind) {
        match kind {
            JudgementKind::Circle(grade) | JudgementKind::SpinnerFinal(grade) => {
                self.count(*grade);
                if *grade == HitGrade::Miss {
                    self.combo = 0;
                } else {
                    self.increment_combo();
                }
            }
            JudgementKind::SliderAggregate(grade) => {
                self.count(*grade);
                // danser slider.go:458 -- the whole-slider miss resets combo
                // (reachable with combo standing only via 2b-style overlap,
                // since a zero rate implies the elements already reset it);
                // a non-miss aggregate holds, never increments
                if *grade == HitGrade::Miss {
                    self.combo = 0;
                }
            }
            JudgementKind::SliderHead { grade } => {
                if *grade != HitGrade::Miss {
                    self.increment_combo();
                } else {
                    self.combo = 0;
                }
            }
            JudgementKind::SliderTick { hit, .. } | JudgementKind::SliderRepeat { hit, .. } => {
                if *hit {
                    self.increment_combo();
                } else {
                    self.combo = 0;
                }
            }
            JudgementKind::SliderTail { hit, .. } => {
                if *hit {
                    self.increment_combo();
                }
            }
            // a lifecycle marker: counts nothing and moves nothing
            JudgementKind::SliderEnd { .. } | JudgementKind::SpinnerSpin | JudgementKind::SpinnerBonus => {}
        }
    }

    pub fn accuracy(&self) -> f64 {
        let total = self.count_300 + self.count_100 + self.count_50 + self.count_miss;
        if total == 0 {
            return 1.0;
        }
        f64::from(300 * self.count_300 + 100 * self.count_100 + 50 * self.count_50) / f64::from(300 * total)
    }

    fn count(&mut self, grade: HitGrade) {
        match grade {
            HitGrade::Great => self.count_300 = self.count_300.saturating_add(1),
            HitGrade::Ok => self.count_100 = self.count_100.saturating_add(1),
            HitGrade::Meh => self.count_50 = self.count_50.saturating_add(1),
            HitGrade::Miss => self.count_miss = self.count_miss.saturating_add(1),
        }
    }

    fn increment_combo(&mut self) {
        // multiplicative slider-nested path (max_slider_nested_objects per slider × max_hit_objects) can exceed u32 within crate caps
        self.combo = self.combo.saturating_add(1);
        self.max_combo = self.max_combo.max(self.combo);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::beatmap::difficulty::HitGrade;

    fn state_after(kinds: &[JudgementKind]) -> ScoreState {
        let mut s = ScoreState::default();
        for k in kinds {
            s.apply(k);
        }
        s
    }

    #[test]
    fn basic_results_count_and_combo() {
        let s = state_after(&[
            JudgementKind::Circle(HitGrade::Great),
            JudgementKind::Circle(HitGrade::Ok),
            JudgementKind::Circle(HitGrade::Meh),
            JudgementKind::Circle(HitGrade::Miss),
            JudgementKind::Circle(HitGrade::Great),
        ]);
        assert_eq!((s.count_300, s.count_100, s.count_50, s.count_miss), (2, 1, 1, 1));
        assert_eq!(s.combo, 1);
        assert_eq!(s.max_combo, 3);
    }

    #[test]
    fn slider_elements_follow_stable_combo_semantics() {
        // head/tick/repeat: +1 on hit, break on miss (lazer LargeTick rules,
        // hitresult.cs:183-203). tail: +1 on hit -- the deliberate stable
        // deviation (osulegacyscoresimulator.cs:92-96) -- and no break on miss
        let s = state_after(&[
            JudgementKind::SliderHead {
                grade: HitGrade::Great,
            },
            JudgementKind::SliderTick {
                hit: true,
                nested_index: Some(1),
            },
            JudgementKind::SliderRepeat {
                hit: true,
                repeat_index: 0,
                nested_index: Some(2),
            },
            JudgementKind::SliderTail {
                hit: true,
                nested_index: Some(3),
            },
            JudgementKind::SliderAggregate(HitGrade::Great),
            JudgementKind::SliderEnd { complete: true },
        ]);
        assert_eq!(s.combo, 4);
        assert_eq!(s.count_300, 1); // only the aggregate counts
        assert_eq!(s.count_miss, 0);

        let s = state_after(&[
            JudgementKind::SliderHead {
                grade: HitGrade::Great,
            },
            JudgementKind::SliderTick {
                hit: false,
                nested_index: None,
            }, // breaks
            JudgementKind::SliderTail {
                hit: false,
                nested_index: None,
            }, // does not break
            JudgementKind::SliderAggregate(HitGrade::Meh),
            JudgementKind::SliderEnd { complete: true },
        ]);
        assert_eq!(s.combo, 0);
        assert_eq!(s.max_combo, 1);
        assert_eq!(s.count_50, 1);
    }

    #[test]
    fn slider_aggregate_never_increments_and_resets_only_on_miss() {
        // danser slider.go:458-465 -- the aggregate holds combo on any hit
        // grade and resets on a whole-slider miss
        let s = state_after(&[
            JudgementKind::SliderHead {
                grade: HitGrade::Great,
            },
            JudgementKind::SliderAggregate(HitGrade::Ok),
        ]);
        assert_eq!(s.combo, 1);
        assert_eq!(s.count_100, 1);

        let s = state_after(&[
            JudgementKind::SliderHead {
                grade: HitGrade::Great,
            },
            JudgementKind::SliderAggregate(HitGrade::Miss),
        ]);
        assert_eq!(s.combo, 0);
        assert_eq!(s.max_combo, 1);
        assert_eq!(s.count_miss, 1);
    }

    #[test]
    fn spinner_events_follow_stable_semantics() {
        // spins/bonus: score only, no combo (osulegacyscoresimulator.cs:102-114);
        // the final result acts like a circle
        let s = state_after(&[
            JudgementKind::Circle(HitGrade::Great),
            JudgementKind::SpinnerSpin,
            JudgementKind::SpinnerBonus,
            JudgementKind::SpinnerFinal(HitGrade::Great),
        ]);
        assert_eq!(s.combo, 2);
        assert_eq!(s.count_300, 2);

        let s = state_after(&[
            JudgementKind::Circle(HitGrade::Great),
            JudgementKind::SpinnerFinal(HitGrade::Miss),
        ]);
        assert_eq!(s.combo, 0);
        assert_eq!(s.count_miss, 1);
    }

    #[test]
    fn accuracy_is_the_stable_formula_over_basic_results() {
        let mut s = ScoreState::default();
        assert_eq!(s.accuracy(), 1.0);
        s.apply(&JudgementKind::Circle(HitGrade::Great));
        assert_eq!(s.accuracy(), 1.0);
        s.apply(&JudgementKind::Circle(HitGrade::Ok));
        assert_eq!(s.accuracy(), 400.0 / 600.0);
        s.apply(&JudgementKind::SliderTick {
            hit: true,
            nested_index: None,
        }); // ticks are not basic
        assert_eq!(s.accuracy(), 400.0 / 600.0);
        s.apply(&JudgementKind::Circle(HitGrade::Miss));
        assert_eq!(s.accuracy(), 400.0 / 900.0);
    }

    #[test]
    fn saturating_arithmetic_does_not_panic_at_u32_max() {
        // multiplicative slider-nested path can drive combo/counts to u32::MAX within crate caps
        let mut s = ScoreState {
            combo: u32::MAX,
            max_combo: u32::MAX,
            count_300: u32::MAX,
            count_100: u32::MAX,
            count_50: u32::MAX,
            count_miss: u32::MAX,
        };
        s.apply(&JudgementKind::SliderTick {
            hit: true,
            nested_index: None,
        });
        assert_eq!(s.combo, u32::MAX);
        assert_eq!(s.max_combo, u32::MAX);
        s.apply(&JudgementKind::Circle(HitGrade::Great));
        assert_eq!(s.count_300, u32::MAX);
    }
}
