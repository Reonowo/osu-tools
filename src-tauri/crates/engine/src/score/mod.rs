//! derived-field regeneration for export: everything a dirty `.osr` export
//! must recompute so the written header describes the edited play rather
//! than the original one (TODO.md's "export integrity" case study).
//!
//! the module is a set of pure functions over the judgement timeline the
//! simulator already emits plus a [`ScoreContext`] captured at load -- no
//! new simulation machinery. every ported value cites its lazer source and
//! is pinned by lazer-dumped goldens under `fixtures/score/`; the one
//! deliberate divergence (geki/katu, which the pinned lazer encoder zeroes
//! for osu!) is documented at its code site and oracled by the NoMod corpus.

mod derive;
mod hash;
mod peppy;
mod scorev1;
mod sections;

pub use derive::{derive_score, DerivedFields, DerivedScore, OverflowField};
pub use hash::{invariant_date_string, replay_hash};
pub use peppy::peppy_stars;
pub use scorev1::total_score;
pub use sections::{is_perfect, max_achievable_combo, section_tally, SectionTally};

/// the NoMod legacy score multiplier -- the only row of the mod multiplier
/// table shipping while mod simulation stays gated (TODO.md)
pub const NOMOD_SCORE_MULTIPLIER: f64 = 1.0;

use crate::formats::beatmap::Beatmap;
use crate::math::dotnet_double_to_i32_unchecked;

/// the stable-faithful inputs to legacy score derivation, captured once at
/// load from the decoded (pre-processing) beatmap: peppy stars and scorev1
/// read raw difficulty settings and the drain length, none of which survive
/// `beatmap::process_beatmap`
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ScoreContext {
    /// raw decoded value, clamped to [0, 10] like lazer's difficulty parse
    pub hp_drain_rate: f32,
    /// raw decoded value, clamped to [0, 10] like lazer's difficulty parse
    pub overall_difficulty: f32,
    /// raw decoded value, clamped to [0, 10] like lazer's difficulty parse
    pub circle_size: f32,
    pub object_count: i32,
    /// legacyscoreutils.cs:90-102 -- all-integer over rounded object *start*
    /// times minus unfiltered break lengths, truncating-divided to seconds
    pub drain_length_seconds: i32,
}

impl ScoreContext {
    pub fn from_beatmap(map: &Beatmap) -> Self {
        Self {
            hp_drain_rate: map.hp_drain_rate,
            overall_difficulty: map.overall_difficulty,
            circle_size: map.circle_size,
            // MAX_HIT_OBJECTS caps the decode well inside i32 range
            object_count: map.hit_objects.len() as i32,
            drain_length_seconds: drain_length_seconds(map),
        }
    }
}

/// `(int)Math.Round(double)`: banker's rounding, then .net's unchecked
/// int cast (out-of-range collapses to i32::MIN on the pinned runtime)
fn legacy_round(time: f64) -> i32 {
    dotnet_double_to_i32_unchecked(time.round_ties_even())
}

/// port of legacyscoreutils.cs:95-99, which mixes two different overflow
/// behaviours in one expression:
///
/// - the break total comes from linq `Sum` over `int`, which is *checked* and
///   throws on overflow -- lazer crashes outright there. this port sums into
///   an i64 and narrows, so the no-panic guarantee holds; a break total that
///   overflows an int is the one input where the two deliberately disagree
///   rather than one of them aborting.
/// - the drain expression around it is ordinary unchecked c# `int` arithmetic,
///   so it silently *wraps*. that case lazer reaches without crashing, so
///   parity means wrapping in 32 bits too -- widening the whole chain to i64
///   would answer 4_294_967 where lazer answers 0 for a map whose rounded
///   first and last start times span the signed 32-bit range
fn drain_length_seconds(map: &Beatmap) -> i32 {
    let Some((first, last)) = map.hit_objects.first().zip(map.hit_objects.last()) else {
        return 0;
    };
    let break_length: i64 = map
        .breaks
        .iter()
        .map(|b| i64::from(legacy_round(b.end_time)) - i64::from(legacy_round(b.start_time)))
        .sum();
    let span = legacy_round(last.start_time).wrapping_sub(legacy_round(first.start_time));
    // i32 division truncates toward zero, matching c# int division
    span.wrapping_sub(break_length as i32) / 1000
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::formats::beatmap::{BreakPeriod, HitObject, HitObjectKind};
    use crate::formats::GameMode;
    use crate::math::Vec2;

    fn circle(start_time: f64) -> HitObject {
        HitObject {
            start_time,
            pos: Vec2::new(256.0, 192.0),
            new_combo: false,
            combo_offset: 0,
            samples: Vec::new(),
            kind: HitObjectKind::Circle,
        }
    }

    fn map_with(hit_objects: Vec<HitObject>, breaks: Vec<BreakPeriod>) -> Beatmap {
        Beatmap {
            format_version: 14,
            mode: GameMode::Osu,
            title: String::new(),
            artist: String::new(),
            creator: String::new(),
            version: String::new(),
            beatmap_id: 0,
            beatmap_set_id: 0,
            audio_file: String::new(),
            audio_lead_in: 0.0,
            background_file: String::new(),
            stack_leniency: 0.7,
            hp_drain_rate: 6.5,
            circle_size: 4.2,
            overall_difficulty: 8.3,
            approach_rate: 9.0,
            slider_multiplier: 1.4,
            slider_tick_rate: 1.0,
            combo_colors: Vec::new(),
            default_sample_bank: crate::formats::samples::SampleBank::Normal,
            default_sample_volume: 100,
            samples_match_playback_rate: false,
            breaks,
            timing_points: Vec::new(),
            difficulty_points: Vec::new(),
            hit_objects,
        }
    }

    #[test]
    fn context_captures_raw_difficulty_and_object_count() {
        let ctx = ScoreContext::from_beatmap(&map_with(vec![circle(1000.0), circle(61_000.0)], Vec::new()));
        assert_eq!(ctx.hp_drain_rate, 6.5);
        assert_eq!(ctx.overall_difficulty, 8.3);
        assert_eq!(ctx.circle_size, 4.2);
        assert_eq!(ctx.object_count, 2);
        assert_eq!(ctx.drain_length_seconds, 60);
    }

    #[test]
    fn drain_length_is_zero_without_objects() {
        let ctx = ScoreContext::from_beatmap(&map_with(Vec::new(), Vec::new()));
        assert_eq!(ctx.object_count, 0);
        assert_eq!(ctx.drain_length_seconds, 0);

        // a lone object spans zero milliseconds
        let one = ScoreContext::from_beatmap(&map_with(vec![circle(5000.0)], Vec::new()));
        assert_eq!(one.drain_length_seconds, 0);
    }

    #[test]
    fn drain_length_uses_start_times_and_truncates_toward_zero() {
        // 1999ms of span is 1 second, not 2 -- c# int division truncates
        let ctx = ScoreContext::from_beatmap(&map_with(vec![circle(1.0), circle(2000.0)], Vec::new()));
        assert_eq!(ctx.drain_length_seconds, 1);
    }

    #[test]
    fn drain_length_rounds_each_endpoint_to_even() {
        // Math.Round is banker's: 500.5 -> 500, 61_501.5 -> 61_502
        let ctx = ScoreContext::from_beatmap(&map_with(vec![circle(500.5), circle(61_501.5)], Vec::new()));
        assert_eq!(ctx.drain_length_seconds, 61);

        // ordinary halves away from the tie still round normally
        let ctx = ScoreContext::from_beatmap(&map_with(vec![circle(499.6), circle(61_499.4)], Vec::new()));
        assert_eq!(ctx.drain_length_seconds, 60);
    }

    #[test]
    fn breaks_subtract_unfiltered_with_per_endpoint_rounding() {
        // a 400ms break sits below lazer's 650ms "has effect" threshold and
        // still subtracts: the legacy computation reads breaks unfiltered
        let ctx = ScoreContext::from_beatmap(&map_with(
            vec![circle(0.0), circle(60_000.0)],
            vec![
                BreakPeriod {
                    start_time: 10_000.0,
                    end_time: 10_400.0,
                },
                BreakPeriod {
                    // endpoints round independently before differencing:
                    // round(20_000.4) = 20_000, round(24_600.6) = 24_601
                    start_time: 20_000.4,
                    end_time: 24_600.6,
                },
            ],
        ));
        // (60_000 - 0 - (400 + 4601)) / 1000 = 54_999 / 1000 = 54
        assert_eq!(ctx.drain_length_seconds, 54);
    }

    #[test]
    fn breaks_longer_than_the_object_span_go_negative_like_stable() {
        // stable's int arithmetic happily yields a negative drain length;
        // peppy stars later treats any non-zero value as a divisor
        let ctx = ScoreContext::from_beatmap(&map_with(
            vec![circle(0.0), circle(10_000.0)],
            vec![BreakPeriod {
                start_time: 0.0,
                end_time: 25_000.0,
            }],
        ));
        assert_eq!(ctx.drain_length_seconds, -15);
    }
}
