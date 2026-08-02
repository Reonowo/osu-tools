mod fixture_util;

use engine::limits::MAX_SLIDER_PATH_VERTICES;
use engine::math::Vec2;
use engine::path::approximator;
use fixture_util::*;
use serde::Deserialize;

#[derive(Deserialize)]
struct BsplineFixture {
    cases: Vec<BsplineCase>,
}

#[derive(Deserialize)]
struct BsplineCase {
    name: String,
    control_points: Vec<[f32; 2]>,
    degree: Option<i32>,
    vertices: Vec<[f32; 2]>,
}

fn points(raw: &[[f32; 2]]) -> Vec<Vec2> {
    raw.iter().map(|p| Vec2::new(p[0], p[1])).collect()
}

#[test]
fn bspline_matches_lazer() {
    let fixture: BsplineFixture = load_json("path/approximator_bspline.json");
    assert!(!fixture.cases.is_empty());
    for case in &fixture.cases {
        let cps = points(&case.control_points);
        let result = match case.degree {
            Some(d) => approximator::b_spline_to_piecewise_linear(&cps, d as usize, MAX_SLIDER_PATH_VERTICES),
            None => approximator::bezier_to_piecewise_linear(&cps, MAX_SLIDER_PATH_VERTICES),
        }
        .unwrap();
        assert_vertices_close(&result, &case.vertices, &case.name);
    }
}

#[test]
fn bezier_vertex_budget_is_enforced() {
    let cps = vec![
        Vec2::new(0.0, 0.0),
        Vec2::new(100.0, 100.0),
        Vec2::new(200.0, 0.0),
    ];
    // a normal curve fits a generous budget but not a tiny one
    assert!(approximator::bezier_to_piecewise_linear(&cps, MAX_SLIDER_PATH_VERTICES).is_ok());
    assert!(approximator::bezier_to_piecewise_linear(&cps, 2).is_err());
}

#[derive(Deserialize)]
struct CatmullFixture {
    catmull: Vec<PlainCase>,
    linear: Vec<PlainCase>,
}

#[derive(Deserialize)]
struct PlainCase {
    name: String,
    control_points: Vec<[f32; 2]>,
    vertices: Vec<[f32; 2]>,
}

#[test]
fn catmull_and_linear_match_lazer() {
    let fixture: CatmullFixture = load_json("path/approximator_catmull.json");
    assert!(!fixture.catmull.is_empty());
    assert!(!fixture.linear.is_empty());
    for case in &fixture.catmull {
        let result = approximator::catmull_to_piecewise_linear(
            &points(&case.control_points),
            MAX_SLIDER_PATH_VERTICES,
        )
        .unwrap();
        assert_vertices_close(&result, &case.vertices, &case.name);
    }
    for case in &fixture.linear {
        let result =
            approximator::linear_to_piecewise_linear(&points(&case.control_points), MAX_SLIDER_PATH_VERTICES)
                .unwrap();
        assert_vertices_close(&result, &case.vertices, &case.name);
    }
}

#[test]
fn catmull_vertex_budget_precheck() {
    // (n-1) * 100 vertices are known up front; the cap rejects before allocating
    let n = MAX_SLIDER_PATH_VERTICES / 100 + 2;
    let cps: Vec<Vec2> = (0..n).map(|i| Vec2::new(i as f32, 0.0)).collect();
    assert!(approximator::catmull_to_piecewise_linear(&cps, MAX_SLIDER_PATH_VERTICES).is_err());
}

#[derive(Deserialize)]
struct ArcFixture {
    cases: Vec<ArcCase>,
}

#[derive(Deserialize)]
struct ArcCase {
    name: String,
    control_points: Vec<[f32; 2]>,
    properties: ArcProps,
    vertices: Vec<[f32; 2]>,
}

#[derive(Deserialize)]
struct ArcProps {
    is_valid: bool,
    theta_start: f64,
    theta_range: f64,
    direction: f64,
    radius: f32,
    centre: [f32; 2],
}

#[test]
fn circular_arc_matches_lazer() {
    let fixture: ArcFixture = load_json("path/approximator_circular_arc.json");
    assert!(!fixture.cases.is_empty());
    for case in &fixture.cases {
        let cps = points(&case.control_points);
        let pr = engine::path::arc::CircularArcProperties::new(cps[0], cps[1], cps[2]);
        assert_eq!(pr.is_valid, case.properties.is_valid, "{} validity", case.name);
        if pr.is_valid {
            let p = &case.properties;
            assert!(
                (pr.theta_start - p.theta_start).abs() <= RATIO_TOL,
                "{} theta_start",
                case.name
            );
            assert!(
                (pr.theta_range - p.theta_range).abs() <= RATIO_TOL,
                "{} theta_range",
                case.name
            );
            assert_eq!(pr.direction, p.direction, "{} direction", case.name);
            assert!(
                (pr.radius - p.radius).abs() <= POSITION_TOL,
                "{} radius",
                case.name
            );
            assert_vec2_close(pr.centre, p.centre, &format!("{} centre", case.name));
        }
        let result = approximator::circular_arc_to_piecewise_linear(&cps, MAX_SLIDER_PATH_VERTICES).unwrap();
        assert_vertices_close(&result, &case.vertices, &case.name);
    }
}
