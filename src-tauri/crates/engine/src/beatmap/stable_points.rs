//! stable's slider score points: the tick/repeat/end list the legacy
//! simulation path judges, timed by stable's own accumulated-track walk.
//! ports danser-go `objects/slider.go:436-538` (the stable score-point
//! construction; danser @ 8331b0ff is the community-verified stable model,
//! reference digest in `.scratch/engine-parity-pass/stable-tracking-reference.md`)
//! plus the timing derivations it consumes (`objects/timing.go:27-41,149-171`).
//!
//! this deliberately does NOT reuse the lazer-parity derivations in
//! `beatmap::timing` or the nested objects from `slider_events`: stable
//! differs from lazer's generator in enumerable ways (engine parity pass,
//! issue 13) --
//!
//! - ticks spawn from accumulated float32 SEGMENT lengths of the flattened
//!   track, not exact f64 multiples of tick distance over the expected
//!   length, with a skip-then-BREAK rule when the remaining distance falls
//!   within `velocity * 10ms` of the span end;
//! - tick times are `floor(f32(accumulated length) / velocity * 1000)`;
//! - the tick phase carries across repeat spans through the
//!   `tickDistance - remainder` handoff instead of restarting per span;
//! - the slider's own end time is the floor of the accumulated per-segment
//!   traversal, not `start + spans * (length / velocity)`;
//! - the beat-length ratio narrows through an f32 DIVISION
//!   (`float32(clamp)/100`, timing.go:32), where lazer's compat shim
//!   (`timing::precision_adjusted_beat_length`) divides in f64 after the
//!   narrowing -- last-bit differences that matter exactly at tick-count
//!   boundaries.
//!
//! the lazer nested objects stay untouched for rendering and every
//! lazer-parity fixture; only the legacy simulation consumes this list.

use crate::beatmap::NestedKind;
use crate::error::{resource_limit, Result};
use crate::limits;
use crate::path::SliderPath;

/// one stable score point. `time` is whole milliseconds by construction
/// (stable floors every score time)
#[derive(Debug, Clone, Copy)]
pub struct StableScorePoint {
    pub time: f64,
    /// tick, repeat, or tail -- the head is not a score point (it feeds the
    /// aggregate rate through the click machinery instead)
    pub kind: NestedKind,
}

/// timing.go:27-33 `GetRatio` -- the clamped inverse slider velocity,
/// narrowed to f32 and divided by 100 IN f32. the raw green-line beat
/// length is reconstructed as `100 / sv`; a non-positive or non-finite sv
/// models danser's `beatLength >= 0 || IsNaN` branch (ratio 1)
fn stable_beat_ratio(sv_multiplier: f64) -> f64 {
    if !sv_multiplier.is_finite() || sv_multiplier <= 0.0 {
        return 1.0;
    }
    let neg_beat_len = 100.0 / sv_multiplier;
    f64::from(neg_beat_len.clamp(10.0, 1000.0) as f32 / 100.0f32)
}

/// stable's score-point walk over one slider. returns the time-sorted
/// points and stable's own end time (the floor of the accumulated
/// per-segment traversal). never panics: degenerate inputs (zero-length
/// paths, zero tick distance, non-finite velocities) fall through to a
/// tail-only list, and the point count is capped like the lazer nested list
pub(crate) fn stable_score_points(
    start_time: f64,
    span_count: i32,
    path: &SliderPath,
    beat_len: f64,
    sv_multiplier: f64,
    generate_ticks: bool,
    slider_multiplier: f64,
    tick_rate: f64,
    format_version: i32,
) -> Result<(Vec<StableScorePoint>, f64)> {
    // timing.go:149-151 + 157-171, operation order preserved: the scoring
    // distance divides by tick rate and multiplies it back for the velocity
    let ratio = stable_beat_ratio(sv_multiplier);
    let scoring_distance = (100.0 * slider_multiplier) / tick_rate;
    let mut velocity = scoring_distance * tick_rate;
    let beat_length = beat_len * ratio;
    if beat_length >= 0.0 {
        velocity *= 1000.0 / beat_length;
    }
    // slider.go:446-449 -- pre-v8 tick spacing ignores the green line
    let mut tick_distance = if format_version < 8 {
        scoring_distance
    } else {
        scoring_distance / ratio
    };

    // per-segment f32 lengths of stable's track: consecutive diffs of the
    // expected-distance-adjusted cumulative, so lazer's truncation/extension
    // of the declared pixel length is already applied. the engine's
    // flattened vertices ARE stable's (the path module ports the same
    // approximators stable ran); danser flattens with its own code, so
    // where the two disagree in the last f32 bit the sweep arbitrates
    let cumulative = path.cumulative_length();
    let segment_lengths: Vec<f32> = cumulative
        .windows(2)
        .map(|w| (w[1] - w[0]) as f32)
        .collect();
    let track_length_f32: f32 = segment_lengths.iter().sum();
    let track_length = f64::from(track_length_f32);

    let min_distance_from_end = velocity * 0.01;
    let pixel_length = path.expected_distance().unwrap_or_else(|| path.calculated_distance());
    // slider.go:451-458 -- the pixel-length clamp and the 32768 sanity cap
    if track_length > 0.0 && tick_distance > pixel_length {
        tick_distance = pixel_length;
    }
    if track_length / tick_distance > 32768.0 {
        tick_distance = track_length / 32768.0;
    }

    let span_count = span_count.max(1) as usize;
    let mut points: Vec<StableScorePoint> = Vec::new();
    let mut running_time = start_time;
    let mut end_time = start_time.floor();
    let mut scoring_length_total = 0.0f64;
    let mut scoring_distance_acc = 0.0f64;

    for span in 0..span_count {
        let mut distance_to_end = track_length;
        // NaN-SV greens keep normal velocity but spawn no ticks
        // (slider.go:466); the engine's generate_ticks models that flag
        let mut skip_tick = !generate_ticks;

        // odd spans traverse the track backwards; segment lengths are
        // direction-free but the accumulation order is not
        let indices: Vec<usize> = if span % 2 == 0 {
            (0..segment_lengths.len()).collect()
        } else {
            (0..segment_lengths.len()).rev().collect()
        };
        for j in indices {
            let distance = segment_lengths[j];
            let progress = 1000.0 * f64::from(distance) / velocity;
            running_time += progress;
            end_time = running_time.floor();
            scoring_distance_acc += f64::from(distance);

            // the `tick_distance > 0` guard is ours, not danser's: a crafted
            // zero tick distance must fall through instead of spinning
            while tick_distance > 0.0 && scoring_distance_acc >= tick_distance && !skip_tick {
                scoring_length_total += tick_distance;
                scoring_distance_acc -= tick_distance;
                distance_to_end -= tick_distance;
                skip_tick = distance_to_end <= min_distance_from_end;
                if skip_tick {
                    break;
                }
                let score_time =
                    start_time + (f64::from(scoring_length_total as f32) / velocity * 1000.0).floor();
                points.push(StableScorePoint {
                    time: score_time,
                    kind: NestedKind::Tick,
                });
                if points.len() > limits::MAX_SLIDER_NESTED_OBJECTS {
                    return Err(resource_limit(
                        "MAX_SLIDER_NESTED_OBJECTS",
                        limits::MAX_SLIDER_NESTED_OBJECTS as u64,
                        points.len() as u64,
                    ));
                }
            }
        }

        scoring_length_total += scoring_distance_acc;
        let last_span = span + 1 == span_count;
        let score_time = if last_span {
            // slider.go:522-525 -- the final point pins to the end time
            end_time
        } else {
            start_time + (f64::from(scoring_length_total as f32) / velocity * 1000.0).floor()
        };
        points.push(StableScorePoint {
            time: score_time,
            kind: if last_span {
                NestedKind::Tail
            } else {
                NestedKind::Repeat
            },
        });
        if points.len() > limits::MAX_SLIDER_NESTED_OBJECTS {
            return Err(resource_limit(
                "MAX_SLIDER_NESTED_OBJECTS",
                limits::MAX_SLIDER_NESTED_OBJECTS as u64,
                points.len() as u64,
            ));
        }

        // slider.go:532-537 -- the cross-span phase handoff
        if skip_tick {
            scoring_distance_acc = 0.0;
        } else {
            scoring_length_total -= tick_distance - scoring_distance_acc;
            scoring_distance_acc = tick_distance - scoring_distance_acc;
        }
    }

    // slider.go:549 sorts by time (danser's sort is unstable, so its tie
    // order is undefined; rust's stable sort keeps emission order on ties,
    // which is deterministic and the only defensible reading)
    points.sort_by(|a, b| a.time.partial_cmp(&b.time).unwrap_or(std::cmp::Ordering::Equal));
    // a degenerate velocity (crafted beat lengths) can push the accumulated
    // traversal to +inf/NaN; the driver's end trigger (`time >= end`) would
    // then never fire and the post-replay walk would spin to the sweep
    // budget. clamp to the floored start so the slider resolves immediately
    // -- ours, not danser's (danser would hang the same way stable would)
    if !end_time.is_finite() {
        end_time = start_time.floor();
    }
    Ok((points, end_time))
}

#[cfg(test)]
mod tests {
    use crate::beatmap::{process_beatmap, NestedKind, ProcessedKind};
    use crate::formats::beatmap::{
        Beatmap, HitObject, HitObjectKind, PathControlPoint, PathType, SliderData, TimingPoint,
    };
    use crate::formats::GameMode;
    use crate::math::Vec2;

    /// one linear 100px slider at t=1000 with the given repeats; beat 500,
    /// sm 1.4, tick rate 2 -> stable velocity 280 px/s, tick distance 70
    fn slider_map(repeat_count: i32) -> crate::beatmap::ProcessedBeatmap {
        let map = Beatmap {
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
            hp_drain_rate: 5.0,
            circle_size: 4.0,
            overall_difficulty: 5.0,
            approach_rate: 9.0,
            slider_multiplier: 1.4,
            slider_tick_rate: 2.0,
            combo_colors: Vec::new(),
            breaks: Vec::new(),
            timing_points: vec![TimingPoint {
                time: 0.0,
                beat_len: 500.0,
            }],
            difficulty_points: Vec::new(),
            hit_objects: vec![HitObject {
                start_time: 1000.0,
                pos: Vec2::new(100.0, 100.0),
                new_combo: true,
                combo_offset: 0,
                kind: HitObjectKind::Slider(SliderData {
                    control_points: vec![
                        PathControlPoint {
                            pos: Vec2::ZERO,
                            path_type: Some(PathType::Linear),
                        },
                        PathControlPoint {
                            pos: Vec2::new(100.0, 0.0),
                            path_type: None,
                        },
                    ],
                    expected_distance: Some(100.0),
                    repeat_count,
                }),
            }],
        };
        process_beatmap(&map).unwrap()
    }

    fn points_of(processed: &crate::beatmap::ProcessedBeatmap) -> Vec<(f64, NestedKind)> {
        match &processed.objects[0].kind {
            ProcessedKind::Slider(s) => s.stable_points.iter().map(|p| (p.time, p.kind)).collect(),
            _ => unreachable!("the test map holds one slider"),
        }
    }

    #[test]
    fn single_span_points_walk_the_accumulated_track() {
        // one 100px span at 280 px/s, tick distance 70: the tick fires at
        // accumulated length 70 -> 1000 + floor(70/280 * 1000) = 1250; the
        // second candidate leaves distance-to-end 100 - 140 < 2.8 (the
        // 10ms proximity), so it skips; the end lands at the floored
        // traversal 1000 + floor(100/280 * 1000) = 1357
        let processed = slider_map(0);
        assert_eq!(
            points_of(&processed),
            vec![(1250.0, NestedKind::Tick), (1357.0, NestedKind::Tail)]
        );
        let ProcessedKind::Slider(s) = &processed.objects[0].kind else {
            unreachable!()
        };
        assert_eq!(s.stable_end_time, 1357.0);
    }

    #[test]
    fn repeat_spans_carry_the_tick_phase_instead_of_mirroring() {
        // two 100px spans, tick distance 70. span 1: tick at length 70
        // (t=1250), remainder 30 at the repeat (t=1357). stable hands the
        // phase across the boundary (scoringDistance = 70 - 30 = 40), so
        // span 2's tick fires after only 30px of travel -- accumulated
        // scoring length 130, t = 1000 + floor(130/280 * 1000) = 1464.
        // lazer mirrors ticks per span instead (its span-2 tick sits 70px
        // from the repeat, ~1607) -- the divergence issue 13 exists for.
        // the next candidate leaves distance-to-end 100 - 70 - 70 < 0,
        // skipped; the end pins to the floored full traversal
        // 1000 + floor(2 * 100/280 * 1000) = 1714
        let processed = slider_map(1);
        assert_eq!(
            points_of(&processed),
            vec![
                (1250.0, NestedKind::Tick),
                (1357.0, NestedKind::Repeat),
                (1464.0, NestedKind::Tick),
                (1714.0, NestedKind::Tail),
            ]
        );
    }
}
