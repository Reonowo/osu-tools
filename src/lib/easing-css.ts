// the bridge between the engine's verbatim easing port and what a stylesheet
// can hold. two shapes of css easing matter here: `cubic-bezier(...)`, which
// is exact for the polynomial curves and cheap to read, and `linear(...)`,
// which is a piecewise-linear sampling and is the only way to spell a curve
// that overshoots and oscillates (the elastic ones).
//
// nothing in the app calls this at runtime -- it exists so `easing-css.test.ts`
// can regenerate every `--ease-*` token in index.css from `engine/easing.ts`
// and fail when a hand-tweaked curve drifts from the one it claims to be
// (docs/adr/0010: a token carries a lazer citation, and a citation nobody
// checks is a comment)

import type { EasingFn } from "@/engine/easing";

/** segments in a generated `linear()`, so the string carries this many stops
 * plus one. picked against the pin test's 0.01 tolerance on the sharpest
 * curve the stylesheet holds (OutElasticHalf): its first oscillation is where
 * a piecewise-linear chord deviates most, and 48 segments keep that chord
 * inside a hundredth while leaving the token readable in one line of the
 * stylesheet */
export const LINEAR_SEGMENTS = 48;

/** decimals a generated stop carries. four is below what a compositor
 * resolves on any real element and keeps the string stable across platforms:
 * the engine's formulas are doubles, and printing every digit would make the
 * token differ on a machine whose libm rounds the last bit elsewhere */
const STOP_DECIMALS = 4;

/** a stop as the generator prints it: fixed decimals with the trailing zeros
 * dropped, so 0 stays `0` and 1 stays `1` rather than `0.0000` */
function printStop(value: number): string {
	const fixed = value.toFixed(STOP_DECIMALS);
	const trimmed = fixed.replace(/\.?0+$/, "");
	// -0 prints as "-0" through toFixed; the curves that undershoot at t=0 are
	// none of the ones here, but a token that reads "-0" would still be wrong
	return trimmed === "-0" || trimmed === "" ? "0" : trimmed;
}

/** the css `linear()` easing for a curve, sampled at even inputs. even
 * spacing is why no stop needs a percentage: css distributes an unpositioned
 * stop list uniformly across the input range, which is exactly the sampling */
export function linearEasing(fn: EasingFn, segments: number = LINEAR_SEGMENTS): string {
	const stops: string[] = [];
	for (let i = 0; i <= segments; i++) stops.push(printStop(fn(i / segments)));
	return `linear(${stops.join(", ")})`;
}

/** the stops of a `linear()` string, or null for anything that is not one.
 * the inverse of the generator, which is what lets the pin test compare
 * curves rather than compare strings when a token is hand-written */
export function parseLinearEasing(value: string): number[] | null {
	const match = /^linear\(([^)]*)\)$/.exec(value.trim());
	if (match === null) return null;
	const parts = match[1].split(",").map((part) => part.trim());
	// a stop that is not a number makes the whole thing unreadable, never a
	// shorter curve: dropping it would let `linear(0, oops, 1)` parse as a
	// valid two-stop easing and quietly pass the pin test this module exists
	// for. the empty check is not redundant -- Number("") is 0, so a missing
	// stop would otherwise read as a real one. two stops is the shortest thing
	// that describes a curve at all
	if (parts.length < 2 || parts.some((part) => part === "")) return null;
	const stops = parts.map(Number);
	if (stops.some((n) => Number.isNaN(n))) return null;
	return stops;
}

/** a parsed `linear()` evaluated at an input, by the same uniform spacing the
 * generator wrote: the chord between the two stops the input falls between */
export function sampleLinear(stops: readonly number[], t: number): number {
	if (stops.length === 0) return 0;
	if (stops.length === 1) return stops[0];
	const clamped = Math.max(0, Math.min(1, t));
	const scaled = clamped * (stops.length - 1);
	const lower = Math.min(Math.floor(scaled), stops.length - 2);
	const fraction = scaled - lower;
	return stops[lower] + (stops[lower + 1] - stops[lower]) * fraction;
}

/** the four control values of a `cubic-bezier(...)`, or null */
export function parseCubicBezier(value: string): [number, number, number, number] | null {
	const match = /^cubic-bezier\(([^)]*)\)$/.exec(value.trim());
	if (match === null) return null;
	const parts = match[1].split(",").map((part) => Number(part.trim()));
	if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return null;
	return [parts[0], parts[1], parts[2], parts[3]];
}

// the cubic polynomial coefficients of one axis of a css timing bezier: p0 is
// pinned at 0 and p3 at 1, so only the two middle control values vary
const bezierA = (c1: number, c2: number) => 1 - 3 * c2 + 3 * c1;
const bezierB = (c1: number, c2: number) => 3 * c2 - 6 * c1;
const bezierC = (c1: number) => 3 * c1;
const bezierAt = (t: number, c1: number, c2: number) => ((bezierA(c1, c2) * t + bezierB(c1, c2)) * t + bezierC(c1)) * t;
const bezierSlopeAt = (t: number, c1: number, c2: number) =>
	3 * bezierA(c1, c2) * t * t + 2 * bezierB(c1, c2) * t + bezierC(c1);

// newton converges in a handful of steps wherever the x curve is not flat;
// the bisection below covers the flat starts (x1 = 0) newton stalls on
const NEWTON_ITERATIONS = 8;
const NEWTON_MIN_SLOPE = 1e-3;
const BISECTION_ITERATIONS = 32;

/** the parameter at which a css timing bezier's x reaches the given input.
 * css beziers are parameterised on their own t, not on x, so a value at an
 * input is two steps: invert x, then read y */
function parameterForX(x: number, x1: number, x2: number): number {
	let t = x;
	for (let i = 0; i < NEWTON_ITERATIONS; i++) {
		const slope = bezierSlopeAt(t, x1, x2);
		if (Math.abs(slope) < NEWTON_MIN_SLOPE) break;
		t -= (bezierAt(t, x1, x2) - x) / slope;
	}
	if (t >= 0 && t <= 1 && Math.abs(bezierAt(t, x1, x2) - x) < 1e-7) return t;
	let low = 0;
	let high = 1;
	let mid = x;
	for (let i = 0; i < BISECTION_ITERATIONS; i++) {
		mid = (low + high) / 2;
		if (bezierAt(mid, x1, x2) < x) low = mid;
		else high = mid;
	}
	return mid;
}

/** a css `cubic-bezier(x1, y1, x2, y2)` evaluated at an input in [0, 1] */
export function cubicBezierAt(control: readonly [number, number, number, number], t: number): number {
	const [x1, y1, x2, y2] = control;
	if (t <= 0) return 0;
	if (t >= 1) return 1;
	return bezierAt(parameterForX(t, x1, x2), y1, y2);
}

/** the largest gap between a css easing value and the curve it claims to be,
 * over an even grid of inputs. the one number the pin test thresholds on, so
 * a failure reads as "this token is off by x" rather than as a diff of two
 * long strings */
export function maxDeviation(fn: EasingFn, css: (t: number) => number, gridPoints: number): number {
	let worst = 0;
	for (let i = 0; i <= gridPoints; i++) {
		const t = i / gridPoints;
		worst = Math.max(worst, Math.abs(css(t) - fn(t)));
	}
	return worst;
}
