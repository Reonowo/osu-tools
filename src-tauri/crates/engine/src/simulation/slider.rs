//! stable's slider machine: head clicks, the frame-sampled tracking state,
//! one-point-per-update nested judgement, and the end aggregate. ports
//! danser-go `Slider` (slider.go) on its stable (non-lazer) path -- the
//! community-verified port of stable's own tracking; reference map and pin
//! in `.scratch/engine-parity-pass/stable-tracking-reference.md`.
//!
//! this replaced the lazer `SliderInputManager` port when the legacy path
//! moved to stable semantics (engine parity pass, issue 05): stable samples
//! tracking once per replay frame with the raw cursor, judges at most one
//! nested point per update at the first frame at-or-past its time, gates a
//! point on the slide having begun at or before that point's time (a late
//! re-entry cannot rescue an already-passed point -- no lazer-style
//! forceful post-head hit), compares the follow radius with f64-promoted
//! f32 arithmetic and STRICT less-than, and folds the whole-slider result
//! from the scored rate with the head counted in

use crate::beatmap::difficulty::HitGrade;
use crate::beatmap::stable_points::StablePointKind;
use crate::beatmap::{ProcessedKind, ProcessedObject, ProcessedSlider};
use crate::math::Vec2;
use crate::simulation::buttons::ActionMask;
use crate::simulation::presses::{can_be_hit_stable, ClickAction};
use crate::simulation::score::JudgementKind;
use crate::simulation::{Ctx, ObjectState};

/// drawablesliderball.cs:19 / slider.go:276-285 -- the follow-circle
/// expansion while sliding
const FOLLOW_AREA: f32 = 2.4;

/// slider.go:282 -- x87 promotion: f32 operands, f64 intermediate, f32
/// result (math87.go). .net framework computed these on the x87 unit, which
/// danser models exactly this way; rust reproduces it bit-for-bit with casts
fn mul87(a: f32, b: f32) -> f32 {
    (f64::from(a) * f64::from(b)) as f32
}

/// vector2f.go:95-100 -- f32 subtraction first, then f64 squares and sum,
/// rounded back to f32
fn dst_sq_87(a: Vec2, b: Vec2) -> f32 {
    let x = f64::from(b.x - a.x);
    let y = f64::from(b.y - a.y);
    (x * x + y * y) as f32
}

/// one scoreable point (tick/repeat/tail), carrying stable's own floored
/// score time from `beatmap::stable_points` (engine parity pass, issue 13 --
/// tick existence, times, and span phase all follow stable's accumulated
/// track walk, not the lazer nested list), with the final point
/// repositioned to `max(start + duration/2, end - 36)` in integer
/// arithmetic (slider.go:99-111)
#[derive(Debug, Clone, Copy)]
pub(crate) struct TickPoint {
    pub time: f64,
    pub kind: StablePointKind,
}

#[derive(Debug)]
pub(crate) struct SliderState {
    /// tick/repeat/tail in judgement order; the head is not a point --
    /// it contributes to the rate via start_result_hit instead
    pub points: Vec<TickPoint>,
    pub down_button: ActionMask,
    pub is_start_hit: bool,
    /// the end aggregate has been judged (danser `isHit`) -- what the note
    /// lock and the tracking gate read
    pub is_hit: bool,
    /// startResult != Miss (danser records the full grade; only this bit is
    /// ever read back)
    pub start_result_hit: bool,
    pub sliding: bool,
    pub slide_start: f64,
    pub scored: u32,
    pub missed: u32,
}

impl SliderState {
    pub fn new(obj_start_time: f64, slider: &ProcessedSlider) -> SliderState {
        // slider.go:99-106 -- danser builds the judgement points as
        // SliderPoint/SliderRepeat only (the generation-side end marker is
        // just another non-reverse point here), then re-kinds the SORTED
        // last one to SliderEnd below. on a pathological slider whose f32
        // tick arithmetic sorts a final-span tick past the end point, the
        // tail semantics follow the list position, not the generator's
        // marker
        let mut points: Vec<TickPoint> = slider
            .stable_points
            .iter()
            .map(|p| TickPoint {
                time: p.time,
                kind: match p.kind {
                    // the repeat keeps its ordinal through the re-kind below:
                    // that ordinal is the node identity a consumer needs, and
                    // it is a property of the generated slider, not of where
                    // the point lands in this list
                    repeat @ StablePointKind::Repeat { .. } => repeat,
                    _ => StablePointKind::Tick,
                },
            })
            .collect();
        // slider.go:108-111 -- the final (time-sorted) point becomes the
        // slider end: repositioned to 36ms before stable's end (never
        // before the midpoint) in truncated integer milliseconds
        if let Some(last) = points.last_mut() {
            let start = obj_start_time as i64;
            let end = slider.stable_end_time as i64;
            // wrapping, not `-`/`+`: the saturating casts let a crafted
            // finite end time sit at i64::MAX against a negative start,
            // where go wraps and a debug-build rust `-` would panic (same
            // posture as ProcessedSpinner::spins_required_for_bonus)
            let duration = end.wrapping_sub(start);
            last.time = start.wrapping_add(duration / 2).max(end.wrapping_sub(36)) as f64;
            last.kind = StablePointKind::Tail;
        }
        SliderState {
            points,
            down_button: ActionMask::NONE,
            is_start_hit: false,
            is_hit: false,
            start_result_hit: false,
            sliding: false,
            slide_start: 0.0,
            scored: 0,
            missed: 0,
        }
    }

    /// drain condition (slider.go:505-517 UpdatePost): a slider leaves the
    /// processed list once both the end aggregate and the head resolved
    pub fn finished(&self) -> bool {
        self.is_hit && self.is_start_hit
    }
}

fn slider_of(obj: &ProcessedObject) -> &ProcessedSlider {
    match &obj.kind {
        ProcessedKind::Slider(s) => s,
        _ => unreachable!("slider fns are only called for slider objects"),
    }
}

fn state_of(states: &mut [crate::simulation::ObjectState], index: usize) -> &mut SliderState {
    match &mut states[index] {
        ObjectState::Slider(s) => s,
        _ => unreachable!("slider fns are only called for slider states"),
    }
}

/// the ball's absolute position at `time`: the engine's f32 curve walk over
/// the folded span progress, stack-adjusted. danser walks stable's
/// int64-timed piecewise score path instead (objects/slider.go:288-309) --
/// the cheapest remaining fidelity lever if sweep residuals point at follow
/// radius boundaries
fn ball_position(obj: &ProcessedObject, slider: &ProcessedSlider, time: f64) -> Vec2 {
    let progress = ((time - obj.start_time) / slider.duration).clamp(0.0, 1.0);
    obj.stacked_position + slider.curve_position_at(progress)
}

/// slider.go:117-184 -- the head's view of the frame's click edges, called
/// from the click walk while `!is_start_hit && !is_hit`
pub(crate) fn try_click_head(ctx: &mut Ctx<'_>, index: usize, time: f64, cursor_pos: Vec2, radius: f32) {
    let obj = &ctx.beatmap.objects[index];
    let in_range = Vec2::distance(cursor_pos, obj.stacked_position) <= radius;
    let action = can_be_hit_stable(ctx, index, time);
    if in_range {
        match action {
            ClickAction::Click => {
                ctx.buttons.consume_one_edge();
                let down_button = ctx.buttons.latch_down_button();
                // truncated delta, as in the circle path (GetResultForDelta)
                let delta = ((time - obj.start_time).abs() as i64) as f64;
                let grade = ctx.beatmap.windows.result_for(delta).unwrap_or(HitGrade::Miss);
                let hit = grade != HitGrade::Miss;
                let state = state_of(&mut ctx.states, index);
                state.down_button = down_button;
                state.start_result_hit = hit;
                state.is_start_hit = true;
                ctx.emit(time, index, JudgementKind::SliderHead { hit });
            }
            ClickAction::Shake | ClickAction::Ignored => ctx.buttons.consume_both_edges(),
        }
    }
}

/// slider.go:222-313 UpdateFor on the stable path: the button-acceptance
/// machine, the x87 follow-radius test, and the one-point tick walk. the
/// caller enforces `time >= start_time && !is_hit` and stable's
/// one-unfinished-slider gate (ruleset.go:444-472)
pub(crate) fn update_for(ctx: &mut Ctx<'_>, index: usize, time: f64, cursor_pos: Vec2) {
    let obj = &ctx.beatmap.objects[index];
    let slider = slider_of(obj);
    let ball = ball_position(obj, slider, time);
    let radius = ctx.stable_radius;

    // the acceptance machine (slider.go:245-269): which held buttons may
    // carry the slide, with the swap rule that lets a fresh button replace
    // the one the head was hit with
    let m = &ctx.buttons;
    let (game_down, mouse_down, last_button, last_button2) =
        (m.game_down_state, m.mouse_down_button, m.last_button, m.last_button2);
    let latch = m.latch_down_button();

    let state = state_of(&mut ctx.states, index);
    let swap_acceptable = game_down && !(last_button == ActionMask::BOTH && last_button2 == mouse_down);
    let mut mouse_down_acceptable = false;
    if game_down {
        if state.down_button == ActionMask::NONE || (mouse_down != ActionMask::BOTH && swap_acceptable) {
            state.down_button = latch;
            mouse_down_acceptable = true;
        } else if mouse_down.intersects(state.down_button) {
            mouse_down_acceptable = true;
        }
    } else {
        state.down_button = ActionMask::NONE;
    }
    mouse_down_acceptable |= swap_acceptable;

    // slider.go:280-286 -- the x87 radius comparison, STRICT less-than
    let radius_needed = if state.sliding {
        mul87(radius, FOLLOW_AREA)
    } else {
        radius
    };
    let allowable =
        mouse_down_acceptable && dst_sq_87(cursor_pos, ball) < mul87(radius_needed, radius_needed);

    if allowable && !state.sliding {
        state.sliding = true;
        state.slide_start = time;
    }

    process_ticks_stable(ctx, index, time, allowable);

    // slider.go:303-309 -- leaving the follow area kills the slide only
    // while points remain
    let state = state_of(&mut ctx.states, index);
    if !allowable && state.sliding && state.scored + state.missed < state.points.len() as u32 {
        state.sliding = false;
    }
}

/// slider.go:315-355 -- the point walk: each due point scored iff the
/// follow state allows it and the slide began at or before the point's
/// time.
///
/// deliberate divergence from the danser reference: danser judges at most
/// ONE point per update (`if`, not `while` -- stable's own Update scores
/// one point per game tick), which at live render rates never matters but
/// at replay frame rates starves points denser than the frame cadence --
/// the starved point loses its flat scorev1 value and its combo increment,
/// and the header this engine is oracled against (docs/adr/0001) was
/// written by LIVE stable, where updates were dense enough that no point
/// ever starved. judging every due point per update models the live
/// client the header recorded; the frame-sampled `allowable` and the
/// slide_start gate -- the parts that carry the real divergence classes --
/// are unchanged by the pacing
fn process_ticks_stable(ctx: &mut Ctx<'_>, index: usize, time: f64, allowable: bool) {
    let state = state_of(&mut ctx.states, index);
    let mut points_passed = 0usize;
    for point in &state.points {
        // processSliderEndsAhead is hard-disabled at the danser pin
        // (rcontroller.go:564), so the plain time test is the whole rule
        if point.time > time {
            break;
        }
        points_passed += 1;
    }
    while ((state_of(&mut ctx.states, index).scored + state_of(&mut ctx.states, index).missed) as usize)
        < points_passed
    {
        let state = state_of(&mut ctx.states, index);
        let judged_so_far = (state.scored + state.missed) as usize;
        let point = state.points[judged_so_far];
        let hit = allowable && state.slide_start <= point.time;
        if hit {
            state.scored += 1;
        } else {
            state.missed += 1;
        }
        let kind = match point.kind {
            StablePointKind::Tick => JudgementKind::SliderTick { hit },
            StablePointKind::Repeat { repeat_index } => JudgementKind::SliderRepeat { hit, repeat_index },
            // the tail's combo semantics (+1 on hit, no break on miss --
            // danser's end-point Hold) live in ScoreState::apply
            StablePointKind::Tail => JudgementKind::SliderTail { hit },
        };
        ctx.emit(time, index, kind);
    }
}

/// slider.go:412-474 UpdatePostFor (stable branch): the head timeout first,
/// then the end aggregate at the first update at-or-past the truncated end
/// time. `hit50` is the truncated integer 50-window
pub(crate) fn update_post_for(ctx: &mut Ctx<'_>, index: usize, time: f64, hit50: f64) {
    process_head_miss(ctx, index, time, hit50);

    let obj = &ctx.beatmap.objects[index];
    // stable's own end time (already floored), not lazer's -- the two can
    // sit on different milliseconds (beatmap::stable_points, issue 13)
    let end_int = slider_of(obj).stable_end_time;
    let already_hit = matches!(&ctx.states[index], ObjectState::Slider(s) if s.is_hit);
    if time >= end_int && !already_hit {
        let state = state_of(&mut ctx.states, index);
        if state.start_result_hit {
            state.scored += 1;
        }
        // slider.go:428-467 -- the whole-slider result from the scored rate,
        // head included in both numerator (above) and denominator
        let rate = f64::from(state.scored) / (state.points.len() as f64 + 1.0);
        let grade = if rate == 1.0 {
            HitGrade::Great
        } else if rate >= 0.5 {
            HitGrade::Ok
        } else if rate > 0.0 {
            HitGrade::Meh
        } else {
            HitGrade::Miss
        };
        state.is_hit = true;
        ctx.emit(time, index, JudgementKind::SliderAggregate(grade));
    }
}

/// slider.go:476-503 -- the head times out at the first update strictly
/// past `start + hit50`, latching the down button from the current held
/// state. gated only on the head being unresolved, so on a sub-50ms slider
/// this can legitimately land after the end aggregate
fn process_head_miss(ctx: &mut Ctx<'_>, index: usize, time: f64, hit50: f64) {
    // slider.go:479 -- `time > int64(start) + Hit50`, truncated start
    let start = (ctx.beatmap.objects[index].start_time as i64) as f64;
    let unresolved = matches!(&ctx.states[index], ObjectState::Slider(s) if !s.is_start_hit);
    if unresolved && time > start + hit50 {
        let latch = ctx.buttons.latch_down_button();
        let state = state_of(&mut ctx.states, index);
        state.down_button = latch;
        state.is_start_hit = true;
        state.start_result_hit = false;
        ctx.emit(time, index, JudgementKind::SliderHead { hit: false });
    }
}

#[cfg(test)]
mod tests {
    use super::{dst_sq_87, mul87};
    use crate::beatmap::difficulty::HitGrade;
    use crate::math::Vec2;
    use crate::replay::frames::Buttons;
    use crate::simulation::score::JudgementKind;
    use crate::simulation::simulate;
    use crate::simulation::test_support::{beatmap_tick_time, frame, slider_map, wrap};

    // slider_map builds: od 5, ar 9, cs 4, sm 1.4, beat 500 (velocity 0.28),
    // tick rate configurable; one linear slider at (100, 100), length 100,
    // repeat_count configurable => head, optional ticks, tail at (200, 100).
    // duration = 100 / 0.28 = 357.142857... per span; end 1357.142857;
    // the tail POINT sits at max(1000 + 357/2, 1357 - 36) = 1321 (integer
    // truncation per danser's tickpoint construction)

    #[test]
    fn x87_helpers_promote_through_f64_and_round_once() {
        // math87.go / vector2f.go:95-100 -- f64 intermediates, one f32
        // rounding at the boundary
        assert_eq!(mul87(1.1, 2.2), ((1.1f32 as f64) * (2.2f32 as f64)) as f32);
        let a = Vec2::new(0.1, 0.2);
        let b = Vec2::new(3.3, 4.4);
        let dx = f64::from(b.x - a.x);
        let dy = f64::from(b.y - a.y);
        assert_eq!(dst_sq_87(a, b), (dx * dx + dy * dy) as f32);
    }

    #[test]
    fn held_tracked_slider_full_combos() {
        // tick rate 2 -> one tick at 70px (t = 1250); tail point at 1321
        let beatmap = slider_map(2.0, 0);
        let head_t = 1000.0;
        let end_t = beatmap.objects[0].end_time;
        let frames = wrap(vec![
            frame(head_t, 100.0, 100.0, Buttons::LEFT_1),
            frame(head_t + 250.0, 170.0, 100.0, Buttons::LEFT_1),
            frame(end_t, 200.0, 100.0, Buttons::LEFT_1),
            frame(end_t + 50.0, 200.0, 100.0, 0),
        ]);
        let timeline = simulate(&beatmap, &frames).unwrap();
        let kinds: Vec<_> = timeline.events.iter().map(|e| e.kind).collect();
        assert_eq!(
            kinds,
            vec![
                JudgementKind::SliderHead { hit: true },
                JudgementKind::SliderTick { hit: true },
                JudgementKind::SliderTail { hit: true },
                JudgementKind::SliderAggregate(HitGrade::Great),
            ]
        );
        // stable combo: head, tick and tail each +1; aggregate holds
        assert_eq!(timeline.totals.max_combo, 3);
        assert_eq!(timeline.totals.count_300, 1);
        // the tail point (1321) resolves on the end-time frame, and the
        // aggregate on that same update
        assert_eq!(timeline.events[2].time, end_t);
        assert_eq!(timeline.events[3].time, end_t);
    }

    #[test]
    fn a_late_slide_start_cannot_rescue_a_passed_tick() {
        // slider.go:340 -- a point scores only if the slide began at or
        // before the point's time. head hit, tracking lost over the tick,
        // re-entered after it: the tick is judged at the re-entry frame but
        // the fresh slide_start postdates it -> miss. (lazer classic would
        // have force-hit it via postprocessheadjudgement -- this is the
        // stable-vs-lazer divergence behind the sweep's dominant zero-miss
        // class, the engine tracking elements stable dropped)
        let beatmap = slider_map(2.0, 0);
        let head_t = 1000.0;
        let end_t = beatmap.objects[0].end_time;
        let frames = wrap(vec![
            frame(head_t, 100.0, 100.0, Buttons::LEFT_1),
            frame(head_t + 100.0, 400.0, 300.0, Buttons::LEFT_1), // far away: slide killed
            frame(head_t + 300.0, 184.0, 100.0, Buttons::LEFT_1), // re-entry past the tick (1250)
            frame(end_t, 200.0, 100.0, Buttons::LEFT_1),
            frame(end_t + 50.0, 200.0, 100.0, 0),
        ]);
        let timeline = simulate(&beatmap, &frames).unwrap();
        let kinds: Vec<_> = timeline.events.iter().map(|e| e.kind).collect();
        assert_eq!(
            kinds,
            vec![
                JudgementKind::SliderHead { hit: true },
                JudgementKind::SliderTick { hit: false }, // judged at 1300, slide_start 1300 > 1250
                JudgementKind::SliderTail { hit: true },  // slide_start 1300 <= 1321
                JudgementKind::SliderAggregate(HitGrade::Ok), // head + tail = 2/3
            ]
        );
        assert_eq!(timeline.events[1].time, head_t + 300.0);
        assert_eq!(timeline.totals.max_combo, 1);
        assert_eq!(timeline.totals.count_100, 1);
    }

    #[test]
    fn unpressed_head_misses_but_a_held_body_still_tracks() {
        // no press within the head window; right held from mid-body. the
        // head times out at the first update past start + 150 (the 1200
        // frame), and the acceptance machine latches the held button for
        // the body -- stable tracks ticks with no head hit at all
        let beatmap = slider_map(2.0, 0);
        let head_t = 1000.0;
        let end_t = beatmap.objects[0].end_time;
        let frames = wrap(vec![
            frame(head_t + 200.0, 156.0, 100.0, 0),
            frame(head_t + 220.0, 160.0, 100.0, Buttons::RIGHT_1),
            frame(head_t + 250.0, 170.0, 100.0, Buttons::RIGHT_1),
            frame(end_t, 200.0, 100.0, Buttons::RIGHT_1),
            frame(end_t + 50.0, 200.0, 100.0, 0),
        ]);
        let timeline = simulate(&beatmap, &frames).unwrap();
        let kinds: Vec<_> = timeline.events.iter().map(|e| e.kind).collect();
        assert_eq!(
            kinds,
            vec![
                JudgementKind::SliderHead { hit: false },
                JudgementKind::SliderTick { hit: true },
                JudgementKind::SliderTail { hit: true },
                JudgementKind::SliderAggregate(HitGrade::Ok), // tick + tail = 2/3
            ]
        );
        assert_eq!(timeline.events[0].time, 1200.0); // first update past 1150
    }

    #[test]
    fn the_held_prior_key_alone_cannot_carry_the_slide() {
        // the z, z+x, z case through stable's acceptance machine
        // (slider.go:245-269): left held from before, right pressed at the
        // head (down_button latches right), right released mid-body. left
        // alone fails both the swap rule (last_button == both and
        // last_button2 == the current left mean no fresh state) and the
        // down-button intersection -> the tick misses
        let beatmap = slider_map(2.0, 0);
        let head_t = 1000.0;
        let end_t = beatmap.objects[0].end_time;
        let frames = wrap(vec![
            frame(head_t - 500.0, 400.0, 400.0, Buttons::LEFT_1), // left held early, off the head
            frame(head_t, 100.0, 100.0, Buttons::LEFT_1 | Buttons::RIGHT_1), // right press hits head
            frame(head_t + 100.0, 128.0, 100.0, Buttons::LEFT_1), // right released; left still invalid
            frame(head_t + 250.0, 170.0, 100.0, Buttons::LEFT_1),
            frame(end_t, 200.0, 100.0, Buttons::LEFT_1),
            frame(end_t + 50.0, 200.0, 100.0, 0),
        ]);
        let timeline = simulate(&beatmap, &frames).unwrap();
        let kinds: Vec<_> = timeline.events.iter().map(|e| e.kind).collect();
        assert_eq!(kinds[0], JudgementKind::SliderHead { hit: true });
        assert_eq!(kinds[1], JudgementKind::SliderTick { hit: false });
        assert_eq!(kinds[2], JudgementKind::SliderTail { hit: false });
        assert_eq!(kinds[3], JudgementKind::SliderAggregate(HitGrade::Meh)); // head only, 1/3
    }

    #[test]
    fn releasing_the_other_key_swaps_acceptance_to_the_survivor() {
        // same setup, but LEFT releases instead: the state change from both
        // down to right-only satisfies the swap rule (last_button == both,
        // last_button2 == left != right), so the surviving right keeps the
        // slide -- stable accepts here where lazer's key restriction would
        // not, one of the enumerated lazer-vs-stable differences
        let beatmap = slider_map(2.0, 0);
        let head_t = 1000.0;
        let end_t = beatmap.objects[0].end_time;
        let frames = wrap(vec![
            frame(head_t - 500.0, 400.0, 400.0, Buttons::LEFT_1),
            frame(head_t, 100.0, 100.0, Buttons::LEFT_1 | Buttons::RIGHT_1),
            frame(head_t + 100.0, 128.0, 100.0, Buttons::RIGHT_1), // left released; right survives
            frame(head_t + 250.0, 170.0, 100.0, Buttons::RIGHT_1),
            frame(end_t, 200.0, 100.0, Buttons::RIGHT_1),
            frame(end_t + 50.0, 200.0, 100.0, 0),
        ]);
        let timeline = simulate(&beatmap, &frames).unwrap();
        let kinds: Vec<_> = timeline.events.iter().map(|e| e.kind).collect();
        assert_eq!(
            kinds,
            vec![
                JudgementKind::SliderHead { hit: true },
                JudgementKind::SliderTick { hit: true },
                JudgementKind::SliderTail { hit: true },
                JudgementKind::SliderAggregate(HitGrade::Great),
            ]
        );
    }

    #[test]
    fn every_due_point_resolves_in_one_update_in_list_order() {
        // tick rate 1.5 -> one tick at 93.33px (t = 1333), AFTER the tail
        // point (1321) in time but BEFORE it in list order: the point walk
        // is list-ordered, so the tail waits behind the tick and both
        // resolve on the end-time frame, tick first. danser's replay-time
        // model would judge one point per update and starve the tail behind
        // the aggregate; the deliberate divergence documented at
        // process_ticks_stable judges every due point, modelling the live
        // client where nothing ever starved
        let beatmap = slider_map(1.5, 0);
        let head_t = 1000.0;
        let end_t = beatmap.objects[0].end_time;
        let tick_t = beatmap_tick_time(&beatmap);
        assert!(tick_t > 1321.0);
        let frames = wrap(vec![
            frame(head_t, 100.0, 100.0, Buttons::LEFT_1),
            frame(end_t, 200.0, 100.0, Buttons::LEFT_1),
            frame(end_t + 50.0, 200.0, 100.0, 0),
        ]);
        let timeline = simulate(&beatmap, &frames).unwrap();
        let kinds: Vec<_> = timeline.events.iter().map(|e| e.kind).collect();
        assert_eq!(
            kinds,
            vec![
                JudgementKind::SliderHead { hit: true },
                JudgementKind::SliderTick { hit: true },
                JudgementKind::SliderTail { hit: true },
                JudgementKind::SliderAggregate(HitGrade::Great),
            ]
        );
        assert_eq!(timeline.totals.count_300, 1);
        assert_eq!(timeline.totals.max_combo, 3);
        // both points land on the end-time frame, tick (list-earlier) first
        assert_eq!(timeline.events[1].time, end_t);
        assert_eq!(timeline.events[2].time, end_t);
    }

    #[test]
    fn a_never_tracked_slider_with_a_missed_head_aggregates_miss() {
        // nothing pressed, cursor away, and the replay ends before the
        // slider: everything resolves on the whole-millisecond post-replay
        // walk -- head timeout at 1151 (first tick past start + 150), the
        // tick at its own millisecond, the tail point at 1321, the
        // aggregate at the truncated end (1357). rate 0 -> miss
        let beatmap = slider_map(2.0, 0);
        let frames = vec![frame(-1000.0, 400.0, 400.0, 0), frame(500.0, 400.0, 400.0, 0)];
        let timeline = simulate(&beatmap, &frames).unwrap();
        let kinds: Vec<_> = timeline.events.iter().map(|e| e.kind).collect();
        assert_eq!(
            kinds,
            vec![
                JudgementKind::SliderHead { hit: false },
                JudgementKind::SliderTick { hit: false },
                JudgementKind::SliderTail { hit: false },
                JudgementKind::SliderAggregate(HitGrade::Miss),
            ]
        );
        let times: Vec<_> = timeline.events.iter().map(|e| e.time).collect();
        assert_eq!(times, vec![1151.0, 1250.0, 1321.0, 1357.0]);
        assert_eq!(timeline.totals.count_miss, 1);
        assert_eq!(timeline.totals.max_combo, 0);
    }
}
