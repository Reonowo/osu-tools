// this module is compiled separately into every integration test binary, so any
// helper a given binary happens not to need would otherwise warn there
#![allow(dead_code)]

use engine::math::Vec2;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer};
use std::path::PathBuf;

// tolerances mirror fixtures/meta.json. all three are ZERO: the 2026-08-12
// tolerance audit (engine parity pass, issue 08) zeroed every recorded
// tolerance and found the entire golden surface bit-exact once the one
// genuine divergence was fixed at its source (the slider duration chain's
// double rounding, beatmap/processing.rs) -- both sides compute in ieee-754
// f32/f64 with matched operation order, so exactness is the contract and
// any nonzero drift is a regression, not noise to absorb
pub const POSITION_TOL: f32 = 0.0;
pub const DISTANCE_TOL: f64 = 0.0;
pub const RATIO_TOL: f64 = 0.0;

pub fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures")
}

pub fn load_json<T: DeserializeOwned>(relative: &str) -> T {
    let path = fixtures_dir().join(relative);
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("missing fixture {path:?} — regenerate with fixture-gen: {e}"));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("bad fixture {path:?}: {e}"))
}

/// mirror of fixtures/score/legacy_score_attributes.json, shared by the
/// score goldens and the corpus's synthetic full-combo cross-check
#[derive(Deserialize)]
pub struct LegacyScoreAttributesDump {
    pub maps: Vec<LegacyScoreAttributesMap>,
}

#[derive(Deserialize)]
pub struct LegacyScoreAttributesMap {
    pub name: String,
    pub accuracy_score: u64,
    pub combo_score: u64,
    pub bonus_score: u64,
    pub max_combo: u32,
}

/// stable's flat score surplus over lazer's kind-valued model for a whole
/// map's sliders: the sum over every slider of `stable_slider_point_values`
/// minus the by-kind 10/30 sum. on real point spacings (nothing
/// sub-millisecond) it is nonzero exactly when a slider's final tick falls
/// at or past the -36ms tail point, where stable judges the tick with
/// every point due and values it as the slider end (engine parity issue 15;
/// documented at `score::stable_slider_point_values`). the synthetic
/// full-combo tests add this to lazer's dumped attributes, because lazer's
/// own simulator does not model the term and stable headers demand it
pub fn stable_tick_surplus(processed: &engine::beatmap::ProcessedBeatmap) -> u64 {
    use engine::beatmap::stable_points::StablePointKind;
    use engine::beatmap::ProcessedKind;

    let mut surplus: i64 = 0;
    for obj in &processed.objects {
        let ProcessedKind::Slider(slider) = &obj.kind else { continue };
        let valued: i64 = engine::score::stable_slider_point_values(obj.start_time, slider)
            .iter()
            .map(|&v| v as i64)
            .sum();
        let by_kind: i64 = slider
            .stable_points
            .iter()
            .enumerate()
            .map(|(i, p)| {
                // mirror the machine's re-kind (simulation/slider.rs): the
                // final sorted point becomes the tail (30) and every other
                // point emits as a tick (10) unless it is a repeat, so a
                // mis-sorted non-final tail entry prices as the tick it
                // would have scored, not 30
                if i == slider.stable_points.len() - 1 {
                    30
                } else {
                    match p.kind {
                        StablePointKind::Repeat { .. } => 30,
                        _ => 10,
                    }
                }
            })
            .sum();
        surplus += valued - by_kind;
    }
    // sub-millisecond point ties can demote a repeat below its kind value
    // and turn the surplus negative; no fixture map spaces points that
    // tightly, so a panic here means a fixture acquired that degenerate
    // shape and this helper needs a signed rethink
    u64::try_from(surplus).expect("no fixture map spaces slider points sub-millisecond")
}

pub fn assert_vec2_close(actual: Vec2, expected: [f32; 2], ctx: &str) {
    assert!(
        (actual.x - expected[0]).abs() <= POSITION_TOL && (actual.y - expected[1]).abs() <= POSITION_TOL,
        "{ctx}: got ({}, {}), expected ({}, {})",
        actual.x,
        actual.y,
        expected[0],
        expected[1]
    );
}

pub fn assert_vertices_close(actual: &[Vec2], expected: &[[f32; 2]], ctx: &str) {
    assert_eq!(actual.len(), expected.len(), "{ctx}: vertex count mismatch");
    for (i, (a, e)) in actual.iter().zip(expected).enumerate() {
        assert_vec2_close(*a, *e, &format!("{ctx} vertex {i}"));
    }
}

/// fixture-gen serialises non-finite doubles (infinity/nan) as json's named
/// floating point literals rather than numbers -- see fixtures/README.md's
/// "named floating point literals" section for why lazer genuinely produces
/// them for some fixture cases. shared scalar deserializer; slider_path_fixtures.rs
/// keeps its own list variant of this same idiom for `Vec<f64>` fields
pub fn deserialize_lenient_f64<'de, D: Deserializer<'de>>(d: D) -> Result<f64, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum NumberOrNamedLiteral {
        Number(f64),
        Named(String),
    }

    match NumberOrNamedLiteral::deserialize(d)? {
        NumberOrNamedLiteral::Number(n) => Ok(n),
        NumberOrNamedLiteral::Named(s) => match s.as_str() {
            "Infinity" => Ok(f64::INFINITY),
            "-Infinity" => Ok(f64::NEG_INFINITY),
            "NaN" => Ok(f64::NAN),
            other => Err(serde::de::Error::custom(format!(
                "unexpected floating point literal {other:?}"
            ))),
        },
    }
}

/// non-finite expectations compare by classification (both nan, or exactly
/// equal, which already distinguishes +/- infinity); finite ones use the
/// caller-supplied tolerance
pub fn assert_f64_close(actual: f64, expected: f64, tolerance: f64, ctx: &str) {
    if expected.is_finite() {
        assert!(
            (actual - expected).abs() <= tolerance,
            "{ctx}: got {actual}, expected {expected}"
        );
    } else {
        assert!(
            (expected.is_nan() && actual.is_nan()) || actual == expected,
            "{ctx}: got {actual}, expected {expected}"
        );
    }
}

/// mirror of fixtures/judgement/*.json -- the scenario judgement-dump
/// family. events are lazer's own per-element judgement timeline in
/// application order; kinds and results carry lazer's type/enum names
/// verbatim. raw judgement times and spinner rotation are deliberately
/// absent (update-loop sampling artifacts; see the meta.json note)
#[derive(Deserialize)]
pub struct JudgementDump {
    pub scenario: String,
    pub description: String,
    pub beatmap_file: String,
    pub mods: Vec<String>,
    pub clock_step_ms: f64,
    pub frames: Vec<JudgementDumpFrame>,
    pub events: Vec<JudgementDumpEvent>,
}

#[derive(Deserialize)]
pub struct JudgementDumpFrame {
    pub time: f64,
    pub pos: [f32; 2],
    pub left: bool,
    pub right: bool,
}

#[derive(Deserialize)]
pub struct JudgementDumpEvent {
    pub object_index: usize,
    pub nested_index: Option<usize>,
    pub kind: String,
    pub start_time: f64,
    pub result: String,
    pub is_hit: bool,
    pub combo_after: u32,
}

/// every scenario the family commits; tests iterate this list so a new
/// scenario cannot land without its consumers noticing
pub const JUDGEMENT_SCENARIOS: [&str; 4] = [
    "baseline",
    "spinner-accumulation",
    "slider-tracking",
    "notelock-stack",
];

pub fn load_judgement_dump(scenario: &str) -> JudgementDump {
    load_json(&format!("judgement/{scenario}.json"))
}

/// the dump's frames as engine replay frames -- the dump records gameplay
/// time and gamefield coordinates directly, the same post-conversion shape
/// `replay::frames::convert_frames` produces, so no fixup pass applies
pub fn judgement_frames(dump: &JudgementDump) -> Vec<engine::replay::frames::ReplayFrame> {
    use engine::replay::frames::{Buttons, ReplayFrame};
    dump.frames
        .iter()
        .map(|f| ReplayFrame {
            time: f.time,
            pos: Vec2::new(f.pos[0], f.pos[1]),
            buttons: Buttons::new(
                if f.left { Buttons::LEFT_1 } else { 0 } | if f.right { Buttons::RIGHT_1 } else { 0 },
            ),
        })
        .collect()
}
