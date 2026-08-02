//! float-parity primitives mirroring .net semantics.
//! sources: osutk `Vector2` (nuget dep of osu-framework 2026.731.0),
//! osu.framework/utils/precision.cs, dotnet `System.Array.BinarySearch`.

use std::ops::{Add, Div, Mul, Neg, Sub};

/// osu.framework/utils/precision.cs:18
pub const FLOAT_EPSILON: f32 = 1e-3;
/// osu.framework/utils/precision.cs:23
pub const DOUBLE_EPSILON: f64 = 1e-7;

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Vec2 {
    pub x: f32,
    pub y: f32,
}

impl Vec2 {
    pub const ZERO: Vec2 = Vec2 { x: 0.0, y: 0.0 };

    pub fn new(x: f32, y: f32) -> Self {
        Vec2 { x, y }
    }

    pub fn length(self) -> f32 {
        (self.x * self.x + self.y * self.y).sqrt()
    }

    pub fn length_squared(self) -> f32 {
        self.x * self.x + self.y * self.y
    }

    /// osutk vector2.normalized: reciprocal multiply, not component division
    pub fn normalized(self) -> Vec2 {
        let scale = 1.0 / self.length();
        Vec2::new(self.x * scale, self.y * scale)
    }

    pub fn dot(a: Vec2, b: Vec2) -> f32 {
        a.x * b.x + a.y * b.y
    }

    pub fn distance(a: Vec2, b: Vec2) -> f32 {
        (b - a).length()
    }
}

impl Add for Vec2 {
    type Output = Vec2;
    fn add(self, rhs: Vec2) -> Vec2 {
        Vec2::new(self.x + rhs.x, self.y + rhs.y)
    }
}

impl Sub for Vec2 {
    type Output = Vec2;
    fn sub(self, rhs: Vec2) -> Vec2 {
        Vec2::new(self.x - rhs.x, self.y - rhs.y)
    }
}

impl Neg for Vec2 {
    type Output = Vec2;
    fn neg(self) -> Vec2 {
        Vec2::new(-self.x, -self.y)
    }
}

impl Mul<f32> for Vec2 {
    type Output = Vec2;
    fn mul(self, rhs: f32) -> Vec2 {
        Vec2::new(self.x * rhs, self.y * rhs)
    }
}

impl Mul<Vec2> for f32 {
    type Output = Vec2;
    fn mul(self, rhs: Vec2) -> Vec2 {
        rhs * self
    }
}

impl Div<f32> for Vec2 {
    type Output = Vec2;
    fn div(self, rhs: f32) -> Vec2 {
        Vec2::new(self.x / rhs, self.y / rhs)
    }
}

pub fn almost_equals_f32(a: f32, b: f32, acceptable: f32) -> bool {
    (a - b).abs() <= acceptable
}

pub fn almost_equals_f64(a: f64, b: f64, acceptable: f64) -> bool {
    (a - b).abs() <= acceptable
}

/// mirrors `System.Array.BinarySearch<double>`: returns a matching index
/// (whichever the midpoint walk lands on) or the bitwise complement of the
/// insertion point on a miss
pub fn dotnet_binary_search(values: &[f64], target: f64) -> isize {
    let mut lo: isize = 0;
    let mut hi: isize = values.len() as isize - 1;
    while lo <= hi {
        let mid = lo + ((hi - lo) >> 1);
        let v = values[mid as usize];
        if v == target {
            return mid;
        }
        if v < target {
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    !lo
}

/// mirrors an unchecked c# `(int)someDouble` cast under this port's pinned
/// toolchain: **.net 8, x86/x64 specifically**, not c# in general. on that
/// exact combination, a non-finite or out-of-i32-range double truncates to
/// `int.MinValue` (`0x80000000`, the x86/x64 `cvttsd2si` "integer indefinite"
/// sentinel) — not a saturating clamp toward the nearer bound and not zero.
///
/// this is architecture- and version-specific, and it is *not* a jit-tiering
/// effect (an earlier version of this comment incorrectly claimed it was;
/// the real behaviour is identical whether the surrounding method is cold,
/// warmed up past tier1, or run with tiered compilation disabled entirely).
/// the actual cause: arm64 already saturated on out-of-range float-to-int
/// conversions before this, and .net 9 changed x86/x64 to match — see
/// "floating point-to-integer conversions are saturating"
/// (<https://learn.microsoft.com/en-us/dotnet/core/compatibility/jit/9.0/fp-to-integer>),
/// a documented jit breaking change shipped in .net 9 preview 4. post-.net-9,
/// `nan -> 0`, `> i32::MAX -> i32::MAX`, `< i32::MIN -> i32::MIN` on every
/// architecture. pre-.net-9 x86/x64 is what `global.json` pins this repo to,
/// and what `fixtures/README.md` documents as a hard requirement for
/// regenerating `path/approximator_circular_arc.json`.
///
/// verified empirically against the actual `PathApproximator` call path
/// inside `fixture-gen` (temporarily instrumented, then reverted) rather than
/// trusted from general knowledge: a naive saturating port disagreed with the
/// pinned fixture's vertex count on `arc-huge-radius-zero-acos`, where
/// `theta_range / 0.0` explodes to `+infinity` and the pinned toolchain
/// truncates that to `int.MinValue` (which `Math.Max(2, ...)` then clamps
/// back up to 2), not `int.MaxValue`. an initial standalone `dotnet new
/// console` scratch probe gave the opposite (saturating) answer because it
/// silently escaped this repo's `global.json` sdk pin — a bare `dotnet new`
/// outside the repo picks up the newest installed sdk and that sdk's default
/// target framework (.net 9/10), not the pinned .net 8
pub fn dotnet_double_to_i32_unchecked(v: f64) -> i32 {
    if v.is_finite() && v >= i32::MIN as f64 && v < 2147483648.0 {
        v as i32
    } else {
        i32::MIN
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vec2_length_matches_dotnet_float_semantics() {
        let v = Vec2::new(3.0, 4.0);
        assert_eq!(v.length(), 5.0f32);
        assert_eq!(v.length_squared(), 25.0f32);
    }

    #[test]
    fn vec2_normalized_uses_reciprocal_multiply() {
        // osutk vector2.normalized computes scale = 1 / length then multiplies,
        // which differs in the last ulp from dividing; assert the multiply form
        let v = Vec2::new(3.0, 4.0);
        let scale = 1.0f32 / v.length();
        assert_eq!(v.normalized(), Vec2::new(3.0 * scale, 4.0 * scale));
    }

    #[test]
    fn vec2_operators() {
        let a = Vec2::new(1.0, 2.0);
        let b = Vec2::new(3.0, 5.0);
        assert_eq!(a + b, Vec2::new(4.0, 7.0));
        assert_eq!(b - a, Vec2::new(2.0, 3.0));
        assert_eq!(a * 2.0, Vec2::new(2.0, 4.0));
        assert_eq!(2.0 * a, Vec2::new(2.0, 4.0));
        assert_eq!(b / 2.0, Vec2::new(1.5, 2.5));
        assert_eq!(-a, Vec2::new(-1.0, -2.0));
        assert_eq!(Vec2::dot(a, b), 13.0);
        assert_eq!(Vec2::distance(a, b), (2.0f32 * 2.0 + 3.0 * 3.0).sqrt());
    }

    #[test]
    fn binary_search_mirrors_dotnet_semantics() {
        let values = [0.0, 1.0, 2.0, 4.0];
        assert_eq!(dotnet_binary_search(&values, 2.0), 2);
        // miss returns bitwise complement of the insertion point
        assert_eq!(dotnet_binary_search(&values, 3.0), !3);
        assert_eq!(dotnet_binary_search(&values, -1.0), !0);
        assert_eq!(dotnet_binary_search(&values, 5.0), !4);
        assert_eq!(dotnet_binary_search(&[], 1.0), !0);
        // duplicates: .net midpoint search returns the mid index it lands on
        let dupes = [0.0, 1.0, 1.0, 1.0, 2.0];
        assert_eq!(dotnet_binary_search(&dupes, 1.0), 2);
    }

    #[test]
    fn dotnet_double_to_i32_unchecked_matches_indefinite_integer_semantics() {
        // in-range values truncate normally, exactly like a checked cast would
        assert_eq!(dotnet_double_to_i32_unchecked(0.0), 0);
        assert_eq!(dotnet_double_to_i32_unchecked(41.9), 41);
        assert_eq!(dotnet_double_to_i32_unchecked(-41.9), -41);
        assert_eq!(dotnet_double_to_i32_unchecked(2147483647.0), 2147483647);
        assert_eq!(dotnet_double_to_i32_unchecked(-2147483648.0), i32::MIN);

        // non-finite and out-of-range values all collapse to the indefinite
        // sentinel, not a saturating clamp toward the nearer bound
        assert_eq!(dotnet_double_to_i32_unchecked(f64::NAN), i32::MIN);
        assert_eq!(dotnet_double_to_i32_unchecked(f64::INFINITY), i32::MIN);
        assert_eq!(dotnet_double_to_i32_unchecked(f64::NEG_INFINITY), i32::MIN);
        assert_eq!(dotnet_double_to_i32_unchecked(2147483648.0), i32::MIN);
        assert_eq!(dotnet_double_to_i32_unchecked(-2147483649.0), i32::MIN);
        assert_eq!(dotnet_double_to_i32_unchecked(1e30), i32::MIN);
    }

    #[test]
    fn precision_constants_match_framework() {
        // osu.framework/utils/precision.cs:18,23
        assert_eq!(FLOAT_EPSILON, 1e-3f32);
        assert_eq!(DOUBLE_EPSILON, 1e-7f64);
        assert!(almost_equals_f32(0.0, 0.0009, FLOAT_EPSILON));
        assert!(!almost_equals_f32(0.0, 0.0011, FLOAT_EPSILON));
        assert!(almost_equals_f64(1.0, 1.0 + 5e-8, DOUBLE_EPSILON));
    }
}
