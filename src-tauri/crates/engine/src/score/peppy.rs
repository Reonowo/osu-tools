//! the peppy-stars difficulty multiplier, ported from
//! `legacyrulesetextensions.cs:61-94` (`CalculateDifficultyPeppyStars`).
//! stable computed this on x87 registers; lazer emulates that with
//! `System.Decimal`, so the port runs on `rust_decimal` (the same 96-bit
//! base-10 layout) including an explicit port of .net's double->decimal
//! conversion, whose 15-significant-digit rounding is what the "decimal
//! emulation" actually hinges on. pinned by `fixtures/score/peppy_stars.json`.

use rust_decimal::prelude::ToPrimitive;
use rust_decimal::Decimal;

use crate::error::{EngineError, Result};
use crate::score::ScoreContext;

/// `1e0..=1e28` as f64 literals, mirroring .net's `s_doublePowers10` over
/// the index range this port can reach (both languages parse the literals
/// to the nearest double, so the tables agree bit-for-bit)
const POWERS_10: [f64; 29] = [
    1e0, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12, 1e13, 1e14, 1e15, 1e16, 1e17,
    1e18, 1e19, 1e20, 1e21, 1e22, 1e23, 1e24, 1e25, 1e26, 1e27, 1e28,
];

/// port of .net's `DecCalc.VarDecFromR8` (the `decimal(double)` conversion):
/// round the double to 15 significant digits, then store mantissa/scale with
/// trailing zeros factored out. the float difficulty values must widen
/// through double before entering here, exactly like the c# `(decimal)(double)`
/// double-cast chain
fn dotnet_double_to_decimal(input: f64) -> Result<Decimal> {
    let overflow = || EngineError::InvalidArgument("value out of range for a .net decimal".into());

    if !input.is_finite() {
        return Err(overflow());
    }

    // exponent such that |input| = m * 2^exp with m in [0.5, 1)
    const DBL_BIAS: i32 = 1022;
    let exp = (((input.to_bits() >> 52) & 0x7FF) as i32) - DBL_BIAS;
    // anything below 2^-94 can't reach half of decimal's smallest ulp
    if input == 0.0 || exp < -94 {
        return Ok(Decimal::ZERO);
    }
    if exp > 96 {
        return Err(overflow());
    }

    let negative = input < 0.0;
    let mut dbl = input.abs();

    // 14 - exp * log10(2), via the same scaled-integer multiply .net uses
    // (log10(2) * 2^16 = 19728.3)
    let mut power: i32 = 14 - ((exp * 19728) >> 16);

    if power >= 0 {
        // fewer than 15 digits before the decimal point: scale up
        if power > 28 {
            power = 28;
        }
        dbl *= POWERS_10[power as usize];
    } else if power != -1 || dbl >= 1e15 {
        dbl /= POWERS_10[(power + 15) as usize];
    } else {
        power = 0;
    }

    if dbl < 1e14 && power < 28 {
        dbl *= 10.0;
        power += 1;
    }

    // (ulong)(long)Math.Round: banker's rounding to a 15-digit integer
    let mut mantissa = dbl.round_ties_even() as u64;
    if mantissa == 0 {
        return Ok(Decimal::ZERO);
    }

    let value = if power < 0 {
        // add -power factors of 10; -power <= 14, so this stays inside i128
        let factors = power.unsigned_abs();
        power = 0;
        i128::from(mantissa) * 10i128.pow(factors)
    } else {
        // factor out trailing zeros to reduce the scale (the staged 8/4/2/1
        // divisions in VarDecFromR8 remove exactly this many)
        let removable = power.min(14);
        for _ in 0..removable {
            if mantissa % 10 == 0 {
                mantissa /= 10;
                power -= 1;
            } else {
                break;
            }
        }
        i128::from(mantissa)
    };

    let signed = if negative { -value } else { value };
    Decimal::try_from_i128_with_scale(signed, power as u32).map_err(|_| overflow())
}

/// `CalculateDifficultyPeppyStars` itself: all-decimal arithmetic ending in
/// banker's rounding. errors only on difficulty values no `.osu` decode can
/// produce (non-finite or beyond decimal range), keeping the entry point
/// panic-free for hand-built contexts
pub fn peppy_stars(ctx: &ScoreContext) -> Result<i32> {
    let object_to_drain_ratio = if ctx.drain_length_seconds != 0 {
        (Decimal::from(ctx.object_count) / Decimal::from(ctx.drain_length_seconds) * Decimal::from(8))
            .clamp(Decimal::ZERO, Decimal::from(16))
    } else {
        Decimal::from(16)
    };

    let drain_rate = dotnet_double_to_decimal(f64::from(ctx.hp_drain_rate))?;
    let overall_difficulty = dotnet_double_to_decimal(f64::from(ctx.overall_difficulty))?;
    let circle_size = dotnet_double_to_decimal(f64::from(ctx.circle_size))?;

    let stars = ((drain_rate + overall_difficulty + circle_size + object_to_drain_ratio)
        / Decimal::from(38)
        * Decimal::from(5))
    .round();
    stars
        .to_i32()
        .ok_or_else(|| EngineError::InvalidArgument("peppy stars out of i32 range".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decimal(s: &str) -> Decimal {
        s.parse().unwrap()
    }

    #[test]
    fn double_conversion_rounds_to_15_significant_digits() {
        // 5.3f widens to the double 5.300000190734863...; .net keeps 15 digits
        assert_eq!(
            dotnet_double_to_decimal(f64::from(5.3f32)).unwrap(),
            decimal("5.30000019073486")
        );
        // a clean double stays clean, trailing zeros factored out
        assert_eq!(dotnet_double_to_decimal(5.0).unwrap(), decimal("5"));
        assert_eq!(dotnet_double_to_decimal(0.25).unwrap(), decimal("0.25"));
        assert_eq!(dotnet_double_to_decimal(0.0).unwrap(), Decimal::ZERO);
        assert_eq!(dotnet_double_to_decimal(-2.5).unwrap(), decimal("-2.5"));
        // 0.1f's double is 0.10000000149011612
        assert_eq!(
            dotnet_double_to_decimal(f64::from(0.1f32)).unwrap(),
            decimal("0.100000001490116")
        );
    }

    #[test]
    fn double_conversion_handles_extremes_without_panicking() {
        assert!(dotnet_double_to_decimal(f64::NAN).is_err());
        assert!(dotnet_double_to_decimal(f64::INFINITY).is_err());
        assert!(dotnet_double_to_decimal(1e30).is_err());
        // below 2^-94: collapses to zero exactly like .net
        assert_eq!(dotnet_double_to_decimal(1e-30).unwrap(), Decimal::ZERO);
        assert_eq!(dotnet_double_to_decimal(f64::MIN_POSITIVE).unwrap(), Decimal::ZERO);
    }

    #[test]
    fn peppy_stars_rejects_pathological_contexts() {
        let ctx = ScoreContext {
            hp_drain_rate: f32::NAN,
            overall_difficulty: 5.0,
            circle_size: 5.0,
            object_count: 100,
            drain_length_seconds: 60,
        };
        assert!(peppy_stars(&ctx).is_err());
    }
}
