//! control point lookup and slider speed derivations.
//! sources: osu.game/beatmaps/controlpoints/controlpointinfo.cs:75 (timing
//! fallback), timingcontrolpoint.cs:60 (default beat length),
//! osu.game/rulesets/objects/legacy/legacyrulesetextensions.cs:17-41
//! (precision-adjusted beat length), osu.game.rulesets.osu/objects/slider.cs:158-170
//! (velocity + tick distance), osu.game.rulesets.osu/beatmaps/osubeatmapconverter.cs:47-51
//! (pre-v8 tick distance multiplier)

use crate::formats::beatmap::{DifficultyPoint, TimingPoint};

/// timingcontrolpoint.cs:60
pub const DEFAULT_BEAT_LENGTH: f64 = 1000.0;

/// last point with `time <= t`; before the first point the first point applies
/// (controlpointinfo.cs:75), and an empty list falls back to the default
pub fn timing_point_at(points: &[TimingPoint], time: f64) -> TimingPoint {
    let idx = points.partition_point(|p| p.time <= time);
    if idx == 0 {
        points.first().cloned().unwrap_or(TimingPoint {
            time: 0.0,
            beat_len: DEFAULT_BEAT_LENGTH,
        })
    } else {
        points[idx - 1].clone()
    }
}

/// last point with `time <= t`; before the first point (and for an empty list)
/// the neutral default applies -- sv 1, ticks on -- matching
/// DifficultyControlPoint.DEFAULT, deliberately unlike the timing fallback
pub fn difficulty_point_at(points: &[DifficultyPoint], time: f64) -> DifficultyPoint {
    let idx = points.partition_point(|p| p.time <= time);
    if idx == 0 {
        DifficultyPoint {
            time: 0.0,
            slider_velocity: 1.0,
            generate_ticks: true,
        }
    } else {
        points[idx - 1].clone()
    }
}

/// legacyrulesetextensions.cs:17-41, "osu"/"fruits" branch. the (float)
/// narrowing before the clamp is the stable-compatibility quirk this function
/// exists to preserve
pub fn precision_adjusted_beat_length(slider_velocity_multiplier: f64, beat_length: f64) -> f64 {
    let sv_as_beat_length = -100.0 / slider_velocity_multiplier;
    let bpm_multiplier = if sv_as_beat_length < 0.0 {
        f64::from(((-sv_as_beat_length) as f32).clamp(10.0, 1000.0)) / 100.0
    } else {
        1.0
    };
    beat_length * bpm_multiplier
}

/// slider.cs:164 -- BASE_SCORING_DISTANCE (100) * multiplier over the
/// precision-adjusted beat length
pub fn slider_velocity(slider_multiplier: f64, sv_multiplier: f64, beat_length: f64) -> f64 {
    100.0 * slider_multiplier / precision_adjusted_beat_length(sv_multiplier, beat_length)
}

/// slider.cs:165-169 -- the scoring distance is intentionally `velocity *
/// beat_length` rather than `100 * slider_multiplier`, reintroducing stable's
/// floating point error; generate_ticks false yields +infinity (no ticks)
pub fn tick_distance(
    velocity: f64,
    beat_length: f64,
    slider_tick_rate: f64,
    tick_distance_multiplier: f64,
    generate_ticks: bool,
) -> f64 {
    if !generate_ticks {
        return f64::INFINITY;
    }
    let scoring_distance = velocity * beat_length;
    scoring_distance / slider_tick_rate * tick_distance_multiplier
}

/// osubeatmapconverter.cs:47-49 -- before v8, speed multipliers do not adjust
/// tick spacing, so the converter divides it back out (`1f / sv`; 1f widens to
/// exactly 1.0)
pub fn tick_distance_multiplier(format_version: i32, sv_multiplier: f64) -> f64 {
    if format_version < 8 {
        1.0 / sv_multiplier
    } else {
        1.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::formats::beatmap::{DifficultyPoint, TimingPoint};

    fn tp(time: f64, beat_len: f64) -> TimingPoint {
        TimingPoint { time, beat_len }
    }

    fn dp(time: f64, sv: f64) -> DifficultyPoint {
        DifficultyPoint {
            time,
            slider_velocity: sv,
            generate_ticks: true,
        }
    }

    #[test]
    fn timing_lookup_takes_the_last_point_at_or_before_time() {
        let points = [tp(0.0, 500.0), tp(1000.0, 400.0)];
        assert_eq!(timing_point_at(&points, 999.9).beat_len, 500.0);
        assert_eq!(timing_point_at(&points, 1000.0).beat_len, 400.0);
        assert_eq!(timing_point_at(&points, 5000.0).beat_len, 400.0);
    }

    #[test]
    fn timing_lookup_before_the_first_point_returns_the_first_point() {
        // controlpointinfo.cs:75 -- the fallback for a non-empty list is the
        // first timing point, not a default
        let points = [tp(1000.0, 400.0)];
        assert_eq!(timing_point_at(&points, 0.0).beat_len, 400.0);
        // and an empty list falls back to timingcontrolpoint.cs:60's default
        assert_eq!(timing_point_at(&[], 0.0).beat_len, DEFAULT_BEAT_LENGTH);
    }

    #[test]
    fn difficulty_lookup_before_the_first_point_returns_the_neutral_default() {
        // legacycontrolpointinfo's difficultypointat falls back to
        // DifficultyControlPoint.DEFAULT (sv 1, ticks on), unlike timing
        let points = [dp(1000.0, 2.0)];
        let before = difficulty_point_at(&points, 0.0);
        assert_eq!(before.slider_velocity, 1.0);
        assert!(before.generate_ticks);
        assert_eq!(difficulty_point_at(&points, 1000.0).slider_velocity, 2.0);
    }

    #[test]
    fn precision_adjusted_beat_length_narrows_through_f32() {
        // legacyrulesetextensions.cs:17-41, osu branch. sv 1 -> multiplier
        // exactly 1; the quirk case is an sv whose -100/sv is not f32-exact
        assert_eq!(precision_adjusted_beat_length(1.0, 500.0), 500.0);
        // sv = 0.3 -> -100/0.3 = 333.3333333333333...; through f32 that is
        // 333.33334f, so the multiplier is (333.33334 as f64)/100, not 10/3
        let expected = 500.0 * (f64::from((100.0f64 / 0.3) as f32) / 100.0);
        assert_eq!(precision_adjusted_beat_length(0.3, 500.0), expected);
    }

    #[test]
    fn velocity_and_tick_distance_match_the_slider_defaults_pipeline() {
        // slider.cs:162-169 with sm 1.4, sv 1, beat length 500, tick rate 1:
        // velocity = 100 * 1.4 / 500; scoring distance deliberately recomputed
        // as velocity * beat length
        let v = slider_velocity(1.4, 1.0, 500.0);
        assert_eq!(v, 100.0 * 1.4 / 500.0);
        let td = tick_distance(v, 500.0, 1.0, 1.0, true);
        assert_eq!(td, v * 500.0 / 1.0 * 1.0);
    }

    #[test]
    fn generate_ticks_false_makes_tick_distance_infinite() {
        // slider.cs:169
        assert_eq!(tick_distance(0.28, 500.0, 1.0, 1.0, false), f64::INFINITY);
    }

    #[test]
    fn tick_distance_multiplier_reciprocates_sv_before_format_v8() {
        // osubeatmapconverter.cs:47-49
        assert_eq!(tick_distance_multiplier(7, 2.0), 0.5);
        assert_eq!(tick_distance_multiplier(8, 2.0), 1.0);
        assert_eq!(tick_distance_multiplier(14, 0.5), 1.0);
        assert_eq!(tick_distance_multiplier(4, 0.5), 2.0);
    }
}
