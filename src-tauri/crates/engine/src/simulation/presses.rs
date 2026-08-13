//! stable's click pipeline: the per-frame object-order click walk, the
//! stable note lock, and circle judgement. ports danser-go's
//! `OsuRuleSet.UpdateClickFor` object loop (ruleset.go:402-408),
//! `CanBeHitStable` (ruleset.go:610-663), and `Circle.UpdateClickFor`
//! (circle.go:42-99); reference map in
//! `.scratch/engine-parity-pass/stable-tracking-reference.md`.
//!
//! this replaced the lazer receptor-per-press walk
//! (drawablehitcircle.cs/legacyhitpolicy.cs) when the legacy path moved to
//! stable semantics (engine parity pass, issues 05+06): stable walks the
//! processed objects once per frame and lets each object inspect the frame's
//! click edges, where lazer walked receptors once per press. the observable
//! differences are the consumption rules -- a shaken or note-locked click
//! consumes BOTH edges of its frame (circle.go:84-91), while an
//! out-of-range click consumes nothing and falls through to later objects

use crate::beatmap::difficulty::{HitGrade, MISS_WINDOW};
use crate::beatmap::ProcessedKind;
use crate::math::Vec2;
use crate::simulation::score::JudgementKind;
use crate::simulation::{Ctx, ObjectState};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ClickAction {
    Ignored,
    Shake,
    Click,
}

/// danser `IsHit` per kind: circle judged, slider END judged (not the head
/// -- an in-flight slider is "unhit" to the note lock), spinner finished
pub(crate) fn object_is_hit(ctx: &Ctx<'_>, index: usize) -> bool {
    match &ctx.states[index] {
        ObjectState::Circle(c) => c.judged,
        ObjectState::Slider(s) => s.is_hit,
        ObjectState::Spinner(s) => s.finished,
    }
}

/// danser `GetEndTime` per kind: sliders end at stable's own accumulated
/// end (beatmap::stable_points, issue 13), everything else at the lazer
/// end time (circles end where they start; spinner windows are shared)
fn stable_end_time(ctx: &Ctx<'_>, index: usize) -> f64 {
    match &ctx.beatmap.objects[index].kind {
        ProcessedKind::Slider(s) => s.stable_end_time,
        _ => ctx.beatmap.objects[index].end_time,
    }
}

// note: an expiry-aware lock read (treating an object whose timeout had
// already passed as unable to lock, modelling live ordering inside a
// batched frame) was built and measured during the parity pass -- it LOST
// a point of all-eight sweep parity against the plain danser membership
// rule below, so the strict batched lock is the validated behaviour

/// ruleset.go:610-663 -- the stable hit policy over the processed list.
///
/// the stack shield consults the target's IMMEDIATE predecessor in the
/// processed list, whatever kind it is: judged objects leave the list at
/// millisecond granularity (the driver drains after each frame group), so a
/// predecessor judged on an earlier frame no longer occupies the slot. this
/// is what resolves the note-lock predecessor lifetime question (parity
/// issue 06) on the legacy path: where lazer's `AliveObjects` keeps a
/// judged drawable alive through its fade and `LegacyHitPolicy` consults
/// that slot, stable's membership rule reaches the same answer on the
/// dense-stack oracle (`fixtures/judgement/notelock-stack.json`) through
/// different mechanics -- the judged-but-fading predecessor is simply gone,
/// and a spinner predecessor never carries stack height
pub(crate) fn can_be_hit_stable(ctx: &Ctx<'_>, target: usize, time: f64) -> ClickAction {
    // "don't shake the stacks" (ruleset.go:636-648) -- circle targets only
    if matches!(ctx.beatmap.objects[target].kind, ProcessedKind::Circle) {
        let mut position = None;
        for (i, &index) in ctx.processed.iter().enumerate() {
            ctx.charge_sweep_step();
            if index == target {
                position = Some(i);
                // the reference walks the whole list to find the LAST match
                // (ruleset.go:639-643), but indices are unique here
                break;
            }
        }
        if let Some(pos) = position {
            if pos > 0 {
                let prev = ctx.processed[pos - 1];
                if ctx.beatmap.objects[prev].stack_height > 0 && !object_is_hit(ctx, prev) {
                    return ClickAction::Ignored;
                }
            }
        }
    }

    // the note lock proper (ruleset.go:650-660): any earlier unhit object
    // whose end sits 3ms of unsnap leniency before the target's start shakes
    let target_start = ctx.beatmap.objects[target].start_time;
    for &index in &ctx.processed {
        ctx.charge_sweep_step();
        if index == target {
            break;
        }
        if !object_is_hit(ctx, index) && stable_end_time(ctx, index) + 3.0 < target_start {
            return ClickAction::Shake;
        }
    }

    // the hittable range gate (ruleset.go:628): at or past 400ms from the
    // TRUNCATED start a would-be click only shakes -- danser compares
    // `time - int64(start)`, observable only on fractional object times
    if (time - (target_start as i64) as f64).abs() >= MISS_WINDOW {
        return ClickAction::Shake;
    }
    ClickAction::Click
}

/// the per-frame click walk (ruleset.go:402-408): every processed object in
/// order inspects the frame's click edges. `cursor_pos` is the frame's raw
/// position -- stable never interpolates for judgement
pub(crate) fn update_clicks(ctx: &mut Ctx<'_>, time: f64, cursor_pos: Vec2) {
    if !ctx.buttons.any_edge() {
        // every per-object body below gates on a present edge, so the walk
        // is a no-op without one -- skipped outright
        return;
    }
    let radius = ctx.stable_radius;
    let mut idx = 0;
    while idx < ctx.processed.len() {
        let index = ctx.processed[idx];
        idx += 1;
        ctx.charge_sweep_step();
        if !ctx.buttons.any_edge() {
            break;
        }
        match &ctx.beatmap.objects[index].kind {
            ProcessedKind::Circle => {
                if matches!(&ctx.states[index], ObjectState::Circle(c) if c.judged) {
                    continue;
                }
                try_click_circle(ctx, index, time, cursor_pos, radius);
            }
            ProcessedKind::Slider(_) => {
                // slider.go:126 -- the head consumes clicks only until it is
                // start-hit (hit or head-missed); after that clicks over the
                // head fall through to later objects, unlike lazer classic's
                // whole-slider receptor (osumodclassic.cs:96-99)
                let start_hit = matches!(&ctx.states[index], ObjectState::Slider(s) if s.is_start_hit);
                let is_hit = matches!(&ctx.states[index], ObjectState::Slider(s) if s.is_hit);
                if start_hit || is_hit {
                    continue;
                }
                crate::simulation::slider::try_click_head(ctx, index, time, cursor_pos, radius);
            }
            // spinners never consume clicks
            ProcessedKind::Spinner(_) => continue,
        }
    }
}

/// circle.go:42-99 -- one circle's view of the frame's click edges
fn try_click_circle(ctx: &mut Ctx<'_>, index: usize, time: f64, cursor_pos: Vec2, radius: f32) {
    let obj = &ctx.beatmap.objects[index];
    // inclusive f32 distance (vector2f.go:72-77 Dst <= GetRadius)
    let in_range = Vec2::distance(cursor_pos, obj.stacked_position) <= radius;
    let action = can_be_hit_stable(ctx, index, time);
    if in_range {
        match action {
            ClickAction::Click => {
                ctx.buttons.consume_one_edge();
                // stable truncates the delta before the window compare
                // (GetResultForDelta, ruleset.go:692-712 -- `int64(delta) <
                // Hit300`); for the truncated integer this is exactly
                // result_for's floor(range) - 0.5 tiers
                // (stable-tracking-reference.md, "hit windows")
                let delta = ((time - obj.start_time).abs() as i64) as f64;
                let grade = ctx.beatmap.windows.result_for(delta).unwrap_or(HitGrade::Miss);
                match &mut ctx.states[index] {
                    ObjectState::Circle(c) => c.judged = true,
                    _ => unreachable!("try_click_circle is only called for circle objects"),
                }
                ctx.emit(time, index, JudgementKind::Circle(grade));
            }
            // a shaken or note-locked click consumes both edges and judges
            // nothing (circle.go:84-91)
            ClickAction::Shake | ClickAction::Ignored => ctx.buttons.consume_both_edges(),
        }
    }
    // out of range: a positional miss (no count effect), edges kept for
    // later objects in the same walk (circle.go:92-94)
}
