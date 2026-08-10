mod fixture_util;

use engine::formats::osr::decode_osr;
use engine::math::Vec2;
use engine::replay::frames::{convert_frames, Buttons, ReplayFrame};
use engine::replay::interpolation::cursor_state_at;
use fixture_util::assert_vec2_close;
use serde::Deserialize;

#[derive(Deserialize)]
struct CursorFixture {
    cases: Vec<CursorCase>,
}

#[derive(Deserialize)]
struct CursorCase {
    name: String,
    frames: Vec<FrameDump>,
    samples: Vec<SampleDump>,
}

#[derive(Deserialize)]
struct FrameDump {
    time: f64,
    pos: [f32; 2],
    left: bool,
    right: bool,
    #[serde(default)]
    smoke: bool,
}

#[derive(Deserialize)]
struct SampleDump {
    time: f64,
    pos: [f32; 2],
    left: bool,
    right: bool,
}

fn to_frame(d: &FrameDump) -> ReplayFrame {
    let mut raw = 0;
    if d.left {
        raw |= Buttons::LEFT_1;
    }
    if d.right {
        raw |= Buttons::RIGHT_1;
    }
    if d.smoke {
        raw |= Buttons::SMOKE;
    }
    ReplayFrame {
        time: d.time,
        pos: Vec2::new(d.pos[0], d.pos[1]),
        buttons: Buttons::new(raw),
    }
}

#[test]
fn cursor_interpolation_matches_lazer_handler() {
    let fixture: CursorFixture = fixture_util::load_json("replays/cursor_interpolation.json");
    assert!(!fixture.cases.is_empty(), "fixture must carry at least one case");
    for case in &fixture.cases {
        assert!(
            !case.samples.is_empty(),
            "{}: case must carry at least one sample",
            case.name
        );
        let frames: Vec<ReplayFrame> = case.frames.iter().map(to_frame).collect();
        for (i, sample) in case.samples.iter().enumerate() {
            let ctx = format!("{} sample {i} (t={})", case.name, sample.time);
            let s = cursor_state_at(&frames, sample.time).unwrap();
            assert_vec2_close(s.pos, sample.pos, &ctx);
            assert_eq!(s.buttons.left(), sample.left, "{ctx}: left");
            assert_eq!(s.buttons.right(), sample.right, "{ctx}: right");
        }
    }
}

#[derive(Deserialize)]
struct ConversionFixture {
    frames: Vec<FrameDump>,
}

#[test]
fn frame_conversion_matches_lazer_decoder() {
    for (osr, json, format_version) in [
        (
            "replays/synthetic_v14.osr",
            "replays/frame_conversion_v14.json",
            14,
        ),
        ("replays/synthetic_v4.osr", "replays/frame_conversion_v4.json", 4),
    ] {
        let bytes = std::fs::read(fixture_util::fixtures_dir().join(osr)).expect("fixture osr");
        let file = decode_osr(&bytes).expect("decode");
        let ours = convert_frames(&file.actions, format_version);
        let theirs: ConversionFixture = fixture_util::load_json(json);

        assert_eq!(ours.len(), theirs.frames.len(), "{osr}: frame count");
        for (i, (a, b)) in ours.iter().zip(&theirs.frames).enumerate() {
            let ctx = format!("{osr} frame {i}");
            assert!(
                (a.time - b.time).abs() <= 1e-3,
                "{ctx}: time {} vs {}",
                a.time,
                b.time
            );
            assert_vec2_close(a.pos, b.pos, &ctx);
            assert_eq!(a.buttons.left(), b.left, "{ctx}: left");
            assert_eq!(a.buttons.right(), b.right, "{ctx}: right");
            assert_eq!(a.buttons.smoke(), b.smoke, "{ctx}: smoke");
        }
    }
}
