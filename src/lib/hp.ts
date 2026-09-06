// the HP curve's whole reading surface, pure and canvas-free: what HP the
// play held at a moment, what the HP bar's damped fill shows there, the
// lowest point and the fail point, and the overview strip's per-column
// resampling. the bar, the strip and the analysis panel are thin shells
// over these -- nothing re-derives HP for itself, so no two surfaces can
// disagree about the same play
//
// every reading is of the ENGINE's curve (scene-types' HpCurve): HP as a
// fraction of 200, never the .osr header's life bar ratio, whose divisor is
// each object's own perfect-play HP

import type { HpCurve } from "./scene-types";

/** HP before the curve's first breakpoint, and what an absent curve reads
 * everywhere: a play starts full */
const FULL = 1;

/** the last breakpoint at or before `time`, or -1 when the curve is empty or
 * starts after it. the LAST such point is what makes a same-millisecond pair
 * read as the post-judgement value */
function indexAt(curve: HpCurve, time: number): number {
	if (curve.length === 0 || !(time >= curve[0][0])) return -1;
	let lo = 0;
	let hi = curve.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (curve[mid][0] <= time) lo = mid;
		else hi = mid - 1;
	}
	return lo;
}

/** the HP the curve holds at `time`, as a fraction of full.
 *
 * full before the first breakpoint, the last value after the last, linear
 * between two, and at a millisecond a judgement landed on, the value AFTER
 * that judgement — which is the HP that judgement's life bar sample was
 * recorded from (engine `HealthCurve::fraction_at`, the same rules) */
export function hpAt(curve: HpCurve, time: number): number {
	const index = indexAt(curve, time);
	if (index < 0) return FULL;
	const [atTime, atValue] = curve[index];
	const next = curve[index + 1];
	if (next === undefined) return atValue;
	const [nextTime, nextValue] = next;
	// nextTime > time >= atTime by construction; a degenerate span reads as
	// the later value rather than dividing by zero
	if (!(nextTime > atTime)) return nextValue;
	return atValue + ((nextValue - atValue) * (time - atTime)) / (nextTime - atTime);
}

/** the HP bar's easing constant. both games ease their own display — stable
 * at about 0.02 per ms, Argon at a 50 ms half-life — and this is the app's
 * own choice under `docs/adr/0008`, not a port of either */
export const HP_DAMP_TAU_MS = 50;

/** how many time constants back the damp integrates. past six the weight is
 * under 0.25% and everything older is charged at the value the window opened
 * on, which is what makes a step reach its target EXACTLY once the window
 * has passed rather than approaching it forever */
const HP_DAMP_WINDOWS = 6;

/** the half-open breakpoint range `[from, to)` the damp integrates over: the
 * breakpoints strictly inside the window ending at `time`.
 *
 * exported because it is the whole cost argument — the smoothing walks this
 * range and never the curve, so a frame costs the same on a ten-minute
 * marathon as on a one-minute map */
export function dampWindow(curve: HpCurve, time: number, tau = HP_DAMP_TAU_MS): { from: number; to: number } {
	const window = Math.max(0, tau) * HP_DAMP_WINDOWS;
	return { from: indexAt(curve, time - window) + 1, to: indexAt(curve, time) + 1 };
}

/** the exponentially weighted mean of a linear piece, in closed form.
 *
 * `a`..`b` is a stretch of the curve ending at or before `now`, over which HP
 * runs linearly from `fa` to `fb`; the answer is that piece's contribution to
 * `∫ f(u) · (1/τ)e^{−(now−u)/τ} du`. closed-form rather than sampled, which
 * is what makes the smoothed value a pure function of time: playing into a
 * moment and seeking straight to it give the same number */
function weightedPiece(now: number, tau: number, a: number, fa: number, b: number, fb: number): number {
	const near = now - b;
	const far = now - a;
	if (!(far > near)) return 0;
	const slope = (fa - fb) / (far - near);
	return Math.exp(-near / tau) * (fb + slope * tau) - Math.exp(-far / tau) * (fa + slope * tau);
}

/** the damped HP the bar draws at `time`: the exponentially weighted integral
 * of the curve over the preceding window, computed closed-form per piece.
 *
 * a pure function of time and nothing else — no per-frame state, no
 * dependence on how the playhead reached the moment — so scrubbing, seeking
 * and playing all show the same fill at the same millisecond */
export function smoothedHpAt(curve: HpCurve, time: number, tau = HP_DAMP_TAU_MS): number {
	if (curve.length === 0) return FULL;
	if (!(tau > 0)) return hpAt(curve, time);
	const window = tau * HP_DAMP_WINDOWS;
	const start = time - window;
	const { from, to } = dampWindow(curve, time, tau);

	// everything older than the window is charged at the value the window
	// opened on, carrying the residual weight the truncation dropped
	let value = hpAt(curve, start);
	let total = value * Math.exp(-HP_DAMP_WINDOWS);
	let cursor = start;
	for (let index = from; index < to; index++) {
		const [pieceTime, pieceValue] = curve[index];
		total += weightedPiece(time, tau, cursor, value, pieceTime, pieceValue);
		cursor = pieceTime;
		value = pieceValue;
	}
	return total + weightedPiece(time, tau, cursor, value, time, hpAt(curve, time));
}

/** the lowest HP the play reached and when, and the fail point */
export interface HpExtremes {
	/** null for an empty curve */
	lowest: { time: number; fraction: number } | null;
	/** the first millisecond the curve reached zero, or null. a play that
	 * recovers past zero keeps its FIRST zero: that is where stable would
	 * have ended the play */
	failPoint: number | null;
}

/** the two readings the strip's fail mark and the panel's hp section need,
 * taken in one walk. both live at breakpoints — the curve is piecewise
 * linear, so its minimum is attained at one — which is why neither needs a
 * sampling rate of its own */
export function hpExtremes(curve: HpCurve): HpExtremes {
	let lowest: HpExtremes["lowest"] = null;
	let failPoint: number | null = null;
	for (const [time, fraction] of curve) {
		if (lowest === null || fraction < lowest.fraction) lowest = { time, fraction };
		if (failPoint === null && fraction <= 0) failPoint = time;
	}
	return { lowest, failPoint };
}

/** one value per pixel column of the overview strip: the LOWEST HP the curve
 * reached anywhere inside that column's time range, so a dip narrower than a
 * column still shows rather than being sampled straight past.
 *
 * `null` for a column the curve does not cover — the lead-in before the first
 * breakpoint and any audio tail past the last are the strip's own layers to
 * draw, not the fill's */
export function resampleHpColumns(
	curve: HpCurve,
	bounds: { minTime: number; maxTime: number },
	columns: number
): (number | null)[] {
	const width = Math.max(0, Math.floor(columns));
	const out: (number | null)[] = Array.from({ length: width }, () => null);
	const span = bounds.maxTime - bounds.minTime;
	if (curve.length === 0 || width === 0 || !(span > 0)) return out;

	const first = curve[0][0];
	const last = curve[curve.length - 1][0];
	// the breakpoint cursor only moves forward: columns ascend, so each one
	// resumes where the last left off and the whole resample is one pass over
	// the columns and one over the curve
	let cursor = 0;
	for (let column = 0; column < width; column++) {
		const from = bounds.minTime + (span * column) / width;
		const to = bounds.minTime + (span * (column + 1)) / width;
		// a column that only touches the curve's ends carries no span of it,
		// so it stays empty rather than drawing a hairline of nothing
		if (to <= first || from >= last) continue;
		const lo = Math.max(from, first);
		const hi = Math.min(to, last);
		// the minimum of a piecewise-linear curve over a range is attained at
		// one of its ends or at a breakpoint inside it
		let lowest = Math.min(hpAt(curve, lo), hpAt(curve, hi));
		while (cursor < curve.length && curve[cursor][0] < lo) cursor++;
		for (let index = cursor; index < curve.length && curve[index][0] <= hi; index++) {
			if (curve[index][1] < lowest) lowest = curve[index][1];
		}
		out[column] = lowest;
	}
	return out;
}

// ---------------------------------------------------------------------------
// the analysis panel's hp section, worded here rather than in the component so
// every state is pinned by tests rather than by reading jsx

/** the fail-point row, over all three states it can be in: no curve to read
 * at all, a curve that never reached zero, or the moment it did.
 *
 * the no-curve state matters because an authoritative play can still carry
 * an empty curve — an object-free map, or a drain-rate search that never
 * settled — and answering "none" there would claim the play survived when
 * nothing was ever computed. the time comes in already formatted, so the
 * section prints times the way every other panel row does */
export function describeFailPoint(hasCurve: boolean, formattedTime: string | null): string {
	if (!hasCurve) return "unknown — this play has no HP curve";
	if (formattedTime === null) return "none";
	return `${formattedTime} — stable would have failed this play here`;
}
