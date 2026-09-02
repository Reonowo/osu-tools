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
//! - the slider's own end time is the floor of the accumulated per-line
//!   traversal of the X87 CUT LINES (the ball walk, danser slider.go:496),
//!   not `start + spans * (length / velocity)` and not the lazer-adjusted
//!   segment walk the ticks ride -- the two f32-narrowed sums can straddle
//!   an integer floor (issue 16's end-time provenance class), and the 1ms
//!   decides the -36ms tail verdict;
//! - the beat-length ratio narrows through an f32 DIVISION
//!   (`float32(clamp)/100`, timing.go:32), where lazer's compat shim
//!   (`timing::precision_adjusted_beat_length`) divides in f64 after the
//!   narrowing -- last-bit differences that matter exactly at tick-count
//!   boundaries.
//!
//! the lazer nested objects stay untouched for rendering and every
//! lazer-parity fixture; only the legacy simulation consumes this list.

use crate::error::{resource_limit, Result};
use crate::limits;
use crate::math::Vec2;
use crate::path::SliderPath;

/// which slider element a stable score point is. deliberately not
/// [`crate::beatmap::NestedKind`]: the head is not a score point (it feeds
/// the aggregate rate through the click machinery instead), and a repeat
/// carries WHICH repeat it is.
///
/// that ordinal is not decoration. lazer picks a repeat's samples by node
/// (`slider.cs` -- repeat *n* takes `GetNodeSamples(n + 1)`), so a consumer
/// holding only "this is a repeat" would have to recover the node by counting
/// repeat judgements in emission order. that join is silently wrong the first
/// time emission order changes, and wrong means the map's own hitsounding
/// plays on the wrong reverse -- audible, and not attributable to anything
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StablePointKind {
    Tick,
    /// 0-based: the repeat that ends span `repeat_index`
    Repeat { repeat_index: u32 },
    Tail,
}

/// one stable score point. `time` is whole milliseconds by construction
/// (stable floors every score time)
#[derive(Debug, Clone, Copy)]
pub struct StableScorePoint {
    pub time: f64,
    pub kind: StablePointKind,
}

/// one segment of stable's score path (danser slider.go:492 PathLine):
/// the ball walks segment endpoints in time windows TRUNCATED to whole
/// milliseconds, so its position lags or leads the exact constant-velocity
/// walk by up to velocity x 1ms. endpoints are ABSOLUTE raw playfield
/// positions (stacking applies at read time); consumed by the legacy
/// tracking's ball model (simulation::slider::ball_position)
#[derive(Debug, Clone, Copy)]
pub struct StableScorePathSeg {
    pub time1: f64,
    pub time2: f64,
    pub p1: crate::math::Vec2,
    pub p2: crate::math::Vec2,
}

/// one line of stable's cut track (danser curves::Linear + the customLength
/// the multi-curve stamps on it)
#[derive(Debug, Clone, Copy)]
struct StableLine {
    p1: Vec2,
    p2: Vec2,
    custom_length: f64,
}

/// multicurve.go:118 -- the cut keeps a line only while it is longer than
/// the remaining overshoot by at least this much
const MIN_PART_WIDTH: f64 = 0.0001;

/// math87.go Mul87 -- f32 operands, f64 intermediate, f32 result
fn mul87(a: f32, b: f32) -> f32 {
    (f64::from(a) * f64::from(b)) as f32
}

/// math87.go Div87
fn div87(a: f32, b: f32) -> f32 {
    (f64::from(a) / f64::from(b)) as f32
}

/// vector2f.go Dst87 -- f32 subtraction first, f64 squares, the SUM
/// narrowed to f32, then the f32 square root
fn dst87(a: Vec2, b: Vec2) -> f32 {
    let x = f64::from(b.x - a.x);
    let y = f64::from(b.y - a.y);
    ((x * x + y * y) as f32).sqrt()
}

/// vector2f.go Nor87 -- x87 normalise with the epsilon short-circuit
fn nor87(v: Vec2) -> Vec2 {
    let len_sq = (f64::from(v.x) * f64::from(v.x) + f64::from(v.y) * f64::from(v.y)) as f32;
    if len_sq < 0.00001 {
        return v;
    }
    let scale = div87(1.0, len_sq.sqrt());
    Vec2::new(mul87(v.x, scale), mul87(v.y, scale))
}

/// multicurve.go:102-186 NewMultiCurveT, the stable branch: build one line
/// per flattened edge of the UNADJUSTED path, cut the list to the declared
/// pixel length with x87 arithmetic (whole trailing lines dropped while
/// they fit inside the overshoot; the survivor re-aimed -- or extended,
/// which a zero-length last line blocks, stable's no-extension quirk), then
/// stamp each line's walk length as the f64 round-trip of its x87 f32
/// length through the running accumulation (multicurve.go:172-177).
///
/// the whole computation runs in ABSOLUTE playfield coordinates -- the raw
/// path arrives absolute (slider_path's stable flatten, new_at) because
/// danser's curve points are absolute and the f32 arithmetic rounds
/// differently there than in head-relative space (one ulp of track length
/// is one truncated window millisecond at the right velocity, measured on
/// a real play 2026-09-01)
fn stable_cut_lines(raw_path: &[Vec2], desired_length: Option<f64>) -> Vec<StableLine> {
    let mut lines: Vec<StableLine> = raw_path
        .windows(2)
        .map(|w| StableLine {
            p1: w[0],
            p2: w[1],
            custom_length: 0.0,
        })
        .collect();

    let length64: f64 = lines.iter().map(|l| f64::from(dst87(l.p1, l.p2))).sum();
    let desired = desired_length.unwrap_or(0.0);
    if length64 > 0.0 && desired != 0.0 {
        let mut diff = length64 - desired;
        while let Some(line) = lines.last().copied() {
            let len87 = dst87(line.p1, line.p2);
            if f64::from(len87) > diff + MIN_PART_WIDTH {
                if line.p1 != line.p2 {
                    let nor = nor87(line.p2 - line.p1);
                    let mag = len87 - diff as f32;
                    let pt = line.p1 + Vec2::new(mul87(nor.x, mag), mul87(nor.y, mag));
                    lines.last_mut().expect("non-empty inside the cut loop").p2 = pt;
                }
                break;
            }
            diff -= f64::from(len87);
            lines.pop();
        }
    }

    let mut acc = 0.0f64;
    for line in &mut lines {
        let prev = acc;
        acc += f64::from(dst87(line.p1, line.p2));
        line.custom_length = acc - prev;
    }
    lines
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
/// points and stable's own end time (the floor of the cut-line walk's
/// accumulated traversal, danser slider.go:496; the lazer-adjusted walk's
/// floor only when the ball path is abandoned). never panics: degenerate
/// inputs (zero-length paths, zero tick distance, non-finite velocities)
/// fall through to a tail-only list, and the point count is capped like the
/// lazer nested list
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
) -> Result<(Vec<StableScorePoint>, f64, Vec<StableScorePathSeg>)> {
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
    // approximators stable ran); danser flattens with its own code and cuts
    // with x87 arithmetic (multicurve.go NewMultiCurveT) -- porting that cut
    // over these vertices was measured 2026-09-01 and REJECTED: it shifts
    // tick boundaries on maps issue 13's walk already gets right (34 sweep
    // regressions vs this walk's 21, mixing two mechanisms), because the
    // x87 lengths are only as danser-equal as the vertex set underneath
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

    // the tracking ball's score path AND the slider's end time, built from
    // stable's own cut of the UNADJUSTED flattened path (danser
    // slider.go:489-496 over the lines NewMultiCurveT produced).
    // deliberately decoupled from the tick walk below, which stays on the
    // lazer-adjusted cumulative diffs that issue 13's sweeps validated
    // tick-for-tick: coupling the TICKS to the x87 cut was measured
    // 2026-09-01 and rejected (it shifts tick boundaries on maps the walk
    // already gets right), while the ball and the end are where the sweep
    // says stable's own geometry decides plays (the strict-< follow compare
    // flips on sub-pixel placement at slide start; the end's floor decides
    // the -36ms tail check's millisecond)
    let lines = stable_cut_lines(path.stable_raw_path(), path.expected_distance());
    let mut score_path: Vec<StableScorePathSeg> = Vec::new();
    // the walk retains span_count x lines segments, two independently
    // capped axes whose product is not: ~9000 declared slides over a
    // near-cap vertex path is tens of GB from a cap-compliant file. past
    // the per-slider ceiling the ball path abandons to empty -- the legacy
    // tracking falls back to lazer geometry, like a budget-blown stable
    // flatten -- instead of failing a map lazer loads fine
    let seg_budget_blown = span_count.saturating_mul(lines.len()) > limits::MAX_SLIDER_NESTED_OBJECTS;
    let ball_spans = if seg_budget_blown { 0 } else { span_count };
    let mut ball_time = start_time;
    for span in 0..ball_spans {
        let indices: Vec<usize> = if span % 2 == 0 {
            (0..lines.len()).collect()
        } else {
            (0..lines.len()).rev().collect()
        };
        for j in indices {
            let line = lines[j];
            // slider.go:479 -- the walk distance is the f32 narrowing of
            // the line's stamped custom length
            let distance = line.custom_length as f32;
            let progress = 1000.0 * f64::from(distance) / velocity;
            // danser slider.go:492 -- Time1/Time2 are int64-truncated; odd
            // spans walk the same line with its endpoints swapped
            let (p1, p2) = if span % 2 == 0 {
                (line.p1, line.p2)
            } else {
                (line.p2, line.p1)
            };
            score_path.push(StableScorePathSeg {
                time1: ball_time.trunc(),
                time2: (ball_time + progress).trunc(),
                p1,
                p2,
            });
            ball_time += progress;
        }
    }
    // danser slider.go:493-496 -- the slider's end time is the floor of
    // THIS walk's accumulation, assigned as the lines are consumed. the
    // lazer-adjusted walk below keeps timing the ticks (issue 13), but its
    // f32-narrowed sum can straddle an integer floor against the cut-line
    // sum (structurally different vertex sets on arc sliders), and the 1ms
    // shifts the -36ms tail verdict across the player's release (issue
    // 16's end-time provenance class). a budget-abandoned or degenerate
    // ball path falls back to the lazer walk's floor, same posture as the
    // ball geometry itself
    let cut_end_usable = !seg_budget_blown && !lines.is_empty() && ball_time.is_finite();
    let mut points: Vec<StableScorePoint> = Vec::new();
    let mut running_time = start_time;
    let mut end_time = if cut_end_usable {
        ball_time.floor()
    } else {
        start_time.floor()
    };
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
            if !cut_end_usable {
                end_time = running_time.floor();
            }
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
                    kind: StablePointKind::Tick,
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
                StablePointKind::Tail
            } else {
                // the repeat that ends span `span` is repeat `span`, which is
                // node `span + 1` in lazer's node-sample list
                StablePointKind::Repeat {
                    repeat_index: span as u32,
                }
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
    Ok((points, end_time, score_path))
}

#[cfg(test)]
mod tests {
    use super::StablePointKind;
    use crate::beatmap::{process_beatmap, ProcessedKind};
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
            default_sample_bank: crate::formats::samples::SampleBank::Normal,
            default_sample_volume: 100,
            samples_match_playback_rate: false,
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
                samples: Vec::new(),
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
                    node_samples: Vec::new(),
                }),
            }],
        };
        process_beatmap(&map).unwrap()
    }

    fn points_of(processed: &crate::beatmap::ProcessedBeatmap) -> Vec<(f64, StablePointKind)> {
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
            vec![(1250.0, StablePointKind::Tick), (1357.0, StablePointKind::Tail)]
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
                (1250.0, StablePointKind::Tick),
                (1357.0, StablePointKind::Repeat { repeat_index: 0 }),
                (1464.0, StablePointKind::Tick),
                (1714.0, StablePointKind::Tail),
            ]
        );
    }

    #[test]
    fn every_repeat_names_its_own_ordinal_in_span_order() {
        // four spans -> three repeats, numbered 0, 1, 2 in the order they are
        // reached. this is the identity a hit sample's node lookup rides on,
        // so it must survive the time sort rather than depend on it
        let processed = slider_map(3);
        let repeats: Vec<u32> = match &processed.objects[0].kind {
            ProcessedKind::Slider(s) => s
                .stable_points
                .iter()
                .filter_map(|p| match p.kind {
                    StablePointKind::Repeat { repeat_index } => Some(repeat_index),
                    _ => None,
                })
                .collect(),
            _ => unreachable!("the test map holds one slider"),
        };
        assert_eq!(repeats, vec![0, 1, 2]);
    }

    #[test]
    fn the_cut_reaims_the_last_line_to_the_declared_length() {
        // raw track 100px, declared 80: diff 20, the last 50px line is
        // longer than the overshoot so it is re-aimed to 50 - 20 = 30px
        let lines = super::stable_cut_lines(
            &[Vec2::ZERO, Vec2::new(50.0, 0.0), Vec2::new(100.0, 0.0)],
            Some(80.0),
        );
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[1].p2, Vec2::new(80.0, 0.0));
        assert_eq!(lines[0].custom_length, 50.0);
        assert_eq!(lines[1].custom_length, 30.0);
    }

    #[test]
    fn the_cut_drops_whole_trailing_lines_inside_the_overshoot() {
        // raw track 60px, declared 45: diff 15 swallows the whole 10px
        // trailing line (dropped, diff 5), then the 50px line re-aims to 45
        let lines = super::stable_cut_lines(
            &[Vec2::ZERO, Vec2::new(50.0, 0.0), Vec2::new(60.0, 0.0)],
            Some(45.0),
        );
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].p2, Vec2::new(45.0, 0.0));
        assert_eq!(lines[0].custom_length, 45.0);
    }

    #[test]
    fn a_zero_length_last_line_blocks_the_extension() {
        // raw track 30px with a duplicated final vertex, declared 50: the
        // negative diff would extend, but the zero-length last line takes
        // the p1 == p2 branch and breaks without moving anything -- the
        // stable no-extension quirk on this side of the pipeline
        let lines = super::stable_cut_lines(
            &[Vec2::ZERO, Vec2::new(30.0, 0.0), Vec2::new(30.0, 0.0)],
            Some(50.0),
        );
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].p2, Vec2::new(30.0, 0.0));
        assert_eq!(lines[1].p1, Vec2::new(30.0, 0.0));
        assert_eq!(lines[1].p2, Vec2::new(30.0, 0.0));
    }

    #[test]
    fn the_stable_arc_steps_a_fixed_detail() {
        // a half circle: a (0,0), b (100,100), c (200,0) circumscribe
        // centre (100,0) radius 100; the sweep angle is pi, so stable's
        // fixed step yields int(pi * 100 * 0.125) = 39 segments, 40
        // vertices -- one every ~8px of arc, where lazer's tolerance
        // subdivision would pick a different count entirely
        let pts = crate::path::approximator::approximate_circular_arc_stable(
            Vec2::ZERO,
            Vec2::new(100.0, 100.0),
            Vec2::new(200.0, 0.0),
            crate::limits::MAX_SLIDER_PATH_VERTICES,
        )
        .expect("a genuine arc");
        assert_eq!(pts.len(), 40);
        assert_eq!(pts[0], Vec2::ZERO);
        assert_eq!(pts[39], Vec2::new(200.0, 0.0));
        for p in &pts[1..39] {
            let r = (f64::from(p.x - 100.0).powi(2) + f64::from(p.y).powi(2)).sqrt();
            assert!((r - 100.0).abs() < 0.01, "interior vertex off the circle: {p:?}");
            assert!(p.y > 0.0, "interior vertex on the wrong side: {p:?}");
        }
    }

    #[test]
    fn the_end_time_floors_the_cut_line_walk_not_the_lazer_one() {
        // nenten puranetto [a world without form] object 1184, the parity
        // pass's end-time provenance repro (issue 16, 2026-09-02): the green
        // line's f32 clamp pushes the f64 span duration to 75.000001287466148,
        // so a walk over the lazer-adjusted segment lengths floors the end to
        // start + 75 = 210470 -- but stable's end is the floor of the x87
        // cut-line walk, whose f32 length sum stays under 75. oracle:
        // .scratch/engine-parity-pass/danser-oracle/dumps/
        // nenten-obj1184.path.txt ([SLIDER] endTime=210469), danser pin
        // 8331b0ff, and the 1ms shift is what flips the -36ms tail verdict
        // on the map's 12 port-gap plays
        let osu = "osu file format v14

[General]
AudioFilename: audio.mp3
Mode: 0

[Difficulty]
HPDrainRate:6
CircleSize:4.2
OverallDifficulty:8.5
ApproachRate:9.5
SliderMultiplier:1.8
SliderTickRate:1

[TimingPoints]
5195,300,4,1,1,50,1,0
206945,-83.3333333333333,4,1,1,75,0,1

[HitObjects]
489,210,210395,2,0,P|496:184|494:157,1,53.9999983520508,2|2,0:0|0:0,0:0:0:0:
";
        let map = crate::formats::beatmap::decode_beatmap_bytes(osu.as_bytes()).unwrap();
        let processed = process_beatmap(&map).unwrap();
        let ProcessedKind::Slider(s) = &processed.objects[0].kind else {
            unreachable!()
        };
        assert_eq!(s.stable_end_time, 210469.0);
    }

    #[test]
    fn the_score_path_windows_walk_stable_lengths_in_absolute_space() {
        // the linear 100px slider at 280 px/s from slider_map: one cut line,
        // window 1000 .. trunc(1000 + 100/280*1000) = 1357, endpoints at the
        // slider's ABSOLUTE position (100,100) -> (200,100) -- the ball
        // model reads these raw and applies stacking as a delta at the site
        let processed = slider_map(0);
        let ProcessedKind::Slider(s) = &processed.objects[0].kind else {
            unreachable!()
        };
        assert_eq!(s.stable_score_path.len(), 1);
        let seg = s.stable_score_path[0];
        assert_eq!(seg.time1, 1000.0);
        assert_eq!(seg.time2, 1357.0);
        assert_eq!(seg.p1, Vec2::new(100.0, 100.0));
        assert_eq!(seg.p2, Vec2::new(200.0, 100.0));
    }

    #[test]
    fn a_danser_straight_arc_flattens_as_the_raw_points() {
        // multicurve.go:302-305 -- IsStraightLine32 routes the def through
        // processLinear: the raw points survive, minus a point equal to its
        // successor (old-map red anchors)
        let straight = crate::path::approximator::approximate_circular_arc_stable(
            Vec2::ZERO,
            Vec2::new(10.0, 10.0),
            Vec2::new(100.0, 100.0),
            crate::limits::MAX_SLIDER_PATH_VERTICES,
        )
        .expect("straight is a polyline, not a budget bounce");
        assert_eq!(
            straight,
            vec![Vec2::ZERO, Vec2::new(10.0, 10.0), Vec2::new(100.0, 100.0)]
        );

        let red_anchor = crate::path::approximator::approximate_circular_arc_stable(
            Vec2::ZERO,
            Vec2::ZERO,
            Vec2::new(100.0, 0.0),
            crate::limits::MAX_SLIDER_PATH_VERTICES,
        )
        .expect("a duplicated point is straight");
        assert_eq!(red_anchor, vec![Vec2::ZERO, Vec2::new(100.0, 0.0)]);
    }

    #[test]
    fn a_span_by_line_bomb_abandons_the_ball_path_not_the_walk() {
        // 600k spans x 2 cut lines crosses the per-slider segment ceiling:
        // the ball's score path abandons to empty (the legacy tracking's
        // lazer-geometry fallback) while the point walk still resolves
        // every span
        let path = crate::path::SliderPath::new_at(
            vec![
                PathControlPoint {
                    pos: Vec2::ZERO,
                    path_type: Some(PathType::Linear),
                },
                PathControlPoint {
                    pos: Vec2::new(50.0, 0.0),
                    path_type: None,
                },
                PathControlPoint {
                    pos: Vec2::new(100.0, 0.0),
                    path_type: None,
                },
            ],
            Some(100.0),
            true,
            Vec2::new(100.0, 100.0),
        )
        .expect("a plain linear path");
        let (points, _, score_path) =
            super::stable_score_points(1000.0, 600_000, &path, 500.0, 1.0, false, 1.4, 2.0, 14)
                .expect("the point walk itself stays under its caps");
        assert!(score_path.is_empty());
        assert_eq!(points.len(), 600_000);
    }
}
