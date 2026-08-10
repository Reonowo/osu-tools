mod fixture_util;

use engine::beatmap::{process_beatmap, NestedKind, ProcessedKind};
use engine::formats::beatmap::decode_beatmap_path;
use fixture_util::{assert_vec2_close, deserialize_lenient_f64, DISTANCE_TOL, RATIO_TOL};
use serde::Deserialize;

#[derive(Deserialize)]
struct MapDump {
    format_version: i32,
    stack_leniency: f32,
    windows: WindowsDump,
    objects: Vec<ObjectDump>,
}

#[derive(Deserialize)]
struct WindowsDump {
    great: f64,
    ok: f64,
    meh: f64,
}

#[derive(Deserialize)]
struct ObjectDump {
    kind: String,
    start_time: f64,
    end_time: f64,
    position: [f32; 2],
    stacked_position: [f32; 2],
    stack_height: i32,
    scale: f32,
    preempt: f64,
    fade_in: f64,
    combo_index: i32,
    combo_index_with_offsets: i32,
    index_in_current_combo: i32,
    last_in_combo: bool,
    slider: Option<SliderDump>,
    spinner: Option<SpinnerDump>,
}

#[derive(Debug, Deserialize)]
struct SliderDump {
    velocity: f64,
    /// slider-zoo-v14's 8000,NaN inherited point disables tick generation for
    /// the slider active at that time (slider.cs:169), which makes lazer's
    /// tick distance +infinity there; fixture-gen serialises that with json's
    /// named floating point literals, same convention as
    /// path/slider_path.json's segment_ends_progress
    #[serde(deserialize_with = "deserialize_lenient_f64")]
    tick_distance: f64,
    span_duration: f64,
    duration: f64,
    end_position: [f32; 2],
    nested: Vec<NestedDump>,
    ball_samples: Vec<BallSample>,
}

#[derive(Debug, Deserialize)]
struct NestedDump {
    kind: String,
    span_index: i32,
    time: f64,
    position: [f32; 2],
    stacked_position: [f32; 2],
    path_progress: Option<f64>,
    preempt: f64,
    fade_in: f64,
}

#[derive(Debug, Deserialize)]
struct SpinnerDump {
    duration: f64,
    spins_required: i32,
    maximum_bonus_spins: i32,
}

#[derive(Debug, Deserialize)]
struct BallSample {
    progress: f64,
    pos: [f32; 2],
}

const MAPS: &[&str] = &[
    "stacking-v14",
    "old-format-v4",
    "slider-zoo-v14",
    "v7-tick-multiplier",
    "spinners-combos-od10",
];

fn close(a: f64, b: f64, tol: f64, ctx: &str) {
    assert!((a - b).abs() <= tol, "{ctx}: got {a}, expected {b}");
}

#[test]
fn combo_colours_decode_verbatim_from_the_fixture_map() {
    // the spec's combo-colour fixture item, satisfied against the file's own
    // literal integers rather than a lazer dump: lazer surfaces beatmap
    // [Colours] through its skin subsystem (LegacyBeatmapSkin), not the
    // playable beatmap, and the values are verbatim rgb bytes -- there is no
    // computation for a dump to witness. the colour-order display quirk
    // (combo1 applying to the second combo) is a render concern owned by
    // plans 3/4
    let map = decode_beatmap_path(&fixture_util::fixtures_dir().join("beatmaps/stacking-v14.osu")).unwrap();
    assert_eq!(
        map.combo_colors,
        vec![[255, 128, 64, 255], [0, 202, 0, 255], [18, 124, 255, 255]]
    );
}

#[test]
fn processed_beatmaps_match_lazer_dumps() {
    for name in MAPS {
        let dump: MapDump = fixture_util::load_json(&format!("beatmap/{name}.json"));
        let map = decode_beatmap_path(&fixture_util::fixtures_dir().join(format!("beatmaps/{name}.osu")))
            .unwrap_or_else(|e| panic!("{name}: decode failed: {e}"));
        let processed = process_beatmap(&map).unwrap_or_else(|e| panic!("{name}: process failed: {e}"));

        assert_eq!(
            processed.format_version, dump.format_version,
            "{name}: format version"
        );
        assert!(
            (processed.stack_leniency - dump.stack_leniency).abs() <= RATIO_TOL as f32,
            "{name}: stack leniency"
        );
        close(
            processed.windows.great(),
            dump.windows.great,
            DISTANCE_TOL,
            &format!("{name}: great window"),
        );
        close(
            processed.windows.ok(),
            dump.windows.ok,
            DISTANCE_TOL,
            &format!("{name}: ok window"),
        );
        close(
            processed.windows.meh(),
            dump.windows.meh,
            DISTANCE_TOL,
            &format!("{name}: meh window"),
        );
        assert_eq!(
            processed.objects.len(),
            dump.objects.len(),
            "{name}: object count"
        );

        for (i, (ours, theirs)) in processed.objects.iter().zip(&dump.objects).enumerate() {
            let ctx = format!("{name} object {i}");
            let kind = match &ours.kind {
                ProcessedKind::Circle => "circle",
                ProcessedKind::Slider(_) => "slider",
                ProcessedKind::Spinner(_) => "spinner",
            };
            assert_eq!(kind, theirs.kind, "{ctx}: kind");
            close(ours.start_time, theirs.start_time, DISTANCE_TOL, &ctx);
            close(ours.end_time, theirs.end_time, DISTANCE_TOL, &ctx);
            assert_vec2_close(ours.position, theirs.position, &ctx);
            assert_vec2_close(ours.stacked_position, theirs.stacked_position, &ctx);
            assert_eq!(ours.stack_height, theirs.stack_height, "{ctx}: stack height");
            assert!(
                (processed.scale - theirs.scale).abs() <= RATIO_TOL as f32,
                "{ctx}: scale"
            );
            close(processed.preempt, theirs.preempt, DISTANCE_TOL, &ctx);
            close(processed.fade_in, theirs.fade_in, DISTANCE_TOL, &ctx);
            assert_eq!(ours.combo_index, theirs.combo_index, "{ctx}: combo index");
            assert_eq!(
                ours.combo_index_with_offsets, theirs.combo_index_with_offsets,
                "{ctx}: combo index with offsets"
            );
            assert_eq!(
                ours.index_in_current_combo, theirs.index_in_current_combo,
                "{ctx}: index in combo"
            );
            assert_eq!(ours.last_in_combo, theirs.last_in_combo, "{ctx}: last in combo");

            match (&ours.kind, &theirs.slider, &theirs.spinner) {
                (ProcessedKind::Slider(s), Some(sd), _) => {
                    close(s.velocity, sd.velocity, RATIO_TOL, &ctx);
                    if sd.tick_distance.is_finite() {
                        close(s.tick_distance, sd.tick_distance, DISTANCE_TOL, &ctx);
                    } else {
                        // slider.cs:169's disabled-ticks case is always +infinity;
                        // is_infinite() alone would also accept -infinity
                        assert!(
                            s.tick_distance.is_infinite() && s.tick_distance.is_sign_positive(),
                            "{ctx}: tick distance"
                        );
                    }
                    close(s.span_duration, sd.span_duration, DISTANCE_TOL, &ctx);
                    close(s.duration, sd.duration, DISTANCE_TOL, &ctx);
                    assert_vec2_close(s.end_position, sd.end_position, &ctx);
                    assert_eq!(s.nested.len(), sd.nested.len(), "{ctx}: nested count");
                    for (j, (n_ours, n_theirs)) in s.nested.iter().zip(&sd.nested).enumerate() {
                        let nctx = format!("{ctx} nested {j}");
                        let n_kind = match n_ours.kind {
                            NestedKind::Head => "head",
                            NestedKind::Tick => "tick",
                            NestedKind::Repeat => "repeat",
                            NestedKind::Tail => "tail",
                        };
                        assert_eq!(n_kind, n_theirs.kind, "{nctx}: kind");
                        assert_eq!(n_ours.span_index, n_theirs.span_index, "{nctx}: span");
                        close(n_ours.time, n_theirs.time, DISTANCE_TOL, &nctx);
                        assert_vec2_close(n_ours.position, n_theirs.position, &nctx);
                        assert_vec2_close(n_ours.stacked_position, n_theirs.stacked_position, &nctx);
                        if let Some(pp) = n_theirs.path_progress {
                            close(n_ours.path_progress, pp, RATIO_TOL, &nctx);
                        }
                        close(n_ours.preempt, n_theirs.preempt, DISTANCE_TOL, &nctx);
                        close(n_ours.fade_in, n_theirs.fade_in, DISTANCE_TOL, &nctx);
                    }
                    for (j, sample) in sd.ball_samples.iter().enumerate() {
                        let pos = s.curve_position_at(sample.progress);
                        assert_vec2_close(pos, sample.pos, &format!("{ctx} ball sample {j}"));
                    }
                }
                (ProcessedKind::Spinner(sp), _, Some(spd)) => {
                    close(sp.duration, spd.duration, DISTANCE_TOL, &ctx);
                    assert_eq!(sp.spins_required, spd.spins_required, "{ctx}: spins");
                    assert_eq!(sp.max_bonus_spins, spd.maximum_bonus_spins, "{ctx}: bonus spins");
                }
                (ProcessedKind::Circle, None, None) => {}
                other => panic!("{ctx}: kind/dump mismatch {other:?}"),
            }
        }
    }
}
