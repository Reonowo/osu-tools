//! assembles the per-load package the frontend renderer consumes: per-object
//! placement and timing, slider geometry (head-relative polyline,
//! cumulative-length lut, nested events, snaking), and the global constants
//! (playfield, combo colours, hit windows). pure data assembly over
//! beatmap::ProcessedBeatmap -- no new gameplay math lives here, so there is
//! nothing to fixture-test: every value is copied from an
//! already-parity-tested source or is a cited constant
//!
//! # size budget
//!
//! the plan retains one flattened path (vertices + cumulative lengths) and
//! one nested-event list per slider, both taken verbatim from the processed
//! beatmap, so its size is bounded by the map-wide caps process_beatmap
//! already enforces: limits::MAX_TOTAL_SLIDER_PATH_VERTICES and
//! limits::MAX_TOTAL_SLIDER_NESTED_OBJECTS. the spec's render-plan budget
//! therefore needs no cap of its own -- a beatmap that decodes and processes
//! cannot produce an unbounded plan

use serde::Serialize;

use crate::beatmap::difficulty::MISS_WINDOW;
use crate::beatmap::{NestedKind, ProcessedBeatmap, ProcessedKind};
use crate::formats::beatmap::Beatmap;
use crate::math::Vec2;

/// argonskin.cs:51-71 -- the argon skin's combo palette, used whenever the
/// beatmap declares no colours of its own. beatmap skins refuse the legacy
/// default-palette fallback (legacybeatmapskin.cs:40), so under the argon
/// visual target a colourless map resolves to these six
pub const ARGON_COMBO_COLOURS: [[u8; 4]; 6] = [
    [241, 116, 0, 255], // orange
    [0, 241, 53, 255],  // green
    [0, 82, 241, 255],  // blue
    [241, 0, 0, 255],   // red
    [232, 235, 0, 255], // yellow
    [92, 0, 241, 255],  // purple
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderPlan {
    pub playfield: PlayfieldConstants,
    /// rgba rows; consumers pick colours[combo_colour_index % len]
    /// (argonskin.cs:318-319)
    pub combo_colours: Vec<[u8; 4]>,
    pub hit_windows: HitWindowBounds,
    pub scale: f32,
    pub preempt: f64,
    pub fade_in: f64,
    pub objects: Vec<RenderObject>,
}

/// osuplayfield.cs:47 BASE_SIZE
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayfieldConstants {
    pub width: f32,
    pub height: f32,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HitWindowBounds {
    pub great: f64,
    pub ok: f64,
    pub meh: f64,
    pub miss: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderObject {
    pub start_time: f64,
    pub end_time: f64,
    /// stacked, playfield coordinates
    pub position: [f32; 2],
    pub stack_height: i32,
    /// combo_index_with_offsets, the colour rotation index
    pub combo_colour_index: i32,
    pub combo_index: i32,
    /// zero-based position within the combo; the number on the circle is
    /// this + 1
    pub index_in_combo: i32,
    pub preempt: f64,
    pub fade_in: f64,
    pub kind: RenderKind,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum RenderKind {
    Circle,
    Slider(RenderSlider),
    Spinner(RenderSpinner),
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderSlider {
    /// head-relative polyline, [x0, y0, x1, y1, ...]; translate by the
    /// object's stacked position to draw
    pub vertices: Vec<f32>,
    /// cumulative arc length at each polyline vertex -- the progress lut
    pub cumulative_lengths: Vec<f64>,
    /// single-span travel distance (expected-distance adjusted)
    pub distance: f64,
    /// progress ratio at which each control-point segment ends
    pub segment_ends: Vec<f64>,
    pub repeat_count: i32,
    pub span_count: i32,
    pub span_duration: f64,
    pub duration: f64,
    /// stacked
    pub end_position: [f32; 2],
    /// snakingsliderbody.cs -- the body snakes in over preempt / 3
    pub snake_in_duration: f64,
    pub nested: Vec<RenderNested>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderNested {
    pub kind: RenderNestedKind,
    pub span_index: i32,
    pub time: f64,
    /// stacked
    pub position: [f32; 2],
    pub path_progress: f64,
    pub preempt: f64,
    pub fade_in: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RenderNestedKind {
    Head,
    Tick,
    Repeat,
    Tail,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderSpinner {
    pub duration: f64,
    pub spins_required: i32,
    pub max_bonus_spins: i32,
}

fn xy(v: Vec2) -> [f32; 2] {
    [v.x, v.y]
}

/// a zero-distance slider divides by zero in segment_ends_progress (the
/// engine mirrors sliderpath.cs:263, which is equally non-finite there), but
/// json cannot carry nan or infinity -- serde_json writes null, handing the
/// frontend a non-numeric segmentEnds. every point of a zero-length path is
/// its end, so the degenerate entries collapse to 1.0, preserving the
/// invariant that segment ends close at the path's end
fn finite_segment_ends(ends: Vec<f64>) -> Vec<f64> {
    ends.into_iter()
        .map(|p| if p.is_finite() { p } else { 1.0 })
        .collect()
}

pub fn build_render_plan(map: &Beatmap, processed: &ProcessedBeatmap) -> RenderPlan {
    let combo_colours = if map.combo_colors.is_empty() {
        ARGON_COMBO_COLOURS.to_vec()
    } else {
        map.combo_colors.clone()
    };

    let objects = processed
        .objects
        .iter()
        .map(|obj| {
            let stack_offset = obj.stacked_position - obj.position;
            let kind = match &obj.kind {
                ProcessedKind::Circle => RenderKind::Circle,
                ProcessedKind::Slider(s) => RenderKind::Slider(RenderSlider {
                    vertices: s.path.calculated_path().iter().flat_map(|v| [v.x, v.y]).collect(),
                    cumulative_lengths: s.path.cumulative_length().to_vec(),
                    distance: s.path.distance(),
                    segment_ends: finite_segment_ends(s.path.segment_ends_progress()),
                    repeat_count: s.repeat_count,
                    span_count: s.span_count,
                    span_duration: s.span_duration,
                    duration: s.duration,
                    end_position: xy(s.end_position + stack_offset),
                    snake_in_duration: processed.preempt / 3.0,
                    nested: s
                        .nested
                        .iter()
                        .map(|n| RenderNested {
                            kind: match n.kind {
                                NestedKind::Head => RenderNestedKind::Head,
                                NestedKind::Tick => RenderNestedKind::Tick,
                                NestedKind::Repeat => RenderNestedKind::Repeat,
                                NestedKind::Tail => RenderNestedKind::Tail,
                            },
                            span_index: n.span_index,
                            time: n.time,
                            position: xy(n.stacked_position),
                            path_progress: n.path_progress,
                            preempt: n.preempt,
                            fade_in: n.fade_in,
                        })
                        .collect(),
                }),
                ProcessedKind::Spinner(sp) => RenderKind::Spinner(RenderSpinner {
                    duration: sp.duration,
                    spins_required: sp.spins_required,
                    max_bonus_spins: sp.max_bonus_spins,
                }),
            };
            RenderObject {
                start_time: obj.start_time,
                end_time: obj.end_time,
                position: xy(obj.stacked_position),
                stack_height: obj.stack_height,
                combo_colour_index: obj.combo_index_with_offsets,
                combo_index: obj.combo_index,
                index_in_combo: obj.index_in_current_combo,
                preempt: processed.preempt,
                fade_in: processed.fade_in,
                kind,
            }
        })
        .collect();

    RenderPlan {
        playfield: PlayfieldConstants {
            width: 512.0,
            height: 384.0,
        },
        combo_colours,
        hit_windows: HitWindowBounds {
            great: processed.windows.great(),
            ok: processed.windows.ok(),
            meh: processed.windows.meh(),
            miss: MISS_WINDOW,
        },
        scale: processed.scale,
        preempt: processed.preempt,
        fade_in: processed.fade_in,
        objects,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::beatmap::process_beatmap;
    use crate::formats::beatmap::{
        Beatmap, HitObject, HitObjectKind, PathControlPoint, PathType, SliderData, TimingPoint,
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
            breaks: Vec::new(),
            timing_points: vec![TimingPoint {
                time: 0.0,
                beat_len: 500.0,
            }],
            difficulty_points: Vec::new(),
            hit_objects,
        }
    }

    fn circle(start_time: f64, x: f32, y: f32) -> HitObject {
        HitObject {
            start_time,
            pos: Vec2::new(x, y),
            new_combo: false,
            combo_offset: 0,
            kind: HitObjectKind::Circle,
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

    fn spinner(start_time: f64, duration: f64) -> HitObject {
        HitObject {
            start_time,
            pos: Vec2::new(100.0, 100.0),
            new_combo: false,
            combo_offset: 0,
            kind: HitObjectKind::Spinner { duration },
        }
    }

    fn plan_for(map: &Beatmap) -> RenderPlan {
        let processed = process_beatmap(map).unwrap();
        build_render_plan(map, &processed)
    }

    #[test]
    fn globals_come_from_the_processed_map() {
        let plan = plan_for(&base_map(vec![circle(1000.0, 256.0, 192.0)]));
        assert_eq!(plan.playfield.width, 512.0);
        assert_eq!(plan.playfield.height, 384.0);
        // od 5 windows: (floor(80-6*5)-0.5, floor(140-8*5)-0.5, floor(200-10*5)-0.5)
        assert_eq!(plan.hit_windows.great, 49.5);
        assert_eq!(plan.hit_windows.ok, 99.5);
        assert_eq!(plan.hit_windows.meh, 149.5);
        assert_eq!(plan.hit_windows.miss, 400.0);
        assert_eq!(plan.preempt, 600.0);
        assert_eq!(plan.fade_in, 400.0);
        assert_eq!(plan.scale, process_beatmap(&base_map(vec![])).unwrap().scale);
    }

    #[test]
    fn colourless_maps_fall_back_to_the_argon_palette() {
        let plan = plan_for(&base_map(vec![circle(0.0, 0.0, 0.0)]));
        assert_eq!(plan.combo_colours, ARGON_COMBO_COLOURS.to_vec());
    }

    #[test]
    fn declared_combo_colours_win_over_the_fallback() {
        let mut map = base_map(vec![circle(0.0, 0.0, 0.0)]);
        map.combo_colors = vec![[255, 128, 64, 255], [1, 2, 3, 255]];
        let plan = plan_for(&map);
        assert_eq!(plan.combo_colours, map.combo_colors);
    }

    #[test]
    fn circle_objects_carry_combo_and_timing_fields() {
        let plan = plan_for(&base_map(vec![circle(1000.0, 256.0, 192.0)]));
        let obj = &plan.objects[0];
        assert_eq!(obj.start_time, 1000.0);
        assert_eq!(obj.end_time, 1000.0);
        assert_eq!(obj.position, [256.0, 192.0]);
        assert_eq!(obj.stack_height, 0);
        // the first combo has index 1 (combo pre-processing starts there), so
        // the colour rotation index for the first object is 1, matching the
        // "starts from index 1" note at argonskin.cs:54
        assert_eq!(obj.combo_colour_index, 1);
        assert_eq!(obj.combo_index, 1);
        assert_eq!(obj.index_in_combo, 0);
        assert_eq!(obj.preempt, 600.0);
        assert_eq!(obj.fade_in, 400.0);
        assert!(matches!(obj.kind, RenderKind::Circle));
    }

    #[test]
    fn slider_geometry_is_copied_from_the_processed_path() {
        let map = base_map(vec![linear_slider(1000.0, Vec2::new(100.0, 100.0), 100.0, 0)]);
        let processed = process_beatmap(&map).unwrap();
        let plan = build_render_plan(&map, &processed);
        let RenderKind::Slider(rs) = &plan.objects[0].kind else {
            panic!("expected slider")
        };
        let crate::beatmap::ProcessedKind::Slider(ps) = &processed.objects[0].kind else {
            panic!("expected processed slider")
        };

        assert_eq!(rs.vertices, vec![0.0, 0.0, 100.0, 0.0]);
        assert_eq!(rs.cumulative_lengths, ps.path.cumulative_length().to_vec());
        assert_eq!(rs.distance, 100.0);
        assert_eq!(rs.segment_ends, ps.path.segment_ends_progress());
        assert_eq!(rs.repeat_count, 0);
        assert_eq!(rs.span_count, 1);
        assert_eq!(rs.span_duration, ps.span_duration);
        assert_eq!(rs.duration, ps.duration);
        assert_eq!(rs.end_position, [200.0, 100.0]);
        // snakingsliderbody.cs -- the body snakes in over preempt / 3
        assert_eq!(rs.snake_in_duration, 200.0);

        let kinds: Vec<_> = rs.nested.iter().map(|n| n.kind).collect();
        assert_eq!(
            kinds,
            vec![
                RenderNestedKind::Head,
                RenderNestedKind::Tick,
                RenderNestedKind::Tail
            ]
        );
        for (rn, pn) in rs.nested.iter().zip(&ps.nested) {
            assert_eq!(rn.span_index, pn.span_index);
            assert_eq!(rn.time, pn.time);
            assert_eq!(rn.position, [pn.stacked_position.x, pn.stacked_position.y]);
            assert_eq!(rn.path_progress, pn.path_progress);
            assert_eq!(rn.preempt, pn.preempt);
            assert_eq!(rn.fade_in, pn.fade_in);
        }
    }

    #[test]
    fn spinner_objects_carry_spin_requirements() {
        let plan = plan_for(&base_map(vec![spinner(0.0, 2000.0)]));
        let obj = &plan.objects[0];
        // spinners always render at the playfield centre
        assert_eq!(obj.position, [256.0, 192.0]);
        assert_eq!(obj.end_time, 2000.0);
        let RenderKind::Spinner(sp) = &obj.kind else {
            panic!("expected spinner")
        };
        assert_eq!(sp.duration, 2000.0);
        assert_eq!(sp.spins_required, 5);
        assert_eq!(sp.max_bonus_spins, 5);
    }

    #[test]
    fn stacked_objects_render_at_their_stacked_positions() {
        // three identical circles: the reverse stacking pass pushes earlier
        // ones up-left, so objects[0] carries a nonzero offset
        let map = base_map(vec![
            circle(0.0, 256.0, 192.0),
            circle(100.0, 256.0, 192.0),
            circle(200.0, 256.0, 192.0),
        ]);
        let processed = process_beatmap(&map).unwrap();
        let plan = build_render_plan(&map, &processed);
        for (pobj, robj) in processed.objects.iter().zip(&plan.objects) {
            assert_eq!(robj.position, [pobj.stacked_position.x, pobj.stacked_position.y]);
            assert_eq!(robj.stack_height, pobj.stack_height);
        }
        assert_ne!(plan.objects[0].position, [256.0, 192.0], "stack must have bitten");
    }

    #[test]
    fn stacked_sliders_shift_their_end_and_nested_positions_too() {
        // a slider with circles stacked on its head gets pushed like any
        // other stack member; its end position and nested objects must carry
        // the same offset the head does (vertices stay head-relative)
        let map = base_map(vec![
            linear_slider(0.0, Vec2::new(256.0, 192.0), 100.0, 0),
            circle(100.0, 256.0, 192.0),
            circle(200.0, 256.0, 192.0),
        ]);
        let processed = process_beatmap(&map).unwrap();
        let plan = build_render_plan(&map, &processed);

        let pobj = &processed.objects[0];
        let offset = pobj.stacked_position - pobj.position;
        assert_ne!(offset, Vec2::ZERO, "the slider must have stacked");
        let crate::beatmap::ProcessedKind::Slider(ps) = &pobj.kind else {
            panic!()
        };
        let RenderKind::Slider(rs) = &plan.objects[0].kind else {
            panic!()
        };

        let expected_end = ps.end_position + offset;
        assert_eq!(rs.end_position, [expected_end.x, expected_end.y]);
        assert_eq!(
            rs.vertices,
            vec![0.0, 0.0, 100.0, 0.0],
            "vertices stay head-relative"
        );
        for (rn, pn) in rs.nested.iter().zip(&ps.nested) {
            assert_eq!(rn.position, [pn.stacked_position.x, pn.stacked_position.y]);
        }
    }

    #[test]
    fn serialized_shape_is_the_camel_case_tagged_contract() {
        // plan 4 reads exactly these names; this test freezes them
        let mut map = base_map(vec![
            circle(1000.0, 256.0, 192.0),
            linear_slider(2000.0, Vec2::new(100.0, 100.0), 100.0, 0),
            spinner(4000.0, 2000.0),
        ]);
        map.combo_colors = vec![[255, 128, 64, 255]];
        let plan = plan_for(&map);
        let v = serde_json::to_value(&plan).unwrap();

        assert_eq!(v["playfield"]["width"], 512.0);
        assert_eq!(v["comboColours"][0], serde_json::json!([255, 128, 64, 255]));
        assert_eq!(v["hitWindows"]["great"], 49.5);
        assert_eq!(v["fadeIn"], 400.0);

        let objects = v["objects"].as_array().unwrap();
        assert_eq!(objects[0]["kind"]["type"], "circle");
        assert_eq!(objects[0]["comboColourIndex"], 1);
        assert_eq!(objects[0]["indexInCombo"], 0);
        assert_eq!(objects[0]["startTime"], 1000.0);

        let slider = &objects[1]["kind"];
        assert_eq!(slider["type"], "slider");
        assert_eq!(slider["vertices"], serde_json::json!([0.0, 0.0, 100.0, 0.0]));
        assert_eq!(slider["cumulativeLengths"][1], 100.0);
        assert_eq!(slider["segmentEnds"], serde_json::json!([1.0]));
        assert_eq!(slider["snakeInDuration"], 200.0);
        assert_eq!(slider["endPosition"], serde_json::json!([200.0, 100.0]));
        assert_eq!(slider["nested"][0]["kind"], "head");
        assert_eq!(slider["nested"][0]["pathProgress"], 0.0);

        let spinner = &objects[2]["kind"];
        assert_eq!(spinner["type"], "spinner");
        assert_eq!(spinner["spinsRequired"], 5);
        assert_eq!(spinner["maxBonusSpins"], 5);
    }

    #[test]
    fn zero_distance_sliders_serialize_finite_segment_ends() {
        // segment_ends_progress divides by a zero distance here (nan/inf,
        // faithful to sliderpath.cs); the plan must still emit numbers, not
        // the nulls serde_json writes for non-finite floats
        let map = base_map(vec![linear_slider(1000.0, Vec2::new(100.0, 100.0), 0.0, 0)]);
        let plan = plan_for(&map);
        let RenderKind::Slider(rs) = &plan.objects[0].kind else {
            panic!("expected slider")
        };
        assert!(
            rs.segment_ends.iter().all(|p| p.is_finite()),
            "{:?}",
            rs.segment_ends
        );

        let v = serde_json::to_value(&plan).unwrap();
        let ends = v["objects"][0]["kind"]["segmentEnds"].as_array().unwrap();
        assert!(!ends.is_empty());
        for end in ends {
            assert!(end.is_number(), "segmentEnds must stay numeric, got {end:?}");
        }
    }
}
