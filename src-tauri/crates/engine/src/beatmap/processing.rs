//! assembles the decoded beatmap into gameplay-ready objects: combo
//! indexing, per-object difficulty values, slider nested objects, spinner
//! spin requirements. pipeline order mirrors workingbeatmap.cs:291-351:
//! convert -> combo pre-process -> per-object defaults (incl. nested) ->
//! stacking post-process (beatmap::stacking, wired in by process_beatmap)

use crate::beatmap::difficulty::{
    difficulty_range, fade_in_from_preempt, preempt_from_approach_rate, scale_from_circle_size, OsuHitWindows,
};
use crate::beatmap::slider_events::{generate_slider_events, SliderEvent, SliderEventKind};
use crate::beatmap::timing::{
    difficulty_point_at, slider_velocity, tick_distance, tick_distance_multiplier, timing_point_at,
};
use crate::error::{resource_limit, Result};
use crate::formats::beatmap::{Beatmap, HitObjectKind};
use crate::limits;
use crate::math::{dotnet_double_to_i32_unchecked, Vec2};
use crate::path::SliderPath;

/// osuplayfield.cs:47 -- BASE_SIZE / 2, where every legacy spinner sits
/// (osubeatmapconverter.cs:60, convertspinner.cs has no position)
const SPINNER_POSITION: Vec2 = Vec2 { x: 256.0, y: 192.0 };

/// spinner.cs:52-56 -- gap between clearing and the first bonus-awarding spin
const BONUS_SPINS_GAP: i32 = 2;

#[derive(Debug, Clone)]
pub struct ProcessedBeatmap {
    pub format_version: i32,
    pub stack_leniency: f32,
    pub scale: f32,
    pub preempt: f64,
    pub fade_in: f64,
    pub windows: OsuHitWindows,
    pub objects: Vec<ProcessedObject>,
}

#[derive(Debug, Clone)]
pub struct ProcessedObject {
    pub start_time: f64,
    pub end_time: f64,
    pub position: Vec2,
    pub stacked_position: Vec2,
    pub stack_height: i32,
    pub combo_index: i32,
    pub combo_index_with_offsets: i32,
    pub index_in_current_combo: i32,
    pub last_in_combo: bool,
    pub kind: ProcessedKind,
}

impl ProcessedObject {
    /// osuhitobject.cs:78 / slider.cs:41 -- sliders end where the span-aware
    /// curve ends; circles and spinners end where they sit
    pub fn end_position(&self) -> Vec2 {
        match &self.kind {
            ProcessedKind::Slider(s) => s.end_position,
            _ => self.position,
        }
    }
}

#[derive(Debug, Clone)]
pub enum ProcessedKind {
    Circle,
    Slider(ProcessedSlider),
    Spinner(ProcessedSpinner),
}

#[derive(Debug, Clone)]
pub struct ProcessedSlider {
    pub path: SliderPath,
    pub velocity: f64,
    pub tick_distance: f64,
    pub repeat_count: i32,
    pub span_count: i32,
    pub span_duration: f64,
    pub duration: f64,
    pub end_position: Vec2,
    pub nested: Vec<NestedObject>,
}

impl ProcessedSlider {
    /// ihaspathwithrepeats.cs:46-49
    pub fn span_at(&self, progress: f64) -> i32 {
        dotnet_double_to_i32_unchecked(progress * self.span_count as f64)
    }

    /// ihaspathwithrepeats.cs:33-41
    pub fn progress_at(&self, progress: f64) -> f64 {
        let mut p = (progress * self.span_count as f64) % 1.0;
        if self.span_at(progress) % 2 == 1 {
            p = 1.0 - p;
        }
        p
    }

    /// ihaspathwithrepeats.cs:24-26 -- head-relative ball position
    pub fn curve_position_at(&self, progress: f64) -> Vec2 {
        self.path.position_at(self.progress_at(progress))
    }
}

#[derive(Debug, Clone)]
pub struct ProcessedSpinner {
    pub duration: f64,
    pub spins_required: i32,
    pub max_bonus_spins: i32,
}

impl ProcessedSpinner {
    /// spinner.cs:47-50. c#'s `+` here is unchecked and wraps on overflow;
    /// spins_required can sit at the dotnet_double_to_i32_unchecked sentinel
    /// (i32::MIN) for a spinner with out-of-range times, so this must use
    /// wrapping_add rather than an ordinary rust `+`, which would panic in a
    /// debug build instead
    pub fn spins_required_for_bonus(&self) -> i32 {
        self.spins_required.wrapping_add(BONUS_SPINS_GAP)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NestedKind {
    Head,
    Tick,
    Repeat,
    Tail,
}

#[derive(Debug, Clone)]
pub struct NestedObject {
    pub kind: NestedKind,
    pub span_index: i32,
    pub time: f64,
    pub position: Vec2,
    pub stacked_position: Vec2,
    pub path_progress: f64,
    pub preempt: f64,
    pub fade_in: f64,
}

pub fn process_beatmap(map: &Beatmap) -> Result<ProcessedBeatmap> {
    let scale = scale_from_circle_size(map.circle_size);
    let preempt = preempt_from_approach_rate(map.approach_rate);
    let fade_in = fade_in_from_preempt(preempt);
    let windows = OsuHitWindows::from_overall_difficulty(map.overall_difficulty);

    let mut objects = Vec::with_capacity(map.hit_objects.len());
    // the per-slider caps inside build_slider bound one slider's cost, but
    // every built slider stays resident here -- these accumulators enforce
    // the map-wide retention ceilings (charged after each slider, so the
    // transient overshoot is at most one per-slider cap)
    let mut total_nested: usize = 0;
    let mut total_vertices: usize = 0;
    for obj in &map.hit_objects {
        let (position, end_time, kind) = match &obj.kind {
            HitObjectKind::Circle => (obj.pos, obj.start_time, ProcessedKind::Circle),
            HitObjectKind::Slider(data) => {
                let slider = build_slider(map, obj.start_time, obj.pos, data, preempt, fade_in)?;
                total_nested += slider.nested.len();
                if total_nested > limits::MAX_TOTAL_SLIDER_NESTED_OBJECTS {
                    return Err(resource_limit(
                        "MAX_TOTAL_SLIDER_NESTED_OBJECTS",
                        limits::MAX_TOTAL_SLIDER_NESTED_OBJECTS as u64,
                        total_nested as u64,
                    ));
                }
                total_vertices += slider.path.calculated_path().len();
                if total_vertices > limits::MAX_TOTAL_SLIDER_PATH_VERTICES {
                    return Err(resource_limit(
                        "MAX_TOTAL_SLIDER_PATH_VERTICES",
                        limits::MAX_TOTAL_SLIDER_PATH_VERTICES as u64,
                        total_vertices as u64,
                    ));
                }
                let end_time = obj.start_time + slider.duration;
                (obj.pos, end_time, ProcessedKind::Slider(slider))
            }
            HitObjectKind::Spinner { duration } => (
                SPINNER_POSITION,
                obj.start_time + duration,
                ProcessedKind::Spinner(build_spinner(map.overall_difficulty, *duration)),
            ),
        };
        objects.push(ProcessedObject {
            start_time: obj.start_time,
            end_time,
            position,
            stacked_position: position,
            stack_height: 0,
            combo_index: 0,
            combo_index_with_offsets: 0,
            index_in_current_combo: 0,
            last_in_combo: false,
            kind,
        });
    }

    apply_combo_information(map, &mut objects);

    let mut processed = ProcessedBeatmap {
        format_version: map.format_version,
        stack_leniency: map.stack_leniency,
        scale,
        preempt,
        fade_in,
        windows,
        objects,
    };
    crate::beatmap::stacking::apply_stacking(&mut processed);
    Ok(processed)
}

/// osubeatmapprocessor.cs:29-43 (new-combo enforcement) followed by the
/// osuhitobject.cs:185-209 fold beatmapprocessor.cs:21-30 runs over the list
fn apply_combo_information(map: &Beatmap, objects: &mut [ProcessedObject]) {
    let is_spinner = |o: &ProcessedObject| matches!(o.kind, ProcessedKind::Spinner(_));

    // enforcement: the first object and the first after a spinner start a new
    // combo; spinners themselves are exempt
    let mut forced_new_combo = vec![false; objects.len()];
    let mut last: Option<usize> = None;
    for i in 0..objects.len() {
        if !is_spinner(&objects[i]) && (last.is_none() || is_spinner(&objects[last.unwrap()])) {
            forced_new_combo[i] = true;
        }
        last = Some(i);
    }

    let mut last: Option<usize> = None;
    for i in 0..objects.len() {
        let (last_index, last_with_offsets, last_in_current) = match last {
            Some(l) => (
                objects[l].combo_index,
                objects[l].combo_index_with_offsets,
                objects[l].index_in_current_combo + 1,
            ),
            None => (0, 0, 0),
        };
        let mut index = last_index;
        let mut index_with_offsets = last_with_offsets;
        let mut in_current = last_in_current;

        let new_combo = map.hit_objects[i].new_combo || forced_new_combo[i];
        let last_is_spinner = last.map(|l| is_spinner(&objects[l])).unwrap_or(false);
        if !is_spinner(&objects[i]) && (new_combo || last.is_none() || last_is_spinner) {
            in_current = 0;
            index += 1;
            index_with_offsets += map.hit_objects[i].combo_offset + 1;
            // beatmapprocessor.cs:21-30 / osuhitobject.cs:196-204: lazer has no final-object pass, so the last object stays unmarked
            if let Some(l) = last {
                objects[l].last_in_combo = true;
            }
        }

        objects[i].combo_index = index;
        objects[i].combo_index_with_offsets = index_with_offsets;
        objects[i].index_in_current_combo = in_current;
        last = Some(i);
    }
}

fn build_slider(
    map: &Beatmap,
    start_time: f64,
    position: Vec2,
    data: &crate::formats::beatmap::SliderData,
    base_preempt: f64,
    base_fade_in: f64,
) -> Result<ProcessedSlider> {
    // slider.cs:45 -- osu! sliders always optimise catmull
    let path = SliderPath::new(data.control_points.clone(), data.expected_distance, true)?;

    let timing = timing_point_at(&map.timing_points, start_time);
    let diff_point = difficulty_point_at(&map.difficulty_points, start_time);
    let velocity = slider_velocity(map.slider_multiplier, diff_point.slider_velocity, timing.beat_len);
    let tick_distance = tick_distance(
        velocity,
        timing.beat_len,
        map.slider_tick_rate,
        tick_distance_multiplier(map.format_version, diff_point.slider_velocity),
        diff_point.generate_ticks,
    );

    // converthitobjectparser.cs -- math.max(0, repeatcount) guards a malformed negative repeat count
    let repeat_count = data.repeat_count.max(0);
    let span_count = repeat_count + 1;
    // slider.cs:28 -- duration through span count and the adjusted distance
    let duration = span_count as f64 * path.distance() / velocity;
    let span_duration = duration / span_count as f64;

    let mut slider = ProcessedSlider {
        velocity,
        tick_distance,
        repeat_count,
        span_count,
        span_duration,
        duration,
        end_position: Vec2::ZERO,
        nested: Vec::new(),
        path,
    };
    slider.end_position = position + slider.curve_position_at(1.0);

    let events = generate_slider_events(
        start_time,
        span_duration,
        velocity,
        tick_distance,
        slider.path.distance(),
        span_count,
    )?;
    slider.nested = build_nested(&slider, position, start_time, base_preempt, base_fade_in, &events);
    Ok(slider)
}

/// slider.cs:172-229 (nested creation) + slidertick.cs:19-35 and
/// sliderendcircle.cs:28-44 (per-kind preempt overrides)
fn build_nested(
    slider: &ProcessedSlider,
    position: Vec2,
    start_time: f64,
    base_preempt: f64,
    base_fade_in: f64,
    events: &[SliderEvent],
) -> Vec<NestedObject> {
    let mut nested: Vec<NestedObject> = events
        .iter()
        .map(|e| {
            let (kind, time, pos) = match e.kind {
                SliderEventKind::Head => (NestedKind::Head, e.time, position),
                SliderEventKind::Tick => (
                    NestedKind::Tick,
                    e.time,
                    position + slider.path.position_at(e.path_progress),
                ),
                // slider.cs:219 recomputes the repeat time from span arithmetic
                SliderEventKind::Repeat => (
                    NestedKind::Repeat,
                    start_time + (e.span_index + 1) as f64 * slider.span_duration,
                    position + slider.path.position_at(e.path_progress),
                ),
                SliderEventKind::Tail => (NestedKind::Tail, e.time, slider.end_position),
            };
            let (preempt, fade_in) = match kind {
                NestedKind::Head => (base_preempt, base_fade_in),
                NestedKind::Tick => {
                    let offset = if e.span_index > 0 {
                        200.0
                    } else {
                        base_preempt * (0.66f32 as f64)
                    };
                    ((time - e.span_start_time) / 2.0 + offset, base_fade_in)
                }
                NestedKind::Repeat | NestedKind::Tail => {
                    // repeat index is the event's span index for both kinds
                    if e.span_index > 0 {
                        (slider.span_duration * 2.0, 0.0)
                    } else {
                        (base_preempt + (time - start_time), base_fade_in)
                    }
                }
            };
            NestedObject {
                kind,
                span_index: e.span_index,
                time,
                position: pos,
                stacked_position: pos,
                path_progress: e.path_progress,
                preempt,
                fade_in,
            }
        })
        .collect();

    // hitobject.cs:130 sorts nested objects by start time. c# uses an
    // unstable sort, but ties only occur for a zero-duration slider (every
    // nested object's time collapses to the same instant), and up to 16
    // tied elements .net's array.sort takes its insertion-sort path, which
    // is stable -- so this stable sort is identical for every real map. a
    // crafted zero-duration slider can exceed that (nothing stops a file
    // declaring thousands of repeats), where .net switches to unstable
    // introsort and the tie permutation diverges from this stable order --
    // a known, deliberate divergence in element order only, never in the
    // judged counts; reproducing it would mean porting introsort's exact
    // permutation (see TODO.md, "zero-duration nested tie order")
    nested.sort_by(|a, b| a.time.total_cmp(&b.time));
    nested
}

/// spinner.cs:60-77
fn build_spinner(overall_difficulty: f32, duration: f64) -> ProcessedSpinner {
    let od = overall_difficulty as f64;
    let min_rps = difficulty_range(od, 90.0, 150.0, 225.0) / 60.0;
    let max_rps = difficulty_range(od, 250.0, 380.0, 430.0) / 60.0;
    let seconds_duration = duration / 1000.0;
    const DURATION_ERROR: f64 = 0.0001;
    let spins_required = dotnet_double_to_i32_unchecked(min_rps * seconds_duration + DURATION_ERROR);
    // c#'s subtraction chain here is unchecked and wraps on overflow. a
    // spinner with out-of-range or non-finite times can send either
    // dotnet_double_to_i32_unchecked call to its i32::MIN sentinel while the
    // other stays in range, so an ordinary rust `-` can underflow past
    // i32::MIN and panic in a debug build; wrapping_sub is both panic-free
    // and parity-faithful
    let max_bonus_spins = dotnet_double_to_i32_unchecked(max_rps * seconds_duration + DURATION_ERROR)
        .wrapping_sub(spins_required)
        .wrapping_sub(BONUS_SPINS_GAP)
        .max(0);
    ProcessedSpinner {
        duration,
        spins_required,
        max_bonus_spins,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::EngineError;
    use crate::formats::beatmap::{
        Beatmap, DifficultyPoint, HitObject, HitObjectKind, PathControlPoint, PathType, SliderData,
        TimingPoint,
    };
    use crate::formats::GameMode;
    use crate::math::Vec2;

    fn base_map(hit_objects: Vec<HitObject>) -> Beatmap {
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
            hp_drain_rate: 5.0,
            circle_size: 4.0,
            overall_difficulty: 5.0,
            approach_rate: 9.0,
            slider_multiplier: 1.4,
            slider_tick_rate: 2.0,
            combo_colors: Vec::new(),
            timing_points: vec![TimingPoint {
                time: 0.0,
                beat_len: 500.0,
            }],
            difficulty_points: Vec::new(),
            hit_objects,
        }
    }

    fn circle(start_time: f64, pos: Vec2, new_combo: bool, combo_offset: i32) -> HitObject {
        HitObject {
            start_time,
            pos,
            new_combo,
            combo_offset,
            kind: HitObjectKind::Circle,
        }
    }

    fn spinner(start_time: f64, duration: f64) -> HitObject {
        HitObject {
            start_time,
            pos: Vec2::new(100.0, 100.0),
            new_combo: false,
            combo_offset: 0,
            kind: HitObjectKind::Spinner { duration },
        }
    }

    fn linear_slider(start_time: f64, pos: Vec2, length: f64, repeat_count: i32) -> HitObject {
        HitObject {
            start_time,
            pos,
            new_combo: false,
            combo_offset: 0,
            kind: HitObjectKind::Slider(SliderData {
                control_points: vec![
                    PathControlPoint {
                        pos: Vec2::ZERO,
                        path_type: Some(PathType::Linear),
                    },
                    PathControlPoint {
                        pos: Vec2::new(length as f32, 0.0),
                        path_type: None,
                    },
                ],
                expected_distance: Some(length),
                repeat_count,
            }),
        }
    }

    /// a map whose ticks never generate: tick distance arrives as +infinity,
    /// so each slider's events are exactly head + repeats + tail
    fn tickless(mut map: Beatmap) -> Beatmap {
        map.difficulty_points = vec![DifficultyPoint {
            time: 0.0,
            slider_velocity: 1.0,
            generate_ticks: false,
        }];
        map
    }

    #[test]
    fn total_nested_object_cap_boundary() {
        // a repeat count is a handful of file bytes, so several sliders can
        // sit at the per-slider cap at once; the total budget bounds their
        // combined retention. two at-cap sliders land exactly on the total,
        // and the smallest possible third slider (head + tail) goes past it
        assert_eq!(
            2 * limits::MAX_SLIDER_NESTED_OBJECTS,
            limits::MAX_TOTAL_SLIDER_NESTED_OBJECTS
        );
        let at_cap_repeats = (limits::MAX_SLIDER_NESTED_OBJECTS - 2) as i32;
        let at_cap = |start: f64| linear_slider(start, Vec2::ZERO, 100.0, at_cap_repeats);

        let map = tickless(base_map(vec![at_cap(0.0), at_cap(1e9)]));
        assert!(process_beatmap(&map).is_ok());

        let map = tickless(base_map(vec![
            at_cap(0.0),
            at_cap(1e9),
            linear_slider(2e9, Vec2::ZERO, 100.0, 0),
        ]));
        match process_beatmap(&map) {
            Err(EngineError::ResourceLimit {
                cap: "MAX_TOTAL_SLIDER_NESTED_OBJECTS",
                ..
            }) => {}
            other => panic!("expected ResourceLimit, got {other:?}"),
        }
    }

    #[test]
    fn total_path_vertex_cap_boundary() {
        // a linear path keeps every distinct control point as a vertex, so a
        // slider declaring exactly the per-slider vertex cap in control
        // points retains that many vertices; two of those sit exactly on the
        // total budget and the smallest possible further path goes past it
        assert_eq!(
            2 * limits::MAX_SLIDER_PATH_VERTICES,
            limits::MAX_TOTAL_SLIDER_PATH_VERTICES
        );
        let at_cap = |start: f64| HitObject {
            start_time: start,
            pos: Vec2::ZERO,
            new_combo: false,
            combo_offset: 0,
            kind: HitObjectKind::Slider(SliderData {
                control_points: (0..limits::MAX_SLIDER_PATH_VERTICES)
                    .map(|i| PathControlPoint {
                        pos: Vec2::new(i as f32, 0.0),
                        path_type: if i == 0 { Some(PathType::Linear) } else { None },
                    })
                    .collect(),
                expected_distance: None,
                repeat_count: 0,
            }),
        };

        let map = tickless(base_map(vec![at_cap(0.0), at_cap(1e9)]));
        assert!(process_beatmap(&map).is_ok());

        let map = tickless(base_map(vec![
            at_cap(0.0),
            at_cap(1e9),
            linear_slider(2e9, Vec2::ZERO, 100.0, 0),
        ]));
        match process_beatmap(&map) {
            Err(EngineError::ResourceLimit {
                cap: "MAX_TOTAL_SLIDER_PATH_VERTICES",
                ..
            }) => {}
            other => panic!("expected ResourceLimit, got {other:?}"),
        }
    }

    #[test]
    fn per_map_difficulty_values_come_from_the_difficulty_module() {
        let map = base_map(vec![circle(1000.0, Vec2::new(256.0, 192.0), true, 0)]);
        let processed = process_beatmap(&map).unwrap();
        assert_eq!(
            processed.scale,
            super::super::difficulty::scale_from_circle_size(4.0)
        );
        assert_eq!(processed.preempt, 600.0);
        assert_eq!(processed.fade_in, 400.0);
        assert_eq!(processed.windows.great(), 49.5);
    }

    #[test]
    fn combo_indexing_matches_update_combo_information() {
        // osuhitobject.cs:185-209 + osubeatmapprocessor.cs:29-43. objects:
        // c0 (forced new combo), c1, spinner, c2 (forced new combo after
        // spinner, combo_offset 2), c3 (explicit new combo)
        let map = base_map(vec![
            circle(0.0, Vec2::ZERO, false, 0), // enforcement makes this new combo
            circle(100.0, Vec2::ZERO, false, 0),
            spinner(200.0, 100.0),
            circle(400.0, Vec2::ZERO, false, 2), // offset only counts on a new combo
            circle(500.0, Vec2::ZERO, true, 1),
        ]);
        let p = process_beatmap(&map).unwrap();

        assert_eq!(p.objects[0].combo_index, 1);
        assert_eq!(p.objects[0].combo_index_with_offsets, 1);
        assert_eq!(p.objects[0].index_in_current_combo, 0);
        assert!(!p.objects[0].last_in_combo);

        // c1 carries no new_combo of its own and nothing forces one on it, so
        // it does not close c0's combo -- only the spinner right after it
        // (which inherits, uncounted toward closing) leads into c2's forced
        // new combo, which is what finally marks the spinner as last_in_combo
        assert_eq!(p.objects[1].combo_index, 1);
        assert_eq!(p.objects[1].index_in_current_combo, 1);
        assert!(!p.objects[1].last_in_combo);

        // spinners never bump the combo; they inherit and count within it
        assert_eq!(p.objects[2].combo_index, 1);
        assert_eq!(p.objects[2].index_in_current_combo, 2);
        assert!(p.objects[2].last_in_combo); // c2's new combo marks the spinner too

        // c2: new combo enforced after the spinner; offset 2 counts here.
        // note rosu-map zeroes combo_offset on non-new-combo objects at decode,
        // so an offset can only ever coincide with a new combo
        assert_eq!(p.objects[3].combo_index, 2);
        assert_eq!(p.objects[3].combo_index_with_offsets, 4);
        assert_eq!(p.objects[3].index_in_current_combo, 0);

        assert_eq!(p.objects[4].combo_index, 3);
        assert_eq!(p.objects[4].combo_index_with_offsets, 6);
        assert!(p.objects[3].last_in_combo);
        // beatmapprocessor.cs:21-30 / osuhitobject.cs:196-204: lazer has no
        // final-object pass, so the last object stays unmarked even though
        // it is trivially the end of its own combo
        assert!(!p.objects[4].last_in_combo);
    }

    #[test]
    fn slider_velocity_duration_and_nested_events() {
        // sm 1.4, beat 500 -> velocity 0.28; tick rate 2 -> tick distance 70;
        // length 100 -> ticks at 70 only (140 > 100); duration = 100 / 0.28
        let map = base_map(vec![linear_slider(1000.0, Vec2::new(100.0, 100.0), 100.0, 0)]);
        let p = process_beatmap(&map).unwrap();
        let ProcessedKind::Slider(s) = &p.objects[0].kind else {
            panic!("expected slider")
        };

        assert_eq!(s.velocity, 100.0 * 1.4 / 500.0);
        assert_eq!(s.tick_distance, s.velocity * 500.0 / 2.0);
        assert_eq!(s.span_count, 1);
        let expected_duration = 1.0 * s.path.distance() / s.velocity;
        assert_eq!(s.duration, expected_duration);
        assert_eq!(p.objects[0].end_time, 1000.0 + expected_duration);
        assert_eq!(s.end_position, Vec2::new(200.0, 100.0));
        assert_eq!(p.objects[0].end_position(), Vec2::new(200.0, 100.0));

        let kinds: Vec<_> = s.nested.iter().map(|n| n.kind).collect();
        assert_eq!(kinds, vec![NestedKind::Head, NestedKind::Tick, NestedKind::Tail]);

        let head = &s.nested[0];
        assert_eq!(head.time, 1000.0);
        assert_eq!(head.position, Vec2::new(100.0, 100.0));
        assert_eq!(head.preempt, 600.0);
        assert_eq!(head.fade_in, 400.0);

        let tick = &s.nested[1];
        assert_eq!(tick.path_progress, 70.0 / 100.0);
        assert_eq!(tick.position, Vec2::new(170.0, 100.0));
        // slidertick.cs:24-35: span 0 offset is TimePreempt * 0.66f (widened)
        let expected_tick_preempt = (tick.time - 1000.0) / 2.0 + 600.0 * (0.66f32 as f64);
        assert_eq!(tick.preempt, expected_tick_preempt);

        let tail = &s.nested[2];
        assert_eq!(tail.time, p.objects[0].end_time);
        assert_eq!(tail.position, Vec2::new(200.0, 100.0));
        // sliderendcircle.cs:40-43: repeat index 0 extends preempt to cover
        // the slider from its own start
        assert_eq!(tail.preempt, 600.0 + (tail.time - 1000.0));
    }

    #[test]
    fn repeat_slider_nested_positions_and_preempts() {
        let map = base_map(vec![linear_slider(0.0, Vec2::ZERO, 100.0, 2)]);
        let p = process_beatmap(&map).unwrap();
        let ProcessedKind::Slider(s) = &p.objects[0].kind else {
            panic!("expected slider")
        };

        assert_eq!(s.span_count, 3);
        // odd span count -> tail sits at the far end
        assert_eq!(s.end_position, Vec2::new(100.0, 0.0));

        let repeats: Vec<_> = s.nested.iter().filter(|n| n.kind == NestedKind::Repeat).collect();
        assert_eq!(repeats.len(), 2);
        // slider.cs:215-224: repeat time comes from span arithmetic, position
        // from the path progress (span+1) % 2
        assert_eq!(repeats[0].time, s.span_duration);
        assert_eq!(repeats[0].position, Vec2::new(100.0, 0.0));
        assert_eq!(repeats[1].time, 2.0 * s.span_duration);
        assert_eq!(repeats[1].position, Vec2::ZERO);
        // sliderendcircle.cs:31-38: later end circles preempt two span lengths
        assert_eq!(repeats[1].preempt, s.span_duration * 2.0);
        assert_eq!(repeats[1].fade_in, 0.0);

        // ihaspathwithrepeats.cs:24-49 span-aware ball position
        assert_eq!(s.curve_position_at(0.5), Vec2::new(50.0, 0.0));
        assert_eq!(s.progress_at(1.0 / 3.0), 1.0);
        assert_eq!(s.progress_at(2.0 / 3.0), 0.0);
    }

    #[test]
    fn spinner_position_is_forced_to_playfield_centre() {
        // convertspinner has no position, so osubeatmapconverter.cs:60 centres
        // every spinner regardless of the file's coordinates
        let map = base_map(vec![spinner(0.0, 2000.0)]);
        let p = process_beatmap(&map).unwrap();
        assert_eq!(p.objects[0].position, Vec2::new(256.0, 192.0));
        assert_eq!(p.objects[0].end_time, 2000.0);
    }

    #[test]
    fn spinner_spin_requirements_follow_the_od_ranges() {
        // spinner.cs:60-77: od 5 -> min rps 150/60 = 2.5, max rps 380/60;
        // 2s duration -> required = (int)(5.0001) = 5,
        // bonus = (int)(12.6667...) - 5 - 2 = 5
        let map = base_map(vec![spinner(0.0, 2000.0)]);
        let p = process_beatmap(&map).unwrap();
        let ProcessedKind::Spinner(sp) = &p.objects[0].kind else {
            panic!("expected spinner")
        };
        assert_eq!(sp.spins_required, 5);
        assert_eq!(sp.max_bonus_spins, 5);
        assert_eq!(sp.spins_required_for_bonus(), 7);
    }

    #[test]
    fn extreme_spinner_duration_does_not_panic_the_bonus_spin_subtraction() {
        // od 10 -> min rps 3.75, max rps 430/60. a duration of 4e11 ms (4e8
        // seconds) puts min_rps*seconds (1_500_000_000) inside i32 range but
        // max_rps*seconds (~2.87e9) past it, so dotnet_double_to_i32_unchecked
        // sends only the max side to its i32::MIN sentinel -- exactly the
        // mixed in-range/out-of-range case that overflows a plain `-` chain
        // in a debug build. an ordinary beatmap can never reach this
        // (real maps do not have multi-year spinners), but a directly
        // constructed Beatmap can, and process_beatmap must still return Ok
        let mut map = base_map(vec![HitObject {
            start_time: 0.0,
            pos: Vec2::new(100.0, 100.0),
            new_combo: false,
            combo_offset: 0,
            kind: HitObjectKind::Spinner { duration: 4.0e11 },
        }]);
        map.overall_difficulty = 10.0;
        let p = process_beatmap(&map).unwrap();
        let ProcessedKind::Spinner(sp) = &p.objects[0].kind else {
            panic!("expected spinner")
        };
        assert_eq!(sp.spins_required, 1_500_000_000);
        // wrapping_sub reproduces c#'s unchecked wraparound rather than the
        // saturated value a checked subtraction would otherwise clamp to
        assert_eq!(sp.max_bonus_spins, 647_483_646);
    }

    #[test]
    fn nested_objects_are_sorted_by_time() {
        let map = base_map(vec![linear_slider(0.0, Vec2::ZERO, 100.0, 3)]);
        let p = process_beatmap(&map).unwrap();
        let ProcessedKind::Slider(s) = &p.objects[0].kind else {
            panic!("expected slider")
        };
        for pair in s.nested.windows(2) {
            assert!(pair[0].time <= pair[1].time);
        }
    }
}
