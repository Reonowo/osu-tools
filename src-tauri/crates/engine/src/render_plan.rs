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
use crate::formats::beatmap::{Beatmap, HitObject, HitObjectKind};
use crate::formats::samples::{HitSample, SampleBank, SampleName};
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
    /// what this object sounds when its OWN judgement lands. a circle and a
    /// spinner sound these; a slider is deliberately empty, because a slider
    /// never sounds as a whole -- its head, repeats, tail and ticks each
    /// sound their own, and the slider's file-level samples exist only to
    /// derive the tick sample, which is already resolved onto every tick
    /// below (slider.cs:258-289)
    pub samples: Vec<RenderSample>,
    pub kind: RenderKind,
}

/// one skin-independent sample lookup: lazer's `HitSampleInfo` as it stands
/// after its sample control point has been applied, which is exactly what
/// `ISkin.GetSample(ISampleInfo)` is handed. deliberately carries no path,
/// no extension and no source -- resolving those is the skin's job, and
/// keeping that split here is what makes the frontend's skin substitutable
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderSample {
    /// `normal` | `soft` | `drum` | `none`
    pub bank: &'static str,
    /// `hitnormal` | `hitwhistle` | `hitfinish` | `hitclap` | `slidertick`
    pub name: &'static str,
    /// the custom sample bank index when >= 2; the suffixed lookup name is
    /// tried first and falls back to the unsuffixed one
    pub suffix: Option<u32>,
    /// 0-100. the per-sample floor (`max(volume, 5)`) is a playback rule and
    /// is applied where playback happens
    pub volume: i32,
    /// a `hitnormal` that plays UNDER this object's additions rather than
    /// instead of them
    pub layered: bool,
    /// set when the object named an explicit `hitSample` file. lazer models
    /// this as a `FileHitSampleInfo` -- a normal-bank `hitnormal` that
    /// prepends the filename and its extension-stripped form to its lookup
    /// names (converthitobjectparser.cs:682-697) -- which is why `bank` and
    /// `name` still read as that pair here
    pub filename: Option<String>,
}

fn render_sample(sample: &HitSample) -> RenderSample {
    RenderSample {
        bank: sample.bank.as_str(),
        name: sample.name.as_str().unwrap_or("hitnormal"),
        suffix: sample.suffix,
        volume: sample.volume,
        layered: sample.is_layered,
        filename: match &sample.name {
            SampleName::File(filename) => Some(filename.clone()),
            _ => None,
        },
    }
}

fn render_samples(samples: &[HitSample]) -> Vec<RenderSample> {
    samples.iter().map(render_sample).collect()
}

/// hitobject.cs:229-243 `CreateHitSampleInfo` -- the object's own sample under
/// a different name. an ADDITION's bank wins first ("as per stable, all
/// non-normal addition samples should use the same bank"), then the
/// hitnormal's, and an object with no samples at all falls back to a bare
/// normal-bank sample at full volume.
///
/// only ever called with a non-hitnormal name here, which is why the first
/// branch is unconditional.
///
/// a file sample counts as the HITNORMAL on both sides of that split, never as
/// the addition: `FileHitSampleInfo` builds itself on `HIT_NORMAL`
/// (converthitobjectparser.cs:687), so lazer's `s.Name != HIT_NORMAL` skips it
/// looking for an addition and its `s.Name == HIT_NORMAL` finds it as the
/// fallback -- the same predicate `tick_sample` already spells out
fn derived_sample(samples: &[HitSample], name: SampleName) -> HitSample {
    let is_normal = |s: &&HitSample| matches!(s.name, SampleName::Normal | SampleName::File(_));
    let base = samples
        .iter()
        .find(|s| !is_normal(s))
        .or_else(|| samples.iter().find(is_normal));
    match base {
        // the rename is dropped for a file sample for the reason `tick_sample`
        // gives: `FileHitSampleInfo.With` rebuilds itself from the filename and
        // volume alone (converthitobjectparser.cs:699-701), so a spinner whose
        // `hitSample` names a file bonuses with that same file
        Some(sample) if matches!(sample.name, SampleName::File(_)) => sample.clone(),
        Some(sample) => HitSample {
            name,
            ..sample.clone()
        },
        None => HitSample {
            bank: SampleBank::Normal,
            name,
            suffix: None,
            volume: 100,
            is_layered: false,
        },
    }
}

/// slider.cs:263 -- the tick sample is the slider's own `hitnormal` (or, if
/// it has none, its first sample at all) renamed to `slidertick`, so a slider
/// hitsounded onto drum ticks in drum.
///
/// the rename is skipped for a file sample on purpose: `FileHitSampleInfo`
/// overrides `With` to rebuild itself from the filename and volume alone
/// (converthitobjectparser.cs:699-701), dropping the new name on the floor,
/// so a slider whose `hitSample` names a file ticks with that same file. a
/// slider with no samples at all ticks silently, matching the null `tickSample`
fn tick_sample(samples: &[HitSample]) -> Option<HitSample> {
    let base = samples
        .iter()
        // a FileHitSampleInfo's own Name is hitnormal, so it matches lazer's
        // predicate here as well as the fallback below
        .find(|s| matches!(s.name, SampleName::Normal | SampleName::File(_)))
        .or_else(|| samples.first())?;
    Some(match base.name {
        SampleName::File(_) => base.clone(),
        _ => HitSample {
            name: SampleName::SliderTick,
            ..base.clone()
        },
    })
}

/// ihasrepeats.cs:46-47 `GetNodeSamples` -- node `index`, or the object's own
/// samples when the file declared fewer nodes than it has. rosu-map builds
/// exactly `repeat_count + 2` nodes (the same guarantee lazer's
/// `PopulateNodeSamples` provides), so the fallback is unreachable through a
/// decoded file and stands only for a hand-built one
fn node_samples(object: &HitObject, index: usize) -> &[HitSample] {
    match &object.kind {
        HitObjectKind::Slider(slider) => slider
            .node_samples
            .get(index)
            .map_or(&object.samples[..], |node| &node[..]),
        _ => &object.samples[..],
    }
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
    /// what this piece sounds when its own judgement lands, resolved per
    /// slider.cs:258-289: the head takes node 0, a repeat takes node
    /// `span_index + 1`, the tail takes node `repeat_count + 1`, and a tick
    /// takes the slider's own sample renamed to `slidertick`
    pub samples: Vec<RenderSample>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RenderNestedKind {
    Head,
    Tick,
    Repeat,
    Tail,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderSpinner {
    pub duration: f64,
    pub spins_required: i32,
    pub max_bonus_spins: i32,
    /// what a BONUS spin sounds, resolved per `spinner.cs:94` --
    /// `CreateHitSampleInfo("spinnerbonus")`, i.e. the spinner's own sample
    /// renamed. an ordinary (non-bonus) spin carries no samples at all in
    /// lazer and is silent here too; the continuous `spinnerspin` loop is a
    /// separate, deferred mechanism
    pub bonus_samples: Vec<RenderSample>,
}

/// the lookup names of every sample this plan carries, reduced to the FILE
/// STEMS a beatmap's own folder could answer them with.
///
/// legacyskin.cs:634-641 -- a legacy or beatmap skin tries each lookup name
/// and then its last path piece, so `Gameplay/normal-hitnormal` reaches a
/// beatmap folder's `normal-hitnormal.wav`. that reduction is what makes the
/// `.osz` extract allow-list DERIVABLE: the set below is exactly the set of
/// names the frontend's chain can ask a beatmap source for, so the extractor
/// can stay a targeted allow-list instead of widening to "every audio entry"
/// -- which would hand an attacker the decompression budget the targeted
/// extractor exists to bound.
///
/// stems are lowercased: osu!'s own file lookups are case-insensitive, and a
/// map whose `hitSample` names `Kick.WAV` against a folder holding `kick.wav`
/// is ordinary rather than exotic
pub fn sample_file_stems(plan: &RenderPlan) -> std::collections::BTreeSet<String> {
    let mut stems = std::collections::BTreeSet::new();
    let mut add = |sample: &RenderSample| {
        for name in render_sample_lookup_names(sample) {
            let piece = name.rsplit('/').next().unwrap_or(&name).to_ascii_lowercase();
            stems.insert(piece);
        }
    };
    for object in &plan.objects {
        for sample in &object.samples {
            add(sample);
        }
        match &object.kind {
            RenderKind::Slider(slider) => {
                for nested in &slider.nested {
                    for sample in &nested.samples {
                        add(sample);
                    }
                }
            }
            RenderKind::Spinner(spinner) => {
                for sample in &spinner.bonus_samples {
                    add(sample);
                }
            }
            RenderKind::Circle => {}
        }
    }
    // comboeffects.cs:34 -- a sound the game makes rather than an object, but
    // it goes through the same beatmap-skin container, so a map shipping its
    // own combobreak answers with it
    stems.insert("combobreak".to_string());
    stems
}

/// the wire shape's own lookup names, rebuilt through the engine's one rule so
/// the stems above cannot drift from what the frontend actually asks for
fn render_sample_lookup_names(sample: &RenderSample) -> Vec<String> {
    HitSample {
        bank: match sample.bank {
            "normal" => SampleBank::Normal,
            "soft" => SampleBank::Soft,
            "drum" => SampleBank::Drum,
            _ => SampleBank::None,
        },
        name: match &sample.filename {
            Some(filename) => SampleName::File(filename.clone()),
            None => match sample.name {
                "hitwhistle" => SampleName::Whistle,
                "hitfinish" => SampleName::Finish,
                "hitclap" => SampleName::Clap,
                "slidertick" => SampleName::SliderTick,
                "spinnerbonus" => SampleName::SpinnerBonus,
                _ => SampleName::Normal,
            },
        },
        suffix: sample.suffix,
        volume: sample.volume,
        is_layered: sample.layered,
    }
    .lookup_names()
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

    // process_beatmap pushes exactly one processed object per decoded hit
    // object, in order, so the two lists are index-aligned; zipping (rather
    // than indexing) keeps that an assumption this function cannot panic on
    let objects = processed
        .objects
        .iter()
        .zip(&map.hit_objects)
        .map(|(obj, source)| {
            let stack_offset = obj.stacked_position - obj.position;
            let tick = tick_sample(&source.samples);
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
                            samples: match n.kind {
                                NestedKind::Head => render_samples(node_samples(source, 0)),
                                // the repeat ending span `span_index` is
                                // repeat `span_index`, which is node
                                // `span_index + 1`
                                NestedKind::Repeat => render_samples(node_samples(
                                    source,
                                    n.span_index.max(0) as usize + 1,
                                )),
                                NestedKind::Tail => render_samples(node_samples(
                                    source,
                                    s.repeat_count.max(0) as usize + 1,
                                )),
                                NestedKind::Tick => tick.iter().map(render_sample).collect(),
                            },
                        })
                        .collect(),
                }),
                ProcessedKind::Spinner(sp) => RenderKind::Spinner(RenderSpinner {
                    duration: sp.duration,
                    spins_required: sp.spins_required,
                    max_bonus_spins: sp.max_bonus_spins,
                    bonus_samples: vec![render_sample(&derived_sample(
                        &source.samples,
                        SampleName::SpinnerBonus,
                    ))],
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
                // a slider's own samples never sound as a unit; see the field
                // doc. shipping them would invite a consumer to play them on
                // the aggregate judgement, which lazer does not do
                samples: match &obj.kind {
                    ProcessedKind::Slider(_) => Vec::new(),
                    _ => render_samples(&source.samples),
                },
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
            default_sample_bank: crate::formats::samples::SampleBank::Normal,
            default_sample_volume: 100,
            samples_match_playback_rate: false,
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
            samples: Vec::new(),
            kind: HitObjectKind::Circle,
        }
    }

    fn linear_slider(start_time: f64, pos: Vec2, length: f64, repeat_count: i32) -> HitObject {
        HitObject {
            start_time,
            pos,
            new_combo: false,
            combo_offset: 0,
            samples: Vec::new(),
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
                node_samples: Vec::new(),
            }),
        }
    }

    fn spinner(start_time: f64, duration: f64) -> HitObject {
        HitObject {
            start_time,
            pos: Vec2::new(100.0, 100.0),
            new_combo: false,
            combo_offset: 0,
            samples: Vec::new(),
            kind: HitObjectKind::Spinner { duration },
        }
    }

    /// one default-name sample, with the bank standing in for identity so a
    /// test can tell head from repeat from tail at a glance
    fn s(bank: crate::formats::samples::SampleBank, name: SampleName) -> HitSample {
        HitSample {
            bank,
            name,
            suffix: None,
            volume: 100,
            is_layered: false,
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
    fn a_bonus_spin_takes_the_spinners_own_bank_under_the_spinnerbonus_name() {
        // hitobject.cs:229-243 -- an ADDITION's bank wins first ("as per
        // stable, all non-normal addition samples should use the same bank"),
        // so the drum clap here decides the bonus bank even though the
        // hitnormal is soft
        let mut map = base_map(vec![spinner(1000.0, 3000.0)]);
        map.hit_objects[0].samples = vec![
            s(SampleBank::Soft, SampleName::Normal),
            s(SampleBank::Drum, SampleName::Clap),
        ];
        let plan = plan_for(&map);
        let RenderKind::Spinner(sp) = &plan.objects[0].kind else {
            panic!("expected spinner")
        };
        assert_eq!(sp.bonus_samples.len(), 1);
        assert_eq!(
            (sp.bonus_samples[0].bank, sp.bonus_samples[0].name),
            ("drum", "spinnerbonus")
        );

        // with only a hitnormal it is that bank instead
        map.hit_objects[0].samples = vec![s(SampleBank::Soft, SampleName::Normal)];
        let plan = plan_for(&map);
        let RenderKind::Spinner(sp) = &plan.objects[0].kind else {
            panic!()
        };
        assert_eq!(
            (sp.bonus_samples[0].bank, sp.bonus_samples[0].name),
            ("soft", "spinnerbonus")
        );
    }

    #[test]
    fn a_file_sample_bonuses_with_its_own_file_rather_than_a_banked_spinnerbonus() {
        // a FileHitSampleInfo's Name IS hitnormal (converthitobjectparser.cs:687),
        // so it is the hitnormal `CreateHitSampleInfo` falls back to -- and its
        // `With` rebuilds from the filename and volume alone (:699-701),
        // dropping the new name. a spinner whose hitSample names a file
        // therefore bonuses with that file, exactly as a slider ticks with it
        let mut map = base_map(vec![spinner(1000.0, 3000.0)]);
        map.hit_objects[0].samples = vec![s(SampleBank::Drum, SampleName::File("kick.wav".into()))];
        let plan = plan_for(&map);
        let RenderKind::Spinner(sp) = &plan.objects[0].kind else {
            panic!("expected spinner")
        };
        assert_eq!(sp.bonus_samples.len(), 1);
        assert_eq!(sp.bonus_samples[0].filename.as_deref(), Some("kick.wav"));
        // the name is not rewritten, so the filename still leads its lookups
        assert_eq!(sp.bonus_samples[0].name, "hitnormal");
    }

    #[test]
    fn a_file_sample_is_never_the_addition_whose_bank_wins() {
        // the same predicate, on the other branch: a file sample sits in
        // `Samples` alongside any additions the object declared
        // (converthitobjectparser.cs:544-556), and lazer's addition search skips
        // it because its Name is hitnormal. counting it as the addition would
        // hand the bonus the file's bank instead of the clap's
        let mut map = base_map(vec![spinner(1000.0, 3000.0)]);
        map.hit_objects[0].samples = vec![
            s(SampleBank::Soft, SampleName::File("kick.wav".into())),
            s(SampleBank::Drum, SampleName::Clap),
        ];
        let plan = plan_for(&map);
        let RenderKind::Spinner(sp) = &plan.objects[0].kind else {
            panic!("expected spinner")
        };
        assert_eq!(
            (sp.bonus_samples[0].bank, sp.bonus_samples[0].name),
            ("drum", "spinnerbonus")
        );
        assert_eq!(sp.bonus_samples[0].filename, None);
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
        map.hit_objects[0].samples = vec![HitSample {
            bank: SampleBank::Drum,
            name: SampleName::Clap,
            suffix: Some(3),
            volume: 70,
            is_layered: true,
        }];
        let HitObjectKind::Slider(data) = &mut map.hit_objects[1].kind else {
            panic!()
        };
        data.node_samples = vec![
            // a file sample always reads as the normal-bank hitnormal lazer
            // models it as; the filename is the part that carries identity
            vec![HitSample {
                bank: SampleBank::Normal,
                name: SampleName::File("kick.wav".into()),
                suffix: None,
                volume: 90,
                is_layered: false,
            }],
            vec![s(SampleBank::Normal, SampleName::Normal)],
        ];
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

        // the sample lookup's own frozen shape: fields only, never a path
        assert_eq!(
            objects[0]["samples"][0],
            serde_json::json!({
                "bank": "drum",
                "name": "hitclap",
                "suffix": 3,
                "volume": 70,
                "layered": true,
                "filename": serde_json::Value::Null
            })
        );
        // a slider sounds through its pieces, never as a unit
        assert_eq!(objects[1]["samples"], serde_json::json!([]));
        assert_eq!(
            slider["nested"][0]["samples"][0],
            serde_json::json!({
                "bank": "normal",
                "name": "hitnormal",
                "suffix": serde_json::Value::Null,
                "volume": 90,
                "layered": false,
                "filename": "kick.wav"
            })
        );

        let spinner = &objects[2]["kind"];
        assert_eq!(spinner["type"], "spinner");
        assert_eq!(spinner["spinsRequired"], 5);
        assert_eq!(spinner["maxBonusSpins"], 5);
        // spinner.cs:94 -- a bonus spin sounds the spinner's own sample under
        // the spinnerbonus name; a spinner with no samples falls back to a
        // bare normal-bank one at full volume (hitobject.cs:242)
        assert_eq!(
            spinner["bonusSamples"][0],
            serde_json::json!({
                "bank": "normal",
                "name": "spinnerbonus",
                "suffix": serde_json::Value::Null,
                "volume": 100,
                "layered": false,
                "filename": serde_json::Value::Null
            })
        );
    }

    #[test]
    fn circles_and_spinners_carry_their_own_samples() {
        let mut map = base_map(vec![circle(1000.0, 256.0, 192.0), spinner(4000.0, 2000.0)]);
        map.hit_objects[0].samples = vec![
            s(SampleBank::Soft, SampleName::Normal),
            s(SampleBank::Drum, SampleName::Clap),
        ];
        map.hit_objects[1].samples = vec![s(SampleBank::Normal, SampleName::Finish)];
        let plan = plan_for(&map);

        let circle_samples = &plan.objects[0].samples;
        assert_eq!(circle_samples.len(), 2);
        assert_eq!((circle_samples[0].bank, circle_samples[0].name), ("soft", "hitnormal"));
        assert_eq!((circle_samples[1].bank, circle_samples[1].name), ("drum", "hitclap"));
        assert_eq!(plan.objects[1].samples[0].name, "hitfinish");
    }

    #[test]
    fn slider_nested_pieces_take_the_node_lazer_gives_them() {
        // slider.cs:277-289 -- head is node 0, repeat n is node n + 1, tail is
        // node repeat_count + 1. two repeats means four nodes, and each here
        // carries a distinct bank so a mis-indexed join is visible rather than
        // merely wrong
        let mut map = base_map(vec![linear_slider(1000.0, Vec2::new(100.0, 100.0), 100.0, 2)]);
        map.hit_objects[0].samples = vec![s(SampleBank::Normal, SampleName::Normal)];
        let HitObjectKind::Slider(data) = &mut map.hit_objects[0].kind else {
            panic!()
        };
        data.node_samples = vec![
            vec![s(SampleBank::Normal, SampleName::Normal)], // head
            vec![s(SampleBank::Soft, SampleName::Whistle)],  // repeat 0
            vec![s(SampleBank::Drum, SampleName::Finish)],   // repeat 1
            vec![s(SampleBank::Soft, SampleName::Clap)],     // tail
        ];

        let plan = plan_for(&map);
        let RenderKind::Slider(rs) = &plan.objects[0].kind else {
            panic!("expected slider")
        };
        let named = |kind: RenderNestedKind| -> Vec<(&str, &str)> {
            rs.nested
                .iter()
                .filter(|n| n.kind == kind)
                .flat_map(|n| n.samples.iter().map(|smp| (smp.bank, smp.name)))
                .collect()
        };
        assert_eq!(named(RenderNestedKind::Head), vec![("normal", "hitnormal")]);
        assert_eq!(
            named(RenderNestedKind::Repeat),
            vec![("soft", "hitwhistle"), ("drum", "hitfinish")]
        );
        assert_eq!(named(RenderNestedKind::Tail), vec![("soft", "hitclap")]);
        // a slider never sounds as a unit -- its pieces do
        assert!(plan.objects[0].samples.is_empty());
    }

    #[test]
    fn ticks_inherit_the_sliders_own_bank_under_the_slidertick_name() {
        // slider.cs:263 -- the slider's own hitnormal renamed, so a slider
        // hitsounded onto drum ticks in drum. the NODE samples must not leak
        // into the tick, which is why the nodes here are deliberately soft
        let mut map = base_map(vec![linear_slider(1000.0, Vec2::new(100.0, 100.0), 100.0, 0)]);
        map.hit_objects[0].samples = vec![
            s(SampleBank::Drum, SampleName::Whistle),
            s(SampleBank::Drum, SampleName::Normal),
        ];
        let HitObjectKind::Slider(data) = &mut map.hit_objects[0].kind else {
            panic!()
        };
        data.node_samples = vec![
            vec![s(SampleBank::Soft, SampleName::Normal)],
            vec![s(SampleBank::Soft, SampleName::Normal)],
        ];

        let plan = plan_for(&map);
        let RenderKind::Slider(rs) = &plan.objects[0].kind else {
            panic!("expected slider")
        };
        let tick = rs
            .nested
            .iter()
            .find(|n| n.kind == RenderNestedKind::Tick)
            .expect("the fixture slider ticks");
        // the hitnormal wins over the whistle even though the whistle is
        // first in the list -- FirstOrDefault(s => s.Name == HIT_NORMAL)
        assert_eq!(tick.samples.len(), 1);
        assert_eq!((tick.samples[0].bank, tick.samples[0].name), ("drum", "slidertick"));
    }

    #[test]
    fn a_slider_with_no_samples_of_its_own_ticks_silently() {
        // lazer's tickSample is null there, and a null sample is added to
        // nothing (slider.cs:270-274)
        let map = base_map(vec![linear_slider(1000.0, Vec2::new(100.0, 100.0), 100.0, 0)]);
        let plan = plan_for(&map);
        let RenderKind::Slider(rs) = &plan.objects[0].kind else {
            panic!()
        };
        for nested in &rs.nested {
            assert!(nested.samples.is_empty(), "{:?}", nested.kind);
        }
    }

    #[test]
    fn a_file_sample_keeps_its_filename_through_the_tick_rename() {
        // converthitobjectparser.cs:699-701 -- FileHitSampleInfo.With rebuilds
        // itself from the filename and volume alone, dropping the new name, so
        // a slider whose hitSample names a file ticks with that same file
        let mut map = base_map(vec![linear_slider(1000.0, Vec2::new(100.0, 100.0), 100.0, 0)]);
        map.hit_objects[0].samples = vec![HitSample {
            bank: SampleBank::Normal,
            name: SampleName::File("kick.wav".into()),
            suffix: None,
            volume: 80,
            is_layered: false,
        }];
        let plan = plan_for(&map);
        let RenderKind::Slider(rs) = &plan.objects[0].kind else {
            panic!()
        };
        let tick = rs
            .nested
            .iter()
            .find(|n| n.kind == RenderNestedKind::Tick)
            .expect("the fixture slider ticks");
        assert_eq!(tick.samples[0].filename.as_deref(), Some("kick.wav"));
        // it still reads as the normal-bank hitnormal lazer models it as
        assert_eq!((tick.samples[0].bank, tick.samples[0].name), ("normal", "hitnormal"));
    }

    #[test]
    fn sample_file_stems_are_every_name_a_beatmap_folder_could_answer() {
        // what the .osz extract allow-list is derived from. every lookup name
        // reduced to its last path piece (legacyskin.cs:634-641), lowercased,
        // plus combobreak
        let mut map = base_map(vec![
            circle(1000.0, 0.0, 0.0),
            linear_slider(2000.0, Vec2::new(100.0, 100.0), 100.0, 0),
        ]);
        map.hit_objects[0].samples = vec![HitSample {
            bank: SampleBank::Drum,
            name: SampleName::Clap,
            suffix: Some(3),
            volume: 100,
            is_layered: false,
        }];
        map.hit_objects[1].samples = vec![HitSample {
            bank: SampleBank::Normal,
            name: SampleName::File("Kick.WAV".into()),
            suffix: None,
            volume: 100,
            is_layered: false,
        }];
        let stems = sample_file_stems(&plan_for(&map));

        // the suffixed name AND its unsuffixed fallback AND the bare one
        assert!(stems.contains("drum-hitclap3"));
        assert!(stems.contains("drum-hitclap"));
        assert!(stems.contains("hitclap"));
        // an explicit file, lowercased, with and without its extension
        assert!(stems.contains("kick.wav"));
        assert!(stems.contains("kick"));
        // the slider's tick, derived from the file sample -- which keeps the
        // filename rather than taking the slidertick name
        assert!(stems.contains("combobreak"));
        // nothing the plan never asks for
        assert!(!stems.contains("soft-hitfinish"));
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
