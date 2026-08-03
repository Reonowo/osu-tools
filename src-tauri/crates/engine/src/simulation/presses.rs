//! the press pipeline: receptor walk, note lock, circle judgement.
//! ports drawablehitcircle.cs (receptor consumption + checkforresult) and
//! legacyhitpolicy.cs (classic note lock) onto the instant sweep

use crate::beatmap::difficulty::{MISS_WINDOW, OBJECT_RADIUS};
use crate::beatmap::ProcessedKind;
use crate::math::Vec2;
use crate::replay::interpolation::{CursorSample, OsuAction};
use crate::simulation::score::JudgementKind;
use crate::simulation::{Ctx, ObjectState};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ClickAction {
    Ignore,
    Shake,
    Hit,
}

/// advances ctx.first_unjudged past any permanently fully-judged prefix --
/// safe because fully_judged() never reverts to false once true (a circle's
/// judged flag, a slider's aggregate, and a spinner's finished flag are all
/// one-way), so an object found fully-judged here stays fully-judged for the
/// rest of the run; the cursor only ever moves forward, amortising the total
/// scan cost of both walks below across the whole sweep instead of
/// re-walking a settled prefix on every single press. mirrors
/// slider::advance_first_active's reasoning. alive() already excludes a
/// fully-judged object from every walk in this module, so skipping this
/// prefix cannot change which object either walk selects
fn advance_first_unjudged(ctx: &mut Ctx<'_>) {
    while ctx.first_unjudged < ctx.beatmap.objects.len() && ctx.fully_judged(ctx.first_unjudged) {
        ctx.first_unjudged += 1;
    }
}

/// walks receptors topmost-first (earliest start time first) and lets the
/// first hovered, willing receptor consume the press
/// (drawablehitcircle.cs:277-308). returns once consumed. `cursor` is the
/// pressing frame's own sample -- position for the receptor tests, and
/// threaded through a consumed head hit so its post-judgement tracking
/// update observes this frame's state rather than the settled one
pub(crate) fn handle_press(ctx: &mut Ctx<'_>, time: f64, action: OsuAction, cursor: CursorSample) {
    advance_first_unjudged(ctx);
    let radius = (f64::from(OBJECT_RADIUS) * f64::from(ctx.beatmap.scale)) as f32;
    for index in ctx.first_unjudged..ctx.beatmap.objects.len() {
        // per-press cost is the born, unjudged span -- the same walk lazer
        // pays per press -- but presses here are file-bounded, so the total
        // is charged against the sweep-step budget (the instant loop errors
        // past it)
        ctx.charge_sweep_step();
        let obj = &ctx.beatmap.objects[index];
        if obj.start_time - ctx.beatmap.preempt > time {
            break; // not born yet; later objects are not born either
        }
        match &obj.kind {
            ProcessedKind::Circle => {
                // canbehit: a judged circle no longer consumes
                if ctx.fully_judged(index) {
                    continue;
                }
                if Vec2::distance(cursor.pos, obj.stacked_position) > radius {
                    continue;
                }
                attempt_circle_hit(ctx, index, time, action, false);
                return; // consumed regardless of outcome
            }
            ProcessedKind::Slider(_) => {
                // osumodclassic.cs:96-99 -- the head receptor keeps consuming
                // presses over the head's position until the whole slider
                // (not just the head) is judged
                if ctx.fully_judged(index) {
                    continue;
                }
                if Vec2::distance(cursor.pos, obj.stacked_position) > radius {
                    continue;
                }
                crate::simulation::slider::attempt_head_hit(ctx, index, time, action, cursor);
                return; // consumed regardless of outcome
            }
            // spinners never consume presses
            _ => continue,
        }
    }
    let _ = action;
}

/// drawablehitcircle.cs:137-173's user-triggered path for a plain circle.
/// `is_slider_head` threads through to `check_hittable`'s note-lock skip;
/// slider heads themselves are judged via `slider::attempt_head_hit` instead
/// (drawablesliderhead.cs's classic result mapping needs its own path), so
/// this always runs with `is_slider_head: false` in practice
pub(crate) fn attempt_circle_hit(
    ctx: &mut Ctx<'_>,
    index: usize,
    time: f64,
    _action: OsuAction,
    is_slider_head: bool,
) {
    let obj = &ctx.beatmap.objects[index];
    let result = ctx.beatmap.windows.result_for(time - obj.start_time);
    let click_action = check_hittable(ctx, index, time, result.is_some(), is_slider_head);
    // shake consumes without judging; ignore likewise
    if let Some(grade) = result {
        if click_action == ClickAction::Hit {
            match &mut ctx.states[index] {
                ObjectState::Circle(c) => c.judged = true,
                _ => unreachable!("attempt_circle_hit is only called for circle objects"),
            }
            ctx.emit(time, index, JudgementKind::Circle(grade));
        }
    }
}

/// legacyhitpolicy.cs:36-70. the alive list is starttime-ordered; slider
/// heads skip the stacked-previous gate because their drawables are nested
/// (aliveobjects.indexof yields -1 for them in lazer) and their break-point
/// object is the parent slider, whose own end time can never trip the
/// blocking test -- observationally identical to lazer's no-break walk
pub(crate) fn check_hittable(
    ctx: &Ctx<'_>,
    target: usize,
    time: f64,
    has_result: bool,
    is_slider_head: bool,
) -> ClickAction {
    // both walks start from ctx.first_unjudged rather than 0: everything
    // strictly before it is fully judged, so alive() is already false for
    // every one of those indices and including them could not change either
    // walk's outcome -- a pure iteration-skip over an already-settled prefix
    if !is_slider_head {
        let prev = (ctx.first_unjudged..target).rev().find(|&i| {
            ctx.charge_sweep_step();
            ctx.alive(i, time)
        });
        if let Some(prev) = prev {
            if ctx.beatmap.objects[prev].stack_height > 0 && !ctx.fully_judged(prev) {
                return ClickAction::Ignore;
            }
        }
    }
    if !has_result {
        return ClickAction::Shake;
    }
    let target_start = ctx.beatmap.objects[target].start_time;
    for i in ctx.first_unjudged..target {
        ctx.charge_sweep_step();
        if !ctx.alive(i, time) || ctx.fully_judged(i) {
            continue;
        }
        // 3ms of leniency for slightly unsnapped objects
        if ctx.beatmap.objects[i].end_time + 3.0 < target_start {
            return ClickAction::Shake;
        }
    }
    if (target_start - time).abs() < MISS_WINDOW {
        ClickAction::Hit
    } else {
        ClickAction::Shake
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::replay::frames::ReplayFrame;
    use crate::simulation::score::ScoreState;
    use crate::simulation::test_support::circle_map;
    use crate::simulation::CircleState;

    #[test]
    fn stacked_unjudged_previous_object_reports_ignore_specifically() {
        // legacyhitpolicy.cs:44-49: check_hittable's own return value
        // distinguishes ignore from shake, a distinction simulate() never
        // surfaces on its own (both consume the press and judge nothing) --
        // this pins the ignore branch directly, on the same scenario as
        // mod.rs's stacked_unjudged_previous_object_ignores_the_press
        let beatmap = circle_map(&[
            (1200.0, 100.0, 100.0), // "prev": stacks with the seed circle below
            (1250.0, 300.0, 100.0), // target: under the cursor
            (1290.0, 100.0, 100.0), // seeds prev's stack height
        ]);
        assert!(beatmap.objects[0].stack_height > 0);

        let states = vec![
            ObjectState::Circle(CircleState::default()),
            ObjectState::Circle(CircleState::default()),
            ObjectState::Circle(CircleState::default()),
        ];
        let frames: Vec<ReplayFrame> = Vec::new();
        let ctx = Ctx {
            beatmap: &beatmap,
            frames: &frames,
            states,
            score: ScoreState::default(),
            events: Vec::new(),
            slider_indices: Vec::new(),
            first_active_slider: 0,
            first_unjudged: 0,
            spinner_indices: Vec::new(),
            first_active_spinner: 0,
            sweep_steps: std::cell::Cell::new(0),
        };

        assert_eq!(check_hittable(&ctx, 1, 1250.0, true, false), ClickAction::Ignore);
    }
}
