//! spinner rotation accounting: ports spinnerrotationtracker.cs (angle and
//! delta), spinnerspinhistory.cs (spin completion, forward path only -- the
//! simulator never rewinds), and drawablespinner.cs (presentation ticks).
//! The final grade and score use stable's disc half-turn count (danser-go
//! @ 8331b0ff, rulesets/osu/spinner.go), not lazer's cursor completion.
//! Sampling per the module conventions (standing decision 6):
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
    /// stable's own scoring physics, running beside the lazer mechanics
    pub stable: StableSpinState,
}

/// stable's spinner disc physics, the model its live tick scoring counted:
/// per replay frame, a theoretical angular velocity is read off the raw
/// cursor angle, the disc velocity accelerates toward it under a
/// duration-dependent acceleration cap and a hard 0.05 rad/ms clamp, and
/// the disc's |rotation| accumulates in half-turns through a float32
/// counter. the half-spin count feeds the achieved scorev1 fold
/// (score::scorev1); the lazer-side spin/bonus mechanics above are
/// untouched -- docs/adr/0001's split: mechanics follow lazer, end-value
/// scoring follows stable.
///
/// ported from the stable behaviour as reproduced by danser-go's osu!
/// ruleset (app/rulesets/osu/spinner.go, processStable -- the
/// community-verified port of stable's disc), quirks preserved:
///
/// - on a regular frame cadence (smoothed variance <= 1000/60 * 1.04) the
///   theoretical velocity divides by the fixed 1000/60 frame time, not the
///   actual frame delta;
/// - a zero angle delta decays the theoretical velocity to a third once,
///   then to zero;
/// - an unpressed frame zeroes the angle delta (the disc coasts down under
///   the acceleration cap rather than stopping);
/// - the half-turn counter is a float32 and the scoring count increments at
///   most once per frame, even when a long frame gap crosses two half-turn
///   boundaries;
/// - only frames strictly inside (start_time, end_time) are processed
#[derive(Debug)]
pub(crate) struct StableSpinState {
    last_angle: f64,
    updated_before: bool,
    theoretical_velocity: f64,
    current_velocity: f64,
    frame_variance: f64,
    zero_count: u32,
    rotation_count_f: f32,
    last_rotation_count: i64,
    pub scoring_rotation_count: i64,
}

impl Default for StableSpinState {
    fn default() -> Self {
        StableSpinState {
            last_angle: 0.0,
            updated_before: false,
            theoretical_velocity: 0.0,
            current_velocity: 0.0,
            frame_variance: STABLE_FRAME_TIME,
            zero_count: 0,
            rotation_count_f: 0.0,
            last_rotation_count: 0,
            scoring_rotation_count: 0,
        }
    }
}

/// stable's assumed frame time (one 60fps frame, in ms)
const STABLE_FRAME_TIME: f64 = 1000.0 / 60.0;
/// the disc's hard velocity clamp, radians per ms (477 rpm)
const STABLE_VELOCITY_CAP: f64 = 0.05;

impl SpinnerState {
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

/// advances every in-window spinner's stable disc physics for one replay
/// frame (see [`StableSpinState`]). called at phase 1 of frame instants,
/// beside the lazer-mechanics segment sweep
pub(crate) fn process_stable_scoring_frame(ctx: &mut Ctx<'_>, frame_index: usize) {
    let frame = ctx.frames[frame_index];
    let time = frame.time;
    // stable's timeDiff is the previous replay frame regardless of the
    // spinner window; its first-frame fallback is one 60fps frame
    let time_diff = if frame_index == 0 {
        STABLE_FRAME_TIME
    } else {
        time - ctx.frames[frame_index - 1].time
    };
    let held = frame.buttons.left() || frame.buttons.right();

    advance_first_active(ctx);
    for i in ctx.first_active_spinner..ctx.spinner_indices.len() {
        let index = ctx.spinner_indices[i];
        ctx.charge_sweep_step();
        let obj = &ctx.beatmap.objects[index];
        if obj.start_time >= time {
            break;
        }
        // strictly inside the window, both ends
        if time >= obj.end_time {
            continue;
        }
        let (duration, position) = (obj.end_time - obj.start_time, obj.position);
        let state = match &mut ctx.states[index] {
            ObjectState::Spinner(s) => &mut s.stable,
            _ => unreachable!("spinner_indices only holds spinner objects"),
        };
        stable_scoring_step(state, frame.pos, position, duration, time_diff, held);
    }
}

/// one frame of the stable disc: danser-go spinner.go processStable,
/// NoMod path (no rate modification, no relax/spun-out branches)
fn stable_scoring_step(
    state: &mut StableSpinState,
    cursor: crate::math::Vec2,
    centre: crate::math::Vec2,
    duration: f64,
    time_diff: f64,
    held: bool,
) {
    // 0.00008 + max(0, (5000 - duration) / 1000 / 2000), rad/ms^2 -- short
    // spinners spin up faster
    let max_acceleration = 0.00008 + ((5000.0 - duration) / 1000.0 / 2000.0).max(0.0);
    let max_accel_this_frame = max_acceleration * time_diff;

    if state.theoretical_velocity > state.current_velocity {
        state.current_velocity +=
            (state.theoretical_velocity - state.current_velocity).min(max_accel_this_frame);
    } else {
        state.current_velocity +=
            (state.theoretical_velocity - state.current_velocity).max(-max_accel_this_frame);
    }
    state.current_velocity = state
        .current_velocity
        .clamp(-STABLE_VELOCITY_CAP, STABLE_VELOCITY_CAP);

    // danser's AngleR: atan2(dy, dx) on the raw frame position
    let mouse_angle = f64::from(cursor.y - centre.y).atan2(f64::from(cursor.x - centre.x));

    if !state.updated_before {
        state.last_angle = mouse_angle;
        state.updated_before = true;
    }

    let mut angle_diff = mouse_angle - state.last_angle;
    if mouse_angle - state.last_angle < -std::f64::consts::PI {
        angle_diff = 2.0 * std::f64::consts::PI + mouse_angle - state.last_angle;
    } else if state.last_angle - mouse_angle < -std::f64::consts::PI {
        angle_diff = -2.0 * std::f64::consts::PI - state.last_angle + mouse_angle;
    }

    let decay = 0.999f64.powf(time_diff);
    state.frame_variance = decay * state.frame_variance + (1.0 - decay) * time_diff;

    if angle_diff == 0.0 {
        state.zero_count += 1;
        if state.zero_count < 2 {
            state.theoretical_velocity /= 3.0;
        } else {
            state.theoretical_velocity = 0.0;
        }
    } else {
        state.zero_count = 0;
        // an unpressed frame contributes no cursor motion; the strict
        // window test already happened at the call site, so the time
        // clauses of danser's condition are always false here
        if !held {
            angle_diff = 0.0;
        }
        if angle_diff.abs() < std::f64::consts::PI {
            if state.frame_variance > STABLE_FRAME_TIME * 1.04 {
                state.theoretical_velocity = if time_diff > 0.0 {
                    angle_diff / time_diff
                } else {
                    0.0
                };
            } else {
                state.theoretical_velocity = angle_diff / STABLE_FRAME_TIME;
            }
        } else {
            state.theoretical_velocity = 0.0;
        }
    }

    state.last_angle = mouse_angle;

    let rotation_addition = state.current_velocity * time_diff;
    // the float32 counter and the f32 cast of the addition are stable's own
    // precision, kept bit-faithful
    state.rotation_count_f += ((f64::from(rotation_addition as f32)).abs() / std::f64::consts::PI) as f32;

    let rotation_count = state.rotation_count_f as i64;
    if rotation_count != state.last_rotation_count {
        // at most one scoring increment per frame, even when a long gap
        // crosses two half-turn boundaries -- stable's own accounting
        state.scoring_rotation_count += 1;
        state.last_rotation_count = rotation_count;
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

/// danser-go @ 8331b0ff, rulesets/osu/spinner.go:371-377,427-449:
/// post-20190510 stable grades the disc's scored HALF-turns. Deliberately
/// differs from lazer's cursor-rotation completion fractions: the same
/// cursor can clear lazer's required spins before stable's accelerating
/// disc earns a great. The spin/bonus presentation events still follow
/// lazer; only this aggregate feeds the grade, combo and section tally.
/// Pre-May-2019 grading needs a replay-version rules profile (TODO.md).
fn stable_final_grade(scored_halves: i64, required_halves: i32) -> HitGrade {
    // Widen before +/-1: crafted difficulty/duration can saturate the
    // processed requirement to either i32 bound.
    let required = i64::from(required_halves);
    if required == 0 || scored_halves > required {
        HitGrade::Great
    } else if scored_halves >= required - 1 {
        HitGrade::Ok
    } else if scored_halves >= required / 4 {
        HitGrade::Meh
    } else {
        HitGrade::Miss
    }
}

/// Finish the presentation rotation and judge stable's disc at the first
/// update at or past the spinner end (danser spinner.go UpdatePostFor).
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
    let grade = stable_final_grade(
        state.stable.scoring_rotation_count,
        spinner.stable_half_spins_required,
    );
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
    fn stable_grades_use_integer_half_spin_thresholds() {
        use HitGrade::{Great, Meh, Miss, Ok};
        // Reference: danser spinner.go getRequirement{Great,Ok,Meh}.
        // Aenbharr's three-half-turn requirement is the real-play repro:
        // two scored halves are Ok, three are still Ok, four are Great.
        for (scored, required, expected) in [
            (0, 0, Great),
            (0, 3, Meh),
            (1, 3, Meh),
            (2, 3, Ok),
            (3, 3, Ok),
            (4, 3, Great),
            (1, 10, Miss),
            (2, 10, Meh),
            (8, 10, Meh),
            (9, 10, Ok),
            (10, 10, Ok),
            (11, 10, Great),
            (i64::from(i32::MAX), i32::MAX, Ok),
            (i64::from(i32::MAX) + 1, i32::MAX, Great),
            (0, i32::MIN, Great),
        ] {
            assert_eq!(
                super::stable_final_grade(scored, required),
                expected,
                "{scored} scored halves, {required} required"
            );
        }
    }

    #[test]
    fn cursor_spins_do_not_determine_the_stable_final_grade() {
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
        // danser @ 8331b0ff judges this input Hit100: its disc accelerates
        // and caps velocity, while lazer's cursor-spin counter clears five
        // revolutions. Verified with the synthetic oracle (final-pass
        // report); this was Great before the stable grade fix.
        assert_eq!(final_event.kind, JudgementKind::SpinnerFinal(HitGrade::Ok));
        // stable resolves at update times: no frame lands between the
        // spinner's end (3000) and wrap's trailing frame, so the final
        // result fires there -- finalize's own flush clamps the rotation
        // segment at end_time, so the late landing loses nothing
        assert_eq!(final_event.time, 100_000.0);
        assert_eq!(timeline.totals.count_100, 1);
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
            JudgementKind::SpinnerFinal(HitGrade::Miss),
            "presentation's flushed fifth spin does not advance stable's disc (danser: Miss)"
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
    fn direction_reversal_accumulates_disc_rotation_but_no_lazer_spins() {
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
            // Stable sums absolute disc rotation; danser grades this
            // oscillating input Hit50 even though no lazer spin completes.
            JudgementKind::SpinnerFinal(HitGrade::Meh)
        );
    }

    #[test]
    fn partial_cursor_progress_uses_the_disc_grade() {
        // These cursor paths reach 95% / 82.5% of lazer's five-spin
        // requirement. Danser grades BOTH Hit50 from the slower disc;
        // the first was incorrectly Ok under the old completion fractions.
        let beatmap = spinner_map(2000.0, 5.0);
        let timeline = simulate(&beatmap, &wrap(spin_frames(1000.0, 4.7, 16, Buttons::LEFT_1))).unwrap();
        assert_eq!(
            timeline.events.last().unwrap().kind,
            JudgementKind::SpinnerFinal(HitGrade::Meh)
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
    fn sustained_rotation_earns_a_stable_great() {
        let beatmap = spinner_map(2000.0, 5.0);
        let mut frames = spin_frames(1000.0, 8.0, 8, Buttons::LEFT_1);
        // 375rpm over 1280ms gives the disc time to accelerate; the
        // otherwise identical 750rpm / 640ms input above only earns Ok.
        // Both grades were checked through danser's unmodified ruleset.
        for f in &mut frames {
            f.time = 1000.0 + (f.time - 1000.0) * 2.0;
        }
        let timeline = simulate(&beatmap, &wrap(frames)).unwrap();
        assert_eq!(
            timeline.events.last().unwrap().kind,
            JudgementKind::SpinnerFinal(HitGrade::Great)
        );
        assert_eq!(timeline.totals.count_300, 1);
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
