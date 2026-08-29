//! achieved scorev1 total score, folded over the judgement timeline.
//!
//! ports the per-element rules of `osulegacyscoresimulator.cs` (the pinned
//! stable-score reference): slider parts score a flat 30/10 with no combo
//! bonus, and every object-level judgement scores `base + max(0, combo - 1)
//! * (base / 25) * peppyStars * modMultiplier` with the combo read before
//! the element's own increment (osulegacyscoresimulator.cs:162-177).
//!
//! one place deliberately leaves that reference for a more stable-faithful
//! one: a slider POINT's 10-vs-30 value comes from
//! [`stable_slider_point_values`] (danser `slider.go:330-335`, stable's own
//! shape) rather than from the point's kind, because stable values a judged
//! point by how many points are DUE at that moment, not by what the point
//! is. lazer's simulator never models this -- it walks its own nested
//! objects kind-by-kind -- which is exactly the flat "-20 per map" header
//! class of engine parity issue 15.
//!
//! spinner spin scoring follows stable's half-spin model
//! (osulegacyscoresimulator.cs:130-156), computed from each spinner's
//! stable scoring-rotation count (`simulation::spinner::StableSpinState`,
//! stable's own disc physics) rather than from the timeline's spin/bonus
//! events: those events are lazer's *gameplay* ticks (spins_required + a
//! 2-spin bonus gap), and lazer's own legacy-score simulator does not reuse
//! them -- it redoes the computation stable-style because "gameplay
//! mechanics differ from osu-stable". per docs/adr/0001 the header is the
//! scoring oracle, so the fold does exactly what that simulator does: every
//! full spin from the first scores 100, every second half-spin past
//! `stable_half_spins_required + 3` scores an 1100 bonus (displacing a 100
//! tick only when the gate's parity collides with the whole-spin grid),
//! all capped at `total_half_spins_possible`. lazer's simulator computes
//! the theoretical maximum; this fold walks the achieved half-spin count
//! instead, so the same rules run over what the play actually did.

use crate::beatmap::difficulty::HitGrade;
use crate::beatmap::{ProcessedBeatmap, ProcessedKind, ProcessedSlider, ProcessedSpinner};
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

/// stable's score value (10 or 30) for each of one slider's points, in the
/// judgement machine's list order.
///
/// ports the `maxScore` selection of danser's `processTicksStable`
/// (slider.go:330-335, itself the stable shape): a judged point is valued
/// from `pointsPassed` -- how many points are DUE at the judging moment --
/// never from the point's own identity. `SliderEnd` (30) when every point
/// is due, `SliderRepeat` (30) when the due count is a whole number of
/// spans' worth (`len(points) / len(TickReverse)`, one reverse point per
/// span), `SliderPoint` (10) otherwise.
///
/// under stable's live cadence (one point judged per game tick from the
/// moment it falls due) the due counts, and so the values, are a static
/// property of the map. the one shape real point spacings produce where
/// this diverges from the point's kind (a degenerate sub-millisecond
/// spacing could tie later points into a due count too, priced by the same
/// rule): the tail is repositioned to `max(start + duration/2, end - 36)`
/// (slider.go:109) IN PLACE at the end of the list, so a final tick inside
/// that window has the tail due at or before it -- the walk that counts
/// due points breaks at the first pending point in LIST order, which holds
/// the tail back until the tick is due, and then both are due together:
/// the tick is judged with `pointsPassed == len(points)` and scores 30,
/// not 10. every play that scores such a tick banks a flat +20 the
/// kind-valued fold misses -- constant per map, invisible to counts and
/// combo. that is the whole flat -20-per-map header class of engine
/// parity issue 15 (Totsugeki Rock and STYX HELIX carry one such slider,
/// the two Kyouki Chinden difficulties carry 12 and 24, and each header
/// sits exactly 20 * that count above the kind-valued fold)
pub fn stable_slider_point_values(start_time: f64, slider: &ProcessedSlider) -> Vec<u64> {
    let n = slider.stable_points.len();
    if n == 0 {
        return Vec::new();
    }
    // the machine's own point times: stable's floored score times with the
    // final point repositioned in truncated integer arithmetic, exactly as
    // simulation/slider.rs builds SliderState::points
    let start = start_time as i64;
    let end = slider.stable_end_time as i64;
    let mut times: Vec<i64> = slider.stable_points.iter().map(|p| p.time as i64).collect();
    // wrapping, not `-`/`+`: the saturating casts let a crafted finite end
    // time sit at i64::MAX against a negative start, where go wraps and a
    // debug-build rust `-` would panic (same posture as
    // ProcessedSpinner::spins_required_for_bonus)
    times[n - 1] = start.wrapping_add(end.wrapping_sub(start) / 2).max(end.wrapping_sub(36));

    // pointsPassed's walk breaks at the first pending point in list order,
    // so a point is due-for-counting only once everything before it is due
    // too -- the prefix maximum
    let mut reach = times;
    for i in 1..n {
        reach[i] = reach[i].max(reach[i - 1]);
    }

    let per_span = n / (slider.span_count.max(1) as usize);

    let mut values = Vec::with_capacity(n);
    let mut judge_time = i64::MIN;
    // reach is nondecreasing and judge_time never moves backwards, so the
    // due count is a cursor that only advances: O(n) overall, where a fresh
    // prefix scan per point would go quadratic against the million-point
    // slider MAX_SLIDER_NESTED_OBJECTS admits
    let mut points_passed = 0usize;
    for &reachable_at in &reach {
        // one point per game tick, starting the tick the point falls due
        judge_time = reachable_at.max(judge_time.saturating_add(1));
        while points_passed < n && reach[points_passed] <= judge_time {
            points_passed += 1;
        }
        let value = if points_passed == n || (per_span > 0 && points_passed % per_span == 0) {
            30
        } else {
            10
        };
        values.push(value);
    }
    values
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

/// stable's spinner tick score for one spinner's achieved half-spin count
/// -- closed form over osulegacyscoresimulator.cs:149-155's half-spin
/// loop: `i` walks half spins, a bonus (1100) lands on every second half
/// spin past the gate (`stable_half_spins_required + 3`), and an ordinary
/// tick (100) lands on every even `i > 1` a bonus did not claim. bonus
/// half spins share the gate's parity, so they collide with the even tick
/// grid exactly when the gate is even. i64 throughout: the processed
/// fields can sit at the dotnet i32::MIN cast sentinel for degenerate
/// spinners, and the counts must clamp rather than wrap.
///
/// `total_half_spins_possible` caps the count: the disc physics can exceed
/// the analytic bound by a fraction of a half-turn only through frame-gap
/// bookkeeping at the window edges, and lazer's simulator treats the bound
/// as hard
fn stable_spinner_tick_score(spinner: &ProcessedSpinner, halves_spun: i64) -> u64 {
    let n = halves_spun.min(i64::from(spinner.total_half_spins_possible));
    let gate = i64::from(spinner.stable_half_spins_required) + 3;

    let bonuses = ((n - gate) / 2).max(0);
    let colliding = if gate % 2 == 0 { bonuses } else { 0 };
    let ticks = (n / 2 - colliding).max(0);
    (ticks as u64) * 100 + (bonuses as u64) * 1100
}

/// the achieved scorev1 total. accumulates in u64 -- stable itself wraps a
/// 32-bit int on degenerate maps, but a wrapped header field is exactly the
/// lie export refuses to write, so the wide fold feeds checked narrowing
/// instead (`ExportOverflow` at the export boundary).
///
/// `mod_multiplier` is the mod seam: NoMod passes 1.0, and the multiplier
/// table stays gated with mod simulation itself (TODO.md)
pub fn total_score(
    timeline: &JudgementTimeline,
    processed: &ProcessedBeatmap,
    peppy_stars: i32,
    mod_multiplier: f64,
) -> u64 {
    // replaying the combo fold through ScoreState keeps the bonus multiplier
    // consistent with the exact combo semantics the simulator emitted,
    // including the classic tail divergence
    let mut state = ScoreState::default();
    let mut total: u64 = 0;

    // per-slider stable point values and each slider's next point ordinal:
    // the machine emits one event per judged point in list order, so the
    // running count of a slider's tick/repeat/tail events IS the point index
    let mut point_values: Vec<Option<Vec<u64>>> = vec![None; processed.objects.len()];
    let mut point_ordinal: Vec<usize> = vec![0; processed.objects.len()];
    let mut slider_point = |index: usize, kind_value: u64, hit: bool| -> u64 {
        let ordinal = match point_ordinal.get_mut(index) {
            Some(ordinal) => {
                let current = *ordinal;
                *ordinal += 1;
                current
            }
            // out-of-bounds object: a mismatched timeline/beatmap pair must
            // degrade, never panic (same posture as the spinner leg below)
            None => return if hit { kind_value } else { 0 },
        };
        if !hit {
            return 0;
        }
        let values = point_values[index].get_or_insert_with(|| {
            match processed.objects.get(index).map(|o| (&o.kind, o.start_time)) {
                Some((ProcessedKind::Slider(slider), start_time)) => {
                    stable_slider_point_values(start_time, slider)
                }
                // a point event on a non-slider object only arises from a
                // mismatched pair; the empty table falls back to the kind
                _ => Vec::new(),
            }
        });
        values.get(ordinal).copied().unwrap_or(kind_value)
    };

    for event in &timeline.events {
        match event.kind {
            JudgementKind::SliderHead { hit } => {
                if hit {
                    total = total.saturating_add(30);
                }
            }
            JudgementKind::SliderRepeat { hit, .. } | JudgementKind::SliderTail { hit } => {
                let value = slider_point(event.object_index, 30, hit);
                total = total.saturating_add(value);
            }
            JudgementKind::SliderTick { hit } => {
                let value = slider_point(event.object_index, 10, hit);
                total = total.saturating_add(value);
            }
            // lazer's gameplay ticks; scored via the stable half-spin model
            // below instead (module doc)
            JudgementKind::SpinnerSpin | JudgementKind::SpinnerBonus => {}
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

    for scoring in &timeline.spinner_scoring {
        // .get(): a mismatched processed/timeline pair must degrade to a
        // skipped record, never an out-of-bounds panic (no-panic posture) --
        // guard instead of assert, as in simulation/slider.rs
        let Some(ProcessedKind::Spinner(spinner)) =
            processed.objects.get(scoring.object_index).map(|o| &o.kind)
        else {
            continue;
        };
        total = total.saturating_add(stable_spinner_tick_score(spinner, scoring.scoring_half_spins));
    }

    total
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::beatmap::process_beatmap;
    use crate::formats::beatmap::{Beatmap, HitObject, HitObjectKind, TimingPoint};
    use crate::formats::GameMode;
    use crate::math::Vec2;
    use crate::simulation::{HitTotals, JudgementEvent, SpinnerScoring};

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
            spinner_scoring: Vec::new(),
        }
    }

    /// one shared base map so the beatmap defaults live in a single place
    fn map_of(od: f32, hit_objects: Vec<HitObject>) -> ProcessedBeatmap {
        let map = Beatmap {
            format_version: 14,
            mode: GameMode::Osu,
            title: String::new(),
            artist: String::new(),
            creator: String::new(),
            version: String::new(),
            beatmap_id: 0,
            beatmap_set_id: 0,
            audio_file: String::new(),
            audio_lead_in: 0.0,
            background_file: String::new(),
            stack_leniency: 0.7,
            hp_drain_rate: 5.0,
            circle_size: 4.0,
            overall_difficulty: od,
            approach_rate: 9.0,
            slider_multiplier: 1.4,
            slider_tick_rate: 1.0,
            combo_colors: Vec::new(),
            default_sample_bank: crate::formats::samples::SampleBank::Normal,
            default_sample_volume: 100,
            samples_match_playback_rate: false,
            breaks: Vec::new(),
            timing_points: vec![TimingPoint {
                time: 0.0,
                beat_len: 500.0,
            }],
            difficulty_points: Vec::new(),
            hit_objects,
        };
        process_beatmap(&map).unwrap()
    }

    /// a circles-only map: the spinner leg of total_score never fires, so
    /// the event-fold tests stay focused on the combo arithmetic
    fn circles_map(count: usize) -> ProcessedBeatmap {
        map_of(
            5.0,
            (0..count.max(1))
                .map(|i| HitObject {
                    start_time: 1000.0 + i as f64 * 1000.0,
                    pos: Vec2::new(256.0, 192.0),
                    new_combo: i == 0,
                    combo_offset: 0,
                    samples: Vec::new(),
                    kind: HitObjectKind::Circle,
                })
                .collect(),
        )
    }

    /// a map holding one spinner with the given duration and od
    fn spinner_map(duration: f64, od: f32) -> ProcessedBeatmap {
        map_of(
            od,
            vec![HitObject {
                start_time: 1000.0,
                pos: Vec2::ZERO,
                new_combo: false,
                combo_offset: 0,
                samples: Vec::new(),
                kind: HitObjectKind::Spinner { duration },
            }],
        )
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
        assert_eq!(total_score(&timeline, &circles_map(3), 4, 1.0), 948);
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
        assert_eq!(total_score(&timeline, &circles_map(4), 4, 1.0), 782);
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
        assert_eq!(total_score(&timeline, &circles_map(6), 4, 1.0), 1548);
    }

    #[test]
    fn slider_parts_score_flat_and_feed_the_aggregate_combo() {
        let timeline = timeline_of(&[
            JudgementKind::SliderHead { hit: true },
            JudgementKind::SliderTick { hit: true },
            JudgementKind::SliderRepeat { hit: true, repeat_index: 0 },
            JudgementKind::SliderTail { hit: true },
            JudgementKind::SliderAggregate(HitGrade::Great),
        ]);
        // 30 + 10 + 30 + 30 flat, then the aggregate's 300 with the combo
        // the four parts built: max(0, 4-1) * 12 * 4 = 144
        assert_eq!(total_score(&timeline, &circles_map(5), 4, 1.0), 100 + 300 + 144);
    }

    #[test]
    fn a_head_missed_slider_scores_the_plain_fold() {
        // measured and rejected during parity issue 15's triage: granting a
        // head-missed slider's aggregate an extra combo unit fixed the
        // Totsugeki-class plays but broke 699 previously-exact plays
        // carrying the identical break shape (the sweep is the arbiter).
        // this pins the plain fold so the rejected variant cannot sneak
        // back: reset at the head, tail +30 through combo 1, aggregate Ok
        // with zero bonus
        let mut timeline = timeline_of(&[
            JudgementKind::SliderHead { hit: false },
            JudgementKind::SliderTail { hit: true },
            JudgementKind::SliderAggregate(HitGrade::Ok),
        ]);
        for event in &mut timeline.events {
            event.object_index = 0;
        }
        assert_eq!(total_score(&timeline, &circles_map(3), 5, 1.0), 130);
    }

    #[test]
    fn missed_slider_parts_score_nothing() {
        let timeline = timeline_of(&[
            JudgementKind::SliderHead { hit: false },
            JudgementKind::SliderTick { hit: false },
            JudgementKind::SliderTail { hit: false },
            JudgementKind::SliderAggregate(HitGrade::Miss),
        ]);
        assert_eq!(total_score(&timeline, &circles_map(4), 4, 1.0), 0);
    }

    #[test]
    fn spinner_ticks_score_stable_style_from_the_scoring_count_not_gameplay_events() {
        // 2000ms at od5: stable_half_spins_required = (int)(2 * 5) = 10,
        // gate = 13 (odd), possible = (int)(2 * 15.9) = 31. twelve half
        // spins: no bonus yet, whole spins 1..6 score 100 each. the
        // timeline carries lazer's gameplay events for the same play --
        // they must contribute nothing to the total
        let processed = spinner_map(2000.0, 5.0);
        let mut timeline = timeline_of(&[
            JudgementKind::SpinnerSpin,
            JudgementKind::SpinnerSpin,
            JudgementKind::SpinnerSpin,
            JudgementKind::SpinnerSpin,
            JudgementKind::SpinnerSpin,
            JudgementKind::SpinnerSpin,
            JudgementKind::SpinnerFinal(HitGrade::Great),
        ]);
        for event in &mut timeline.events {
            event.object_index = 0;
        }
        timeline.spinner_scoring = vec![SpinnerScoring {
            object_index: 0,
            scoring_half_spins: 12,
        }];
        // 6 ticks * 100 + the final's bare 300 (combo 0 before it)
        assert_eq!(total_score(&timeline, &processed, 4, 1.0), 600 + 300);
    }

    #[test]
    fn mismatched_spinner_scoring_records_are_skipped_in_every_profile() {
        // a timeline paired with the wrong beatmap must degrade to skipped
        // spinner records in debug as well as release -- this pinned a
        // debug_assert! that panicked where the guard promises to skip
        let mut timeline = timeline_of(&[JudgementKind::Circle(HitGrade::Great)]);
        timeline.spinner_scoring = vec![
            // in bounds but a circle, and past the end of the object list
            SpinnerScoring {
                object_index: 0,
                scoring_half_spins: 12,
            },
            SpinnerScoring {
                object_index: 99,
                scoring_half_spins: 12,
            },
        ];
        assert_eq!(total_score(&timeline, &circles_map(1), 4, 1.0), 300);
    }

    #[test]
    fn spinner_bonus_lands_every_second_half_spin_past_the_gate() {
        // same spinner: gate 13 (odd). twenty-two halves: bonuses at half
        // spins 15, 17, 19, 21 (4 of them), ticks at every even half spin
        // 2..=22 (11) -- the odd gate never collides with the whole-spin
        // tick grid, stable's own interleaving quirk
        let processed = spinner_map(2000.0, 5.0);
        let spinner = match &processed.objects[0].kind {
            ProcessedKind::Spinner(s) => s,
            _ => unreachable!(),
        };
        assert_eq!(
            (spinner.stable_half_spins_required, spinner.total_half_spins_possible),
            (10, 31)
        );
        assert_eq!(super::stable_spinner_tick_score(spinner, 22), 11 * 100 + 4 * 1100);
    }

    #[test]
    fn an_even_gate_displaces_ticks_where_bonuses_land() {
        // 3000ms at od5: required halves = 15, gate = 18 (even), possible =
        // 47. spun past the cap (60 halves, clamped to 47): bonuses at 20,
        // 22, ..., 46 (14), even ticks 2..=46 are 23 minus the 14 the
        // bonuses claimed = 9 -- the exact accounting of
        // osulegacyscoresimulator.cs's loop
        let processed = spinner_map(3000.0, 5.0);
        let spinner = match &processed.objects[0].kind {
            ProcessedKind::Spinner(s) => s,
            _ => unreachable!(),
        };
        assert_eq!(
            (spinner.stable_half_spins_required, spinner.total_half_spins_possible),
            (15, 47)
        );
        assert_eq!(super::stable_spinner_tick_score(spinner, 60), 9 * 100 + 14 * 1100);
    }

    #[test]
    fn the_closed_form_matches_the_simulator_loop_shape() {
        // the reference loop, transcribed from
        // osulegacyscoresimulator.cs:149-155 with the achieved half-spin
        // count in place of totalHalfSpinsPossible as the walk bound
        fn reference(halves: i64, required: i64, possible: i64) -> u64 {
            let mut total = 0u64;
            let gate = required + 3;
            for i in 0..=halves.min(possible) {
                if i > gate && (i - gate) % 2 == 0 {
                    total += 1100;
                } else if i > 1 && i % 2 == 0 {
                    total += 100;
                }
            }
            total
        }

        for od in [0.0f32, 3.3, 5.0, 7.2, 10.0] {
            for duration in [500.0, 1000.0, 2000.0, 3000.0, 7000.0] {
                let processed = spinner_map(duration, od);
                let spinner = match &processed.objects[0].kind {
                    ProcessedKind::Spinner(s) => s,
                    _ => unreachable!(),
                };
                for halves in 0..80i64 {
                    assert_eq!(
                        super::stable_spinner_tick_score(spinner, halves),
                        reference(
                            halves,
                            i64::from(spinner.stable_half_spins_required),
                            i64::from(spinner.total_half_spins_possible),
                        ),
                        "od {od} duration {duration} halves {halves}"
                    );
                }
            }
        }
    }

    #[test]
    fn stable_point_values_match_kinds_on_time_ordered_sliders() {
        use crate::beatmap::stable_points::StablePointKind;
        use crate::simulation::test_support::slider_map;

        // tick rate 2: tick at t=1250, tail point at 1321 -- ordered, so
        // the pointsPassed valuation lands exactly on the kinds
        for (tick_rate, repeats) in [(2.0, 0), (2.0, 1), (1.0, 2)] {
            let beatmap = slider_map(tick_rate, repeats);
            let obj = &beatmap.objects[0];
            let ProcessedKind::Slider(slider) = &obj.kind else { unreachable!() };
            let values = stable_slider_point_values(obj.start_time, slider);
            let n = slider.stable_points.len();
            let by_kind: Vec<u64> = slider
                .stable_points
                .iter()
                .enumerate()
                .map(|(i, p)| match p.kind {
                    // the machine re-kinds the final point to the tail
                    _ if i == n - 1 => 30,
                    StablePointKind::Tick => 10,
                    _ => 30,
                })
                .collect();
            assert_eq!(values, by_kind, "tick rate {tick_rate}, {repeats} repeats");
        }
    }

    #[test]
    fn a_tail_adjacent_tick_is_valued_as_the_slider_end() {
        use crate::simulation::test_support::slider_map;

        // tick rate 1.5: the one tick lands at t=1333, AFTER the tail
        // point's repositioned 1321 -- the walk holds the tail back behind
        // the tick, both fall due together, and the tick is judged with
        // every point due: stable values it 30, not 10
        let beatmap = slider_map(1.5, 0);
        let obj = &beatmap.objects[0];
        let ProcessedKind::Slider(slider) = &obj.kind else { unreachable!() };
        assert_eq!(stable_slider_point_values(obj.start_time, slider), vec![30, 30]);
    }

    #[test]
    fn a_reordered_tail_slider_banks_stables_extra_twenty() {
        use crate::replay::frames::Buttons;
        use crate::simulation::simulate;
        use crate::simulation::test_support::{frame, slider_map, wrap};

        // the same shape end to end: a tracked play through the tick-rate
        // 1.5 slider. head 30 + tick 30 (promoted from 10) + tail 30 +
        // aggregate 300 with combo 3 before it (2 * 12 * 4 = 96) = 486 --
        // exactly 20 more than the kind-valued fold's 466, which is the
        // whole flat -20-per-map header class of parity issue 15
        let beatmap = slider_map(1.5, 0);
        let end_t = beatmap.objects[0].end_time;
        let frames = wrap(vec![
            frame(1000.0, 100.0, 100.0, Buttons::LEFT_1),
            frame(1250.0, 170.0, 100.0, Buttons::LEFT_1),
            frame(end_t, 200.0, 100.0, Buttons::LEFT_1),
            frame(end_t + 50.0, 200.0, 100.0, 0),
        ]);
        let timeline = simulate(&beatmap, &frames).unwrap();
        assert_eq!(
            (timeline.totals.count_300, timeline.totals.max_combo),
            (1, 3),
            "precondition: the play full-combos the slider"
        );
        assert_eq!(total_score(&timeline, &beatmap, 4, 1.0), 486);
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
        assert_eq!(total_score(&timeline, &circles_map(3), 4, 0.5), 924);
        // and the NoMod fold is byte-identical to multiplier 1.0
        assert_eq!(total_score(&timeline, &circles_map(3), 4, 1.0), 948);
    }
}
