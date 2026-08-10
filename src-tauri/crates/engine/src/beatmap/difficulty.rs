//! difficulty-derived scalar values.
//! sources: osu.game/beatmaps/ibeatmapdifficultyinfo.cs (ranges),
//! osu.game/rulesets/objects/legacy/legacyrulesetextensions.cs:46-59 (scale),
//! osu.game.rulesets.osu/objects/osuhitobject.cs (preempt/fade constants),
//! osu.game.rulesets.osu/scoring/osuhitwindows.cs (windows)

use crate::math::dotnet_double_to_i32_unchecked;

/// osuhitobject.cs:22
pub const OBJECT_RADIUS: f32 = 64.0;
/// osuhitobject.cs:37-47
pub const PREEMPT_MIN: f64 = 450.0;
pub const PREEMPT_MID: f64 = 1200.0;
pub const PREEMPT_MAX: f64 = 1800.0;
/// osuhitwindows.cs:19 -- fixed regardless of od
pub const MISS_WINDOW: f64 = 400.0;

/// ibeatmapdifficultyinfo.cs:57-65
pub fn difficulty_range(difficulty: f64, min: f64, mid: f64, max: f64) -> f64 {
    if difficulty > 5.0 {
        mid + (max - mid) * ((difficulty - 5.0) / 5.0)
    } else if difficulty < 5.0 {
        mid + (mid - min) * ((difficulty - 5.0) / 5.0)
    } else {
        mid
    }
}

/// ibeatmapdifficultyinfo.cs:120-121 -- the `(int)` truncation is the point
pub fn difficulty_range_int(difficulty: f64, min: f64, mid: f64, max: f64) -> i32 {
    dotnet_double_to_i32_unchecked(difficulty_range(difficulty, min, mid, max))
}

/// legacyrulesetextensions.cs:46-59 with the fudge always applied (the osu!
/// ruleset always passes applyFudge: true, osuhitobject.cs:182). the 0.7f
/// literal must widen through f32 exactly as c# promotes it
pub fn scale_from_circle_size(circle_size: f32) -> f32 {
    const BROKEN_GAMEFIELD_ROUNDING_ALLOWANCE: f32 = 1.00041;
    ((1.0f64 - (0.7f32 as f64) * ((circle_size as f64 - 5.0) / 5.0)) as f32) / 2.0
        * BROKEN_GAMEFIELD_ROUNDING_ALLOWANCE
}

/// osuhitobject.cs:174 -- integral by construction via difficultyrangeint
pub fn preempt_from_approach_rate(approach_rate: f32) -> f64 {
    difficulty_range_int(approach_rate as f64, PREEMPT_MAX, PREEMPT_MID, PREEMPT_MIN) as f64
}

/// osuhitobject.cs:180
pub fn fade_in_from_preempt(preempt: f64) -> f64 {
    400.0 * f64::min(1.0, preempt / PREEMPT_MIN)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HitGrade {
    Great,
    Ok,
    Meh,
    Miss,
}

#[derive(Debug, Clone, PartialEq)]
pub struct OsuHitWindows {
    great: f64,
    ok: f64,
    meh: f64,
}

impl OsuHitWindows {
    /// osuhitwindows.cs:39-44
    pub fn from_overall_difficulty(od: f32) -> OsuHitWindows {
        let od = od as f64;
        OsuHitWindows {
            great: difficulty_range(od, 80.0, 50.0, 20.0).floor() - 0.5,
            ok: difficulty_range(od, 140.0, 100.0, 60.0).floor() - 0.5,
            meh: difficulty_range(od, 200.0, 150.0, 100.0).floor() - 0.5,
        }
    }

    pub fn great(&self) -> f64 {
        self.great
    }

    pub fn ok(&self) -> f64 {
        self.ok
    }

    pub fn meh(&self) -> f64 {
        self.meh
    }

    /// hitwindows.cs:82-93 walked top-down over the results osuhitwindows
    /// allows (great/ok/meh/miss); none past the fixed miss window
    pub fn result_for(&self, time_offset: f64) -> Option<HitGrade> {
        let t = time_offset.abs();
        if t <= self.great {
            Some(HitGrade::Great)
        } else if t <= self.ok {
            Some(HitGrade::Ok)
        } else if t <= self.meh {
            Some(HitGrade::Meh)
        } else if t <= MISS_WINDOW {
            Some(HitGrade::Miss)
        } else {
            None
        }
    }

    /// hitwindows.cs:109 -- gated on the lowest successful window (meh), which
    /// is when a late unclicked object becomes a guaranteed miss
    pub fn can_be_hit(&self, time_offset: f64) -> bool {
        time_offset <= self.meh
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn difficulty_range_is_piecewise_linear() {
        // ibeatmapdifficultyinfo.cs:57-65
        assert_eq!(difficulty_range(5.0, 1800.0, 1200.0, 450.0), 1200.0);
        assert_eq!(difficulty_range(9.0, 1800.0, 1200.0, 450.0), 600.0);
        assert_eq!(difficulty_range(0.0, 1800.0, 1200.0, 450.0), 1800.0);
        assert_eq!(difficulty_range(10.0, 1800.0, 1200.0, 450.0), 450.0);
        assert_eq!(difficulty_range(2.5, 1800.0, 1200.0, 450.0), 1500.0);
    }

    #[test]
    fn preempt_truncates_like_stable() {
        // difficultyrangeint truncates via the (int) cast
        // (ibeatmapdifficultyinfo.cs:120-121). ar 8.3 as an f32 is
        // 8.30000019..., so the range lands at 704.99997... and the cast makes
        // the preempt 704, not 705 -- this is the parity-relevant part
        assert_eq!(preempt_from_approach_rate(9.0), 600.0);
        assert_eq!(preempt_from_approach_rate(5.0), 1200.0);
        assert_eq!(preempt_from_approach_rate(10.0), 450.0);
        assert_eq!(preempt_from_approach_rate(8.3), 704.0);
    }

    #[test]
    fn fade_in_shrinks_proportionally_below_preempt_min() {
        // osuhitobject.cs:180
        assert_eq!(fade_in_from_preempt(1200.0), 400.0);
        assert_eq!(fade_in_from_preempt(450.0), 400.0);
        assert_eq!(fade_in_from_preempt(300.0), 400.0 * (300.0 / 450.0));
    }

    #[test]
    fn scale_matches_lazer_float_semantics() {
        // legacyrulesetextensions.cs:56-58 computed by hand with the exact c#
        // widening: (float)(1.0 - (double)0.7f * ((cs - 5) / 5)) / 2 * 1.00041f
        let expected_cs4 =
            ((1.0f64 - (0.7f32 as f64) * ((4.0f32 as f64 - 5.0) / 5.0)) as f32) / 2.0 * 1.00041f32;
        assert_eq!(scale_from_circle_size(4.0), expected_cs4);
        // cs 5 collapses the range term to zero exactly
        assert_eq!(scale_from_circle_size(5.0), 0.5f32 * 1.00041f32);
    }

    #[test]
    fn hit_windows_apply_the_floor_minus_half_quirk() {
        // osuhitwindows.cs:39-44 -- od 5 ranges are (50, 100, 150) exactly, so
        // the windows are 49.5 / 99.5 / 149.5
        let w = OsuHitWindows::from_overall_difficulty(5.0);
        assert_eq!(w.great(), 49.5);
        assert_eq!(w.ok(), 99.5);
        assert_eq!(w.meh(), 149.5);

        let w10 = OsuHitWindows::from_overall_difficulty(10.0);
        assert_eq!(w10.great(), 19.5);
    }

    #[test]
    fn result_for_walks_windows_and_ends_at_the_fixed_miss_window() {
        let w = OsuHitWindows::from_overall_difficulty(5.0);
        assert_eq!(w.result_for(0.0), Some(HitGrade::Great));
        assert_eq!(w.result_for(-49.5), Some(HitGrade::Great));
        assert_eq!(w.result_for(49.6), Some(HitGrade::Ok));
        assert_eq!(w.result_for(99.6), Some(HitGrade::Meh));
        assert_eq!(w.result_for(149.6), Some(HitGrade::Miss));
        assert_eq!(w.result_for(-400.0), Some(HitGrade::Miss));
        assert_eq!(w.result_for(400.1), None);
    }

    #[test]
    fn can_be_hit_gates_on_the_meh_window_not_the_miss_window() {
        // hitwindows.cs:109 -- the gate is the lowest successful window. this
        // is what makes circles auto-miss at start + meh, not start + 400
        let w = OsuHitWindows::from_overall_difficulty(5.0);
        assert!(w.can_be_hit(149.5));
        assert!(!w.can_be_hit(149.6));
    }
}
