//! port of osu.game/rulesets/objects/sliderpath.cs (pin 83b8a64), including
//! the osu!stable expected-distance quirks. paths are immutable here; the
//! future editor rebuilds on mutation

use crate::error::Result;
use crate::formats::beatmap::{PathControlPoint, PathType};
use crate::limits;
use crate::math::{
    almost_equals_f64, dotnet_binary_search, dotnet_double_to_i32_unchecked, Vec2, DOUBLE_EPSILON,
};
use crate::path::approximator;
use crate::path::arc::CircularArcProperties;

#[derive(Debug, Clone)]
pub struct SliderPath {
    control_points: Vec<PathControlPoint>,
    expected_distance: Option<f64>,
    optimise_catmull: bool,
    calculated_path: Vec<Vec2>,
    cumulative_length: Vec<f64>,
    calculated_length: f64,
    optimised_length: f64,
    segment_end_distances: Vec<f64>,
}

impl SliderPath {
    /// osu! sliders always pass `optimise_catmull: true` (slider.cs:45).
    ///
    /// the only error a beatmap-derived path can produce is
    /// [`crate::EngineError::ResourceLimit`]; a hand-built
    /// [`PathType::BSpline`] whose degree violates the type's documented
    /// `degree > 0` invariant surfaces as `InvalidArgument` instead of
    /// silently reinterpreting a negative degree
    pub fn new(
        control_points: Vec<PathControlPoint>,
        expected_distance: Option<f64>,
        optimise_catmull: bool,
    ) -> Result<SliderPath> {
        let mut path = SliderPath {
            control_points,
            expected_distance,
            optimise_catmull,
            calculated_path: Vec::new(),
            cumulative_length: Vec::new(),
            calculated_length: 0.0,
            optimised_length: 0.0,
            segment_end_distances: Vec::new(),
        };
        // the c# keeps `segmentEnds` as a field purely because `calculatePath`
        // and `calculateLength` are separate methods sharing it; handing the
        // indices over directly makes it impossible for them to go stale
        let segment_end_indices = path.calculate_path()?;
        path.calculate_length(&segment_end_indices);
        Ok(path)
    }

    pub fn control_points(&self) -> &[PathControlPoint] {
        &self.control_points
    }

    pub fn expected_distance(&self) -> Option<f64> {
        self.expected_distance
    }

    /// sliderpath.cs:119 — distance after expected-distance adjustment
    pub fn distance(&self) -> f64 {
        self.cumulative_length.last().copied().unwrap_or(0.0)
    }

    /// sliderpath.cs:131 — distance before expected-distance adjustment
    pub fn calculated_distance(&self) -> f64 {
        self.calculated_length
    }

    pub fn calculated_path(&self) -> &[Vec2] {
        &self.calculated_path
    }

    pub fn cumulative_length(&self) -> &[f64] {
        &self.cumulative_length
    }

    /// sliderpath.cs:263 — non-finite values possible when distance is zero,
    /// faithful to the source
    pub fn segment_ends_progress(&self) -> Vec<f64> {
        let distance = self.distance();
        self.segment_end_distances.iter().map(|d| d / distance).collect()
    }

    /// sliderpath.cs:205
    pub fn position_at(&self, progress: f64) -> Vec2 {
        let d = self.progress_to_distance(progress);
        self.interpolate_vertices(self.index_of_distance(d), d)
    }

    /// sliderpath.cs:177
    pub fn path_to_progress(&self, p0: f64, p1: f64) -> Vec<Vec2> {
        let d0 = self.progress_to_distance(p0);
        let d1 = self.progress_to_distance(p1);

        let mut path = Vec::new();
        let mut i = 0usize;
        while i < self.calculated_path.len() && self.cumulative_length[i] < d0 {
            i += 1;
        }
        path.push(self.interpolate_vertices(i, d0));
        while i < self.calculated_path.len() && self.cumulative_length[i] <= d1 {
            path.push(self.calculated_path[i]);
            i += 1;
        }
        path.push(self.interpolate_vertices(i, d1));
        path
    }

    /// sliderpath.cs:287 — returns the segment-end vertex indices
    fn calculate_path(&mut self) -> Result<Vec<usize>> {
        self.calculated_path.clear();
        self.optimised_length = 0.0;
        let mut segment_end_indices: Vec<usize> = Vec::new();

        let n = self.control_points.len();
        if n == 0 {
            return Ok(segment_end_indices);
        }

        let vertices: Vec<Vec2> = self.control_points.iter().map(|cp| cp.pos).collect();
        let optimise_catmull = self.optimise_catmull;
        let mut start = 0usize;

        for i in 0..n {
            // sliderpath.cs:304 — only a non-null type ends the previous
            // segment; the final control point always ends one
            if self.control_points[i].path_type.is_none() && i < n - 1 {
                continue;
            }

            let segment = &vertices[start..=i];
            // sliderpath.cs:309 — the segment's type comes from its FIRST
            // point, defaulting to linear
            let segment_type = self.control_points[start].path_type.unwrap_or(PathType::Linear);

            if segment.len() == 1 {
                self.calculated_path.push(segment[0]);
            } else if segment.len() > 1 {
                let sub_path = calculate_sub_path(
                    segment,
                    segment_type,
                    optimise_catmull,
                    &mut self.optimised_length,
                )?;

                // sliderpath.cs:319 — drop a leading vertex that exactly
                // repeats the running path's last one (exact f32 equality,
                // component-wise, so nan never dedups)
                let skip_first = self
                    .calculated_path
                    .last()
                    .zip(sub_path.first())
                    .is_some_and(|(last, first)| last == first);
                self.calculated_path
                    .extend_from_slice(&sub_path[usize::from(skip_first)..]);
                if self.calculated_path.len() > limits::MAX_SLIDER_PATH_VERTICES {
                    return Err(crate::error::resource_limit(
                        "MAX_SLIDER_PATH_VERTICES",
                        limits::MAX_SLIDER_PATH_VERTICES as u64,
                        self.calculated_path.len() as u64,
                    ));
                }
            }

            if i > 0 {
                // sliderpath.cs:328. the path is provably non-empty here: the
                // first loop body to run either pushes a lone head vertex
                // (i == 0) or produces a sub-path from at least two control
                // points, and every approximator emits at least one vertex for
                // such an input. saturating rather than wrapping regardless,
                // since an underflow here would be an index panic
                segment_end_indices.push(self.calculated_path.len().saturating_sub(1));
            }

            // start the new segment at the current vertex
            start = i;
        }

        Ok(segment_end_indices)
    }

    /// sliderpath.cs:426
    fn calculate_length(&mut self, segment_end_indices: &[usize]) {
        // the catmull bulb-culling hack: length removed by the optimisation is
        // seeded back in so expected-distance never re-extends the path to
        // compensate for it (sliderpath.cs:383)
        self.calculated_length = self.optimised_length;
        self.cumulative_length.clear();
        self.cumulative_length.push(0.0);

        for i in 0..self.calculated_path.len().saturating_sub(1) {
            let diff = self.calculated_path[i + 1] - self.calculated_path[i];
            // edge lengths are f32, widened once into the f64 accumulator
            self.calculated_length += f64::from(diff.length());
            self.cumulative_length.push(self.calculated_length);
        }

        // sliderpath.cs:439 — snapshot before shortening invalidates the indices
        self.segment_end_distances = segment_end_indices
            .iter()
            .map(|&i| self.cumulative_length.get(i).copied().unwrap_or(0.0))
            .collect();

        let Some(expected) = self.expected_distance else {
            return;
        };
        if self.calculated_length == expected {
            return;
        }

        // sliderpath.cs:450 — osu!stable performs no extension when the last
        // two path points are equal, and leaves an extra cumulative entry behind
        let np = self.calculated_path.len();
        if np >= 2
            && self.calculated_path[np - 1] == self.calculated_path[np - 2]
            && expected > self.calculated_length
        {
            self.cumulative_length.push(self.calculated_length);
            return;
        }

        // sliderpath.cs:457 — the last length is always incorrect, popped
        // unconditionally and before the shorten branch below
        self.cumulative_length.pop();
        let mut path_end_index = self.calculated_path.len() as isize - 1;

        if self.calculated_length > expected {
            // sliderpath.cs:464 — trim vertices made unnecessary by shortening.
            // the pop and the removal stay in lockstep, which keeps
            // `path_end_index` equal to the remaining cumulative count and so
            // never lets the removal index go negative
            while self
                .cumulative_length
                .last()
                .is_some_and(|&last| last >= expected)
            {
                self.cumulative_length.pop();
                self.calculated_path.remove(path_end_index as usize);
                path_end_index -= 1;
            }
        }

        if path_end_index <= 0 {
            // sliderpath.cs:471 — the expected distance is negative or zero
            self.cumulative_length.push(0.0);
            return;
        }

        // sliderpath.cs:480 — re-aim the final vertex along the last surviving
        // edge. `path_end_index > 0` implies the cumulative list is non-empty
        // (see the lockstep note above), so the fallback below never applies
        let pei = path_end_index as usize;
        let dir = (self.calculated_path[pei] - self.calculated_path[pei - 1]).normalized();
        let last_cum = self.cumulative_length.last().copied().unwrap_or(0.0);
        self.calculated_path[pei] = self.calculated_path[pei - 1] + dir * ((expected - last_cum) as f32);
        self.cumulative_length.push(expected);
    }

    /// sliderpath.cs:487
    fn index_of_distance(&self, d: f64) -> usize {
        let i = dotnet_binary_search(&self.cumulative_length, d);
        (if i < 0 { !i } else { i }) as usize
    }

    /// sliderpath.cs:495
    fn progress_to_distance(&self, progress: f64) -> f64 {
        progress.clamp(0.0, 1.0) * self.distance()
    }

    /// sliderpath.cs:500
    fn interpolate_vertices(&self, i: usize, d: f64) -> Vec2 {
        if self.calculated_path.is_empty() {
            return Vec2::ZERO;
        }
        // the c# guard is `i <= 0`; `i` can never be negative here, since
        // `index_of_distance` complements a miss into a non-negative insertion
        // point and `path_to_progress` only ever counts upwards from zero
        if i == 0 {
            return self.calculated_path[0];
        }
        if i >= self.calculated_path.len() {
            return *self.calculated_path.last().unwrap();
        }

        let p0 = self.calculated_path[i - 1];
        let p1 = self.calculated_path[i];
        let d0 = self.cumulative_length[i - 1];
        let d1 = self.cumulative_length[i];

        // sliderpath.cs:517 — avoid division by an almost-zero number for
        // near-coincident points
        if almost_equals_f64(d0, d1, DOUBLE_EPSILON) {
            return p0;
        }
        let w = (d - d0) / (d1 - d0);
        p0 + (p1 - p0) * (w as f32)
    }
}

/// sliderpath.cs:336. `optimised_length` is accumulated in place rather than
/// returned per segment so that multi-segment catmull paths sum their culled
/// lengths in the same order (and therefore with the same f64 rounding) as the
/// c# field it mirrors
fn calculate_sub_path(
    segment: &[Vec2],
    segment_type: PathType,
    optimise_catmull: bool,
    optimised_length: &mut f64,
) -> Result<Vec<Vec2>> {
    let budget = limits::MAX_SLIDER_PATH_VERTICES;
    match segment_type {
        PathType::Linear => approximator::linear_to_piecewise_linear(segment, budget),

        PathType::PerfectCurve if segment.len() == 3 => {
            let props = CircularArcProperties::new(segment[0], segment[1], segment[2]);
            if props.is_valid {
                // sliderpath.cs:355 — a verbatim duplicate of
                // pathapproximator.cs:186's point-count expression, used here
                // only as a dispatch guard. the `(int)Math.Ceiling(...)` narrowing
                // must go through `dotnet_double_to_i32_unchecked`, not rust's
                // saturating `as i32`: for a circumradius above ~3.4e6 the f32
                // `1 - tolerance / radius` rounds to exactly 1.0f, `acos(1.0)` is
                // 0, and the division explodes to +infinity. the pinned .net 8
                // x86/x64 runtime truncates that to int.MinValue, `Math.Max(2, ..)`
                // restores 2, and `subPoints >= 1000` is FALSE — so lazer takes the
                // circular-arc branch. saturating instead would take the b-spline
                // branch and silently change the shape of real, mapper-producible
                // sliders (e.g. the playfield-range triple (175,121) (44,32)
                // (465,318))
                let sub_points: i32 = if 2.0f32 * props.radius <= approximator::CIRCULAR_ARC_TOLERANCE {
                    2
                } else {
                    let half_angle =
                        f64::from(1.0f32 - approximator::CIRCULAR_ARC_TOLERANCE / props.radius).acos();
                    2i32.max(dotnet_double_to_i32_unchecked(
                        (props.theta_range / (2.0 * half_angle)).ceil(),
                    ))
                };

                // sliderpath.cs:359 — 1000 subpoints needs an arc length of
                // at least ~120 thousand osu!px to occur
                if sub_points < 1000 {
                    let sub_path = approximator::circular_arc_to_piecewise_linear(segment, budget)?;
                    // sliderpath.cs:365 — if an arc could not be fit after all,
                    // fall back to the numerically stable b-spline below
                    if !sub_path.is_empty() {
                        return Ok(sub_path);
                    }
                }
            }
            b_spline_fallback(segment, segment.len(), budget)
        }

        PathType::Catmull => {
            let sub_path = approximator::catmull_to_piecewise_linear(segment, budget)?;
            if !optimise_catmull {
                return Ok(sub_path);
            }

            // sliderpath.cs:378 — osu!stable culls piecewise segments closer
            // than 6px at draw time. that only matters here for the bulbs
            // catmull forms around sequential knots with identical positions,
            // so a very basic form of it is applied and the culled length is
            // reported back so expected-distance does not re-extend the path
            const CATMULL_SEGMENT_LENGTH: usize = approximator::CATMULL_DETAIL * 2;
            let mut optimised = Vec::with_capacity(sub_path.len());
            let mut last_start: Option<Vec2> = None;
            let mut length_removed_since_start = 0.0f64;

            for i in 0..sub_path.len() {
                let Some(start) = last_start else {
                    optimised.push(sub_path[i]);
                    last_start = Some(sub_path[i]);
                    continue;
                };

                let dist_from_start = f64::from(Vec2::distance(start, sub_path[i]));
                length_removed_since_start += f64::from(Vec2::distance(sub_path[i - 1], sub_path[i]));

                // sliderpath.cs:409 — either 6px from the start, the last
                // vertex at every knot, or the end of the path
                if dist_from_start > 6.0 || (i + 1) % CATMULL_SEGMENT_LENGTH == 0 || i == sub_path.len() - 1 {
                    optimised.push(sub_path[i]);
                    *optimised_length += length_removed_since_start - dist_from_start;
                    last_start = None;
                    length_removed_since_start = 0.0;
                }
            }
            Ok(optimised)
        }

        // sliderpath.cs:423 — everything that breaks out of the switch (a
        // perfect curve that is not exactly 3 points, or whose arc was
        // rejected) plus b-spline itself lands here with `Degree ?? point count`
        PathType::PerfectCurve | PathType::Bezier => b_spline_fallback(segment, segment.len(), budget),
        PathType::BSpline(degree) => {
            // `PathType::BSpline`'s invariant is `degree > 0`; mapping anything
            // else to 0 lets the approximator reject it as `InvalidArgument`
            // rather than reinterpreting a negative degree as a huge unsigned one
            b_spline_fallback(segment, usize::try_from(degree).unwrap_or(0), budget)
        }
    }
}

fn b_spline_fallback(segment: &[Vec2], degree: usize, budget: usize) -> Result<Vec<Vec2>> {
    approximator::b_spline_to_piecewise_linear(segment, degree, budget)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cps(points: &[(f32, f32, Option<PathType>)]) -> Vec<PathControlPoint> {
        points
            .iter()
            .map(|&(x, y, path_type)| PathControlPoint {
                pos: Vec2::new(x, y),
                path_type,
            })
            .collect()
    }

    #[test]
    fn segment_type_comes_from_the_first_point_of_the_segment() {
        // sliderpath.cs:309: the trailing points' own types never select the
        // curve family — the second segment here is linear because its FIRST
        // point says linear, even though its last point is tagged catmull
        let path = SliderPath::new(
            cps(&[
                (0.0, 0.0, Some(PathType::Linear)),
                (100.0, 0.0, Some(PathType::Linear)),
                (100.0, 100.0, Some(PathType::Catmull)),
            ]),
            None,
            true,
        )
        .unwrap();
        assert_eq!(
            path.calculated_path(),
            &[
                Vec2::new(0.0, 0.0),
                Vec2::new(100.0, 0.0),
                Vec2::new(100.0, 100.0),
            ]
        );
    }

    #[test]
    fn untyped_first_point_defaults_to_linear() {
        let path = SliderPath::new(cps(&[(0.0, 0.0, None), (10.0, 0.0, None)]), None, true).unwrap();
        assert_eq!(path.calculated_path().len(), 2);
        assert_eq!(path.distance(), 10.0);
    }

    #[test]
    fn catmull_culling_seeds_calculated_length() {
        // the culled length is added back, so both variants report the same
        // calculated distance even though the vertex counts differ wildly
        let points = [
            (50.0, 50.0, Some(PathType::Catmull)),
            (50.0, 50.0, None),
            (150.0, 50.0, None),
            (150.0, 50.0, None),
        ];
        let culled = SliderPath::new(cps(&points), None, true).unwrap();
        let plain = SliderPath::new(cps(&points), None, false).unwrap();

        assert!(culled.calculated_path().len() < plain.calculated_path().len());
        assert!(culled.optimised_length > 0.0);
        assert!(
            (culled.calculated_distance() - plain.calculated_distance()).abs() < 1e-3,
            "{} vs {}",
            culled.calculated_distance(),
            plain.calculated_distance()
        );
    }

    #[test]
    fn expected_distance_extension_is_skipped_for_an_identical_tail() {
        // sliderpath.cs:450 — and the skip leaves one extra cumulative entry
        let path = SliderPath::new(
            cps(&[
                (0.0, 0.0, Some(PathType::Linear)),
                (100.0, 0.0, None),
                (100.0, 0.0, None),
            ]),
            Some(200.0),
            true,
        )
        .unwrap();
        assert_eq!(path.distance(), path.calculated_distance());
        assert_eq!(path.cumulative_length().len(), path.calculated_path().len() + 1);
    }

    #[test]
    fn shortening_removes_vertices_in_step_with_lengths() {
        let path = SliderPath::new(
            cps(&[
                (0.0, 0.0, Some(PathType::Linear)),
                (50.0, 0.0, None),
                (100.0, 0.0, None),
                (150.0, 0.0, None),
                (200.0, 0.0, None),
            ]),
            Some(60.0),
            true,
        )
        .unwrap();
        assert_eq!(path.calculated_path().len(), 3);
        assert_eq!(path.cumulative_length(), &[0.0, 50.0, 60.0]);
        assert_eq!(path.distance(), 60.0);
        assert_eq!(path.calculated_distance(), 200.0);
    }

    #[test]
    fn zero_expected_distance_collapses_the_path() {
        // sliderpath.cs:471's `pathEndIndex <= 0` branch
        let path = SliderPath::new(
            cps(&[(0.0, 0.0, Some(PathType::Linear)), (100.0, 0.0, None)]),
            Some(0.0),
            true,
        )
        .unwrap();
        assert_eq!(path.calculated_path().len(), 1);
        assert_eq!(path.distance(), 0.0);
        // the faithful, unguarded division in segment_ends_progress
        assert!(path.segment_ends_progress()[0].is_infinite());
    }

    #[test]
    fn empty_control_points_produce_an_empty_path() {
        let path = SliderPath::new(Vec::new(), Some(100.0), true).unwrap();
        assert!(path.calculated_path().is_empty());
        assert_eq!(path.distance(), 0.0);
        assert_eq!(path.position_at(0.75), Vec2::ZERO);
    }

    #[test]
    fn progress_is_clamped_before_being_scaled() {
        // sliderpath.cs:497 `Math.Clamp(progress, 0, 1)`
        let path = SliderPath::new(
            cps(&[(0.0, 0.0, Some(PathType::Linear)), (100.0, 0.0, None)]),
            None,
            true,
        )
        .unwrap();
        assert_eq!(path.position_at(-5.0), Vec2::new(0.0, 0.0));
        assert_eq!(path.position_at(5.0), Vec2::new(100.0, 0.0));
        assert_eq!(path.position_at(f64::NAN), Vec2::new(0.0, 0.0));
    }
}
