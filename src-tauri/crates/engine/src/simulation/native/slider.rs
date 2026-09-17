//! the native slider: lazer's `SliderInputManager` (sliderinputmanager.cs)
//! and the nested judgement rules its drawables delegate to it.
//!
//! - tracking (lines 216-290, `updateTracking`): recomputed every update
//!   from the cursor's position against the ball, expanded to the follow
//!   area while already tracking, and from the pressed actions under the
//!   accepted-key rule -- a head hit while no other button was down accepts
//!   either button from then on; a head hit while the other button was down
//!   accepts only its own button until the other is seen released in a
//!   previous update. the head's action is the one the first hovered press
//!   carried, hit or shaken (drawablehitcircle.cs:277-306, `HitAction ??=`),
//!   and it is assigned AFTER that press's judgement ran, so the post-head
//!   tracking update still sees no action restriction;
//! - nested judgement (lines 142-178, `TryJudgeNestedObject`): a tick or
//!   repeat from its own time, the tail from 36ms before the end and only
//!   once the last tick or repeat has judged, none before the head has; a
//!   hit at once while tracking, a miss only from the element's own time;
//! - the late head (lines 84-140, `PostProcessHeadJudgement`): every passed
//!   unjudged element is hit forcefully when the cursor sits inside the
//!   expanded follow area of each of their positions, missed forcefully
//!   otherwise, and tracking is re-evaluated at once.
//!
//! the slider's own result (drawableslider.cs:293-326) is the walk's: an
//! ignore hit once the tail has judged and the end time has passed, hit
//! when any nested element was

use crate::beatmap::{NestedKind, ProcessedObject, ProcessedSlider};
use crate::math::Vec2;
use crate::replay::interpolation::OsuAction;
use crate::score::HitResult;
use crate::simulation::native::Actions;

/// drawablesliderball.cs:19 -- the follow circle's expansion while tracking
const FOLLOW_AREA: f32 = 2.4;

/// slidereventgenerator.cs:24 -- how early the tail may judge
pub(crate) const TAIL_LENIENCY: f64 = -36.0;

#[derive(Debug)]
pub(crate) struct SliderRun {
    pub tracking: bool,
    /// the head receptor's `HitAction`
    pub head_hit_action: Option<OsuAction>,
    time_to_accept_any_key_after: Option<f64>,
    /// the last tick or repeat in nested order, whose judgement the tail
    /// waits for
    pub last_tick_index: Option<usize>,
    pub tail_index: usize,
}

impl SliderRun {
    pub fn new(slider: &ProcessedSlider) -> SliderRun {
        let last_tick_index = slider
            .nested
            .iter()
            .rposition(|n| matches!(n.kind, NestedKind::Tick | NestedKind::Repeat));
        let tail_index = slider
            .nested
            .iter()
            .position(|n| n.kind == NestedKind::Tail)
            .unwrap_or(slider.nested.len().saturating_sub(1));
        SliderRun {
            tracking: false,
            head_hit_action: None,
            time_to_accept_any_key_after: None,
            last_tick_index,
            tail_index,
        }
    }

    /// sliderinputmanager.cs:184-196 -- the cursor against the ball at
    /// `time`, within the plain radius or the expanded follow area
    pub fn is_mouse_in_follow_area(
        obj: &ProcessedObject,
        slider: &ProcessedSlider,
        radius: f32,
        time: f64,
        pos: Vec2,
        expanded: bool,
    ) -> bool {
        let radius = if expanded { radius * FOLLOW_AREA } else { radius };
        let follow_progress = ((time - obj.start_time) / slider.duration).clamp(0.0, 1.0);
        let follow_circle = slider.curve_position_at(follow_progress);
        let mouse_in_slider = pos - obj.stacked_position;
        (mouse_in_slider - follow_circle).length_squared() <= radius * radius
    }

    /// sliderinputmanager.cs:216-268 -- `updateTracking`, given whether the
    /// cursor position counts as valid for this update
    pub fn update_tracking(
        &mut self,
        time: f64,
        end_time: f64,
        all_judged: bool,
        pressed: Actions,
        valid_position: bool,
    ) {
        let head_action = self.head_hit_action;
        if head_action.is_none() {
            self.time_to_accept_any_key_after = None;
        }
        // any button becomes acceptable once the other button is seen up.
        //
        // DELIBERATE DIVERGENCE, and the one place this rule is not a line
        // port: lazer reads `lastPressedActions`, the set the PREVIOUS
        // update filled at its own end (sliderinputmanager.cs:252-261), so
        // the unlock costs three passes -- one to observe the release, one
        // to arm, and a third for `Time.Current <= ...` to stop being true.
        // that is three of lazer's DISPLAY frames, a few milliseconds; a
        // walk paying it over three of the instants IT visits would charge
        // up to two whole replay frames for the same rule, which is not the
        // same behaviour and is measurably harsher (it costs ticks, repeats
        // and tails a real client keeps). this walk takes the limit of an
        // arbitrarily fast display everywhere else, so it takes it here too:
        // reading THIS pass's set collapses the first two passes into the
        // instant that observes the release, and the `time <= after` test
        // below keeps that instant itself restricted -- exactly where the
        // three-display-frame rule converges as the display rate rises. see
        // the module doc's "the sub-frame limit"
        if let Some(head_action) = head_action {
            if self.time_to_accept_any_key_after.is_none() {
                let other = match head_action {
                    OsuAction::Left => OsuAction::Right,
                    OsuAction::Right => OsuAction::Left,
                };
                if !pressed.contains(other) {
                    self.time_to_accept_any_key_after = Some(time);
                }
            }
        }

        let valid_action = pressed.iter().any(|action| self.is_valid_tracking_action(action, time));

        // even past the slider's time an unfinished judgement keeps the
        // tracking state readable rather than dropping it
        self.tracking = (!all_judged || time <= end_time) && valid_position && valid_action;
    }

    /// sliderinputmanager.cs:272-282
    fn is_valid_tracking_action(&self, action: OsuAction, time: f64) -> bool {
        if let Some(head_action) = self.head_hit_action {
            let restricted = match self.time_to_accept_any_key_after {
                None => true,
                Some(after) => time <= after,
            };
            if restricted {
                return action == head_action;
            }
        }
        true
    }
}

/// what `TryJudgeNestedObject` (sliderinputmanager.cs:142-178) decides for
/// one nested element at one update, given the element's kind, its time
/// offset, whether the slider's tracking is on, and the two gates it reads
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NestedVerdict {
    Wait,
    Hit,
    Miss,
}

pub(crate) fn nested_verdict(
    kind: NestedKind,
    time_offset: f64,
    tracking: bool,
    head_judged: bool,
    last_tick_judged: bool,
) -> NestedVerdict {
    match kind {
        NestedKind::Tick | NestedKind::Repeat => {
            if time_offset < 0.0 {
                return NestedVerdict::Wait;
            }
        }
        NestedKind::Tail => {
            if time_offset < TAIL_LENIENCY {
                return NestedVerdict::Wait;
            }
            // the tail activates only after every tick and repeat has, so the
            // leniency cannot reorder score and combo
            if !last_tick_judged {
                return NestedVerdict::Wait;
            }
        }
        NestedKind::Head => return NestedVerdict::Wait,
    }
    if !head_judged {
        return NestedVerdict::Wait;
    }
    if tracking {
        NestedVerdict::Hit
    } else if time_offset >= 0.0 {
        NestedVerdict::Miss
    } else {
        NestedVerdict::Wait
    }
}

/// the result a nested element takes when hit or missed forcefully: its
/// judgement's maximum or minimum (slidertick.cs, sliderendcircle.cs:53,
/// slidertailcircle.cs:32 with judgement.cs:61-85)
pub(crate) fn nested_result(kind: NestedKind, hit: bool) -> HitResult {
    match (kind, hit) {
        (NestedKind::Head, true) => HitResult::Great,
        (NestedKind::Head, false) => HitResult::Miss,
        (NestedKind::Tick | NestedKind::Repeat, true) => HitResult::LargeTickHit,
        (NestedKind::Tick | NestedKind::Repeat, false) => HitResult::LargeTickMiss,
        (NestedKind::Tail, true) => HitResult::SliderTailHit,
        (NestedKind::Tail, false) => HitResult::IgnoreMiss,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_tail_waits_for_the_last_tick_and_misses_only_at_the_end() {
        // inside the leniency window, tracking, but the last tick unjudged
        assert_eq!(
            nested_verdict(NestedKind::Tail, -20.0, true, true, false),
            NestedVerdict::Wait
        );
        // the last tick judged: a hit at once
        assert_eq!(
            nested_verdict(NestedKind::Tail, -20.0, true, true, true),
            NestedVerdict::Hit
        );
        // not tracking inside the window: not yet a miss
        assert_eq!(
            nested_verdict(NestedKind::Tail, -20.0, false, true, true),
            NestedVerdict::Wait
        );
        // not tracking at the end: a miss
        assert_eq!(
            nested_verdict(NestedKind::Tail, 0.0, false, true, true),
            NestedVerdict::Miss
        );
        // before the leniency point nothing happens even while tracking
        assert_eq!(
            nested_verdict(NestedKind::Tail, -40.0, true, true, true),
            NestedVerdict::Wait
        );
    }

    #[test]
    fn a_tick_needs_the_head_judged_and_its_own_time() {
        assert_eq!(
            nested_verdict(NestedKind::Tick, -1.0, true, true, true),
            NestedVerdict::Wait
        );
        assert_eq!(
            nested_verdict(NestedKind::Tick, 0.0, true, false, true),
            NestedVerdict::Wait
        );
        assert_eq!(
            nested_verdict(NestedKind::Tick, 0.0, true, true, true),
            NestedVerdict::Hit
        );
        assert_eq!(
            nested_verdict(NestedKind::Tick, 5.0, false, true, true),
            NestedVerdict::Miss
        );
    }

    #[test]
    fn the_accepted_key_rule_restricts_a_head_hit_while_the_other_button_was_down() {
        let mut run = SliderRun {
            tracking: false,
            head_hit_action: Some(OsuAction::Right),
            time_to_accept_any_key_after: None,
            last_tick_index: None,
            tail_index: 0,
        };
        // both down: only right tracks
        run.update_tracking(
            100.0,
            1000.0,
            false,
            Actions {
                left: true,
                right: true,
            },
            true,
        );
        assert!(run.tracking);
        // right released with left still down: left is not accepted
        run.update_tracking(
            120.0,
            1000.0,
            false,
            Actions {
                left: true,
                right: false,
            },
            true,
        );
        assert!(!run.tracking);
        // left released too: this update SEES the other button up, so it is
        // the one that arms the rule -- the display-rate limit, where
        // lazer's observe-then-arm pair collapses onto the instant the
        // release happens (see update_tracking's divergence note)
        run.update_tracking(140.0, 1000.0, false, Actions::default(), true);
        assert_eq!(run.time_to_accept_any_key_after, Some(140.0));
        assert!(!run.tracking, "the arming update itself still answers to the head's own button");
        // pressed again at the next instant: strictly past the arming time,
        // so left tracks
        run.update_tracking(
            160.0,
            1000.0,
            false,
            Actions {
                left: true,
                right: false,
            },
            true,
        );
        assert!(run.tracking, "from the first instant past the arming one, either button tracks");
    }

    #[test]
    fn a_head_hit_with_the_other_button_up_accepts_either_from_the_next_update() {
        let mut run = SliderRun {
            tracking: false,
            head_hit_action: Some(OsuAction::Left),
            time_to_accept_any_key_after: None,
            last_tick_index: None,
            tail_index: 0,
        };
        run.update_tracking(
            100.0,
            1000.0,
            false,
            Actions {
                left: true,
                right: false,
            },
            true,
        );
        assert_eq!(run.time_to_accept_any_key_after, Some(100.0));
        run.update_tracking(
            120.0,
            1000.0,
            false,
            Actions {
                left: false,
                right: true,
            },
            true,
        );
        assert!(run.tracking, "right tracks once the rule opened");
    }
}
