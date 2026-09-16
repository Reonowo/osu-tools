//! the native profile's health: lazer's osu! health processor over its
//! draining base, ported from osuhealthprocessor.cs and
//! draininghealthprocessor.cs with healthprocessor.cs underneath.
//!
//! - the per-result increase (osuhealthprocessor.cs:76-127): the timed
//!   grades, the nested elements by their kind (a tick 0.015, a repeat,
//!   tail or classic head 0.02), the bonuses, and the two misses read off
//!   the HP difficulty range; anything else 0;
//! - the combo-end bonus (lines 23-70): a per-combo result demoted by an ok
//!   or a dropped tick to good and by a meh or miss to none, reset by an
//!   object carrying the raw new-combo flag, and paid on the hit result of
//!   the object marked last in its combo -- 0.07, 0.05 or 0.03. nested
//!   elements carry neither flag, so only a circle's, a slider's own or a
//!   spinner's own result can reset or collect;
//! - the drain rate (draininghealthprocessor.cs:177-224): a search over
//!   the perfect play's non-bonus increases, halving its step until the
//!   lowest health sits within 0.01 of the target the HP difficulty range
//!   sets (0.99, 0.9, 0.4), with no drain across a raw break period;
//! - the drain itself (lines 89-102): the rate per millisecond between the
//!   first object's start and the last object's end, suspended inside the
//!   no-drain periods that run from the last object ending before a break
//!   to the first object starting after it (lines 111-124);
//! - failure (healthprocessor.cs:46-58,81): checked only when a result is
//!   applied, never by drain alone, and never by a bonus tick or a
//!   slider's own ignore hit (draininghealthprocessor.cs:139-145); once
//!   failed, no result changes health again while the drain keeps it at
//!   zero.
//!
//! health is 0..1 here, lazer's own scale, and the curve is the same wire
//! shape as the stable fold's: a time and a fraction per breakpoint

use crate::beatmap::difficulty::difficulty_range;
use crate::beatmap::{NestedKind, ProcessedBeatmap, ProcessedKind};
use crate::score::{HealthPoint, HitResult};
use crate::simulation::score::JudgementKind;
use crate::simulation::JudgementTimeline;

/// draininghealthprocessor.cs:25-45
const MINIMUM_HEALTH_ERROR: f64 = 0.01;
const MIN_HEALTH_TARGET: f64 = 0.99;
const MID_HEALTH_TARGET: f64 = 0.9;
const MAX_HEALTH_TARGET: f64 = 0.4;

/// precision.cs `DOUBLE_EPSILON`: `AlmostBigger(0, health)` is
/// `0 - health > -epsilon`
const FAIL_EPSILON: f64 = 1e-7;

/// the map-load drain-rate search's answer, cached per session like the
/// stable one because it reads the map alone
#[derive(Debug, Clone, PartialEq)]
pub struct NativeDrain {
    /// health per millisecond, on the 0..1 scale
    pub rate: f64,
    pub target_minimum_health: f64,
    /// the lowest health the perfect play reached under `rate`
    pub lowest_health: f64,
    pub iterations: u32,
}

/// the health fold over one play
#[derive(Debug, Clone, PartialEq)]
pub struct NativeHealth {
    pub drain: NativeDrain,
    /// the piecewise-linear health over time: a pair sharing a millisecond
    /// is a jump, and health before the first point is full
    pub points: Vec<HealthPoint>,
    /// the first result at which health read zero -- lazer's fail, which
    /// leaves the timeline complete and the health at zero from there
    pub fail_time: Option<f64>,
    /// the timeline event that failed: the last one lazer's score
    /// processor counted
    pub fail_event_index: Option<usize>,
}

/// the raw combo-result ladder, osu.game.rulesets.osu/judgements/comboresult.cs
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum ComboResult {
    None,
    Good,
    Perfect,
}

/// the element a result belongs to, as far as the increase table cares
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Element {
    Circle,
    SliderHead,
    SliderTick,
    SliderRepeat,
    SliderTail,
    Slider,
    Spinner,
    SpinnerTick,
}

fn result_of(kind: JudgementKind) -> (HitResult, Element) {
    use crate::beatmap::difficulty::HitGrade;
    let grade = |g: HitGrade| match g {
        HitGrade::Great => HitResult::Great,
        HitGrade::Ok => HitResult::Ok,
        HitGrade::Meh => HitResult::Meh,
        HitGrade::Miss => HitResult::Miss,
    };
    match kind {
        JudgementKind::Circle(g) => (grade(g), Element::Circle),
        JudgementKind::SliderHead { grade: g } => (grade(g), Element::SliderHead),
        JudgementKind::SliderTick { hit, .. } => (
            if hit {
                HitResult::LargeTickHit
            } else {
                HitResult::LargeTickMiss
            },
            Element::SliderTick,
        ),
        JudgementKind::SliderRepeat { hit, .. } => (
            if hit {
                HitResult::LargeTickHit
            } else {
                HitResult::LargeTickMiss
            },
            Element::SliderRepeat,
        ),
        JudgementKind::SliderTail { hit, .. } => (
            if hit {
                HitResult::SliderTailHit
            } else {
                HitResult::IgnoreMiss
            },
            Element::SliderTail,
        ),
        JudgementKind::SliderEnd { complete } => (
            if complete {
                HitResult::IgnoreHit
            } else {
                HitResult::IgnoreMiss
            },
            Element::Slider,
        ),
        // the stable-only aggregate never reaches this fold
        JudgementKind::SliderAggregate(g) => (grade(g), Element::Slider),
        JudgementKind::SpinnerSpin => (HitResult::SmallBonus, Element::SpinnerTick),
        JudgementKind::SpinnerBonus => (HitResult::LargeBonus, Element::SpinnerTick),
        JudgementKind::SpinnerFinal(g) => (grade(g), Element::Spinner),
    }
}

/// osuhealthprocessor.cs:76-127 -- the increase before any combo-end bonus
pub(crate) fn health_increase_for(result: HitResult, element: Element, hp_drain_rate: f32) -> f64 {
    let hp = f64::from(hp_drain_rate);
    match result {
        HitResult::SmallTickMiss | HitResult::LargeTickMiss => difficulty_range(hp, -0.02, -0.075, -0.14),
        HitResult::Miss => difficulty_range(hp, -0.03, -0.125, -0.2),
        HitResult::SmallTickHit => 0.02,
        HitResult::SliderTailHit | HitResult::LargeTickHit => match element {
            Element::SliderTick => 0.015,
            Element::SliderHead | Element::SliderTail | Element::SliderRepeat => 0.02,
            // healthprocessor.cs:75 -> judgement.cs:97-136, the default
            // table, for a large tick on an element the osu! table does not
            // name
            _ => 0.05,
        },
        HitResult::Meh => 0.002,
        HitResult::Ok => 0.011,
        HitResult::Great => 0.03,
        HitResult::SmallBonus => 0.0085,
        HitResult::LargeBonus => 0.01,
        // judgement.cs:97-136 for what osu!'s own table leaves out: the
        // ignores and everything the native walk never produces
        HitResult::Good => 0.05 * 0.75,
        HitResult::Perfect => 0.05 * 1.05,
        HitResult::IgnoreHit
        | HitResult::IgnoreMiss
        | HitResult::ComboBreak
        | HitResult::LegacyComboIncrease => 0.0,
    }
}

/// the increase the drain search reads for an element at its maximum
fn perfect_increase(result: HitResult, element: Element, hp_drain_rate: f32) -> f64 {
    health_increase_for(result, element, hp_drain_rate)
}

/// the no-drain periods lazer tracks at play time
/// (draininghealthprocessor.cs:111-124): each break widened to the objects
/// around it -- the last object, in list order, ending at or before the
/// break and the first starting at or after it -- then merged where they
/// touch, so the fold reads them as one sorted, disjoint list
fn no_drain_periods(beatmap: &ProcessedBeatmap) -> Vec<(f64, f64)> {
    let objects = &beatmap.objects;
    // end times are not monotone (a long slider outlasts a circle after
    // it), so the last object ending by a time is found through the
    // running minimum of the end times from each object on, which is
    let mut earliest_end_from = vec![f64::INFINITY; objects.len() + 1];
    for i in (0..objects.len()).rev() {
        earliest_end_from[i] = earliest_end_from[i + 1].min(objects[i].end_time);
    }
    let mut breaks: Vec<(f64, f64)> = beatmap.breaks.iter().map(|b| (b.start_time, b.end_time)).collect();
    breaks.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.total_cmp(&b.1)));
    let mut periods: Vec<(f64, f64)> = Vec::with_capacity(breaks.len());
    for (break_start, break_end) in breaks {
        // every object from the partition point on ends after the break's
        // start, so the one before it is the last ending by it
        let ends_after = earliest_end_from.partition_point(|&earliest| earliest <= break_start);
        let start = ends_after.checked_sub(1).map_or(f64::MIN, |i| objects[i].end_time);
        let starts_after = objects.partition_point(|o| o.start_time < break_end);
        let end = objects.get(starts_after).map_or(f64::MAX, |o| o.start_time);
        match periods.last_mut() {
            Some(last) if start <= last.1 => last.1 = last.1.max(end),
            _ => periods.push((start, end)),
        }
    }
    periods
}

/// draininghealthprocessor.cs:177-224 -- `ComputeDrainRate` over the
/// perfect play's increases (nested elements first, bonus ticks excluded)
pub fn native_drain(beatmap: &ProcessedBeatmap, hp_drain_rate: f32) -> NativeDrain {
    let hp = f64::from(hp_drain_rate);
    let target_minimum_health =
        difficulty_range(hp, MIN_HEALTH_TARGET, MID_HEALTH_TARGET, MAX_HEALTH_TARGET).clamp(0.0, 1.0);

    let mut increases: Vec<(f64, f64)> = Vec::new();
    for obj in &beatmap.objects {
        match &obj.kind {
            ProcessedKind::Circle => {
                increases.push((obj.start_time, perfect_increase(HitResult::Great, Element::Circle, hp_drain_rate)))
            }
            ProcessedKind::Slider(slider) => {
                for nested in &slider.nested {
                    let (result, element) = match nested.kind {
                        NestedKind::Head => (HitResult::Great, Element::SliderHead),
                        NestedKind::Tick => (HitResult::LargeTickHit, Element::SliderTick),
                        NestedKind::Repeat => (HitResult::LargeTickHit, Element::SliderRepeat),
                        NestedKind::Tail => (HitResult::SliderTailHit, Element::SliderTail),
                    };
                    increases.push((nested.time, perfect_increase(result, element, hp_drain_rate)));
                }
                increases.push((obj.end_time, 0.0));
            }
            ProcessedKind::Spinner(_) => {
                increases.push((obj.end_time, perfect_increase(HitResult::Great, Element::Spinner, hp_drain_rate)))
            }
        }
    }

    let drain_start = beatmap.objects.first().map_or(0.0, |o| o.start_time);
    if increases.len() <= 1 {
        return NativeDrain {
            rate: 0.0,
            target_minimum_health,
            lowest_health: 1.0,
            iterations: 0,
        };
    }

    // the step halves each pass; the c# int doubles until it overflows,
    // which is the loop's own safety net, so the port wraps the same way
    let mut adjustment: i32 = 1;
    let mut result: f64 = 1.0;
    let mut iterations = 0u32;
    let mut lowest_health: f64 = 1.0;
    while adjustment > 0 {
        iterations += 1;
        let mut current_health: f64 = 1.0;
        lowest_health = 1.0;
        let mut current_break = 0usize;
        for i in 0..increases.len() {
            let current_time = increases[i].0;
            let mut last_time = if i > 0 { increases[i - 1].0 } else { drain_start };
            while current_break < beatmap.breaks.len() && beatmap.breaks[current_break].end_time <= current_time {
                // two objects separated by a break drain nothing between them
                last_time = current_time;
                current_break += 1;
            }
            current_health -= (current_time - last_time) * result;
            lowest_health = lowest_health.min(current_health);
            current_health = (current_health + increases[i].1).min(1.0);
            if lowest_health < 0.0 {
                break;
            }
        }
        if (lowest_health - target_minimum_health).abs() <= MINIMUM_HEALTH_ERROR {
            break;
        }
        adjustment = adjustment.wrapping_mul(2);
        let direction = lowest_health - target_minimum_health;
        let sign = if direction > 0.0 {
            1.0
        } else if direction < 0.0 {
            -1.0
        } else {
            0.0
        };
        result += 1.0 / f64::from(adjustment) * sign;
    }

    NativeDrain {
        rate: result,
        target_minimum_health,
        lowest_health,
        iterations,
    }
}

/// the fold over a native timeline, with the session's cached drain
pub fn native_health(beatmap: &ProcessedBeatmap, timeline: &JudgementTimeline, hp_drain_rate: f32, drain: NativeDrain) -> NativeHealth {
    let Some(first) = beatmap.objects.first() else {
        return NativeHealth {
            drain,
            points: Vec::new(),
            fail_time: None,
            fail_event_index: None,
        };
    };
    let drain_start = first.start_time;
    let gameplay_end = beatmap.objects.last().map_or(drain_start, |o| o.end_time);
    let periods = no_drain_periods(beatmap);

    let mut fold = Fold {
        rate: drain.rate,
        drain_start,
        gameplay_end,
        periods,
        health: 1.0,
        clock: drain_start,
        points: vec![HealthPoint {
            time: drain_start,
            fraction: 1.0,
        }],
        failed: false,
        fail_time: None,
        fail_event_index: None,
        combo_result: ComboResult::Perfect,
    };

    for (event_index, event) in timeline.events.iter().enumerate() {
        fold.drain_to(event.time);
        // healthprocessor.cs:46-58 returns on `HasFailed` BEFORE
        // `GetHealthIncreaseFor`, which is where lazer advances the combo
        // ladder -- so a failed play's ladder is frozen where it failed. the
        // increase itself is already discarded by `apply`; this is what stops
        // the ladder from walking on past the fail behind it
        if fold.failed {
            continue;
        }
        let (result, element) = result_of(event.kind);
        let obj = &beatmap.objects[event.object_index];
        let top_level = matches!(element, Element::Circle | Element::Slider | Element::Spinner);
        let increase = fold.increase_with_combo_bonus(
            result,
            element,
            hp_drain_rate,
            top_level && obj.new_combo,
            top_level && obj.last_in_combo,
        );
        fold.apply(event.time, increase, result, element, event_index);
    }
    fold.drain_to(gameplay_end);

    NativeHealth {
        drain,
        points: fold.points,
        fail_time: fold.fail_time,
        fail_event_index: fold.fail_event_index,
    }
}

struct Fold {
    rate: f64,
    drain_start: f64,
    gameplay_end: f64,
    periods: Vec<(f64, f64)>,
    health: f64,
    clock: f64,
    points: Vec<HealthPoint>,
    failed: bool,
    fail_time: Option<f64>,
    fail_event_index: Option<usize>,
    combo_result: ComboResult,
}

impl Fold {
    fn push(&mut self, time: f64, fraction: f64) {
        self.points.push(HealthPoint { time, fraction });
    }

    /// the drain between the clock and `time`: the rate over every stretch
    /// inside the gameplay window and outside the no-drain periods, with a
    /// breakpoint wherever the slope changes and where zero is reached
    fn drain_to(&mut self, time: f64) {
        let time = time.max(self.clock);
        if self.rate <= 0.0 {
            self.clock = time;
            return;
        }
        let mut cursor = self.clock;
        while cursor < time {
            // the next slope change: a window edge or a period edge
            let mut next = time;
            for edge in [self.drain_start, self.gameplay_end] {
                if edge > cursor && edge < next {
                    next = edge;
                }
            }
            let (in_period, period_edge) = self.period_at(cursor);
            if let Some(edge) = period_edge {
                if edge < next {
                    next = edge;
                }
            }
            let draining = cursor >= self.drain_start && cursor < self.gameplay_end && !in_period;
            if draining && self.health > 0.0 {
                let loss = (next - cursor) * self.rate;
                if loss >= self.health {
                    let zero_at = cursor + self.health / self.rate;
                    self.push(zero_at, 0.0);
                    self.health = 0.0;
                } else {
                    self.health -= loss;
                }
                if next == time || self.health > 0.0 {
                    self.push(next, self.health);
                }
            } else if self.points.last().is_none_or(|p| p.time != next || p.fraction != self.health) {
                self.push(next, self.health);
            }
            cursor = next;
        }
        self.clock = time;
    }

    /// whether `cursor` sits inside a no-drain period -- opening edge
    /// inclusive, CLOSING edge exclusive -- and the nearest period edge past
    /// it: the periods are sorted and disjoint, so the first one not ending
    /// before the cursor is found by bisection and at most two are read.
    ///
    /// the half-open end is what makes this the limit of lazer's per-frame
    /// rule rather than a widening of it. `PeriodTracker.IsInAny`
    /// (periodtracker.cs:54) is `time >= Start && time <= End`, inclusive
    /// both ends, but lazer asks it once per DISPLAY FRAME and skips only
    /// that frame's drain, so landing exactly on `End` costs one frame --
    /// measure zero. this walk asks once per visited INSTANT and holds the
    /// answer across `[cursor, next)`, and `drain_to` steps the cursor onto
    /// the closing edge by construction, so a closed end would suspend drain
    /// over the entire stretch from the break's close to the next judgement
    /// -- unbounded when the next object is a spinner nobody spins
    fn period_at(&self, cursor: f64) -> (bool, Option<f64>) {
        let first = self.periods.partition_point(|&(_, end)| end < cursor);
        let mut in_period = false;
        for &(start, end) in &self.periods[first..] {
            if start <= cursor && cursor < end {
                in_period = true;
            }
            if start > cursor {
                return (in_period, Some(start));
            }
            if end > cursor {
                return (in_period, Some(end));
            }
        }
        (in_period, None)
    }

    /// osuhealthprocessor.cs:23-70
    fn increase_with_combo_bonus(
        &mut self,
        result: HitResult,
        element: Element,
        hp_drain_rate: f32,
        new_combo: bool,
        last_in_combo: bool,
    ) -> f64 {
        let base = health_increase_for(result, element, hp_drain_rate);
        if new_combo {
            self.combo_result = ComboResult::Perfect;
        }
        match result {
            HitResult::LargeTickMiss | HitResult::Ok => self.demote(ComboResult::Good),
            HitResult::Meh | HitResult::Miss => self.demote(ComboResult::None),
            _ => {}
        }
        if element == Element::SliderTail && !result.is_hit() {
            self.demote(ComboResult::Good);
        }
        if last_in_combo && result.is_hit() {
            return base
                + match self.combo_result {
                    ComboResult::Perfect => 0.07,
                    ComboResult::Good => 0.05,
                    ComboResult::None => 0.03,
                };
        }
        base
    }

    fn demote(&mut self, to: ComboResult) {
        self.combo_result = self.combo_result.min(to);
    }

    /// healthprocessor.cs:46-58 with draininghealthprocessor.cs:139-145
    fn apply(&mut self, time: f64, increase: f64, result: HitResult, element: Element, event_index: usize) {
        if self.failed {
            return;
        }
        let before = self.health;
        self.health = (self.health + increase).clamp(0.0, 1.0);
        if self.health != before {
            self.push(time, before);
            self.push(time, self.health);
        }
        let exempt = element == Element::SpinnerTick || result == HitResult::IgnoreHit;
        if !exempt && self.health < FAIL_EPSILON {
            self.failed = true;
            self.fail_time = Some(time);
            self.fail_event_index = Some(event_index);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::beatmap::process_beatmap;
    use crate::formats::beatmap::decode_beatmap_bytes;
    use crate::simulation::JudgementEvent;

    fn map(hp: f32, objects: &str) -> ProcessedBeatmap {
        let text = format!(
            "osu file format v14\n\n[Difficulty]\nHPDrainRate:{hp}\nCircleSize:4\nOverallDifficulty:5\nApproachRate:9\nSliderMultiplier:1\nSliderTickRate:2\n\n[TimingPoints]\n0,500,4,2,1,60,1,0\n\n[HitObjects]\n{objects}\n"
        );
        process_beatmap(&decode_beatmap_bytes(text.as_bytes()).expect("decodes")).expect("processes")
    }

    #[test]
    fn the_increase_table_follows_the_hp_difficulty_range() {
        // the range's own arithmetic lands an ulp off its endpoints, as
        // lazer's does (ibeatmapdifficultyinfo.cs), so the ends are
        // compared within one
        let near = |a: f64, b: f64| (a - b).abs() < 1e-12;
        for (hp, miss, tick_miss) in [(0.0f32, -0.03, -0.02), (5.0, -0.125, -0.075), (10.0, -0.2, -0.14)] {
            assert!(near(health_increase_for(HitResult::Miss, Element::Circle, hp), miss));
            assert!(near(health_increase_for(HitResult::LargeTickMiss, Element::SliderTick, hp), tick_miss));
        }
        assert_eq!(health_increase_for(HitResult::Great, Element::Circle, 5.0), 0.03);
        assert_eq!(health_increase_for(HitResult::Ok, Element::SliderHead, 5.0), 0.011);
        assert_eq!(health_increase_for(HitResult::Meh, Element::Spinner, 5.0), 0.002);
        assert_eq!(health_increase_for(HitResult::LargeTickHit, Element::SliderTick, 5.0), 0.015);
        assert_eq!(health_increase_for(HitResult::LargeTickHit, Element::SliderRepeat, 5.0), 0.02);
        assert_eq!(health_increase_for(HitResult::SliderTailHit, Element::SliderTail, 5.0), 0.02);
        assert_eq!(health_increase_for(HitResult::SmallBonus, Element::SpinnerTick, 5.0), 0.0085);
        assert_eq!(health_increase_for(HitResult::LargeBonus, Element::SpinnerTick, 5.0), 0.01);
        assert_eq!(health_increase_for(HitResult::IgnoreHit, Element::Slider, 5.0), 0.0);
        assert_eq!(health_increase_for(HitResult::IgnoreMiss, Element::SliderTail, 5.0), 0.0);
    }

    #[test]
    fn the_combo_end_bonus_pays_by_the_combos_worst_result() {
        let mut fold = Fold {
            rate: 0.0,
            drain_start: 0.0,
            gameplay_end: 0.0,
            periods: Vec::new(),
            health: 1.0,
            clock: 0.0,
            points: Vec::new(),
            failed: false,
            fail_time: None,
            fail_event_index: None,
            combo_result: ComboResult::Perfect,
        };
        // a perfect combo of two circles, the second last in combo
        assert_eq!(fold.increase_with_combo_bonus(HitResult::Great, Element::Circle, 5.0, true, false), 0.03);
        assert_eq!(fold.increase_with_combo_bonus(HitResult::Great, Element::Circle, 5.0, false, true), 0.03 + 0.07);
        // an ok demotes to good; a dropped tail too; a meh to none; the
        // new-combo flag resets
        fold.increase_with_combo_bonus(HitResult::Ok, Element::Circle, 5.0, true, false);
        assert_eq!(fold.combo_result, ComboResult::Good);
        fold.increase_with_combo_bonus(HitResult::IgnoreMiss, Element::SliderTail, 5.0, false, false);
        assert_eq!(fold.combo_result, ComboResult::Good);
        assert_eq!(fold.increase_with_combo_bonus(HitResult::IgnoreHit, Element::Slider, 5.0, false, true), 0.05);
        fold.increase_with_combo_bonus(HitResult::Meh, Element::Circle, 5.0, true, false);
        assert_eq!(fold.increase_with_combo_bonus(HitResult::Great, Element::Circle, 5.0, false, true), 0.03 + 0.03);
        // a miss is not a hit: no bonus even when last in combo
        assert_eq!(fold.increase_with_combo_bonus(HitResult::Miss, Element::Circle, 5.0, true, true), -0.125);
    }

    #[test]
    fn the_drain_search_lands_the_perfect_play_on_the_target() {
        let beatmap = map(
            5.0,
            "100,100,1000,5,0,0:0:0:0:\n200,100,3000,1,0,0:0:0:0:\n100,200,5000,2,0,L|300:200,1,200\n256,192,8000,12,0,10000,0:0:0:0:\n300,100,12000,1,0,0:0:0:0:",
        );
        let drain = native_drain(&beatmap, 5.0);
        assert_eq!(drain.target_minimum_health, 0.9);
        assert!((drain.lowest_health - 0.9).abs() <= MINIMUM_HEALTH_ERROR, "{drain:?}");
        assert!(drain.rate > 0.0 && drain.iterations <= 32);
    }

    #[test]
    fn a_map_with_one_increase_never_drains() {
        let beatmap = map(5.0, "100,100,1000,5,0,0:0:0:0:");
        assert_eq!(native_drain(&beatmap, 5.0).rate, 0.0);
    }

    #[test]
    fn misses_drain_the_bar_to_a_fail_and_nothing_recovers_it() {
        let objects: String = (0..12)
            .map(|i| format!("100,100,{},{},0,0:0:0:0:", 1000 + i * 500, if i == 0 { 5 } else { 1 }))
            .collect::<Vec<_>>()
            .join("\n");
        let beatmap = map(10.0, &objects);
        let drain = native_drain(&beatmap, 10.0);
        let events: Vec<JudgementEvent> = (0..12)
            .map(|i| JudgementEvent {
                time: 1000.0 + i as f64 * 500.0 + 149.5,
                object_index: i,
                kind: JudgementKind::Circle(crate::beatmap::difficulty::HitGrade::Miss),
                combo_after: 0,
                accuracy_after: 0.0,
            })
            .collect();
        let timeline = JudgementTimeline {
            events,
            totals: crate::simulation::HitTotals::default(),
            spinner_scoring: Vec::new(),
            native: None,
        };
        let health = native_health(&beatmap, &timeline, 10.0, drain);
        let fail = health.fail_time.expect("twelve misses at hp 10 fail");
        assert!(fail < 1000.0 + 6.0 * 500.0, "five misses of 0.2 plus drain reach zero: {fail}");
        let last = health.points.last().expect("points");
        assert_eq!(last.fraction, 0.0, "health stays at zero after the fail");
        assert!(last.time >= fail, "the curve runs past the fail to the last judgement");
        assert!(
            health.points.iter().filter(|p| p.time > fail).all(|p| p.fraction == 0.0),
            "nothing recovers a failed bar"
        );
        assert!(
            health.points.windows(2).all(|w| w[0].time <= w[1].time),
            "breakpoints are time-ordered"
        );
    }

    #[test]
    fn breaks_widen_to_the_objects_around_them_and_merge_where_they_touch() {
        let text = "osu file format v14\n\n[Difficulty]\nHPDrainRate:5\nCircleSize:4\nOverallDifficulty:5\nApproachRate:9\nSliderMultiplier:1\nSliderTickRate:2\n\n[Events]\n2,3500,5500\n2,2200,3000\n2,100,500\n\n[TimingPoints]\n0,500,4,2,1,60,1,0\n\n[HitObjects]\n100,100,1000,5,0,0:0:0:0:\n200,100,2000,1,0,0:0:0:0:\n300,100,6000,1,0,0:0:0:0:\n400,100,7000,1,0,0:0:0:0:\n";
        let beatmap = process_beatmap(&decode_beatmap_bytes(text.as_bytes()).expect("decodes")).expect("processes");
        assert_eq!(beatmap.breaks.len(), 3);
        // the two breaks between the second and third object become one
        // period bounded by them; the one before any object opens at the
        // beginning of time and closes at the first
        assert_eq!(no_drain_periods(&beatmap), vec![(f64::MIN, 1000.0), (2000.0, 6000.0)]);

        let drain = native_drain(&beatmap, 5.0);
        assert!(drain.rate > 0.0);
        let events: Vec<JudgementEvent> = [1000.0, 2000.0, 6000.0, 7000.0]
            .into_iter()
            .enumerate()
            .map(|(i, time)| JudgementEvent {
                time,
                object_index: i,
                kind: JudgementKind::Circle(crate::beatmap::difficulty::HitGrade::Great),
                combo_after: i as u32 + 1,
                accuracy_after: 1.0,
            })
            .collect();
        let timeline = JudgementTimeline {
            events,
            totals: crate::simulation::HitTotals::default(),
            spinner_scoring: Vec::new(),
            native: None,
        };
        let health = native_health(&beatmap, &timeline, 5.0, drain);
        let after_second = health.points.iter().filter(|p| p.time == 2000.0).last().expect("hit").fraction;
        let at_third = health.points.iter().find(|p| p.time == 6000.0).expect("reached").fraction;
        assert_eq!(after_second, at_third, "nothing drains across the merged period");
        assert!(
            health.points.iter().all(|p| p.time <= 2000.0 || p.time >= 6000.0),
            "no breakpoint inside it: {:?}",
            health.points
        );
    }

    /// the closing edge of a no-drain period is EXCLUSIVE. `drain_to` steps
    /// the cursor onto that edge by construction, so a closed test reads the
    /// cursor as still inside the break and suspends drain over the whole
    /// stretch from the break's close to the next judgement -- here a full
    /// second, and unbounded when the next object is a spinner nobody spins.
    /// the sibling test above only proves nothing drains INSIDE the period,
    /// which holds either way
    #[test]
    fn drain_resumes_the_instant_a_break_closes_not_at_the_next_judgement() {
        let text = "osu file format v14

[Difficulty]
HPDrainRate:5
CircleSize:4
OverallDifficulty:5
ApproachRate:9
SliderMultiplier:1
SliderTickRate:2

[Events]
2,3500,5500
2,2200,3000
2,100,500

[TimingPoints]
0,500,4,2,1,60,1,0

[HitObjects]
100,100,1000,5,0,0:0:0:0:
200,100,2000,1,0,0:0:0:0:
300,100,6000,1,0,0:0:0:0:
400,100,7000,1,0,0:0:0:0:
";
        let beatmap = process_beatmap(&decode_beatmap_bytes(text.as_bytes()).expect("decodes")).expect("processes");
        // the merged period closes exactly on the third object, which is the
        // cursor position the bug turned into "still in the break"
        assert_eq!(no_drain_periods(&beatmap), vec![(f64::MIN, 1000.0), (2000.0, 6000.0)]);

        let drain = native_drain(&beatmap, 5.0);
        let events: Vec<JudgementEvent> = [1000.0, 2000.0, 6000.0, 7000.0]
            .into_iter()
            .enumerate()
            .map(|(i, time)| JudgementEvent {
                time,
                object_index: i,
                kind: JudgementKind::Circle(crate::beatmap::difficulty::HitGrade::Great),
                combo_after: i as u32 + 1,
                accuracy_after: 1.0,
            })
            .collect();
        let timeline = JudgementTimeline {
            events,
            totals: crate::simulation::HitTotals::default(),
            spinner_scoring: Vec::new(),
            native: None,
        };
        let health = native_health(&beatmap, &timeline, 5.0, drain);

        // `find` is the value on ARRIVAL at a time (after draining to it,
        // before that judgement's own increase); `last` is after the increase
        let leaving_third = health.points.iter().filter(|p| p.time == 6000.0).last().expect("hit").fraction;
        let arriving_fourth = health.points.iter().find(|p| p.time == 7000.0).expect("reached").fraction;
        assert!(
            arriving_fourth < leaving_third,
            "the second after the break must drain: left the break at {leaving_third}, arrived at {arriving_fourth}"
        );
    }

    #[test]
    fn a_perfect_play_dips_only_by_drain_and_recovers_on_every_hit() {
        let beatmap = map(5.0, "100,100,1000,5,0,0:0:0:0:\n200,100,2000,1,0,0:0:0:0:\n300,100,3000,1,0,0:0:0:0:");
        let drain = native_drain(&beatmap, 5.0);
        let events: Vec<JudgementEvent> = (0..3)
            .map(|i| JudgementEvent {
                time: 1000.0 + i as f64 * 1000.0,
                object_index: i,
                kind: JudgementKind::Circle(crate::beatmap::difficulty::HitGrade::Great),
                combo_after: i as u32 + 1,
                accuracy_after: 1.0,
            })
            .collect();
        let timeline = JudgementTimeline {
            events,
            totals: crate::simulation::HitTotals::default(),
            spinner_scoring: Vec::new(),
            native: None,
        };
        let health = native_health(&beatmap, &timeline, 5.0, drain.clone());
        assert!(health.fail_time.is_none());
        let lowest = health.points.iter().map(|p| p.fraction).fold(1.0, f64::min);
        assert!((lowest - 0.9).abs() <= MINIMUM_HEALTH_ERROR + 1e-9, "lowest {lowest} against {drain:?}");
        assert_eq!(health.points.first().map(|p| (p.time, p.fraction)), Some((1000.0, 1.0)));
    }
}
