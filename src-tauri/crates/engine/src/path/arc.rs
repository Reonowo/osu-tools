//! port of osu.framework/utils/circulararcproperties.cs (tag 2026.731.0)

use crate::math::{almost_equals_f32, Vec2, FLOAT_EPSILON};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CircularArcProperties {
    pub is_valid: bool,
    pub theta_start: f64,
    pub theta_range: f64,
    pub direction: f64,
    pub radius: f32,
    pub centre: Vec2,
}

impl CircularArcProperties {
    /// circulararcproperties.cs:34 — `a`, `b`, `c` are three distinct points on the arc
    pub fn new(a: Vec2, b: Vec2, c: Vec2) -> Self {
        let invalid = CircularArcProperties {
            is_valid: false,
            theta_start: 0.0,
            theta_range: 0.0,
            direction: 0.0,
            radius: 0.0,
            centre: Vec2::ZERO,
        };

        // circulararcproperties.cs:41 — degenerate triangle (near-zero side length):
        // give up and let callers fall back to a more numerically stable method.
        // `cross` is entirely f32 here, and the almost-equals check against 0 uses
        // the float tolerance (Precision.AlmostEquals's float overload is picked
        // because `cross` is already a float — widening it to match the double
        // overload would be a worse overload match), not the double one
        let cross = (b.y - a.y) * (c.x - a.x) - (b.x - a.x) * (c.y - a.y);
        if almost_equals_f32(0.0, cross, FLOAT_EPSILON) {
            return invalid;
        }

        // circulararcproperties.cs:53-60 — circumcentre via the cartesian
        // circumscribed-circle formula, entirely in f32
        let d = 2.0 * (a.x * (b - c).y + b.x * (c - a).y + c.x * (a - b).y);
        let a_sq = a.length_squared();
        let b_sq = b.length_squared();
        let c_sq = c.length_squared();

        let centre = Vec2::new(
            a_sq * (b - c).y + b_sq * (c - a).y + c_sq * (a - b).y,
            a_sq * (c - b).x + b_sq * (a - c).x + c_sq * (b - a).x,
        ) / d;

        let d_a = a - centre;
        let d_c = c - centre;
        let radius = d_a.length();

        // circulararcproperties.cs:67-71 — theta_start/theta_end widen the f32
        // offset components to f64 before calling atan2, matching `Math.Atan2`
        // taking doubles
        let theta_start = f64::from(d_a.y).atan2(f64::from(d_a.x));
        let mut theta_end = f64::from(d_c.y).atan2(f64::from(d_c.x));
        while theta_end < theta_start {
            theta_end += 2.0 * std::f64::consts::PI;
        }

        let mut direction = 1.0;
        let mut theta_range = theta_end - theta_start;

        // circulararcproperties.cs:76-85 — decide the winding by checking which
        // side of a->c the point b lies on
        let ortho_a_to_c = c - a;
        let ortho_a_to_c = Vec2::new(ortho_a_to_c.y, -ortho_a_to_c.x);
        if Vec2::dot(ortho_a_to_c, b - a) < 0.0 {
            direction = -direction;
            theta_range = 2.0 * std::f64::consts::PI - theta_range;
        }

        CircularArcProperties {
            is_valid: true,
            theta_start,
            theta_range,
            direction,
            radius,
            centre,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collinear_points_are_invalid() {
        let pr =
            CircularArcProperties::new(Vec2::new(0.0, 0.0), Vec2::new(100.0, 0.0), Vec2::new(200.0, 0.0));
        assert!(!pr.is_valid);
        assert_eq!(pr.theta_start, 0.0);
        assert_eq!(pr.theta_range, 0.0);
        assert_eq!(pr.direction, 0.0);
        assert_eq!(pr.radius, 0.0);
        assert_eq!(pr.centre, Vec2::ZERO);
    }

    #[test]
    fn coincident_points_are_invalid_and_do_not_panic() {
        // a == b == c drives every side length to exactly zero: `d` (the
        // circumcentre denominator) is also exactly zero, so this must be
        // caught by the degenerate check before any division happens
        let p = Vec2::new(5.0, 5.0);
        let pr = CircularArcProperties::new(p, p, p);
        assert!(!pr.is_valid);
    }

    #[test]
    fn nan_and_infinite_coordinates_do_not_panic() {
        let pr = CircularArcProperties::new(
            Vec2::new(f32::NAN, 0.0),
            Vec2::new(100.0, f32::INFINITY),
            Vec2::new(f32::NEG_INFINITY, 0.0),
        );
        // nan propagates through the almost-equals comparison as `false` (nan
        // comparisons are always false), so this proceeds into the valid path
        // and must not panic or divide unsafely regardless of the outcome
        let _ = pr.is_valid;
    }

    #[test]
    fn semicircle_matches_known_geometry() {
        // a simple, hand-verifiable case: (0,0) -> (100,100) -> (200,0) traces
        // the upper half of a circle of radius 100 centred at (100, 0)
        let pr = CircularArcProperties::new(
            Vec2::new(0.0, 0.0),
            Vec2::new(100.0, 100.0),
            Vec2::new(200.0, 0.0),
        );
        assert!(pr.is_valid);
        assert!((pr.radius - 100.0).abs() < 1e-3);
        assert!((pr.centre.x - 100.0).abs() < 1e-3);
        assert!(pr.centre.y.abs() < 1e-3);
        assert!((pr.theta_range - std::f64::consts::PI).abs() < 1e-9);
    }
}
