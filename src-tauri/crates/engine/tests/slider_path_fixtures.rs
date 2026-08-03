mod fixture_util;

use engine::formats::beatmap::{PathControlPoint, PathType};
use engine::math::Vec2;
use engine::path::SliderPath;
use fixture_util::*;
use serde::{Deserialize, Deserializer};

#[derive(Deserialize)]
struct SliderPathFixture {
    cases: Vec<SliderPathCase>,
}

#[derive(Deserialize)]
struct SliderPathCase {
    name: String,
    control_points: Vec<FixtureCp>,
    expected_distance: Option<f64>,
    optimise_catmull: bool,
    vertices: Vec<[f32; 2]>,
    distance: f64,
    calculated_distance: f64,
    /// `SliderPath.GetSegmentEnds` divides by `Distance` with no zero guard, so
    /// lazer emits Infinity/NaN for zero-length paths; fixture-gen serialises
    /// those as json's named floating point literals
    #[serde(deserialize_with = "deserialize_lenient_f64_list")]
    segment_ends_progress: Vec<f64>,
    position_at: Vec<PositionSample>,
    path_to_progress: Vec<RangeSample>,
}

#[derive(Deserialize)]
struct FixtureCp {
    pos: [f32; 2],
    #[serde(rename = "type")]
    kind: Option<String>,
    degree: Option<i32>,
}

#[derive(Deserialize)]
struct PositionSample {
    progress: f64,
    pos: [f32; 2],
}

#[derive(Deserialize)]
struct RangeSample {
    p0: f64,
    p1: f64,
    vertices: Vec<[f32; 2]>,
}

fn deserialize_lenient_f64_list<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<f64>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum NumberOrNamedLiteral {
        Number(f64),
        Named(String),
    }

    Vec::<NumberOrNamedLiteral>::deserialize(d)?
        .into_iter()
        .map(|v| match v {
            NumberOrNamedLiteral::Number(n) => Ok(n),
            NumberOrNamedLiteral::Named(s) => match s.as_str() {
                "Infinity" => Ok(f64::INFINITY),
                "-Infinity" => Ok(f64::NEG_INFINITY),
                "NaN" => Ok(f64::NAN),
                other => Err(serde::de::Error::custom(format!(
                    "unexpected floating point literal {other:?}"
                ))),
            },
        })
        .collect()
}

// assert_f64_close (non-finite-aware comparison, tolerance from
// fixtures/meta.json) lives in fixture_util now and is already in scope via
// the glob import above

fn convert_cp(cp: &FixtureCp) -> PathControlPoint {
    let path_type = cp.kind.as_deref().map(|k| match k {
        "Bezier" => PathType::Bezier,
        "Linear" => PathType::Linear,
        "Catmull" => PathType::Catmull,
        "PerfectCurve" => PathType::PerfectCurve,
        "BSpline" => PathType::BSpline(cp.degree.expect("bspline degree")),
        other => panic!("unknown path type {other}"),
    });
    PathControlPoint {
        pos: Vec2::new(cp.pos[0], cp.pos[1]),
        path_type,
    }
}

#[test]
fn slider_path_matches_lazer() {
    let fixture: SliderPathFixture = load_json("path/slider_path.json");
    assert!(!fixture.cases.is_empty());
    for case in &fixture.cases {
        let path = SliderPath::new(
            case.control_points.iter().map(convert_cp).collect(),
            case.expected_distance,
            case.optimise_catmull,
        )
        .unwrap();

        assert_vertices_close(path.calculated_path(), &case.vertices, &case.name);
        assert_f64_close(
            path.distance(),
            case.distance,
            DISTANCE_TOL,
            &format!("{} distance", case.name),
        );
        assert_f64_close(
            path.calculated_distance(),
            case.calculated_distance,
            DISTANCE_TOL,
            &format!("{} calculated_distance", case.name),
        );

        let ends = path.segment_ends_progress();
        assert_eq!(
            ends.len(),
            case.segment_ends_progress.len(),
            "{}: segment end count",
            case.name
        );
        for (i, (a, e)) in ends.iter().zip(&case.segment_ends_progress).enumerate() {
            assert_f64_close(*a, *e, RATIO_TOL, &format!("{} segment end {i}", case.name));
        }

        for sample in &case.position_at {
            let pos = path.position_at(sample.progress);
            assert_vec2_close(
                pos,
                sample.pos,
                &format!("{} position_at({})", case.name, sample.progress),
            );
        }

        for range in &case.path_to_progress {
            let verts = path.path_to_progress(range.p0, range.p1);
            assert_vertices_close(
                &verts,
                &range.vertices,
                &format!("{} path_to_progress({}, {})", case.name, range.p0, range.p1),
            );
        }
    }
}

/// the cross-cutting finding from task 8, re-applied at `SliderPath.cs:355`:
/// a circumradius of ~4.7e6 makes `1f - 0.1f/radius` round to exactly `1.0f`,
/// so `Acos` returns 0 and the subdivision-count division explodes to
/// `+infinity`. the pinned .net 8 x86/x64 unchecked `(int)` cast truncates that
/// to `int.MinValue` (not a saturating clamp), `Math.Max(2, ...)` restores 2,
/// and the `subPoints >= 1000` guard is therefore FALSE -- lazer takes the
/// circular-arc branch. a saturating port would take the b-spline branch and
/// produce a visibly different slider for playfield-range coordinates a mapper
/// can actually place
#[test]
fn huge_radius_perfect_curve_dispatches_to_the_arc_branch() {
    let cps = vec![
        PathControlPoint {
            pos: Vec2::new(175.0, 121.0),
            path_type: Some(PathType::PerfectCurve),
        },
        PathControlPoint {
            pos: Vec2::new(44.0, 32.0),
            path_type: None,
        },
        PathControlPoint {
            pos: Vec2::new(465.0, 318.0),
            path_type: None,
        },
    ];

    // the arc really is valid and really does have an enormous radius, so the
    // guard is exercised rather than short-circuited by `!is_valid`
    let props = engine::path::arc::CircularArcProperties::new(cps[0].pos, cps[1].pos, cps[2].pos);
    assert!(props.is_valid);
    assert!(props.radius > 3.4e6, "radius was {}", props.radius);
    assert_eq!(1.0f32 - 0.1f32 / props.radius, 1.0f32);

    let path = SliderPath::new(cps.clone(), None, true).unwrap();

    // head vertex + the arc's 2 vertices. the arc's first vertex is
    // centre + (cos, sin) * radius, which at this radius does not land exactly
    // on the head control point, so the exact-equality dedup does not fire
    assert_eq!(path.calculated_path().len(), 3);

    // the branch a saturating cast would have taken instead, for contrast
    let segment: Vec<Vec2> = cps.iter().map(|cp| cp.pos).collect();
    let bspline = engine::path::approximator::b_spline_to_piecewise_linear(
        &segment,
        segment.len(),
        engine::limits::MAX_SLIDER_PATH_VERTICES,
    )
    .unwrap();
    assert!(
        bspline.len() > 100,
        "expected the b-spline fallback to be clearly distinguishable, got {}",
        bspline.len()
    );
}

/// builds `len` control points, typed only at the given segment starts. positions
/// stay on a small integer lattice so every catmull term is exact in f32 and a
/// segment's final vertex lands exactly on its last control point, which is what
/// makes the join dedup (and therefore the vertex totals below) deterministic
fn segmented_control_points(len: usize, starts: &[(usize, PathType)]) -> Vec<PathControlPoint> {
    (0..len)
        .map(|i| PathControlPoint {
            pos: Vec2::new((i % 512) as f32, ((i / 512) % 384) as f32),
            path_type: starts
                .iter()
                .find(|(at, _)| *at == i)
                .map(|&(_, path_type)| path_type),
        })
        .collect()
}

/// `SliderPath`'s derived `Debug` prints every control point and every vertex,
/// which is hundreds of kilobytes for the budget cases below; a failure message
/// only needs the outcome and the size that produced it
fn describe(result: &Result<SliderPath, engine::EngineError>) -> String {
    match result {
        Ok(path) => format!("Ok(path with {} vertices)", path.calculated_path().len()),
        Err(e) => format!("Err({e})"),
    }
}

/// `vertex_budget_surfaces_as_resource_limit` below only ever builds a single
/// segment, so the error it observes comes from the approximator's own projected
/// -length check, never from `calculate_path`'s cross-segment accumulation check.
/// both report the same `cap`, so that test passes whether or not the
/// accumulation check exists. these cases close that gap: each segment is
/// individually inside the budget, so only the accumulation check can reject
/// them, and the exact `actual` identifies which layer did
#[test]
fn cross_segment_vertex_budget_boundary() {
    let max = engine::limits::MAX_SLIDER_PATH_VERTICES;

    // two catmull segments of 10_501 control points: each projects 1_050_000
    // vertices, which the approximator accepts, but they accumulate to
    // 1_050_000 + 1_050_000 - 1 (the join dedups one vertex) across the path.
    // culling is off because it would otherwise collapse the totals
    let two_catmull_segments =
        segmented_control_points(21_001, &[(0, PathType::Catmull), (10_500, PathType::Catmull)]);
    let result = SliderPath::new(two_catmull_segments, None, false);
    match &result {
        Err(engine::EngineError::ResourceLimit {
            cap: "MAX_SLIDER_PATH_VERTICES",
            limit,
            actual,
        }) => {
            assert_eq!(*limit, max as u64);
            // the approximator layer would have reported 1_050_000 for either
            // segment on its own, so this value can only come from calculate_path
            assert_eq!(*actual, 2_099_999);
        }
        _ => panic!(
            "expected the cross-segment budget error, got {}",
            describe(&result)
        ),
    }

    // limits.rs boundary convention -- accept at the limit, error one past it --
    // applied to the accumulation check itself. a 20_000-point catmull segment
    // contributes exactly 1_999_900 vertices; a following linear segment of 101
    // control points contributes 100 more after the join dedup, landing on the
    // cap exactly. two catmull segments cannot express this boundary at all:
    // 100a + 100b - 1 is always 99 mod 100 and the cap is a multiple of 100
    let boundary_segments = [(0, PathType::Catmull), (19_999, PathType::Linear)];

    let at_limit =
        SliderPath::new(segmented_control_points(20_100, &boundary_segments), None, false).unwrap();
    assert_eq!(at_limit.calculated_path().len(), max);

    let past_limit = SliderPath::new(segmented_control_points(20_101, &boundary_segments), None, false);
    match &past_limit {
        Err(engine::EngineError::ResourceLimit {
            cap: "MAX_SLIDER_PATH_VERTICES",
            limit,
            actual,
        }) => {
            assert_eq!(*limit, max as u64);
            assert_eq!(*actual, max as u64 + 1);
        }
        _ => panic!(
            "expected a budget error one vertex past the cap, got {}",
            describe(&past_limit)
        ),
    }
}

#[test]
fn vertex_budget_surfaces_as_resource_limit() {
    // catmull emits (n-1) * 100 vertices; exceed the per-slider budget
    let n = engine::limits::MAX_SLIDER_PATH_VERTICES / 100 + 2;
    let cps: Vec<PathControlPoint> = (0..n)
        .map(|i| PathControlPoint {
            pos: Vec2::new((i % 512) as f32, 0.0),
            path_type: (i == 0).then_some(PathType::Catmull),
        })
        .collect();
    let result = SliderPath::new(cps, None, true);
    match &result {
        Err(engine::EngineError::ResourceLimit {
            cap: "MAX_SLIDER_PATH_VERTICES",
            ..
        }) => {}
        _ => panic!("expected ResourceLimit, got {}", describe(&result)),
    }
}

#[test]
fn empty_and_degenerate_inputs_do_not_panic() {
    // the engine crate never panics on malformed input, in any build profile
    let empty = SliderPath::new(Vec::new(), None, true).unwrap();
    assert!(empty.calculated_path().is_empty());
    assert_eq!(empty.distance(), 0.0);
    assert_eq!(empty.position_at(0.5), Vec2::ZERO);
    assert!(empty.segment_ends_progress().is_empty());
    assert_eq!(empty.path_to_progress(0.0, 1.0).len(), 2);

    // a single control point never forms a segment, so no segment ends exist
    let single = SliderPath::new(
        vec![PathControlPoint {
            pos: Vec2::new(9.0, 9.0),
            path_type: Some(PathType::Linear),
        }],
        Some(-50.0),
        true,
    )
    .unwrap();
    assert_eq!(single.distance(), 0.0);
    assert!(single.segment_ends_progress().is_empty());

    // nan/infinite coordinates propagate as values, never as a panic
    let wild = SliderPath::new(
        vec![
            PathControlPoint {
                pos: Vec2::new(f32::NAN, 0.0),
                path_type: Some(PathType::PerfectCurve),
            },
            PathControlPoint {
                pos: Vec2::new(f32::INFINITY, f32::NEG_INFINITY),
                path_type: None,
            },
            PathControlPoint {
                pos: Vec2::new(0.0, f32::NAN),
                path_type: None,
            },
        ],
        Some(100.0),
        true,
    );
    let _ = wild.map(|p| p.position_at(0.5));
}

#[test]
fn non_positive_bspline_degree_is_a_typed_error_not_a_panic() {
    // `PathType::BSpline`'s documented invariant is `d > 0` and the beatmap
    // decoder never produces anything else, but a hand-built control point can;
    // that must surface as `InvalidArgument` rather than a silent reinterpretation
    // of a negative degree as a huge unsigned one
    for degree in [0, -3, i32::MIN] {
        let cps = vec![
            PathControlPoint {
                pos: Vec2::new(0.0, 0.0),
                path_type: Some(PathType::BSpline(degree)),
            },
            PathControlPoint {
                pos: Vec2::new(60.0, 120.0),
                path_type: None,
            },
            PathControlPoint {
                pos: Vec2::new(120.0, 0.0),
                path_type: None,
            },
        ];
        match SliderPath::new(cps, None, true) {
            Err(engine::EngineError::InvalidArgument(_)) => {}
            other => panic!("degree {degree}: expected InvalidArgument, got {other:?}"),
        }
    }
}
