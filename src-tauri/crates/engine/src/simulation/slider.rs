//! slider tracking and nested judgement: ports sliderinputmanager.cs
//! (tracking state machine, postprocessheadjudgement, tryjudgenestedobject),
//! drawablesliderhead.cs (classic head results), drawableslider.cs:293-315
//! (classic aggregate). cursor-dependent state is sampled at instants per the
//! module conventions

use crate::beatmap::difficulty::{HitGrade, OBJECT_RADIUS};
use crate::beatmap::slider_events::TAIL_LENIENCY;
use crate::beatmap::{NestedKind, ProcessedKind, ProcessedObject, ProcessedSlider};
use crate::math::Vec2;
use crate::replay::interpolation::{CursorSample, OsuAction};
use crate::simulation::score::JudgementKind;
use crate::simulation::{Ctx, ObjectState};

/// drawablesliderball.cs:19
const FOLLOW_AREA: f32 = 2.4;

#[derive(Debug)]
pub(crate) struct SliderState {
    /// per nested-object result, indexed like ProcessedSlider::nested;
    /// none = pending. head lives at its sorted position (always 0)
    pub nested_results: Vec<Option<bool>>,
    pub next_unjudged: usize,
    pub aggregate: Option<HitGrade>,
    pub tracking: bool,
    /// sliderinputmanager.cs:45 -- set when every other key was seen released
    pub time_to_accept_any_key_after: Option<f64>,
    pub head_hit_action: Option<OsuAction>,
    pub last_pressed_left: bool,
    pub last_pressed_right: bool,
}

impl SliderState {
    pub fn new(nested_count: usize) -> SliderState {
        SliderState {
            nested_results: vec![None; nested_count],
            next_unjudged: 0,
            aggregate: None,
            tracking: false,
            time_to_accept_any_key_after: None,
            head_hit_action: None,
            last_pressed_left: false,
            last_pressed_right: false,
        }
    }

    pub fn head_judged(&self) -> bool {
        self.nested_results[0].is_some()
    }

    pub fn finished(&self) -> bool {
        self.aggregate.is_some()
    }
}

/// helper: the slider parts of an object, panicking on misuse (internal only)
fn slider_of(obj: &ProcessedObject) -> &ProcessedSlider {
    match &obj.kind {
        ProcessedKind::Slider(s) => s,
        _ => unreachable!("slider fns are only called for slider objects"),
    }
}

fn state_of(states: &mut [ObjectState], index: usize) -> &mut SliderState {
    match &mut states[index] {
        ObjectState::Slider(s) => s,
        _ => unreachable!("slider fns are only called for slider states"),
    }
}

pub(crate) fn attempt_head_hit(
    ctx: &mut Ctx<'_>,
    index: usize,
    time: f64,
    action: OsuAction,
    cursor: CursorSample,
) {
    // hitreceptor.onpressed sets hitaction ??= for every consumed press
    // (drawablehitcircle.cs:297-301), shaken and post-judgement ones included --
    // but lazer's real order is hit() (-> checkforresult -> postprocesshead-
    // judgement's own tracking update, which reads the old hitaction, still
    // null on a first press) and only then hitaction ??=, so this must stay
    // unset until after the judge/post-process block below: a press that
    // both hits the head and shares its replay frame with another
    // newly-pressed key must not see its own action during that internal
    // tracking call, or the key-restriction check that call performs would
    // read a one-instant-stale (pre-press) lastpressedactions snapshot
    if !state_of(&mut ctx.states, index).head_judged() {
        let obj = &ctx.beatmap.objects[index];
        // drawablesliderhead.cs:60-75 -- every window outcome maps to hit/miss,
        // so the policy's result is never none for a head
        let grade = ctx.beatmap.windows.result_for(time - obj.start_time);
        let click_action = crate::simulation::presses::check_hittable(ctx, index, time, true, true);
        if click_action == crate::simulation::presses::ClickAction::Hit {
            let hit = matches!(grade, Some(g) if g != HitGrade::Miss);
            judge_nested(ctx, index, 0, time, hit);
            if hit {
                post_process_head_judgement(ctx, index, time, cursor);
            }
        }
    }
    // classic block: once the head is judged the press still consumes (no
    // further judging), but it always still counts as a hit action
    state_of(&mut ctx.states, index).head_hit_action.get_or_insert(action);
}

/// advances a slider's next_unjudged past any already-resolved prefix
fn advance_next_unjudged(state: &mut SliderState) {
    while state.next_unjudged < state.nested_results.len()
        && state.nested_results[state.next_unjudged].is_some()
    {
        state.next_unjudged += 1;
    }
}

/// records a nested result and emits its event
pub(crate) fn judge_nested(ctx: &mut Ctx<'_>, index: usize, nested_index: usize, time: f64, hit: bool) {
    let kind = slider_of(&ctx.beatmap.objects[index]).nested[nested_index].kind;
    let state = state_of(&mut ctx.states, index);
    // advance past any already-judged prefix before the guard below, so a
    // guard hit still leaves next_unjudged making forward progress -- drain_pending's
    // loop only ever exits via next_unjudged reaching the end or a break, so a
    // stalled pointer here would hang forever, which this crate's docs record
    // as worse than the panic the guard is replacing
    advance_next_unjudged(state);
    // invariant: each nested object is judged exactly once. a debug_assert
    // here would let the same bug through silently in release (this crate's
    // docs record that happening once already), so guard instead of assert
    if state.nested_results[nested_index].is_some() {
        return;
    }
    state.nested_results[nested_index] = Some(hit);
    advance_next_unjudged(state);
    let event = match kind {
        NestedKind::Head => JudgementKind::SliderHead { hit },
        NestedKind::Tick => JudgementKind::SliderTick { hit },
        NestedKind::Repeat => JudgementKind::SliderRepeat { hit },
        NestedKind::Tail => JudgementKind::SliderTail { hit },
    };
    ctx.emit(time, index, event);
}

/// sliderinputmanager.cs:184-210
fn is_in_follow_area(
    scale: f32,
    obj: &ProcessedObject,
    slider: &ProcessedSlider,
    time: f64,
    cursor: Vec2,
    expanded: bool,
) -> bool {
    // osuhitobject.cs:94 computes radius in double; getfollowradius narrows
    let mut radius = (f64::from(OBJECT_RADIUS) * f64::from(scale)) as f32;
    if expanded {
        radius *= FOLLOW_AREA;
    }
    let follow_progress = ((time - obj.start_time) / slider.duration).clamp(0.0, 1.0);
    let follow_position = slider.curve_position_at(follow_progress);
    let mouse_in_slider = cursor - obj.stacked_position;
    (mouse_in_slider - follow_position).length_squared() <= radius * radius
}

/// sliderinputmanager.cs:78-140. the cursor sample is the pressing frame's
/// own, threaded from the press path -- resampling `cursor_at(time)` here
/// would resolve a duplicate-timestamp press to the last frame's state
fn post_process_head_judgement(ctx: &mut Ctx<'_>, index: usize, time: f64, cursor: CursorSample) {
    let obj = &ctx.beatmap.objects[index];
    let slider = slider_of(obj);
    if !is_in_follow_area(ctx.beatmap.scale, obj, slider, time, cursor.pos, true) {
        return;
    }

    let expanded_radius = (f64::from(OBJECT_RADIUS) * f64::from(ctx.beatmap.scale)) as f32 * FOLLOW_AREA;
    let mouse_in_slider = cursor.pos - obj.stacked_position;

    // pass 1: is every passed unjudged nested position within the expanded
    // area of the current cursor position
    let mut all_in_range = true;
    let mut passed: Vec<usize> = Vec::new();
    {
        let state = state_of(&mut ctx.states, index);
        for (i, nested) in slider.nested.iter().enumerate() {
            if state.nested_results[i].is_some() {
                continue;
            }
            if nested.time > time {
                break;
            }
            let progress = ((nested.time - obj.start_time) / slider.duration).clamp(0.0, 1.0);
            let position = slider.curve_position_at(progress);
            if (position - mouse_in_slider).length_squared() > expanded_radius * expanded_radius {
                all_in_range = false;
                passed.clear();
                break;
            }
            passed.push(i);
        }
        if !all_in_range {
            // pass 1 rebuilt: on any out-of-range object every passed nested
            // is missed instead (sliderinputmanager.cs:110-134)
            for (i, nested) in slider.nested.iter().enumerate() {
                if state.nested_results[i].is_some() {
                    continue;
                }
                if nested.time > time {
                    break;
                }
                passed.push(i);
            }
        }
    }
    for i in passed {
        judge_nested(ctx, index, i, time, all_in_range);
    }

    // sliderinputmanager.cs:139 -- re-enable tracking with the position
    // validity overridden
    let obj = &ctx.beatmap.objects[index];
    let slider = slider_of(obj);
    let position_valid =
        all_in_range || is_in_follow_area(ctx.beatmap.scale, obj, slider, time, cursor.pos, false);
    update_tracking_with_validity(ctx, index, time, cursor, position_valid);
}

/// advances ctx.first_active_slider past ctx.slider_indices' settled prefix
/// -- sliders whose classic aggregate already resolved. safe because
/// `finished()` never reverts to false once true, so a slider found finished
/// here stays finished for the rest of the run; the cursor only ever moves
/// forward, amortising the total scan cost across the whole sweep instead of
/// re-walking a settled prefix at every single instant
fn advance_first_active(ctx: &mut Ctx<'_>) {
    while ctx.first_active_slider < ctx.slider_indices.len() {
        let index = ctx.slider_indices[ctx.first_active_slider];
        let finished = match &ctx.states[index] {
            ObjectState::Slider(s) => s.finished(),
            _ => unreachable!("slider_indices only holds slider objects"),
        };
        if !finished {
            break;
        }
        ctx.first_active_slider += 1;
    }
}

/// the settled-sample sweep for deadline groups: samples the interpolated
/// cursor at `time` and updates every born, unfinished slider
pub(crate) fn update_tracking_all(ctx: &mut Ctx<'_>, time: f64) {
    let cursor = ctx.cursor_at(time);
    update_tracking_all_with_cursor(ctx, time, cursor);
}

/// frame entries pass their frame's own sample instead of the settled one:
/// with duplicate timestamps, `cursor_at` would resolve every entry to the
/// last frame's state (see the instant loop's frame-stability note)
pub(crate) fn update_tracking_all_with_cursor(ctx: &mut Ctx<'_>, time: f64, cursor: CursorSample) {
    advance_first_active(ctx);
    for i in ctx.first_active_slider..ctx.slider_indices.len() {
        let index = ctx.slider_indices[i];
        ctx.charge_sweep_step();
        let obj = &ctx.beatmap.objects[index];
        if obj.start_time - ctx.beatmap.preempt > time {
            break; // objects are start-time ordered: nothing later is born either
        }
        if state_of(&mut ctx.states, index).finished() {
            continue;
        }
        let obj = &ctx.beatmap.objects[index];
        let slider = slider_of(obj);
        let position_valid = is_in_follow_area(
            ctx.beatmap.scale,
            obj,
            slider,
            time,
            cursor.pos,
            state_of(&mut ctx.states, index).tracking,
        );
        update_tracking_with_validity(ctx, index, time, cursor, position_valid);
    }
}

/// sliderinputmanager.cs:216-274 (forward playback branch)
fn update_tracking_with_validity(
    ctx: &mut Ctx<'_>,
    index: usize,
    time: f64,
    cursor: CursorSample,
    position_valid: bool,
) {
    let end_time = ctx.beatmap.objects[index].end_time;
    let state = state_of(&mut ctx.states, index);

    let head_action = state.head_hit_action;
    if head_action.is_none() {
        state.time_to_accept_any_key_after = None;
    }
    if let Some(action) = head_action {
        if state.time_to_accept_any_key_after.is_none() {
            let other_was_pressed = match action {
                OsuAction::Left => state.last_pressed_right,
                OsuAction::Right => state.last_pressed_left,
            };
            // any key becomes acceptable once every other key has been seen
            // released in the previous update
            if !other_was_pressed {
                state.time_to_accept_any_key_after = Some(time);
            }
        }
    }

    let is_valid_action = |action: OsuAction| -> bool {
        // sliderinputmanager.cs:281-290
        if let Some(hit_action) = state.head_hit_action {
            let restricted = match state.time_to_accept_any_key_after {
                None => true,
                Some(after) => time <= after,
            };
            if restricted {
                return action == hit_action;
            }
        }
        true
    };
    let left = cursor.buttons.left();
    let right = cursor.buttons.right();
    let valid_action =
        (left && is_valid_action(OsuAction::Left)) || (right && is_valid_action(OsuAction::Right));

    // sliderinputmanager.cs:216-274 -- this is a direct transcription of
    // lazer's own `Tracking = (!AggregateJudged || Time.Current <= EndTime)
    // && ...`. the first disjunct is provably always true on every reachable
    // path through this port specifically: both callers (update_tracking_all,
    // post_process_head_judgement) only reach this function while
    // `!finished()` holds, i.e. state.aggregate is still none, so it never
    // gates anything here -- kept rather than dropped to stay a faithful,
    // line-for-line port of the cited condition
    state.tracking = (state.aggregate.is_none() || time <= end_time) && position_valid && valid_action;
    state.last_pressed_left = left;
    state.last_pressed_right = right;
}

/// tryjudgenestedobject (sliderinputmanager.cs:142-178) applied to every
/// pending nested object, then the classic aggregate (drawableslider.cs:298-315)
pub(crate) fn drain_pending(ctx: &mut Ctx<'_>, time: f64) {
    advance_first_active(ctx);
    for i in ctx.first_active_slider..ctx.slider_indices.len() {
        let index = ctx.slider_indices[i];
        ctx.charge_sweep_step();
        if ctx.beatmap.objects[index].start_time - ctx.beatmap.preempt > time {
            break; // objects are start-time ordered: nothing later is born either
        }
        if state_of(&mut ctx.states, index).finished() {
            continue;
        }
        if !state_of(&mut ctx.states, index).head_judged() {
            continue; // sliderinputmanager.cs:171 -- nothing judges before the head
        }

        loop {
            let obj = &ctx.beatmap.objects[index];
            let slider = slider_of(obj);
            let state = state_of(&mut ctx.states, index);
            let i = state.next_unjudged;
            if i >= slider.nested.len() {
                break;
            }
            let nested = &slider.nested[i];
            let tracking = state.tracking;
            let due = match nested.kind {
                NestedKind::Head => unreachable!("head precedes next_unjudged once judged"),
                NestedKind::Tick | NestedKind::Repeat => time >= nested.time,
                // the tail activates within the leniency window, but only
                // after every earlier tick/repeat resolved -- which
                // next_unjudged pointing at it already guarantees
                NestedKind::Tail => time - nested.time >= TAIL_LENIENCY,
            };
            if !due {
                break;
            }
            if tracking {
                judge_nested(ctx, index, i, time, true);
            } else if time >= nested.time {
                judge_nested(ctx, index, i, time, false);
            } else {
                break; // tail inside the leniency window: wait for tracking or the end
            }
        }

        // aggregate once everything nested resolved and the end has passed
        let obj = &ctx.beatmap.objects[index];
        let state = state_of(&mut ctx.states, index);
        if time >= obj.end_time && state.nested_results.iter().all(|r| r.is_some()) {
            let total = state.nested_results.len();
            let hit = state.nested_results.iter().filter(|r| **r == Some(true)).count();
            let grade = if hit == total {
                HitGrade::Great
            } else if hit == 0 {
                HitGrade::Miss
            } else if hit as f64 / total as f64 >= 0.5 {
                HitGrade::Ok
            } else {
                HitGrade::Meh
            };
            state.aggregate = Some(grade);
            ctx.emit(time, index, JudgementKind::SliderAggregate(grade));
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::beatmap::difficulty::HitGrade;
    use crate::replay::frames::Buttons;
    use crate::simulation::score::JudgementKind;
    use crate::simulation::simulate;
    use crate::simulation::test_support::{
        beatmap_tick_time, frame, slider_map, slider_map_with_circle_size, wrap,
    };

    // slider_map builds: od 5, ar 9, cs 4, sm 1.4, beat 500 (velocity 0.28),
    // tick rate configurable; one linear slider at (100, 100), length 100,
    // repeat_count configurable => head (0,0-rel), optional ticks, tail at
    // (200, 100). duration = 100 / 0.28 = 357.142857... per span

    #[test]
    fn held_tracked_slider_full_combos() {
        // tick rate 2 -> one tick at 70 (t = head + 250)
        let beatmap = slider_map(2.0, 0);
        let head_t = 1000.0;
        let end_t = beatmap.objects[0].end_time;
        // press on the head, hold and ride the ball to the end
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
        // stable combo: head, tick and tail each +1; aggregate none
        assert_eq!(timeline.totals.max_combo, 3);
        assert_eq!(timeline.totals.count_300, 1);
        // tail leniency: judged at the first instant >= end - 36
        let tail_event = &timeline.events[2];
        assert!(tail_event.time >= end_t + crate::beatmap::slider_events::TAIL_LENIENCY);
        assert!(tail_event.time <= end_t);
    }

    #[test]
    fn dropping_tracking_misses_the_tick_but_not_the_tail() {
        let beatmap = slider_map(2.0, 0);
        let head_t = 1000.0;
        let end_t = beatmap.objects[0].end_time;
        // hit the head, wander far away over the tick, come back for the tail
        let frames = wrap(vec![
            frame(head_t, 100.0, 100.0, Buttons::LEFT_1),
            frame(head_t + 100.0, 400.0, 300.0, Buttons::LEFT_1),
            frame(head_t + 300.0, 195.0, 100.0, Buttons::LEFT_1),
            frame(end_t + 50.0, 200.0, 100.0, 0),
        ]);
        let timeline = simulate(&beatmap, &frames).unwrap();
        let kinds: Vec<_> = timeline.events.iter().map(|e| e.kind).collect();
        assert_eq!(
            kinds,
            vec![
                JudgementKind::SliderHead { hit: true },
                JudgementKind::SliderTick { hit: false },
                JudgementKind::SliderTail { hit: true },
                // head + tail hit, tick missed: 2/3 >= 0.5 -> ok
                JudgementKind::SliderAggregate(HitGrade::Ok),
            ]
        );
        // tick miss broke combo; tail rebuilt it to 1
        assert_eq!(timeline.totals.max_combo, 1);
        assert_eq!(timeline.totals.count_100, 1);
    }

    #[test]
    fn unpressed_head_misses_but_any_key_tracks_the_body() {
        // no press within the head windows; hold from mid-body onward. the
        // head misses at start + meh, and tracking (any key, since no head
        // action was recorded) still collects the tick and tail
        let beatmap = slider_map(2.0, 0);
        let head_t = 1000.0;
        let end_t = beatmap.objects[0].end_time;
        let frames = wrap(vec![
            // cursor away from the head receptor so no press consumes it
            frame(head_t + 200.0, 156.0, 100.0, 0),
            frame(head_t + 220.0, 160.0, 100.0, Buttons::RIGHT_1),
            frame(head_t + 250.0, 170.0, 100.0, Buttons::RIGHT_1),
            frame(end_t + 50.0, 200.0, 100.0, Buttons::RIGHT_1),
        ]);
        let timeline = simulate(&beatmap, &frames).unwrap();
        let kinds: Vec<_> = timeline.events.iter().map(|e| e.kind).collect();
        assert_eq!(
            kinds,
            vec![
                JudgementKind::SliderHead { hit: false },
                JudgementKind::SliderTick { hit: true },
                JudgementKind::SliderTail { hit: true },
                JudgementKind::SliderAggregate(HitGrade::Ok),
            ]
        );
    }

    #[test]
    fn late_head_hit_force_hits_passed_ticks_when_cursor_stayed_in_range() {
        // tick at head + 250; head hit at +140 (meh window) with the cursor on
        // the ball path: sliderinputmanager.cs:78-140 forcefully hits the
        // passed tick. use tick rate 4 -> tick distance 35 -> ticks at 35, 70
        // (t = +125, +250). head centre (100,100), radius = 64 * scale(cs4)
        // ~= 36.49 -- (134,100) sits 34px away, inside the head receptor and
        // (being 1px from the passed tick at (135,100)) trivially inside its
        // 2.4x-expanded follow area too
        let beatmap = slider_map(4.0, 0);
        let head_t = 1000.0;
        let end_t = beatmap.objects[0].end_time;
        let frames = wrap(vec![
            // cursor rides near the ball but nothing is pressed yet
            frame(head_t + 125.0, 130.0, 100.0, 0),
            // press lands on the head receptor (cursor within 64*scale of the
            // head) while also within 2.4x follow radius of the passed tick
            frame(head_t + 140.0, 134.0, 100.0, Buttons::LEFT_1),
            frame(head_t + 250.0, 170.0, 100.0, Buttons::LEFT_1),
            frame(end_t, 200.0, 100.0, Buttons::LEFT_1),
            frame(end_t + 50.0, 200.0, 100.0, 0),
        ]);
        let timeline = simulate(&beatmap, &frames).unwrap();
        let kinds: Vec<_> = timeline.events.iter().map(|e| e.kind).collect();
        assert_eq!(kinds[0], JudgementKind::SliderHead { hit: true });
        // the passed tick was force-hit at the head-press instant
        assert_eq!(kinds[1], JudgementKind::SliderTick { hit: true });
        assert_eq!(timeline.events[1].time, head_t + 140.0);
        assert_eq!(*kinds.last().unwrap(), JudgementKind::SliderAggregate(HitGrade::Great));
    }

    #[test]
    fn late_head_hit_with_cursor_away_force_misses_passed_ticks() {
        // head is hit late from a press on the head's far edge, with the
        // cursor genuinely outside the expanded follow area of the passed
        // tick's position. with the standard cs4 head radius (~36.49) this
        // is geometrically unreachable for tick_rate 4's first tick (35px
        // out): even the farthest on-head point is only 35 + 36.49 = 71.49px
        // from it, comfortably inside the 2.4x-expanded 87.59px area no
        // matter where on the head you press. a bigger circle size (cs9,
        // radius ~14.09, expanded ~33.81) shrinks the receptor enough that
        // a press at (88,100) -- 12px from the head centre, within its
        // ~14.09px radius, but 47px from the tick at (135,100) -- clears the
        // expanded 33.81px area; ticks/positions/times are otherwise
        // identical to slider_map since circle size doesn't affect velocity
        // or tick placement
        let beatmap = slider_map_with_circle_size(4.0, 0, 9.0);
        let head_t = 1000.0;
        let end_t = beatmap.objects[0].end_time;
        let frames = wrap(vec![
            frame(head_t + 125.0, 88.0, 100.0, 0),
            frame(head_t + 140.0, 88.0, 100.0, Buttons::LEFT_1),
            frame(end_t + 50.0, 88.0, 100.0, 0),
        ]);
        let timeline = simulate(&beatmap, &frames).unwrap();
        let kinds: Vec<_> = timeline.events.iter().map(|e| e.kind).collect();
        assert_eq!(kinds[0], JudgementKind::SliderHead { hit: true });
        assert_eq!(kinds[1], JudgementKind::SliderTick { hit: false });
    }

    #[test]
    fn key_restriction_blocks_the_prior_held_key_until_release() {
        // the z, z+x, z case (sliderinputmanager.cs:31-44): left held from
        // before the slider, head hit with right, right released mid-body.
        // left alone must not track until it is released and repressed --
        // here it never is, so the tick misses.
        //
        // the early left press must land off the head receptor's radius:
        // hitreceptor.onpressed sets hitaction unconditionally whenever a
        // press merely hovers the receptor (drawablehitcircle.cs:297-301),
        // before the hit window is even checked, so a press on the head --
        // even one far outside the miss window that only shakes -- would
        // still lock head_hit_action to left and defeat this test. placed
        // well away from (100,100), it only changes the held button state
        // (which is what the z+x restriction check actually reads back via
        // last_pressed_left/right), leaving head_hit_action untouched
        let beatmap = slider_map(2.0, 0);
        let head_t = 1000.0;
        let end_t = beatmap.objects[0].end_time;
        let frames = wrap(vec![
            frame(head_t - 500.0, 400.0, 400.0, Buttons::LEFT_1), // left held from before, off the head
            frame(head_t, 100.0, 100.0, Buttons::LEFT_1 | Buttons::RIGHT_1), // right press hits head
            frame(head_t + 100.0, 128.0, 100.0, Buttons::LEFT_1), // right released; left still invalid
            frame(end_t + 50.0, 200.0, 100.0, Buttons::LEFT_1),
        ]);
        let timeline = simulate(&beatmap, &frames).unwrap();
        // the right press at head time hits it, recording head_hit_action as
        // right (the first and only press to reach the receptor). from then
        // on only right tracks; right vanished at +100, so the tick (t +250)
        // misses
        let kinds: Vec<_> = timeline.events.iter().map(|e| e.kind).collect();
        assert_eq!(kinds[0], JudgementKind::SliderHead { hit: true });
        assert_eq!(kinds[1], JudgementKind::SliderTick { hit: false });
        // the tail also misses: left is still the only key down at end - 36
        assert_eq!(kinds[2], JudgementKind::SliderTail { hit: false });
        assert_eq!(kinds[3], JudgementKind::SliderAggregate(HitGrade::Meh)); // 1/3 hit
    }

    #[test]
    fn a_deadline_sharing_a_frame_timestamp_adds_no_extra_tracking_update() {
        // regression: the instant loop once re-ran the settled-sample sweep
        // for a deadline group even when a frame at the same timestamp had
        // already run its own update. update_tracking_with_validity reads
        // last_pressed_* as the previous update's buttons, so that second
        // same-time update saw the frame's own right-release as "released
        // in the previous update" and opened the any-key acceptance window
        // one frame early. here the release lands exactly on the slider's
        // head-deadline instant (start + meh = 1149.5, a frame+deadline
        // group); acceptance must open AT the repress update, not before
        // it, so the right repress at the tick is still restricted and the
        // tick misses
        let beatmap = slider_map(2.0, 0);
        let head_t = 1000.0;
        let end_t = beatmap.objects[0].end_time;
        let head_deadline = head_t + 149.5; // od 5 meh window
        let frames = wrap(vec![
            frame(head_t - 500.0, 400.0, 400.0, Buttons::RIGHT_1), // right held from before, off the head
            frame(head_t, 100.0, 100.0, Buttons::LEFT_1 | Buttons::RIGHT_1), // left press hits the head
            frame(head_deadline, 142.0, 100.0, Buttons::LEFT_1), // right released on the deadline instant
            frame(head_t + 250.0, 170.0, 100.0, Buttons::RIGHT_1), // right repressed at the tick, left gone
            frame(end_t + 50.0, 200.0, 100.0, Buttons::RIGHT_1),
        ]);
        let timeline = simulate(&beatmap, &frames).unwrap();
        let kinds: Vec<_> = timeline.events.iter().map(|e| e.kind).collect();
        assert_eq!(kinds[0], JudgementKind::SliderHead { hit: true });
        assert_eq!(kinds[1], JudgementKind::SliderTick { hit: false });
        // the acceptance window opened at the tick-time update, so right
        // (still held) tracks the later tail fine
        assert_eq!(kinds[2], JudgementKind::SliderTail { hit: true });
        assert_eq!(kinds[3], JudgementKind::SliderAggregate(HitGrade::Ok));
    }

    #[test]
    fn simultaneous_press_head_hit_keeps_the_restriction_engaged() {
        // sliderinputmanager.cs:31-44's other trigger for the restriction:
        // left and right are newly pressed in the same frame, left first
        // (press_edges's replay order) hits the head. lazer's real order is
        // hitreceptor.onpressed's hit() (-> postprocessheadjudgement's own
        // tracking update, reading hitaction == null still) then
        // hitaction ??= left -- so that internal update sees both keys held
        // (right included) and refreshes lastpressedactions with both,
        // meaning the very next update (with hitaction == left now set)
        // finds "the other key (right) was pressed" true and keeps the
        // restriction engaged, exactly as if left alone had hit the head
        // with right already held. left releases at +100 and never returns,
        // so the body drops even though right stays held throughout
        let beatmap = slider_map(2.0, 0);
        let head_t = 1000.0;
        let end_t = beatmap.objects[0].end_time;
        let frames = wrap(vec![
            frame(head_t, 100.0, 100.0, Buttons::LEFT_1 | Buttons::RIGHT_1), // both newly down; left hits the head first
            frame(head_t + 100.0, 128.0, 100.0, Buttons::RIGHT_1), // left released; right alone stays invalid
            frame(end_t + 50.0, 200.0, 100.0, Buttons::RIGHT_1),
        ]);
        let timeline = simulate(&beatmap, &frames).unwrap();
        let kinds: Vec<_> = timeline.events.iter().map(|e| e.kind).collect();
        assert_eq!(kinds[0], JudgementKind::SliderHead { hit: true });
        // the restriction stayed engaged from the simultaneous press: the
        // tick and tail both miss even though right is held the whole time
        assert_eq!(kinds[1], JudgementKind::SliderTick { hit: false });
        assert_eq!(kinds[2], JudgementKind::SliderTail { hit: false });
        assert_eq!(kinds[3], JudgementKind::SliderAggregate(HitGrade::Meh)); // 1/3 hit
    }

    #[test]
    fn tail_waits_for_the_last_tick_before_judging() {
        // tick rate 1.5 -> tick distance 93.33 -> tick at t + 333.3, inside
        // the (end-36, end) window (duration 357.1): the tail becomes
        // eligible at end-36 = t+321.1 but must wait for the tick
        let beatmap = slider_map(1.5, 0);
        let head_t = 1000.0;
        let end_t = beatmap.objects[0].end_time;
        let tick_t = beatmap_tick_time(&beatmap); // helper: first tick's time
        assert!(tick_t > end_t + crate::beatmap::slider_events::TAIL_LENIENCY);
        let frames = wrap(vec![
            frame(head_t, 100.0, 100.0, Buttons::LEFT_1),
            frame(end_t, 200.0, 100.0, Buttons::LEFT_1),
            frame(end_t + 50.0, 200.0, 100.0, 0),
        ]);
        let timeline = simulate(&beatmap, &frames).unwrap();
        let tick_event = timeline.events.iter().find(|e| matches!(e.kind, JudgementKind::SliderTick { .. })).unwrap();
        let tail_event = timeline.events.iter().find(|e| matches!(e.kind, JudgementKind::SliderTail { .. })).unwrap();
        assert!(tail_event.time >= tick_event.time, "tail may not outrun the last tick");
        assert_eq!(tail_event.kind, JudgementKind::SliderTail { hit: true });
    }
}
