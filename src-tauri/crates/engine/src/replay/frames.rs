//! converts decoded `.osr` actions into playback frames, porting
//! legacyscoredecoder.cs:268-352: cumulative frame times, stable's
//! replaywatcher first-frame fixups, intro-frame removal, and
//! backwards-time drops. button bits per legacyreplayframe.cs

use crate::formats::beatmap::EARLY_VERSION_TIMING_OFFSET;
use crate::formats::osr::{ReplayAction, SEED_FRAME_DELTA};
use crate::math::Vec2;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Buttons {
    pub raw: u32,
}

impl Buttons {
    pub const LEFT_1: u32 = 1;
    pub const RIGHT_1: u32 = 2;
    pub const LEFT_2: u32 = 4;
    pub const RIGHT_2: u32 = 8;
    pub const SMOKE: u32 = 16;

    pub fn new(raw: u32) -> Buttons {
        Buttons { raw }
    }

    /// legacyreplayframe.cs -- mouseleft is left1 or left2, so k1 and m1 are
    /// one gameplay action
    pub fn left(self) -> bool {
        self.raw & (Self::LEFT_1 | Self::LEFT_2) != 0
    }

    pub fn right(self) -> bool {
        self.raw & (Self::RIGHT_1 | Self::RIGHT_2) != 0
    }

    pub fn smoke(self) -> bool {
        self.raw & Self::SMOKE != 0
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ReplayFrame {
    pub time: f64,
    pub pos: Vec2,
    pub buttons: Buttons,
}

pub fn convert_frames(actions: &[ReplayAction], beatmap_format_version: i32) -> Vec<ReplayFrame> {
    // legacyscoredecoder.cs:98,270 -- the same offset the beatmap side bakes
    // into pre-v5 object times seeds the cumulative frame time
    let mut last_time: i64 = if beatmap_format_version < 5 {
        EARLY_VERSION_TIMING_OFFSET as i64
    } else {
        0
    };

    let mut legacy: Vec<ReplayFrame> = Vec::new();
    for action in actions {
        // legacyscoredecoder.cs:282-286 -- the rng-seed pseudo-frame never
        // becomes a gameplay frame. lazer compares the raw token text;
        // formats::osr's SEED_FRAME_DELTA doc covers why the integer compare
        // here is observationally identical for every encoder-written file
        if action.delta == SEED_FRAME_DELTA {
            continue;
        }
        // saturation preserves monotonicity and never panics; wrapped negative time would be dropped by backwards-time filter, saturation keeps behaviour sane
        last_time = last_time.saturating_add(action.delta);
        legacy.push(ReplayFrame {
            time: last_time as f64,
            pos: Vec2::new(action.x, action.y),
            // the same bit-preserving cast lazer's `(ReplayButtonState)` does
            buttons: Buttons::new(action.z as u32),
        });
    }

    // stable replaywatcher fixups, ported at legacyscoredecoder.cs:319-328
    if legacy.len() >= 2 && legacy[1].time < legacy[0].time {
        legacy[1].time = legacy[0].time;
        legacy[0].time = 0.0;
    }
    if legacy.len() >= 3 && legacy[0].time > legacy[2].time {
        let time = legacy[2].time;
        legacy[0].time = time;
        legacy[1].time = time;
    }

    // legacyscoredecoder.cs:330-337 -- stable writes two intro frames at
    // (256, -500); index 1 is removed before index 0, as in the source
    let intro = Vec2::new(256.0, -500.0);
    if legacy.len() >= 2 && legacy[1].pos == intro {
        legacy.remove(1);
    }
    if !legacy.is_empty() && legacy[0].pos == intro {
        legacy.remove(0);
    }

    // legacyscoredecoder.cs:341-351 -- never allow backwards time traversal
    let mut frames: Vec<ReplayFrame> = Vec::with_capacity(legacy.len());
    for frame in legacy {
        if let Some(last) = frames.last() {
            if frame.time < last.time {
                continue;
            }
        }
        frames.push(frame);
    }
    frames
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::formats::osr::ReplayAction;

    fn action(delta: i64, x: f32, y: f32, z: i32) -> ReplayAction {
        ReplayAction { delta, x, y, z }
    }

    #[test]
    fn accumulates_deltas_and_decodes_buttons() {
        let frames = convert_frames(
            &[
                action(100, 10.0, 20.0, 0),
                action(16, 11.0, 21.0, 5),
                action(16, 12.0, 22.0, 2),
            ],
            14,
        );
        assert_eq!(frames.len(), 3);
        assert_eq!(frames[0].time, 100.0);
        assert_eq!(frames[1].time, 116.0);
        assert_eq!(frames[2].time, 132.0);
        // 5 = left1 | left2 -- k1 and m1 held together is still just "left"
        assert!(frames[1].buttons.left());
        assert!(!frames[1].buttons.right());
        assert!(frames[2].buttons.right());
    }

    #[test]
    fn seed_pseudo_frame_is_dropped() {
        // legacyscoredecoder.cs:282-286
        let frames = convert_frames(&[action(100, 10.0, 20.0, 0), action(-12345, 0.0, 0.0, 1337)], 14);
        assert_eq!(frames.len(), 1);
    }

    #[test]
    fn early_format_versions_seed_the_time_with_24ms() {
        // legacyscoredecoder.cs:98 + :270
        let frames = convert_frames(&[action(100, 10.0, 20.0, 0)], 4);
        assert_eq!(frames[0].time, 124.0);
        let frames = convert_frames(&[action(100, 10.0, 20.0, 0)], 5);
        assert_eq!(frames[0].time, 100.0);
    }

    #[test]
    fn stable_first_frame_fixups_apply_in_order() {
        // legacyscoredecoder.cs:319-324: frames[1] earlier than frames[0]
        // pins frame 0 to time 0 and frame 1 to frame 0's old time
        let frames = convert_frames(
            &[
                action(100, 1.0, 1.0, 0),
                action(-50, 2.0, 2.0, 0),
                action(400, 3.0, 3.0, 0),
            ],
            14,
        );
        assert_eq!(frames[0].time, 0.0);
        assert_eq!(frames[1].time, 100.0);
        assert_eq!(frames[2].time, 450.0);

        // legacyscoredecoder.cs:326-328: frame 0 later than frame 2 drags
        // frames 0 and 1 back to frame 2's time
        let frames = convert_frames(
            &[
                action(1000, 1.0, 1.0, 0),
                action(-900, 2.0, 2.0, 0),
                action(400, 3.0, 3.0, 0),
            ],
            14,
        );
        // first fixup runs first: [1000, 100, 500] -> [0, 1000, ...] no --
        // frames[1] (100) < frames[0] (1000): frame1 = 1000, frame0 = 0,
        // then frame0 (0) > frame2 (500)? no. so only the first fires
        assert_eq!(frames[0].time, 0.0);
        assert_eq!(frames[1].time, 1000.0);
    }

    #[test]
    fn intro_frames_at_256_minus_500_are_removed() {
        // legacyscoredecoder.cs:330-337
        let frames = convert_frames(
            &[
                action(0, 256.0, -500.0, 0),
                action(1500, 256.0, -500.0, 0),
                action(500, 100.0, 100.0, 1),
            ],
            14,
        );
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].pos, Vec2::new(100.0, 100.0));
        assert_eq!(frames[0].time, 2000.0);
    }

    #[test]
    fn backwards_time_frames_are_dropped_mid_stream() {
        // legacyscoredecoder.cs:341-351
        let frames = convert_frames(
            &[
                action(100, 1.0, 1.0, 0),
                action(100, 2.0, 2.0, 0),
                action(-50, 3.0, 3.0, 0), // t 150 < 200 -> dropped
                action(100, 4.0, 4.0, 0), // t 250 -> kept
            ],
            14,
        );
        assert_eq!(frames.len(), 3);
        assert_eq!(frames[2].time, 250.0);
        assert_eq!(frames[2].pos, Vec2::new(4.0, 4.0));
    }

    #[test]
    fn empty_action_list_produces_empty_frames() {
        let frames = convert_frames(&[], 14);
        assert_eq!(frames.len(), 0);
    }

    #[test]
    fn delta_overflow_saturates_without_panic() {
        // v4 seeds last_time=24; 24.saturating_add(i64::MAX) overflows to i64::MAX
        // without fix, += would panic in debug -- verify no panic and saturated time
        let frames = convert_frames(&[action(i64::MAX, 100.0, 100.0, 0)], 4);
        assert_eq!(frames.len(), 1);
        // saturated i64::MAX as f64
        let expected = i64::MAX as f64;
        assert_eq!(frames[0].time, expected);
    }

    #[test]
    fn repeated_large_deltas_saturate_without_panic() {
        // multiple deltas that sum past i64::MAX should saturate to i64::MAX
        let frames = convert_frames(
            &[
                action(i64::MAX / 2 + 1, 1.0, 1.0, 0),
                action(i64::MAX / 2 + 1, 2.0, 2.0, 0),
            ],
            14,
        );
        assert_eq!(frames.len(), 2);
        // second frame should be at saturated i64::MAX
        assert_eq!(frames[1].time, i64::MAX as f64);
    }
}
