//! spinner rotation accounting: ports spinnerrotationtracker.cs (angle and
//! delta), spinnerspinhistory.cs (spin completion, forward path only -- the
//! simulator never rewinds), and drawablespinner.cs (tick awarding and the
//! final result). sampling per the module conventions (standing decision 6):
//! cursor-dependent spinner state samples at replay frame times
//! (`process_frame_segment`, one delta per frame-to-frame segment) and at
//! judgement instants (`finalize`'s trailing flush, below), each clipped to
//! the spinnable window
//!
//! # the per-segment sweep equivalence
//!
//! lazer's `SpinnerRotationTracker` samples every render frame -- far more
//! often than replay frames arrive -- and sums each render's own delta,
//! individually normalised into `(-180, 180]` (spinnerspinhistory.cs:69-77).
//! this simulator has no render loop, so instead of summing many small
//! per-render deltas it takes a single delta spanning the whole
//! frame-to-frame (or frame-to-deadline) segment, from the two clipped
//! boundary angles directly. those two computations agree whenever the
//! segment's cursor motion is linear -- which interpolation between two
//! samples guarantees -- because a point moving at constant velocity has a
//! polar angle, about any centre it never passes through, that sweeps
//! monotonically for the whole segment (the sign of its angular velocity is
//! fixed by the segment's endpoints, never flipping mid-segment). under a
//! monotonic sweep, subdividing the segment into arbitrarily many smaller
//! pieces and wrap-summing each one telescopes back down to the single
//! un-subdivided delta, *provided* the whole segment's total sweep stays
//! under 180 degrees -- past that bound a single wraparound correction can
//! no longer tell how many multiples of 360 separate the endpoints, for the
//! whole segment or for any sub-piece of it. that is exactly the same bound
//! lazer's own per-render summation leans on (no single render is assumed to
//! sweep a half turn either), so one delta per segment reproduces lazer's
//! summed-per-render total under the same physical assumption lazer itself
//! makes, not a weaker one

use crate::beatmap::difficulty::HitGrade;
use crate::beatmap::{ProcessedKind, ProcessedSpinner};
use crate::replay::frames::ReplayFrame;
use crate::replay::interpolation::cursor_state_at;
use crate::simulation::score::JudgementKind;
use crate::simulation::{Ctx, ObjectState};

#[derive(Debug, Default)]
pub(crate) struct SpinnerState {
    total_accumulated: f32,
    total_at_last_completion: f32,
    current_spin_max: f32,
    pub completed_spins: u32,
    pub finished: bool,
}

impl SpinnerState {
    /// spinnerspinhistory.cs:29
    pub fn total_rotation(&self) -> f32 {
        360.0 * self.completed_spins as f32 + self.current_spin_max
    }

    fn current_spin_rotation(&self) -> f32 {
        self.total_accumulated - self.total_at_last_completion
    }

    /// spinnerspinhistory.cs:64-101, forward branch; returns spins completed
    /// by this delta
    fn report_delta(&mut self, delta: f32) -> u32 {
        if delta == 0.0 {
            return 0;
        }
        self.total_accumulated += delta;
        self.current_spin_max = self.current_spin_max.max(self.current_spin_rotation().abs());
        let mut completed = 0;
        while self.current_spin_max >= 360.0 {
            let direction = if self.current_spin_rotation() >= 0.0 {
                1.0
            } else {
                -1.0
            };
            self.completed_spins += 1;
            completed += 1;
            self.total_at_last_completion += direction * 360.0;
            self.current_spin_max = self.current_spin_rotation().abs();
        }
        completed
    }
}

/// spinnerrotationtracker.cs:69 -- x leads in the atan2, and the result is
/// negated after converting to degrees
fn angle_at(pos: crate::math::Vec2, centre: crate::math::Vec2) -> f32 {
    -f32::atan2(pos.x - centre.x, pos.y - centre.y).to_degrees()
}

/// applies one segment's rotation delta to a single spinner and awards any
/// spins it completes, honouring the spinnable-window clip and the
/// held-button gate. shared by the frame-to-frame sweep
/// (`process_frame_segment`) and `finalize`'s trailing-segment flush -- the
/// two sampling points standing decision 6 names
fn accumulate_segment(ctx: &mut Ctx<'_>, index: usize, seg_start: f64, seg_end: f64, held: bool) {
    let obj = &ctx.beatmap.objects[index];
    // isspinnabletime: start <= t < end
    let s0 = seg_start.max(obj.start_time);
    let s1 = seg_end.min(obj.end_time);
    if s1 <= s0 {
        return;
    }
    let p0 = cursor_state_at(ctx.frames, s0).expect("frames nonempty").pos;
    let p1 = cursor_state_at(ctx.frames, s1).expect("frames nonempty").pos;
    let centre = obj.position;
    let mut delta = angle_at(p1, centre) - angle_at(p0, centre);
    if delta > 180.0 {
        delta -= 360.0;
    }
    if delta < -180.0 {
        delta += 360.0;
    }
    if !held {
        return; // lastangle advances implicitly: the next segment samples fresh
    }
    let spinner = match &ctx.beatmap.objects[index].kind {
        ProcessedKind::Spinner(s) => s,
        _ => unreachable!("accumulate_segment is only called for spinner objects"),
    };
    let completed = match &mut ctx.states[index] {
        ObjectState::Spinner(state) => state.report_delta(delta),
        _ => unreachable!("index was already matched as a spinner object above"),
    };
    let completed_spins_after = match &ctx.states[index] {
        ObjectState::Spinner(state) => state.completed_spins,
        _ => unreachable!("index was already matched as a spinner object above"),
    };
    // drawablespinner.cs:335-365 -- sequential tick awarding: each newly
    // completed spin's own ordinal decides its tick kind. completed_spins_after
    // is the total once every spin in this delta has already been counted, so
    // `base` recovers the ordinal the first of them held; reading
    // completed_spins_after directly inside the loop (as opposed to base + k
    // + 1) would be loop-invariant and award every spin in this delta the
    // same (final) ordinal instead of its own
    let base = completed_spins_after - completed;
    for k in 0..completed {
        let kind = spin_kind(spinner, base + k + 1);
        if let Some(kind) = kind {
            ctx.emit(s1, index, kind);
        }
    }
}

/// advances ctx.first_active_spinner past ctx.spinner_indices' settled
/// prefix. safe because `finished` never reverts to false once true, so the
/// cursor only ever moves forward, mirroring slider::advance_first_active
fn advance_first_active(ctx: &mut Ctx<'_>) {
    while ctx.first_active_spinner < ctx.spinner_indices.len() {
        let index = ctx.spinner_indices[ctx.first_active_spinner];
        let finished = match &ctx.states[index] {
            ObjectState::Spinner(s) => s.finished,
            _ => unreachable!("spinner_indices only holds spinner objects"),
        };
        if !finished {
            break;
        }
        ctx.first_active_spinner += 1;
    }
}

/// processes the segment ending at frame `frame_index` for every active
/// spinner. called at phase 1 of frame instants
pub(crate) fn process_frame_segment(ctx: &mut Ctx<'_>, frame_index: usize) {
    if frame_index == 0 {
        return;
    }
    let seg_start = ctx.frames[frame_index - 1].time;
    let seg_end = ctx.frames[frame_index].time;
    let held = {
        let b = ctx.frames[frame_index - 1].buttons;
        b.left() || b.right()
    };

    // walk the precomputed spinner list from its finished prefix, breaking
    // at the first spinner not yet spinnable by this segment's end -- object
    // order is start-time order, so nothing later overlaps the segment
    // either. nothing bounds a crafted map's spinner count, so an
    // unconditional full-list walk (let alone the clone this used to do)
    // would multiply against every replay frame
    advance_first_active(ctx);
    for i in ctx.first_active_spinner..ctx.spinner_indices.len() {
        let index = ctx.spinner_indices[i];
        // charged against the sweep-step budget: overlapping unfinished
        // spinners are real per-frame work here (as they are in lazer), and
        // nothing else bounds a crafted overlapping-spinners-times-frames
        // product
        ctx.charge_sweep_step();
        if ctx.beatmap.objects[index].start_time >= seg_end {
            break;
        }
        if matches!(&ctx.states[index], ObjectState::Spinner(s) if s.finished) {
            continue;
        }
        accumulate_segment(ctx, index, seg_start, seg_end, held);
    }
}

/// the last replay frame at or before `time`, with its held-button gate --
/// the same (boundary time, held) pair `process_frame_segment` would use for
/// a segment's earlier edge. used by `finalize` to flush the trailing
/// partial segment up to a judgement instant that isn't itself a frame
fn last_frame_gate(frames: &[ReplayFrame], time: f64) -> Option<(f64, bool)> {
    let idx = frames.partition_point(|f| f.time <= time);
    if idx == 0 {
        return None;
    }
    let f = &frames[idx - 1];
    Some((f.time, f.buttons.left() || f.buttons.right()))
}

/// the n-th completed spin's award (1-based)
fn spin_kind(spinner: &ProcessedSpinner, n: u32) -> Option<JudgementKind> {
    let for_bonus = spinner.spins_required_for_bonus() as u32;
    // saturating rather than an ordinary `+`: for_bonus can already sit near
    // u32::MAX (spins_required_for_bonus reinterprets a negative i32 as a huge
    // u32 for an out-of-range spinner), and every in-range map keeps the sum
    // far below u32::MAX, so saturating never changes ordinary behaviour
    let total = for_bonus.saturating_add(spinner.max_bonus_spins as u32);
    if n <= for_bonus {
        Some(JudgementKind::SpinnerSpin)
    } else if n <= total {
        Some(JudgementKind::SpinnerBonus)
    } else {
        None
    }
}

/// drawablespinner.cs:232-241 -- `Progress` is a c# float: totalrotation,
/// the 360 divisor, and spinsrequired all stay in single precision, and only
/// the grade comparisons (`> .9`, `> .75`) widen the result to double.
/// reproducing the f32 rounding matters exactly at those boundaries: 972
/// degrees over 3 required spins rounds to just above 0.9 in f32 (ok) but to
/// exactly 0.9 in f64 (meh)
fn completion_progress(total_rotation: f32, spins_required: i32) -> f64 {
    f64::from((total_rotation / 360.0 / spins_required as f32).clamp(0.0, 1.0))
}

/// the end-of-spinner deadline: drawablespinner.cs:247-273
pub(crate) fn finalize(ctx: &mut Ctx<'_>, index: usize, time: f64) {
    if matches!(&ctx.states[index], ObjectState::Spinner(s) if s.finished) {
        return;
    }
    // frame instants sort before deadlines at an equal timestamp, so a frame
    // landing exactly on `time` already fed accumulate_segment via
    // process_frame_segment; when no frame lands exactly there, the segment
    // between the last one and `time` would otherwise never be swept at
    // all -- flush it here before computing progress (standing decision 6's
    // second sampling point). a frame that does land exactly on `time`
    // degenerates this into a zero-width, no-op segment (s1 <= s0 inside
    // accumulate_segment), so this is safe to run unconditionally
    if let Some((last_time, held)) = last_frame_gate(ctx.frames, time) {
        accumulate_segment(ctx, index, last_time, time, held);
    }

    let spinner = match &ctx.beatmap.objects[index].kind {
        ProcessedKind::Spinner(s) => s,
        _ => unreachable!("finalize is only called for spinner objects"),
    };
    let state = match &mut ctx.states[index] {
        ObjectState::Spinner(s) => s,
        _ => unreachable!("finalize is only called for spinner states"),
    };
    state.finished = true;
    let progress = if spinner.spins_required == 0 {
        1.0
    } else {
        completion_progress(state.total_rotation(), spinner.spins_required)
    };
    let grade = if progress >= 1.0 {
        HitGrade::Great
    } else if progress > 0.9 {
        HitGrade::Ok
    } else if progress > 0.75 {
        HitGrade::Meh
    } else {
        HitGrade::Miss
    };
    ctx.emit(time, index, JudgementKind::SpinnerFinal(grade));
}

#[cfg(test)]
mod tests {
    use crate::beatmap::difficulty::HitGrade;
    use crate::replay::frames::Buttons;
    use crate::simulation::score::JudgementKind;
    use crate::simulation::simulate;
    use crate::simulation::test_support::{frame, spinner_map, wrap};

    // spinner_map(duration, od) builds a map whose only object is a spinner
    // starting at 1000. helper: circular frames around (256, 192) at radius
    // 100, `steps_per_rev` frames per revolution, 10ms apart, buttons held
    fn spin_frames(
        start: f64,
        revolutions: f64,
        steps_per_rev: u32,
        raw: u32,
    ) -> Vec<crate::replay::frames::ReplayFrame> {
        let total_steps = (revolutions * steps_per_rev as f64).ceil() as u32;
        (0..=total_steps)
            .map(|i| {
                let theta = i as f64 * std::f64::consts::TAU / steps_per_rev as f64;
                frame(
                    start + i as f64 * 10.0,
                    256.0 + 100.0 * theta.cos() as f32,
                    192.0 + 100.0 * theta.sin() as f32,
                    raw,
                )
            })
            .collect()
    }

    #[test]
    fn completion_progress_keeps_lazer_float_rounding_at_grade_boundaries() {
        // 972 degrees over 3 required spins: in f32, 972/360 rounds up to
        // ~2.70000005 and the division by 3 lands at ~0.90000004, which is
        // > 0.9 once widened (lazer awards ok). the same expression in f64
        // rounds to exactly 0.9 and would fall through to meh
        let progress = super::completion_progress(972.0, 3);
        assert!(
            progress > 0.9,
            "f32 arithmetic must clear the ok boundary, got {progress}"
        );
        let f64_progress = 972.0f64 / 360.0 / 3.0;
        assert!(
            f64_progress <= 0.9,
            "f64 arithmetic would sit on the boundary, got {f64_progress}"
        );
    }

    #[test]
    fn enough_spins_complete_the_spinner_with_a_great() {
        // od 5, duration 2000 -> spins_required 5, bonus gap 2, max bonus 5
        let beatmap = spinner_map(2000.0, 5.0);
        // 8 revolutions in 45-degree steps while holding left
        let timeline = simulate(&beatmap, &wrap(spin_frames(1000.0, 8.0, 8, Buttons::LEFT_1))).unwrap();
        let spins = timeline
            .events
            .iter()
            .filter(|e| e.kind == JudgementKind::SpinnerSpin)
            .count();
        let bonus = timeline
            .events
            .iter()
            .filter(|e| e.kind == JudgementKind::SpinnerBonus)
            .count();
        // 8 full spins minus interpolation slack: the first 7 complete within
        // the window (last frames run past end_time). required+gap = 7 spins
        // classified as SpinnerSpin, the rest as bonus
        assert!(spins >= 5, "at least the required spins completed, got {spins}");
        assert_eq!(spins.min(7), spins, "spin events cap at required + 2");
        let final_event = timeline.events.last().unwrap();
        assert_eq!(final_event.kind, JudgementKind::SpinnerFinal(HitGrade::Great));
        assert_eq!(final_event.time, 3000.0);
        assert_eq!(timeline.totals.count_300, 1);
        // combo: only the final result increments
        assert_eq!(timeline.totals.max_combo, 1);
        let _ = bonus;
    }

    #[test]
    fn finalize_flushes_the_trailing_segment_before_end_time() {
        // frame instants sort before deadlines at an equal timestamp, so a
        // frame landing exactly on end_time already feeds
        // process_frame_segment; here nothing lands exactly on it, so the
        // motion between the last frame before end_time and end_time itself
        // would silently vanish without finalize's own flush
        let beatmap = spinner_map(2000.0, 5.0); // spins_required 5, end_time 3000
        fn pos_at_degrees(theta_deg: f64) -> (f32, f32) {
            let theta = theta_deg.to_radians();
            (
                256.0 + 100.0 * theta.cos() as f32,
                192.0 + 100.0 * theta.sin() as f32,
            )
        }
        // 12 held steps (150 degrees each, then a final 140) accumulate
        // exactly 1790 degrees of rotation by t=1120 -- 4 spins complete
        // along the way, landing just under the 1800-degree (5-spin) great
        // threshold, all from exact frame-to-frame deltas (no interpolation
        // involved, so the arithmetic is exact)
        let steps_deg = [
            0.0, 150.0, 300.0, 450.0, 600.0, 750.0, 900.0, 1050.0, 1200.0, 1350.0, 1500.0, 1650.0, 1790.0,
        ];
        let mut frames: Vec<_> = steps_deg
            .iter()
            .enumerate()
            .map(|(i, &deg)| {
                let (x, y) = pos_at_degrees(deg);
                frame(1000.0 + i as f64 * 10.0, x, y, Buttons::LEFT_1)
            })
            .collect();
        // nothing else moves the cursor until a frame just past end_time
        // (3000) resumes the same held rotation from the last real frame at
        // t=1120 -- straddling end_time with no frame exactly on it
        let (x, y) = pos_at_degrees(1810.0);
        frames.push(frame(3010.0, x, y, Buttons::LEFT_1));

        let timeline = simulate(&beatmap, &wrap(frames)).unwrap();
        let spins = timeline
            .events
            .iter()
            .filter(|e| e.kind == JudgementKind::SpinnerSpin)
            .count();
        assert_eq!(
            spins, 5,
            "the flush must complete the fifth spin before the deadline"
        );
        assert_eq!(
            timeline.events.last().unwrap().kind,
            JudgementKind::SpinnerFinal(HitGrade::Great),
            "the flushed rotation must cross the great threshold"
        );
    }

    #[test]
    fn unpressed_motion_accumulates_nothing() {
        let beatmap = spinner_map(2000.0, 5.0);
        let timeline = simulate(&beatmap, &wrap(spin_frames(1000.0, 8.0, 8, 0))).unwrap();
        assert_eq!(timeline.events.len(), 1);
        assert_eq!(
            timeline.events[0].kind,
            JudgementKind::SpinnerFinal(HitGrade::Miss)
        );
        assert_eq!(timeline.totals.count_miss, 1);
    }

    #[test]
    fn direction_reversal_cannot_cheese_spins() {
        // spinnerspinhistory.cs:41-50: swinging +-half turns never reaches a
        // full spin because current_spin_max tracks the absolute extreme
        let beatmap = spinner_map(2000.0, 5.0);
        let mut frames = Vec::new();
        for i in 0..100u32 {
            // oscillate between angle 0 and angle 135 degrees
            let theta = if i % 2 == 0 {
                0.0f64
            } else {
                3.0 * std::f64::consts::FRAC_PI_4
            };
            frames.push(frame(
                1000.0 + i as f64 * 15.0,
                256.0 + 100.0 * theta.cos() as f32,
                192.0 + 100.0 * theta.sin() as f32,
                Buttons::LEFT_1,
            ));
        }
        let timeline = simulate(&beatmap, &wrap(frames)).unwrap();
        assert!(timeline
            .events
            .iter()
            .all(|e| e.kind != JudgementKind::SpinnerSpin));
        assert_eq!(
            timeline.events.last().unwrap().kind,
            JudgementKind::SpinnerFinal(HitGrade::Miss)
        );
    }

    #[test]
    fn partial_progress_grades_ok_and_meh() {
        // spins_required 5 (1800 degrees): 4.7 revolutions at steps_per_rev
        // 16 rounds up to 76 steps of 22.5 degrees = 1710 degrees = 0.95 ->
        // ok; 4.1 revolutions rounds up to 66 steps = 1485 degrees = 0.825 ->
        // meh
        let beatmap = spinner_map(2000.0, 5.0);
        let timeline = simulate(&beatmap, &wrap(spin_frames(1000.0, 4.7, 16, Buttons::LEFT_1))).unwrap();
        assert_eq!(
            timeline.events.last().unwrap().kind,
            JudgementKind::SpinnerFinal(HitGrade::Ok)
        );

        let timeline = simulate(&beatmap, &wrap(spin_frames(1000.0, 4.1, 16, Buttons::LEFT_1))).unwrap();
        assert_eq!(
            timeline.events.last().unwrap().kind,
            JudgementKind::SpinnerFinal(HitGrade::Meh)
        );
    }

    #[test]
    fn a_zero_requirement_spinner_is_implicitly_great() {
        // drawablespinner.cs:236-239: some spinners are too short to require
        // a full spin; they complete on their own
        let beatmap = spinner_map(100.0, 0.0); // od 0 -> min rps 1.5 -> 0 spins
        let timeline = simulate(&beatmap, &wrap(vec![frame(1000.0, 256.0, 192.0, 0)])).unwrap();
        assert_eq!(
            timeline.events.last().unwrap().kind,
            JudgementKind::SpinnerFinal(HitGrade::Great)
        );
    }

    #[test]
    fn bonus_classification_follows_the_tick_sequence() {
        // od 10, duration 1000 -> required = (int)(3.75 + 1e-4) = 3, bonus
        // gap 2 -> first 5 spins are SpinnerSpin, later ones SpinnerBonus up
        // to max_bonus_spins, then nothing
        let beatmap = spinner_map(1000.0, 10.0);
        let timeline = simulate(&beatmap, &wrap(spin_frames(1000.0, 9.5, 8, Buttons::LEFT_1))).unwrap();
        let mut seen_bonus = false;
        for e in &timeline.events {
            match e.kind {
                JudgementKind::SpinnerSpin => assert!(!seen_bonus, "spin after bonus"),
                JudgementKind::SpinnerBonus => seen_bonus = true,
                _ => {}
            }
        }
    }
}
