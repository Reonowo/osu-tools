//! port of osu.framework/utils/pathapproximator.cs (tag 2026.731.0),
//! quirk-for-quirk. all vector math is f32, matching osutk.

use crate::error::{resource_limit, EngineError, Result};
use crate::limits;
use crate::math::{dotnet_double_to_i32_unchecked, Vec2};
use crate::path::arc::CircularArcProperties;

/// pathapproximator.cs:18
pub const BEZIER_TOLERANCE: f32 = 0.25;

/// pathapproximator.cs:23 — the amount of pieces to calculate for each
/// control point quadruplet. public: task 9's bulb-culling logic in
/// `SliderPath` needs `CATMULL_DETAIL * 2`
pub const CATMULL_DETAIL: usize = 50;

/// checked after every point the approximator appends, and once more after
/// the final point; `max_vertices` (not the `limits::MAX_SLIDER_PATH_VERTICES`
/// constant) is reported as the enforced limit, since callers may supply a
/// tighter budget than the production constant
fn budget_check(len: usize, max_vertices: usize) -> Result<()> {
    if len > max_vertices {
        return Err(resource_limit(
            "MAX_SLIDER_PATH_VERTICES",
            max_vertices as u64,
            len as u64,
        ));
    }
    Ok(())
}

/// checked before a subdivision pushes its two children, so a curve that never
/// satisfies `bezier_is_flat_enough` is rejected instead of descending forever;
/// `max_depth` (not the `limits::MAX_BEZIER_SUBDIVISION_DEPTH` constant) is
/// reported as the enforced limit, matching `budget_check`'s convention, since
/// the private capped entry point lets tests supply a tighter bound
fn subdivision_depth_check(depth: usize, max_depth: usize) -> Result<()> {
    if depth > max_depth {
        return Err(resource_limit(
            "MAX_BEZIER_SUBDIVISION_DEPTH",
            max_depth as u64,
            depth as u64,
        ));
    }
    Ok(())
}

/// pathapproximator.cs:33 — delegates to the b-spline path with degree
/// `max(1, len - 1)`; the max(1, ...) keeps the degree valid even for zero
/// or one control points, both of which the b-spline path no-ops on before
/// the degree is ever used
pub fn bezier_to_piecewise_linear(control_points: &[Vec2], max_vertices: usize) -> Result<Vec<Vec2>> {
    let degree = control_points.len().saturating_sub(1).max(1);
    b_spline_to_piecewise_linear(control_points, degree, max_vertices)
}

/// pathapproximator.cs:79
pub fn b_spline_to_piecewise_linear(
    control_points: &[Vec2],
    degree: usize,
    max_vertices: usize,
) -> Result<Vec<Vec2>> {
    b_spline_to_piecewise_linear_capped(
        control_points,
        degree,
        max_vertices,
        limits::MAX_BEZIER_SUBDIVISION_DEPTH,
        limits::MAX_BSPLINE_KNOT_INSERTION_OPS,
    )
}

/// the real body of [`b_spline_to_piecewise_linear`], with the subdivision-depth
/// and knot-insertion bounds as explicit parameters so the boundary tests can
/// drive each to an exact, analytically known value on a tiny input, instead of
/// having to synthesise a 256-level curve or a multi-thousand-degree spline
/// whose accept-side case would cost real seconds to run
fn b_spline_to_piecewise_linear_capped(
    control_points: &[Vec2],
    degree: usize,
    max_vertices: usize,
    max_depth: usize,
    max_insertion_ops: u64,
) -> Result<Vec<Vec2>> {
    // pathapproximator.cs:84 — `ArgumentOutOfRangeException.ThrowIfLessThan(degree, 1)`,
    // checked unconditionally before the control-point-count check below (a
    // zero-degree call is rejected even for zero or one control points).
    // lazer throws a catchable exception here, not undefined behaviour, so
    // the port returns a typed error rather than panicking on malformed input
    if degree < 1 {
        return Err(EngineError::InvalidArgument(format!(
            "b_spline_to_piecewise_linear: degree must be >= 1, got {degree}"
        )));
    }

    // spline fitting does not make sense for zero or one points; this makes
    // the function a no-op in that case, mirroring the c# early return.
    // the budget still applies: returning the lone point unchecked would let a
    // caller-supplied `max_vertices` of 0 come back holding one vertex, which
    // contradicts the cap this function documents itself as enforcing
    if control_points.len() < 2 {
        budget_check(control_points.len(), max_vertices)?;
        return Ok(control_points.to_vec());
    }

    let mut degree = degree.min(control_points.len() - 1);
    let point_count = control_points.len() - 1;

    // each entry carries its own subdivision depth so `subdivision_depth_check`
    // bounds how far the descent below may go; the initial beziers are depth 0
    let mut to_flatten: Vec<(Vec<Vec2>, usize)> =
        b_spline_to_bezier_internal(control_points, &mut degree, max_vertices, max_insertion_ops)?
            .into_iter()
            .map(|curve| (curve, 0))
            .collect();
    let mut free_buffers: Vec<Vec<Vec2>> = Vec::new();
    let mut output: Vec<Vec2> = Vec::new();
    let count = degree + 1;

    // c# subdivision_buffer1 (len degree + 1) and subdivision_buffer2 (len
    // degree * 2 + 1); subdivision_buffer2 doubles as the left-child scratch
    // across iterations, matching `Vector2[] leftChild = subdivisionBuffer2;`
    let mut scratch1 = vec![Vec2::ZERO; count];
    let mut scratch2 = vec![Vec2::ZERO; degree * 2 + 1];

    // "to_flatten" holds curves not yet approximated well enough. using a vec
    // as a stack emulates recursion without risking a stack overflow — the
    // same depth-first subdivision osu-framework performs iteratively
    while let Some((mut parent, depth)) = to_flatten.pop() {
        if bezier_is_flat_enough(&parent) {
            bezier_approximate(&parent, &mut output, &mut scratch2, &mut scratch1, count);
            budget_check(output.len(), max_vertices)?;
            free_buffers.push(parent);
            continue;
        }

        // the c# has no equivalent of this check: it recurses on a real stack
        // and a non-convergent curve simply exhausts it. this port's iterative
        // stack has no such natural bound, and the crate's no-panic guarantee
        // means the runaway has to surface as a typed error rather than as an
        // allocation failure, so the depth the c# bounds implicitly is bounded
        // explicitly here. no curve that converges at all reaches it (see
        // `limits::MAX_BEZIER_SUBDIVISION_DEPTH`), so output is unaffected
        let child_depth = depth + 1;
        subdivision_depth_check(child_depth, max_depth)?;

        let mut right_child = free_buffers.pop().unwrap_or_else(|| vec![Vec2::ZERO; count]);
        bezier_subdivide(&parent, &mut scratch2, &mut right_child, count);
        // reuse the parent buffer for the left child, saving one allocation
        parent[..count].copy_from_slice(&scratch2[..count]);

        to_flatten.push((right_child, child_depth));
        to_flatten.push((parent, child_depth));
    }

    output.push(control_points[point_count]);
    budget_check(output.len(), max_vertices)?;
    Ok(output)
}

/// pathapproximator.cs:774 — boehm's algorithm. the c# builds a `Stack<T>`
/// by pushing sub-beziers left-to-right then the tail remainder, then
/// rebuilds a second stack from the first stack's (top-to-bottom) enumeration
/// — a double reversal that nets out to popping the tail remainder *last*.
/// pushing in the same left-to-right order onto a `Vec` and reversing once
/// reproduces that same final pop order (tail remainder popped last)
fn b_spline_to_bezier_internal(
    control_points: &[Vec2],
    degree: &mut usize,
    max_vertices: usize,
    max_insertion_ops: u64,
) -> Result<Vec<Vec<Vec2>>> {
    *degree = (*degree).min(control_points.len() - 1);
    let point_count = control_points.len() - 1;
    let d = *degree;
    // zero in the degenerate single-bezier case below, which is exactly right:
    // no knot is inserted there, so the loop never runs
    let segments = point_count - d;

    // both charges are taken before *anything* is allocated -- including the
    // working clone and the degenerate early return underneath. this pass runs
    // before a single vertex exists, so neither the vertex budget in the caller
    // nor any caller-side point cap can see it, and its cost is driven by the
    // degree, which none of them constrain. see
    // limits::MAX_BSPLINE_KNOT_INSERTION_OPS for how a plain `.osu` file reaches
    // it. the two resources are charged separately: the points about to be
    // materialised against the caller's vertex budget, the work against the ops
    // cap. saturating throughout, since the whole point is that these products
    // overflow for the inputs being rejected.
    //
    // `segments + 1`, not `segments`: the loop emits one `d + 1`-point bezier
    // per segment and then pushes the tail remainder as one more, so counting
    // only the loop's output under-charges by a whole segment. the same
    // expression covers the single-bezier case, where `segments` is 0 and the
    // charge is the `d + 1 == control_points.len()` points of that one curve --
    // which is the *only* guard that path gets, since every
    // `bezier_to_piecewise_linear` call lands there with `degree == point_count`
    budget_check((segments + 1).saturating_mul(d + 1), max_vertices)?;

    // deliberately the loose `segments * d^2` rather than the exact
    // `segments * (d - 1) * d / 2` the loop actually performs -- about twice
    // the truth, which is the safe direction for a guard and keeps the
    // expression obviously matched to the two nested loops it bounds
    let insertion_ops = (segments as u64)
        .saturating_mul(d as u64)
        .saturating_mul(d as u64);
    if insertion_ops > max_insertion_ops {
        return Err(resource_limit(
            "MAX_BSPLINE_KNOT_INSERTION_OPS",
            max_insertion_ops,
            insertion_ops,
        ));
    }

    let mut points = control_points.to_vec();
    let mut result: Vec<Vec<Vec2>> = Vec::new();

    if d == point_count {
        // b-spline subdivision unnecessary, degenerate to a single bezier
        result.push(points);
        return Ok(result);
    }

    for i in 0..segments {
        let mut sub_bezier = vec![Vec2::ZERO; d + 1];
        sub_bezier[0] = points[i];

        // destructively insert the knot degree-1 times via boehm's algorithm
        for j in 0..d - 1 {
            sub_bezier[j + 1] = points[i + 1];
            for k in 1..d - j {
                let l = k.min(point_count - d - i);
                points[i + k] = (points[i + k] * l as f32 + points[i + k + 1]) / (l as f32 + 1.0);
            }
        }

        sub_bezier[d] = points[i + 1];
        result.push(sub_bezier);
    }
    result.push(points[point_count - d..].to_vec());
    result.reverse();
    Ok(result)
}

/// pathapproximator.cs:831 — second-difference flatness check
fn bezier_is_flat_enough(control_points: &[Vec2]) -> bool {
    for i in 1..control_points.len().saturating_sub(1) {
        let v = control_points[i - 1] - control_points[i] * 2.0 + control_points[i + 1];
        if v.length_squared() > BEZIER_TOLERANCE * BEZIER_TOLERANCE * 4.0 {
            return false;
        }
    }
    true
}

/// pathapproximator.cs:852. the c# signature takes a separate scratch buffer
/// for its `midpoints` working array, but `bezierApproximate` (its only
/// flatten-time caller) always calls it with that scratch buffer set to the
/// same array object as `r`, making `r[count-i-1] = midpoints[count-i-1]` a
/// self-assignment there. that self-assignment is provably a no-op even when
/// `r` and the scratch differ (as they do at the other call site, in the main
/// subdivision loop): `r[count-i-1]` is written exactly once, immediately
/// after the previous iteration's inner loop last touches index `count-i-1`
/// and before any later iteration touches it again, so copying that value
/// into a distinct `r` and finding it already sitting in an aliased `r` are
/// observationally identical. this port therefore drops the separate scratch
/// parameter entirely and uses `r` directly as the midpoints buffer at both
/// call sites, which reproduces the aliased behaviour everywhere
fn bezier_subdivide(control_points: &[Vec2], l: &mut [Vec2], r: &mut [Vec2], count: usize) {
    r[..count].copy_from_slice(&control_points[..count]);

    // clippy wants `l.iter_mut().enumerate().take(count)` here; kept as an
    // index loop so the shape stays recognisable against
    // pathapproximator.cs:859. `i` is load-bearing in the inner loop's bound
    // either way, so the iterator form would hide the index without removing it
    #[allow(clippy::needless_range_loop)]
    for i in 0..count {
        l[i] = r[0];
        for j in 0..count - i - 1 {
            r[j] = (r[j] + r[j + 1]) / 2.0;
        }
    }
}

/// pathapproximator.cs:878 — de casteljau's algorithm
fn bezier_approximate(
    control_points: &[Vec2],
    output: &mut Vec<Vec2>,
    l_buf: &mut [Vec2],
    r_buf: &mut [Vec2],
    count: usize,
) {
    bezier_subdivide(control_points, l_buf, r_buf, count);

    // clippy wants a `copy_from_slice` here; kept as the c#'s explicit copy
    // loop (pathapproximator.cs:885-886) so the index arithmetic that stitches
    // the right child onto the tail of the left one stays visible
    #[allow(clippy::manual_memcpy)]
    for i in 0..count - 1 {
        l_buf[count + i] = r_buf[i + 1];
    }

    output.push(control_points[0]);
    for i in 1..count - 1 {
        let index = 2 * i;
        let p = (l_buf[index - 1] + l_buf[index] * 2.0 + l_buf[index + 1]) * 0.25;
        output.push(p);
    }
}

/// pathapproximator.cs:150. each of the `CATMULL_DETAIL` subdivisions of a
/// control-point pair emits *two* points — `t = c/detail` and `t =
/// (c+1)/detail` — rather than one; that duplication is deliberate lazer
/// behaviour (pathapproximator.cs:163-164) and downstream code (task 9's
/// `SliderPath`) depends on it, so it is reproduced verbatim rather than
/// deduplicated. the projected vertex count — `segments * CATMULL_DETAIL *
/// 2` — is exact, so the budget is checked once up front instead of after
/// every push, avoiding an oversized allocation for a caller-supplied
/// control-point list that would blow the budget
pub fn catmull_to_piecewise_linear(control_points: &[Vec2], max_vertices: usize) -> Result<Vec<Vec2>> {
    let segments = control_points.len().saturating_sub(1);
    let projected_len = segments.saturating_mul(CATMULL_DETAIL).saturating_mul(2);
    budget_check(projected_len, max_vertices)?;

    let mut result = Vec::with_capacity(projected_len);
    for i in 0..segments {
        // pathapproximator.cs:156-159 — endpoint neighbours are extrapolated
        // by reflection (`v2 + v2 - v1`, `v3 + v3 - v2`), not clamped to the
        // nearest real control point
        let v1 = if i > 0 {
            control_points[i - 1]
        } else {
            control_points[i]
        };
        let v2 = control_points[i];
        let v3 = if i < control_points.len() - 1 {
            control_points[i + 1]
        } else {
            v2 + v2 - v1
        };
        let v4 = if i < control_points.len() - 2 {
            control_points[i + 2]
        } else {
            v3 + v3 - v2
        };

        for c in 0..CATMULL_DETAIL {
            result.push(catmull_find_point(
                v1,
                v2,
                v3,
                v4,
                c as f32 / CATMULL_DETAIL as f32,
            ));
            result.push(catmull_find_point(
                v1,
                v2,
                v3,
                v4,
                (c + 1) as f32 / CATMULL_DETAIL as f32,
            ));
        }
    }

    Ok(result)
}

/// pathapproximator.cs:907 — the 0.5f cubic-polynomial catmull-rom basis,
/// entirely in f32. term order matches the c# exactly (float addition is
/// not associative, so a rearranged-but-equivalent expression can differ in
/// the last ulp)
fn catmull_find_point(v1: Vec2, v2: Vec2, v3: Vec2, v4: Vec2, t: f32) -> Vec2 {
    let t2 = t * t;
    let t3 = t * t2;
    Vec2::new(
        0.5 * (2.0 * v2.x
            + (-v1.x + v3.x) * t
            + (2.0 * v1.x - 5.0 * v2.x + 4.0 * v3.x - v4.x) * t2
            + (-v1.x + 3.0 * v2.x - 3.0 * v3.x + v4.x) * t3),
        0.5 * (2.0 * v2.y
            + (-v1.y + v3.y) * t
            + (2.0 * v1.y - 5.0 * v2.y + 4.0 * v3.y - v4.y) * t2
            + (-v1.y + 3.0 * v2.y - 3.0 * v3.y + v4.y) * t3),
    )
}

/// pathapproximator.cs:255 — identity copy; linear "approximation" is just
/// the input control points verbatim
pub fn linear_to_piecewise_linear(control_points: &[Vec2], max_vertices: usize) -> Result<Vec<Vec2>> {
    budget_check(control_points.len(), max_vertices)?;
    Ok(control_points.to_vec())
}

/// pathapproximator.cs:25 — public because task 9's slidercase-level
/// subdivision guard reuses it verbatim
pub const CIRCULAR_ARC_TOLERANCE: f32 = 0.1;

/// pathapproximator.cs:175 — falls back to the bezier path when the three
/// control points form a degenerate (near-collinear or coincident) triangle,
/// mirroring `CircularArcToPiecewiseLinear`'s `if (!pr.IsValid)` branch
pub fn circular_arc_to_piecewise_linear(control_points: &[Vec2], max_vertices: usize) -> Result<Vec<Vec2>> {
    // circulararcproperties.cs's constructor indexes controlPoints[0..2] on a
    // bare `ReadOnlySpan<Vector2>` with no length guard, so a c# caller passing
    // fewer than 3 points crashes with an unhandled exception there. this
    // engine never panics on malformed input, so the same precondition is
    // enforced here as a typed error instead of an out-of-bounds panic
    if control_points.len() < 3 {
        return Err(EngineError::InvalidArgument(format!(
            "circular_arc_to_piecewise_linear: requires at least 3 control points, got {}",
            control_points.len()
        )));
    }

    let pr = CircularArcProperties::new(control_points[0], control_points[1], control_points[2]);
    if !pr.is_valid {
        return bezier_to_piecewise_linear(control_points, max_vertices);
    }

    // pathapproximator.cs:186 — the exact angle required to meet the tolerance
    // is 2 * acos(1 - tolerance / radius); the special case below covers
    // extremely short sliders where the radius is smaller than the tolerance,
    // a pathological rather than realistic case. `1 - tolerance / radius` is
    // computed entirely in f32 (matching the c# float arithmetic) and only
    // widened to f64 once, immediately before the call to `acos`
    let amount_points = if 2.0 * pr.radius <= CIRCULAR_ARC_TOLERANCE {
        2usize
    } else {
        let narrowed_cos_half_angle = 1.0f32 - CIRCULAR_ARC_TOLERANCE / pr.radius;
        let half_angle = f64::from(narrowed_cos_half_angle).acos();
        // the c# narrows this whole expression through `(int)Math.Ceiling(...)`,
        // which on this port's pinned toolchain (.net 8, x86/x64) truncates a
        // non-finite double to int.MinValue rather than saturating — an
        // architecture/version-specific quirk fixed in .net 9, not a
        // jit-tiering effect; see `dotnet_double_to_i32_unchecked`'s doc
        // comment for the verified mechanism and the .net 9 breaking-change
        // reference. when radius is enormous (an almost-collinear "arc"),
        // half_angle rounds to exactly 0.0 and this division explodes to
        // +infinity, so the cast yields int.MinValue here, not int.MaxValue;
        // `Math.Max(2, ...)` then clamps that back up to 2, exactly matching
        // the pinned fixture for arc-huge-radius-zero-acos
        let raw_count = dotnet_double_to_i32_unchecked((pr.theta_range / (2.0 * half_angle)).ceil());
        2i32.max(raw_count) as usize
    };
    budget_check(amount_points, max_vertices)?;

    let mut output = Vec::with_capacity(amount_points);
    for i in 0..amount_points {
        let fract = i as f64 / (amount_points - 1) as f64;
        let theta = pr.theta_start + pr.direction * fract * pr.theta_range;
        let o = Vec2::new(theta.cos() as f32, theta.sin() as f32) * pr.radius;
        output.push(pr.centre + o);
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::limits;

    fn cp(pairs: &[(f32, f32)]) -> Vec<Vec2> {
        pairs.iter().map(|&(x, y)| Vec2::new(x, y)).collect()
    }

    #[test]
    fn a_mid_range_explicit_degree_cannot_run_unbounded_knot_insertion() {
        // the shape limits::MAX_BSPLINE_KNOT_INSERTION_OPS exists for: a
        // 10,000-point B5000 slider is spellable in a plain .osu file and sits
        // under every point cap, but Boehm's algorithm would materialise ~25
        // million intermediate points and run ~1.25e11 iterations for it, all
        // before the first vertex exists. it has to come back as a typed error,
        // and it has to come back fast
        let points: Vec<Vec2> = (0..10_000)
            .map(|i| Vec2::new(i as f32, (i % 97) as f32))
            .collect();

        let start = std::time::Instant::now();
        let result = b_spline_to_piecewise_linear(&points, 5_000, limits::MAX_SLIDER_PATH_VERTICES);
        let elapsed = start.elapsed();

        // this particular shape is caught by the intermediate-point charge
        // first: 5,000 segments of 5,001 points is ~25M, well past the 2M vertex
        // budget. asserting the exact cap keeps the test honest about which
        // guard did the work -- the ops cap gets its own boundary test below
        match result {
            Err(EngineError::ResourceLimit {
                cap: "MAX_SLIDER_PATH_VERTICES",
                ..
            }) => {}
            other => panic!(
                "expected MAX_SLIDER_PATH_VERTICES, got {:?}",
                other.map(|v| v.len())
            ),
        }
        assert!(
            elapsed < std::time::Duration::from_secs(5),
            "must be rejected before doing the work, took {elapsed:?}"
        );
    }

    #[test]
    fn knot_insertion_op_cap_boundary() {
        // limits.rs boundary-test convention: accept at the enforced limit,
        // error just past it. driven through the capped entry point on a tiny
        // input, so the accept side is exact and free rather than a
        // multi-thousand-degree spline costing real seconds.
        //
        // six control points at degree 2: point_count = 5, segments = 5 - 2 = 3,
        // so the counter reads segments * degree^2 = 3 * 4 = 12
        let curve = cp(&[
            (0.0, 0.0),
            (10.0, 40.0),
            (20.0, -20.0),
            (30.0, 40.0),
            (40.0, 0.0),
            (50.0, 20.0),
        ]);
        const OPS: u64 = 12;

        let at_limit =
            b_spline_to_piecewise_linear_capped(&curve, 2, limits::MAX_SLIDER_PATH_VERTICES, 256, OPS)
                .unwrap();
        // the bound must not perturb a curve it admits
        let uncapped = b_spline_to_piecewise_linear(&curve, 2, limits::MAX_SLIDER_PATH_VERTICES).unwrap();
        assert_eq!(at_limit, uncapped);

        match b_spline_to_piecewise_linear_capped(&curve, 2, limits::MAX_SLIDER_PATH_VERTICES, 256, OPS - 1) {
            Err(EngineError::ResourceLimit {
                cap: "MAX_BSPLINE_KNOT_INSERTION_OPS",
                limit: 11,
                actual: 12,
            }) => {}
            other => panic!("expected a MAX_BSPLINE_KNOT_INSERTION_OPS resource limit, got {other:?}"),
        }
    }

    #[test]
    fn a_high_degree_spline_is_caught_by_the_op_cap_not_the_point_charge() {
        // the gap the ops cap exists to close: few segments but a huge degree
        // keeps the intermediate-point count small (4 * 5,001 is ~20k, far under
        // the 2M budget) while the counter reads 3 * 5,000^2 = 75M, past the 50M
        // cap. the loop's actual inner iterations would be 3 * 4,999 * 5,000 / 2
        // = 37,492,500 -- the counter deliberately over-charges, see limits.rs
        let points: Vec<Vec2> = (0..5_004).map(|i| Vec2::new(i as f32, (i % 89) as f32)).collect();

        let start = std::time::Instant::now();
        let result = b_spline_to_piecewise_linear(&points, 5_000, limits::MAX_SLIDER_PATH_VERTICES);
        let elapsed = start.elapsed();

        match result {
            Err(EngineError::ResourceLimit {
                cap: "MAX_BSPLINE_KNOT_INSERTION_OPS",
                ..
            }) => {}
            other => panic!(
                "expected MAX_BSPLINE_KNOT_INSERTION_OPS, got {:?}",
                other.map(|v| v.len())
            ),
        }
        assert!(
            elapsed < std::time::Duration::from_secs(5),
            "must be rejected before doing the work, took {elapsed:?}"
        );
    }

    #[test]
    fn the_degenerate_single_bezier_path_is_charged_too() {
        // `bezier_to_piecewise_linear` always arrives with degree == point_count,
        // which takes the "subdivision unnecessary" branch. that branch used to
        // return before either preflight ran and before the working clone was
        // even allocated, so the whole guard was dead for every bezier call
        let curve = cp(&[(0.0, 0.0), (10.0, 40.0), (20.0, -20.0), (30.0, 40.0)]);

        assert!(bezier_to_piecewise_linear(&curve, limits::MAX_SLIDER_PATH_VERTICES).is_ok());

        // four control points collapse to one 4-point bezier, so the preflight
        // charge is 4 -- a budget of 3 is refused by it rather than by the
        // output check further down (which would report a larger `actual`)
        match bezier_to_piecewise_linear(&curve, 3) {
            Err(EngineError::ResourceLimit {
                cap: "MAX_SLIDER_PATH_VERTICES",
                limit: 3,
                actual: 4,
            }) => {}
            other => panic!("expected the point charge to reject, got {other:?}"),
        }

        // and the charge lands before the clone, not after it
        match b_spline_to_piecewise_linear(&curve, 3, 0) {
            Err(EngineError::ResourceLimit {
                cap: "MAX_SLIDER_PATH_VERTICES",
                limit: 0,
                actual: 4,
            }) => {}
            other => panic!("expected a zero budget to reject immediately, got {other:?}"),
        }
    }

    #[test]
    fn max_bspline_knot_insertion_ops_constant_matches_limits_module() {
        assert_eq!(limits::MAX_BSPLINE_KNOT_INSERTION_OPS, 50_000_000);
    }

    #[test]
    fn ordinary_low_degree_b_splines_are_unaffected_by_the_knot_insertion_cap() {
        // real slider degrees are single digits, so a legitimate path has to
        // stay orders of magnitude clear of the cap
        let points: Vec<Vec2> = (0..10_000)
            .map(|i| Vec2::new(i as f32, (i % 97) as f32))
            .collect();
        for degree in [2usize, 3, 4, 7] {
            assert!(
                b_spline_to_piecewise_linear(&points, degree, limits::MAX_SLIDER_PATH_VERTICES).is_ok(),
                "degree {degree} should be well under the cap"
            );
        }
    }

    #[test]
    fn a_single_point_still_has_to_fit_the_caller_supplied_budget() {
        // the sub-two-point early return is a no-op on the geometry, not an
        // exemption from the cap: one vertex does not fit a budget of zero
        let one = cp(&[(1.0, 2.0)]);
        assert!(b_spline_to_piecewise_linear(&one, 1, 0).is_err());
        assert!(bezier_to_piecewise_linear(&one, 0).is_err());
        assert!(bezier_to_piecewise_linear(&one, 1).is_ok());

        // zero points fit a zero budget, since nothing is produced
        let none: Vec<Vec2> = Vec::new();
        assert!(bezier_to_piecewise_linear(&none, 0).is_ok());
    }

    #[test]
    fn empty_and_single_point_are_no_ops() {
        let empty: Vec<Vec2> = Vec::new();
        assert_eq!(
            bezier_to_piecewise_linear(&empty, limits::MAX_SLIDER_PATH_VERTICES).unwrap(),
            empty
        );

        let one = cp(&[(1.0, 2.0)]);
        assert_eq!(
            bezier_to_piecewise_linear(&one, limits::MAX_SLIDER_PATH_VERTICES).unwrap(),
            one
        );
    }

    #[test]
    fn two_point_bezier_is_the_straight_line_endpoints() {
        // bezier_is_flat_enough is vacuously true for 2 control points (the
        // curvature-check loop bound is len - 1 = 1, so `1..1` never runs),
        // so a straight line always flattens to exactly its two endpoints
        let line = cp(&[(0.0, 0.0), (100.0, 50.0)]);
        let result = bezier_to_piecewise_linear(&line, limits::MAX_SLIDER_PATH_VERTICES).unwrap();
        assert_eq!(result, line);
    }

    #[test]
    fn bezier_subdivide_aliased_and_unaliased_r_agree() {
        // proves the aliasing quirk noted on `bezier_subdivide`: whether `r`
        // shares memory with the scratch buffer bezier_approximate uses, or
        // is a distinct buffer as in the main subdivision loop, the final
        // contents of `r` are identical
        let curve = cp(&[(0.0, 0.0), (30.0, 90.0), (70.0, -40.0), (100.0, 20.0)]);
        let count = curve.len();

        let mut l_a = vec![Vec2::ZERO; count];
        let mut r_a = vec![Vec2::ZERO; count];
        bezier_subdivide(&curve, &mut l_a, &mut r_a, count);

        // a second call reusing a buffer already holding stale data confirms
        // the r[..count].copy_from_slice at the top re-seeds it correctly
        let mut l_b = vec![Vec2::new(-1.0, -1.0); count];
        let mut r_b = vec![Vec2::new(-1.0, -1.0); count];
        bezier_subdivide(&curve, &mut l_b, &mut r_b, count);

        assert_eq!(l_a, l_b);
        assert_eq!(r_a, r_b);
    }

    #[test]
    fn degree_is_clamped_to_point_count() {
        // pathapproximator.cs:94 clamps degree to controlPoints.Length - 1;
        // an over-large degree should behave identically to the clamped one
        let curve = cp(&[(0.0, 0.0), (100.0, 100.0), (200.0, 0.0)]);
        let clamped = b_spline_to_piecewise_linear(&curve, 2, limits::MAX_SLIDER_PATH_VERTICES).unwrap();
        let over = b_spline_to_piecewise_linear(&curve, 7, limits::MAX_SLIDER_PATH_VERTICES).unwrap();
        assert_eq!(clamped, over);
    }

    // limits.rs boundary-test convention: accept at the enforced limit, error
    // just past it. a straight two-point curve always yields exactly 2
    // vertices (see two_point_bezier_is_the_straight_line_endpoints), which
    // makes the boundary exact and deterministic without generating anywhere
    // near limits::MAX_SLIDER_PATH_VERTICES real vertices
    #[test]
    fn slider_path_vertex_count_cap_boundary() {
        let line = cp(&[(0.0, 0.0), (100.0, 50.0)]);

        let at_limit = bezier_to_piecewise_linear(&line, 2).unwrap();
        assert_eq!(at_limit.len(), 2);

        match bezier_to_piecewise_linear(&line, 1) {
            Err(EngineError::ResourceLimit {
                cap: "MAX_SLIDER_PATH_VERTICES",
                limit: 1,
                actual: 2,
            }) => {}
            other => panic!("expected a MAX_SLIDER_PATH_VERTICES resource limit error, got {other:?}"),
        }
    }

    #[test]
    fn max_slider_path_vertices_constant_matches_limits_module() {
        assert_eq!(limits::MAX_SLIDER_PATH_VERTICES, 2_000_000);
    }

    // pathapproximator.cs:84 throws ArgumentOutOfRangeException for degree < 1,
    // unconditionally — even when the control-point list is short enough that
    // the length check below would otherwise no-op. this must return a typed
    // error rather than panic in every build profile, since the earlier
    // `debug_assert!` this replaced silently compiled out of release builds
    // and let execution fall through into an actual index-out-of-bounds panic
    // inside `b_spline_to_bezier_internal`; see the "fix round 1" report
    // section for a `--release` run proving that panic is gone
    #[test]
    fn b_spline_degree_zero_is_rejected() {
        let curve = cp(&[(0.0, 0.0), (100.0, 100.0), (200.0, 0.0)]);
        match b_spline_to_piecewise_linear(&curve, 0, limits::MAX_SLIDER_PATH_VERTICES) {
            Err(EngineError::InvalidArgument(_)) => {}
            other => panic!("expected EngineError::InvalidArgument, got {other:?}"),
        }
    }

    #[test]
    fn b_spline_degree_zero_is_rejected_even_for_short_control_point_lists() {
        // mirrors the c# ordering: the degree check runs before the
        // control-points-length check, so a degree of 0 is rejected even
        // when the point count alone would have made the call a no-op
        for curve in [Vec::new(), cp(&[(1.0, 2.0)]), cp(&[(0.0, 0.0), (1.0, 1.0)])] {
            match b_spline_to_piecewise_linear(&curve, 0, limits::MAX_SLIDER_PATH_VERTICES) {
                Err(EngineError::InvalidArgument(_)) => {}
                other => panic!(
                    "curve len {}: expected EngineError::InvalidArgument, got {other:?}",
                    curve.len()
                ),
            }
        }
    }

    #[test]
    fn bezier_to_piecewise_linear_never_derives_a_zero_degree() {
        // bezier_to_piecewise_linear computes degree = max(1, len - 1), which
        // is always >= 1 regardless of input length, so it can never trip
        // the degree validation above — exercised down to the empty case
        for curve in [Vec::new(), cp(&[(1.0, 2.0)]), cp(&[(0.0, 0.0), (1.0, 1.0)])] {
            assert!(bezier_to_piecewise_linear(&curve, limits::MAX_SLIDER_PATH_VERTICES).is_ok());
        }
    }

    // a quadratic whose second difference is an exact power of two makes the
    // required subdivision depth analytic rather than empirical: de casteljau
    // at t = 0.5 divides a control polygon's second differences by exactly 4
    // per level, and every value here stays exactly representable in f32, so
    // this curve needs exactly 3 levels. |v| starts at 32 (1024 > 0.25, not
    // flat), then 8 (64), then 2 (4), then 0.5 -- and 0.25 > 0.25 is false, so
    // the depth-3 children are flat
    fn depth_three_curve() -> Vec<Vec2> {
        cp(&[(0.0, 0.0), (0.0, 16.0), (0.0, 0.0)])
    }

    #[test]
    fn bezier_subdivision_depth_cap_boundary() {
        // limits.rs boundary-test convention: accept at the enforced limit,
        // error just past it
        let curve = depth_three_curve();

        let at_limit = b_spline_to_piecewise_linear_capped(
            &curve,
            2,
            limits::MAX_SLIDER_PATH_VERTICES,
            3,
            limits::MAX_BSPLINE_KNOT_INSERTION_OPS,
        )
        .unwrap();
        // the depth bound is not allowed to perturb any curve that converges,
        // so a run right at the depth it needs must equal the production run
        let uncapped = bezier_to_piecewise_linear(&curve, limits::MAX_SLIDER_PATH_VERTICES).unwrap();
        assert_eq!(at_limit, uncapped);

        match b_spline_to_piecewise_linear_capped(
            &curve,
            2,
            limits::MAX_SLIDER_PATH_VERTICES,
            2,
            limits::MAX_BSPLINE_KNOT_INSERTION_OPS,
        ) {
            Err(EngineError::ResourceLimit {
                cap: "MAX_BEZIER_SUBDIVISION_DEPTH",
                limit: 2,
                actual: 3,
            }) => {}
            other => panic!("expected a MAX_BEZIER_SUBDIVISION_DEPTH resource limit error, got {other:?}"),
        }
    }

    #[test]
    fn max_bezier_subdivision_depth_constant_matches_limits_module() {
        assert_eq!(limits::MAX_BEZIER_SUBDIVISION_DEPTH, 256);
    }

    #[test]
    fn osu_expressible_extremes_stay_far_under_the_depth_cap() {
        // pins the headroom argument MAX_BEZIER_SUBDIVISION_DEPTH's value rests
        // on. rosu-map rejects curve coordinates outside +-131,072, so +-262,144
        // is the widest head-relative offset a `.osu` file can express; curves
        // built from those extremes are the worst legitimate case, and every one
        // of them flattens within a depth budget more than an order of magnitude
        // under the constant. a change that made real geometry need materially
        // deeper subdivision should fail here rather than quietly eat headroom
        const MEASURED_WORST: usize = 11;
        const _: () = assert!(limits::MAX_BEZIER_SUBDIVISION_DEPTH >= MEASURED_WORST * 10);

        let e = 262_144.0f32;
        let extremes: [(Vec<Vec2>, usize); 4] = [
            (cp(&[(0.0, 0.0), (e, e), (0.0, 0.0)]), 2),
            (cp(&[(0.0, 0.0), (e, -e), (-e, e)]), 2),
            (cp(&[(0.0, 0.0), (e, e), (-e, -e), (e, -e)]), 3),
            (cp(&[(0.0, 0.0), (e, e), (-e, -e), (e, -e), (-e, e)]), 4),
        ];
        for (curve, degree) in &extremes {
            let capped = b_spline_to_piecewise_linear_capped(
                curve,
                *degree,
                limits::MAX_SLIDER_PATH_VERTICES,
                MEASURED_WORST,
                limits::MAX_BSPLINE_KNOT_INSERTION_OPS,
            );
            let uncapped = b_spline_to_piecewise_linear(curve, *degree, limits::MAX_SLIDER_PATH_VERTICES);
            assert_eq!(
                capped.unwrap(),
                uncapped.unwrap(),
                "extremes curve of degree {degree} should flatten within depth {MEASURED_WORST}"
            );
        }
    }

    #[test]
    fn bezier_tolerates_nan_and_infinite_coordinates_without_panicking() {
        // the engine crate must never panic on malformed input, even in release
        // (where debug_assert! compiles out). the bezier/b-spline family is the
        // one approximator with a work loop no output-size cap can bound: a
        // curve that never satisfies bezier_is_flat_enough emits zero vertices,
        // so MAX_SLIDER_PATH_VERTICES is never consulted. before
        // MAX_BEZIER_SUBDIVISION_DEPTH existed, the last case below did not
        // panic -- it aborted the process with an allocation failure, which is
        // strictly worse, since an abort cannot be caught at all
        let nan_and_inf = cp(&[
            (0.0, 0.0),
            (f32::NAN, 1.0),
            (f32::INFINITY, f32::NEG_INFINITY),
            (10.0, 10.0),
        ]);
        let _ = bezier_to_piecewise_linear(&nan_and_inf, limits::MAX_SLIDER_PATH_VERTICES);
        let _ = b_spline_to_piecewise_linear(&nan_and_inf, 2, limits::MAX_SLIDER_PATH_VERTICES);

        // the f32 midpoint recurrence in bezier_subdivide reaches a fixed point
        // for control-point magnitudes around 1e10 and above, at which the
        // second-difference test is permanently false and the subdivision never
        // terminates on its own. these exact coordinates are the reproduction
        // from the review that motivated the depth cap
        let non_convergent = cp(&[(1e22, -1e33), (-1.0, 11.0), (260.0, 0.0), (1e20, 0.0)]);
        match bezier_to_piecewise_linear(&non_convergent, limits::MAX_SLIDER_PATH_VERTICES) {
            Err(EngineError::ResourceLimit {
                cap: "MAX_BEZIER_SUBDIVISION_DEPTH",
                ..
            }) => {}
            other => panic!("expected a MAX_BEZIER_SUBDIVISION_DEPTH resource limit error, got {other:?}"),
        }
    }

    #[test]
    fn catmull_empty_and_single_point_are_no_ops() {
        // pathapproximator.cs:154 `for (i = 0; i < controlPoints.Length - 1; i++)`
        // never runs for length 0 or 1 (`Length - 1` is -1 or 0), so both
        // produce an empty result rather than echoing the input like linear does
        let empty: Vec<Vec2> = Vec::new();
        assert_eq!(
            catmull_to_piecewise_linear(&empty, limits::MAX_SLIDER_PATH_VERTICES).unwrap(),
            Vec::new()
        );

        let one = cp(&[(1.0, 2.0)]);
        assert_eq!(
            catmull_to_piecewise_linear(&one, limits::MAX_SLIDER_PATH_VERTICES).unwrap(),
            Vec::new()
        );
    }

    #[test]
    fn catmull_segment_endpoints_pass_through_control_points() {
        // catmull_find_point(.., t=0) reduces to v2 and (.., t=1) reduces to
        // v3 regardless of the extrapolated v1/v4 neighbours — an analytic
        // property of the basis, independent of the fixture, that every
        // per-segment first/last emitted point should satisfy
        let curve = cp(&[(0.0, 0.0), (80.0, 100.0), (160.0, -20.0), (240.0, 60.0)]);
        let result = catmull_to_piecewise_linear(&curve, limits::MAX_SLIDER_PATH_VERTICES).unwrap();

        for i in 0..curve.len() - 1 {
            let base = i * CATMULL_DETAIL * 2;
            assert_eq!(result[base], curve[i], "segment {i} start");
            assert_eq!(
                result[base + CATMULL_DETAIL * 2 - 1],
                curve[i + 1],
                "segment {i} end"
            );
        }
    }

    #[test]
    fn catmull_doubled_point_quirk_shares_the_subdivision_boundary() {
        // pathapproximator.cs:163-164 pushes t=c/detail then t=(c+1)/detail
        // for every c, so consecutive subdivisions share their boundary value
        // twice in the flat output: result[2c+1] and result[2c+2] are the
        // same point, computed independently from the same v1..v4 and t
        let curve = cp(&[(0.0, 0.0), (80.0, 100.0), (160.0, -20.0), (240.0, 60.0)]);
        let result = catmull_to_piecewise_linear(&curve, limits::MAX_SLIDER_PATH_VERTICES).unwrap();

        for c in 0..CATMULL_DETAIL - 1 {
            assert_eq!(
                result[2 * c + 1],
                result[2 * c + 2],
                "boundary at subdivision {c}"
            );
        }
    }

    #[test]
    fn catmull_extrapolates_reflected_neighbours_at_open_ends() {
        // pathapproximator.cs:156-159: the segment before the first control
        // point uses v1 = v2 (reflection collapses to the point itself since
        // there is no real predecessor), and the segment after the last uses
        // v4 = v3 + v3 - v2. hand-derive the midpoint of a 2-point curve
        // using that exact reflected v1/v4 and check it against the port
        let p0 = Vec2::new(0.0, 0.0);
        let p1 = Vec2::new(100.0, 60.0);
        let curve = vec![p0, p1];

        let v1 = p0; // reflection at i=0 degenerates to v2 itself
        let v2 = p0;
        let v3 = p1;
        let v4 = v3 + v3 - v2; // reflection past the last real point

        let expected_mid = catmull_find_point(v1, v2, v3, v4, 0.5);

        let result = catmull_to_piecewise_linear(&curve, limits::MAX_SLIDER_PATH_VERTICES).unwrap();
        // c = 25 is the subdivision straddling t = 0.5 (25/50)
        assert_eq!(result[2 * 25], expected_mid);
    }

    #[test]
    fn catmull_vertex_budget_cap_boundary() {
        // limits.rs boundary-test convention: accept at the enforced limit,
        // error just past it. a 2-point curve always yields exactly
        // CATMULL_DETAIL * 2 = 100 vertices
        let curve = cp(&[(0.0, 0.0), (100.0, 60.0)]);
        let expected_len = CATMULL_DETAIL * 2;

        let at_limit = catmull_to_piecewise_linear(&curve, expected_len).unwrap();
        assert_eq!(at_limit.len(), expected_len);

        match catmull_to_piecewise_linear(&curve, expected_len - 1) {
            Err(EngineError::ResourceLimit {
                cap: "MAX_SLIDER_PATH_VERTICES",
                ..
            }) => {}
            other => panic!("expected a MAX_SLIDER_PATH_VERTICES resource limit error, got {other:?}"),
        }
    }

    #[test]
    fn catmull_tolerates_nan_and_infinite_coordinates_without_panicking() {
        // the engine crate must never panic on malformed input, even in
        // release (where debug_assert! compiles out); nan/infinite
        // coordinates propagate through the arithmetic as nan/infinite
        // results rather than tripping any assertion or comparison-based branch
        let curve = cp(&[
            (0.0, 0.0),
            (f32::NAN, 1.0),
            (f32::INFINITY, f32::NEG_INFINITY),
            (10.0, 10.0),
        ]);
        let result = catmull_to_piecewise_linear(&curve, limits::MAX_SLIDER_PATH_VERTICES).unwrap();
        assert_eq!(result.len(), (curve.len() - 1) * CATMULL_DETAIL * 2);
    }

    #[test]
    fn linear_to_piecewise_linear_is_identity() {
        // pathapproximator.cs:255-263 is a pure copy of the input
        let empty: Vec<Vec2> = Vec::new();
        assert_eq!(
            linear_to_piecewise_linear(&empty, limits::MAX_SLIDER_PATH_VERTICES).unwrap(),
            empty
        );

        let one = cp(&[(1.0, 2.0)]);
        assert_eq!(
            linear_to_piecewise_linear(&one, limits::MAX_SLIDER_PATH_VERTICES).unwrap(),
            one
        );

        let many = cp(&[(0.0, 0.0), (50.0, 50.0), (50.0, 50.0), (120.0, 0.0)]);
        assert_eq!(
            linear_to_piecewise_linear(&many, limits::MAX_SLIDER_PATH_VERTICES).unwrap(),
            many
        );
    }

    #[test]
    fn linear_vertex_budget_cap_boundary() {
        let curve = cp(&[(0.0, 0.0), (50.0, 50.0), (120.0, 0.0)]);

        let at_limit = linear_to_piecewise_linear(&curve, 3).unwrap();
        assert_eq!(at_limit.len(), 3);

        match linear_to_piecewise_linear(&curve, 2) {
            Err(EngineError::ResourceLimit {
                cap: "MAX_SLIDER_PATH_VERTICES",
                limit: 2,
                actual: 3,
            }) => {}
            other => panic!("expected a MAX_SLIDER_PATH_VERTICES resource limit error, got {other:?}"),
        }
    }

    #[test]
    fn catmull_detail_constant_matches_reference() {
        // pathapproximator.cs:23 `private const int catmull_detail = 50;`
        assert_eq!(CATMULL_DETAIL, 50);
    }

    #[test]
    fn circular_arc_tolerance_constant_matches_reference() {
        // pathapproximator.cs:25 `private const float circular_arc_tolerance = 0.1f;`
        assert_eq!(CIRCULAR_ARC_TOLERANCE, 0.1);
    }

    #[test]
    fn circular_arc_falls_back_to_bezier_for_degenerate_triangle() {
        // pathapproximator.cs:175-179's `if (!pr.IsValid) return BezierToPiecewiseLinear(...)`
        let collinear = cp(&[(0.0, 0.0), (100.0, 0.0), (200.0, 0.0)]);
        let arc_result =
            circular_arc_to_piecewise_linear(&collinear, limits::MAX_SLIDER_PATH_VERTICES).unwrap();
        let bezier_result = bezier_to_piecewise_linear(&collinear, limits::MAX_SLIDER_PATH_VERTICES).unwrap();
        assert_eq!(arc_result, bezier_result);
    }

    #[test]
    fn circular_arc_rejects_fewer_than_three_control_points() {
        // circulararcproperties.cs indexes controlPoints[0..2] with no length
        // guard; the c# side would throw an unhandled exception here, but this
        // engine never panics on malformed input, so this must be a typed error
        // in every build profile instead
        for curve in [Vec::new(), cp(&[(0.0, 0.0)]), cp(&[(0.0, 0.0), (1.0, 1.0)])] {
            match circular_arc_to_piecewise_linear(&curve, limits::MAX_SLIDER_PATH_VERTICES) {
                Err(EngineError::InvalidArgument(_)) => {}
                other => panic!(
                    "curve len {}: expected EngineError::InvalidArgument, got {other:?}",
                    curve.len()
                ),
            }
        }
    }

    #[test]
    fn circular_arc_tolerates_nan_and_infinite_coordinates_without_panicking() {
        // the engine crate must never panic on malformed input, even in
        // release (where debug_assert! compiles out); a nan/infinite offset
        // propagates through the trig and division as nan/infinite results
        // rather than tripping any assertion or comparison-based branch, and
        // the vertex budget check catches any resulting pathological count
        let curve = cp(&[(f32::NAN, 0.0), (100.0, f32::INFINITY), (f32::NEG_INFINITY, 0.0)]);
        let _ = circular_arc_to_piecewise_linear(&curve, limits::MAX_SLIDER_PATH_VERTICES);
    }

    // an equilateral triangle inscribed in a circle of radius 0.04 clears the
    // degenerate-triangle check (its area sits comfortably above
    // FLOAT_EPSILON) while its circumradius still trips the
    // `2 * radius <= CIRCULAR_ARC_TOLERANCE` special case (2 * 0.04 = 0.08 <=
    // 0.1). the fixture's `arc-tiny-radius` case is caught by the degenerate
    // check instead (a genuinely tiny non-degenerate radius needs a triangle
    // area right at the FLOAT_EPSILON boundary), which is exactly why this
    // branch needed its own coverage: `PathCases.Arcs`'s
    // `arc-radius-under-tolerance` case now uses this same construction (see
    // `circular_arc_matches_lazer` in path_approximator_fixtures.rs), giving
    // this branch golden, lazer-verified coverage too. this unit test is kept
    // alongside that golden case as an independent, property-based check
    // (geometry, not values copied from a fixture) that doesn't depend on the
    // fixture file existing
    fn tiny_radius_arc_points() -> Vec<Vec2> {
        let r = 0.04f32;
        vec![
            Vec2::new(0.0, r),
            Vec2::new(r * 210.0f32.to_radians().cos(), r * 210.0f32.to_radians().sin()),
            Vec2::new(r * 330.0f32.to_radians().cos(), r * 330.0f32.to_radians().sin()),
        ]
    }

    #[test]
    fn circular_arc_tiny_radius_uses_exactly_two_points() {
        let cps = tiny_radius_arc_points();

        let pr = crate::path::arc::CircularArcProperties::new(cps[0], cps[1], cps[2]);
        assert!(pr.is_valid);
        assert!(
            (pr.radius - 0.04).abs() < 1e-3,
            "expected radius near 0.04, got {}",
            pr.radius
        );
        assert!(2.0 * pr.radius <= CIRCULAR_ARC_TOLERANCE);

        let result = circular_arc_to_piecewise_linear(&cps, limits::MAX_SLIDER_PATH_VERTICES).unwrap();
        assert_eq!(result.len(), 2);
        for v in &result {
            let dist = Vec2::distance(*v, pr.centre);
            assert!(
                (dist - pr.radius).abs() < 1e-3,
                "vertex {v:?} not on the circle: dist {dist}, radius {}",
                pr.radius
            );
        }
    }

    #[test]
    fn circular_arc_vertex_budget_cap_boundary() {
        let cps = tiny_radius_arc_points();

        let at_limit = circular_arc_to_piecewise_linear(&cps, 2).unwrap();
        assert_eq!(at_limit.len(), 2);

        match circular_arc_to_piecewise_linear(&cps, 1) {
            Err(EngineError::ResourceLimit {
                cap: "MAX_SLIDER_PATH_VERTICES",
                limit: 1,
                actual: 2,
            }) => {}
            other => panic!("expected a MAX_SLIDER_PATH_VERTICES resource limit error, got {other:?}"),
        }
    }
}
