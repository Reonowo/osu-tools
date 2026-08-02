// this module is compiled separately into every integration test binary, so any
// helper a given binary happens not to need would otherwise warn there
#![allow(dead_code)]

use engine::math::Vec2;
use serde::de::DeserializeOwned;
use std::path::PathBuf;

// tolerances mirror fixtures/meta.json; integers and counts compare exact
pub const POSITION_TOL: f32 = 1e-4;
pub const DISTANCE_TOL: f64 = 1e-3;
pub const RATIO_TOL: f64 = 1e-6;

pub fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures")
}

pub fn load_json<T: DeserializeOwned>(relative: &str) -> T {
    let path = fixtures_dir().join(relative);
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("missing fixture {path:?} — regenerate with fixture-gen: {e}"));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("bad fixture {path:?}: {e}"))
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
