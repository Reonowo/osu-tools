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

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum JudgementKind {
    Circle(HitGrade),
    SliderHead { hit: bool },
    SliderTick { hit: bool },
    SliderRepeat { hit: bool },
    SliderTail { hit: bool },
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
            JudgementKind::SliderAggregate(grade) => self.count(*grade),
            JudgementKind::SliderHead { hit }
            | JudgementKind::SliderTick { hit }
            | JudgementKind::SliderRepeat { hit } => {
                if *hit {
                    self.increment_combo();
                } else {
                    self.combo = 0;
                }
            }
            JudgementKind::SliderTail { hit } => {
                if *hit {
                    self.increment_combo();
                }
            }
            JudgementKind::SpinnerSpin | JudgementKind::SpinnerBonus => {}
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
            JudgementKind::SliderHead { hit: true },
            JudgementKind::SliderTick { hit: true },
            JudgementKind::SliderRepeat { hit: true },
            JudgementKind::SliderTail { hit: true },
            JudgementKind::SliderAggregate(HitGrade::Great),
        ]);
        assert_eq!(s.combo, 4);
        assert_eq!(s.count_300, 1); // only the aggregate counts
        assert_eq!(s.count_miss, 0);

        let s = state_after(&[
            JudgementKind::SliderHead { hit: true },
            JudgementKind::SliderTick { hit: false }, // breaks
            JudgementKind::SliderTail { hit: false }, // does not break
            JudgementKind::SliderAggregate(HitGrade::Meh),
        ]);
        assert_eq!(s.combo, 0);
        assert_eq!(s.max_combo, 1);
        assert_eq!(s.count_50, 1);
    }

    #[test]
    fn slider_aggregate_never_touches_combo() {
        // osulegacyscoresimulator.cs:121-127 -- increaseCombo = false for the
        // slider object itself; its combo came from the nested elements
        let s = state_after(&[
            JudgementKind::SliderHead { hit: true },
            JudgementKind::SliderAggregate(HitGrade::Miss),
        ]);
        assert_eq!(s.combo, 1);
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
        s.apply(&JudgementKind::SliderTick { hit: true }); // ticks are not basic
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
        s.apply(&JudgementKind::SliderTick { hit: true });
        assert_eq!(s.combo, u32::MAX);
        assert_eq!(s.max_combo, u32::MAX);
        s.apply(&JudgementKind::Circle(HitGrade::Great));
        assert_eq!(s.count_300, u32::MAX);
    }
}
