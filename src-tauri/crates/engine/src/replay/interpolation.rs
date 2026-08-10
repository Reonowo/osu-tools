//! cursor state sampling: a stateless equivalent of
//! framedreplayinputhandler.cs's frame walk feeding
//! osuframedreplayinputhandler.cs's interpolation.
//!
//! the lazer handler is stateful (setframefromtime advances one frame per
//! call and the driver loops it), but over a sorted frame list its observable
//! state at time t is fully determined: the current frame is the last frame
//! with `time <= t`, and currenttime is t clamped into [current.time,
//! next.time]. equal-time frames collapse to the last of the run, exactly
//! where repeated single-step advancement lands (framedreplayinputhandler.cs:
//! 141-146; pinned by osu.Game.Tests/NonVisual/FramedReplayInputHandlerTest.cs's
//! TestMultipleFramesSameTime, whose comment reads "forward direction is
//! prioritized when multiple frames have the same time"). the fixture suite
//! (task 10) drives lazer's real stateful handler, settling it fully at each
//! sample time before recording -- see replaydumps.cs's drain loop -- so this
//! function must reproduce that settled state sample for sample

use crate::math::Vec2;
use crate::replay::frames::{Buttons, ReplayFrame};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CursorSample {
    pub pos: Vec2,
    pub buttons: Buttons,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OsuAction {
    Left,
    Right,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Press {
    pub time: f64,
    pub action: OsuAction,
    pub frame_index: usize,
}

pub fn cursor_state_at(frames: &[ReplayFrame], time: f64) -> Option<CursorSample> {
    if frames.is_empty() {
        return None;
    }
    let idx = frames.partition_point(|f| f.time <= time);
    if idx == 0 {
        // before the first frame: startframe == endframe == frames[0]
        // (framedreplayinputhandler.cs:48-72 with currentframeindex -1) and
        // currentframe is null, so nothing is pressed. an exact query at
        // frames[0].time is not "before" anything: it lands here only when
        // time < frames[0].time strictly, since the partition predicate
        // includes an exact match, pushing idx to at least 1 in that case
        return Some(CursorSample {
            pos: frames[0].pos,
            buttons: Buttons::default(),
        });
    }
    // framedreplayinputhandler.cs:141-146 -- when query time matches a run of
    // equal-time frames exactly, the handler settles on the last of the run
    // (forward-direction convergence via repeated single-step advancement);
    // partition_point's `<=` predicate already selects that frame directly
    let start = &frames[idx - 1];
    let end = frames.get(idx).unwrap_or(start);
    // setframefromtime clamps currenttime into the frame interval
    let clamped = time.clamp(start.time, end.time);
    Some(CursorSample {
        pos: vector2_value_at(clamped, start.pos, end.pos, start.time, end.time),
        buttons: start.buttons,
    })
}

/// interpolation.cs:351-361 -- float-space lerp with the framework's exact
/// zero-duration and zero-elapsed early-outs
fn vector2_value_at(time: f64, val1: Vec2, val2: Vec2, start_time: f64, end_time: f64) -> Vec2 {
    let current = (time - start_time) as f32;
    let duration = (end_time - start_time) as f32;
    if duration == 0.0 || current == 0.0 {
        return val1;
    }
    let t = current / duration;
    val1 + t * (val2 - val1)
}

/// rising edges of the two gameplay buttons in replay order. within one frame
/// left precedes right, matching the pressedactions list order lazer builds in
/// osureplayframe.cs (left added first) and dispatches in list order
pub fn press_edges(frames: &[ReplayFrame]) -> Vec<Press> {
    let mut presses = Vec::new();
    let mut prev = Buttons::default();
    for (frame_index, frame) in frames.iter().enumerate() {
        if frame.buttons.left() && !prev.left() {
            presses.push(Press {
                time: frame.time,
                action: OsuAction::Left,
                frame_index,
            });
        }
        if frame.buttons.right() && !prev.right() {
            presses.push(Press {
                time: frame.time,
                action: OsuAction::Right,
                frame_index,
            });
        }
        prev = frame.buttons;
    }
    presses
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::Vec2;
    use crate::replay::frames::{Buttons, ReplayFrame};

    fn frame(time: f64, x: f32, y: f32, raw: u32) -> ReplayFrame {
        ReplayFrame {
            time,
            pos: Vec2::new(x, y),
            buttons: Buttons::new(raw),
        }
    }

    #[test]
    fn empty_frames_yield_none() {
        assert!(cursor_state_at(&[], 0.0).is_none());
    }

    #[test]
    fn before_the_first_frame_the_first_position_holds_and_nothing_is_pressed() {
        // framedreplayinputhandler.cs:35 -- currentframe is null before the
        // first frame, so pressedactions is empty, while startframe/endframe
        // both resolve to frames[0]
        let frames = [frame(100.0, 10.0, 20.0, 1), frame(200.0, 30.0, 40.0, 1)];
        let s = cursor_state_at(&frames, -50.0).unwrap();
        assert_eq!(s.pos, Vec2::new(10.0, 20.0));
        assert!(!s.buttons.left());
    }

    #[test]
    fn exactly_at_the_first_frames_own_time_its_actual_state_holds() {
        // a unique (non-duplicate) frame at time == the query must report its
        // own position and buttons, not the before-first-frame default of
        // nothing pressed: partition_point's `<=` predicate already includes
        // an exact match, so idx lands on 1 (not 0) here and start resolves
        // to frames[0] itself
        let frames = [
            frame(100.0, 10.0, 20.0, Buttons::LEFT_1),
            frame(200.0, 30.0, 40.0, 0),
        ];
        let s = cursor_state_at(&frames, 100.0).unwrap();
        assert_eq!(s.pos, Vec2::new(10.0, 20.0));
        assert!(s.buttons.left());
    }

    #[test]
    fn interpolates_between_frames_in_float_space() {
        // interpolation.cs:351-361: t = (float)(time-start) / (float)duration
        let frames = [frame(0.0, 0.0, 0.0, 0), frame(100.0, 10.0, 20.0, 1)];
        let s = cursor_state_at(&frames, 25.0).unwrap();
        let t = 25.0f32 / 100.0f32;
        assert_eq!(
            s.pos,
            Vec2::new(0.0, 0.0) + t * (Vec2::new(10.0, 20.0) - Vec2::new(0.0, 0.0))
        );
        // buttons come from the frame at or before the sample, uninterpolated
        assert!(!s.buttons.left());
        let s = cursor_state_at(&frames, 100.0).unwrap();
        assert_eq!(s.pos, Vec2::new(10.0, 20.0));
        assert!(s.buttons.left());
    }

    #[test]
    fn exactly_at_a_frame_time_the_frame_position_holds() {
        // current == 0 early-out in the framework lerp
        let frames = [
            frame(0.0, 0.0, 0.0, 0),
            frame(100.0, 10.0, 20.0, 0),
            frame(200.0, 50.0, 50.0, 0),
        ];
        let s = cursor_state_at(&frames, 100.0).unwrap();
        assert_eq!(s.pos, Vec2::new(10.0, 20.0));
    }

    #[test]
    fn after_the_last_frame_the_last_state_holds() {
        let frames = [frame(0.0, 0.0, 0.0, 0), frame(100.0, 10.0, 20.0, 2)];
        let s = cursor_state_at(&frames, 5000.0).unwrap();
        assert_eq!(s.pos, Vec2::new(10.0, 20.0));
        assert!(s.buttons.right());
    }

    #[test]
    fn duplicate_time_frames_resolve_to_the_last_at_exact_time() {
        // framedreplayinputhandler.cs:141-146 -- when query time matches a
        // duplicate-time run exactly, the handler settles on the last frame
        // of the run via forward-direction single-step convergence, pinned by
        // FramedReplayInputHandlerTest.cs's TestMultipleFramesSameTime ("forward
        // direction is prioritized when multiple frames have the same time")
        let frames = [
            frame(0.0, 0.0, 0.0, 0),
            frame(100.0, 10.0, 10.0, 1),
            frame(100.0, 90.0, 90.0, 2),
        ];
        let s = cursor_state_at(&frames, 100.0).unwrap();
        assert_eq!(s.pos, Vec2::new(90.0, 90.0));
        assert!(s.buttons.right());
        // past the duplicates, interpolation still uses the last of the run
        let s = cursor_state_at(&frames, 150.0).unwrap();
        assert_eq!(s.pos, Vec2::new(90.0, 90.0));
        assert!(s.buttons.right());
    }

    #[test]
    fn press_edges_fire_once_per_action_left_first() {
        let frames = [
            frame(0.0, 0.0, 0.0, 0),
            frame(16.0, 0.0, 0.0, Buttons::LEFT_1 | Buttons::RIGHT_1),
            // k1 joins m1: still left, no new edge
            frame(
                32.0,
                0.0,
                0.0,
                Buttons::LEFT_1 | Buttons::LEFT_2 | Buttons::RIGHT_1,
            ),
            frame(48.0, 0.0, 0.0, 0),
            frame(64.0, 0.0, 0.0, Buttons::LEFT_2),
        ];
        let presses = press_edges(&frames);
        assert_eq!(presses.len(), 3);
        assert_eq!((presses[0].time, presses[0].action), (16.0, OsuAction::Left));
        assert_eq!((presses[1].time, presses[1].action), (16.0, OsuAction::Right));
        assert_eq!((presses[2].time, presses[2].action), (64.0, OsuAction::Left));
        assert_eq!(presses[2].frame_index, 4);
    }
}
