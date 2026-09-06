import { describe, expect, test } from "bun:test";
import { dampWindow, describeFailPoint, hpAt, hpExtremes, HP_DAMP_TAU_MS, resampleHpColumns, smoothedHpAt } from "./hp";
import type { HpCurve } from "./scene-types";

/** a drain from full to half over a second, a judgement's jump back up at
 * 2000, and a hold after it — one curve carrying every shape the evaluator
 * has a rule for */
const CURVE: HpCurve = [
	[1000, 1],
	[2000, 0.5],
	[2000, 0.9],
	[3000, 0.7]
];

describe("hpAt", () => {
	test("an empty curve is full everywhere", () => {
		expect(hpAt([], 0)).toBe(1);
		expect(hpAt([], -5000)).toBe(1);
		expect(hpAt([], 1e9)).toBe(1);
	});

	test("HP is full before the first breakpoint", () => {
		expect(hpAt(CURVE, 0)).toBe(1);
		expect(hpAt(CURVE, 999)).toBe(1);
		expect(hpAt(CURVE, 1000)).toBe(1);
	});

	test("it lerps between two breakpoints", () => {
		expect(hpAt(CURVE, 1500)).toBeCloseTo(0.75, 12);
		expect(hpAt(CURVE, 1250)).toBeCloseTo(0.875, 12);
		expect(hpAt(CURVE, 2500)).toBeCloseTo(0.8, 12);
	});

	test("a judgement's millisecond reads the value after the judgement", () => {
		expect(hpAt(CURVE, 2000)).toBe(0.9);
		// and the millisecond before it still reads the pre-judgement side
		expect(hpAt(CURVE, 1999)).toBeCloseTo(0.5005, 12);
	});

	test("the last value holds after the last breakpoint", () => {
		expect(hpAt(CURVE, 3000)).toBe(0.7);
		expect(hpAt(CURVE, 1e9)).toBe(0.7);
	});

	test("a one-point curve is that point, before and after", () => {
		expect(hpAt([[500, 0.4]], 0)).toBe(1);
		expect(hpAt([[500, 0.4]], 500)).toBe(0.4);
		expect(hpAt([[500, 0.4]], 9999)).toBe(0.4);
	});
});

describe("hpExtremes", () => {
	test("an empty curve has neither a lowest point nor a fail point", () => {
		expect(hpExtremes([])).toEqual({ lowest: null, failPoint: null });
	});

	test("a clean play reports its lowest point and no fail point", () => {
		const extremes = hpExtremes(CURVE);
		expect(extremes.lowest).toEqual({ time: 2000, fraction: 0.5 });
		expect(extremes.failPoint).toBeNull();
	});

	test("a play reaching zero twice keeps the first zero as its fail point", () => {
		const failed: HpCurve = [
			[0, 1],
			[1000, 0],
			[2000, 0],
			[2000, 0.6],
			[4000, 0],
			[5000, 0.3]
		];
		const extremes = hpExtremes(failed);
		expect(extremes.failPoint).toBe(1000);
		// the lowest reading is the first one that attains the minimum
		expect(extremes.lowest).toEqual({ time: 1000, fraction: 0 });
	});
});

describe("smoothedHpAt", () => {
	/** a curve holding one value from end to end */
	const flat: HpCurve = [
		[0, 0.6],
		[10_000, 0.6]
	];
	/** a step down from full to empty at t=0, held either side */
	const step: HpCurve = [
		[-5000, 1],
		[0, 1],
		[0, 0],
		[10_000, 0]
	];

	test("an empty curve smooths to full", () => {
		expect(smoothedHpAt([], 1234)).toBe(1);
	});

	test("a flat curve smooths to itself", () => {
		expect(smoothedHpAt(flat, 5000)).toBeCloseTo(0.6, 12);
		expect(smoothedHpAt(flat, 9999)).toBeCloseTo(0.6, 12);
	});

	test("a step is within five percent of its target three time constants later", () => {
		const tau = HP_DAMP_TAU_MS;
		// the exact exponential answer is e^-3 of the way from 1 to 0
		expect(smoothedHpAt(step, 3 * tau)).toBeCloseTo(Math.exp(-3), 6);
		expect(smoothedHpAt(step, 3 * tau)).toBeLessThan(0.05);
	});

	test("a step equals the raw value once the whole window has passed", () => {
		const tau = HP_DAMP_TAU_MS;
		expect(smoothedHpAt(step, 6 * tau)).toBe(0);
		expect(hpAt(step, 6 * tau)).toBe(0);
		// and before the step it is the pre-step value exactly
		expect(smoothedHpAt(step, -6 * tau)).toBe(1);
	});

	test("a linear drain lags the raw value by the rate times the constant", () => {
		const drain: HpCurve = [
			[0, 1],
			[10_000, 0]
		];
		const ratePerMs = 1 / 10_000;
		const raw = hpAt(drain, 5000);
		// the lag is upward: the smoothed value trails the falling curve
		expect(smoothedHpAt(drain, 5000) - raw).toBeCloseTo(ratePerMs * HP_DAMP_TAU_MS, 4);
	});

	test("the value is the same computed cold and after a run of earlier reads", () => {
		const cold = smoothedHpAt(step, 137);
		for (let t = -500; t < 137; t += 7) smoothedHpAt(step, t);
		expect(smoothedHpAt(step, 137)).toBe(cold);
	});

	test("the walk covers the window's breakpoints, never the curve", () => {
		// one breakpoint per millisecond across ten minutes
		const dense: HpCurve = Array.from({ length: 600_000 }, (_, i) => [i, 1 - i / 1_200_000] as const);
		const { from, to } = dampWindow(dense, 300_000);
		// six time constants at one point per millisecond is 300 points, and
		// the walk is exactly that many however long the curve runs
		expect(to - from).toBe(HP_DAMP_TAU_MS * 6);
		expect(from).toBeGreaterThan(0);
	});
});

describe("resampleHpColumns", () => {
	const bounds = { minTime: 0, maxTime: 100 };

	test("an empty curve fills no column", () => {
		expect(resampleHpColumns([], bounds, 4)).toEqual([null, null, null, null]);
	});

	test("it answers one value per column", () => {
		const curve: HpCurve = [
			[0, 1],
			[100, 0]
		];
		expect(resampleHpColumns(curve, bounds, 4)).toHaveLength(4);
		expect(resampleHpColumns(curve, bounds, 0)).toEqual([]);
	});

	test("each column takes its own minimum", () => {
		const curve: HpCurve = [
			[0, 1],
			[100, 0]
		];
		// a column spanning 0..25 reaches 0.75 by its end
		expect(resampleHpColumns(curve, bounds, 4)).toEqual([0.75, 0.5, 0.25, 0]);
	});

	test("a dip narrower than a column still shows in its column", () => {
		// full everywhere but a one-millisecond notch to zero at 62ms, which a
		// four-column strip would sample straight past
		const curve: HpCurve = [
			[0, 1],
			[61, 1],
			[62, 0],
			[63, 1],
			[100, 1]
		];
		const columns = resampleHpColumns(curve, bounds, 4);
		expect(columns[2]).toBe(0);
		expect(columns[0]).toBe(1);
		expect(columns[3]).toBe(1);
	});

	test("a curve shorter than the strip's range fills only its own span", () => {
		const curve: HpCurve = [
			[25, 1],
			[75, 0.5]
		];
		const columns = resampleHpColumns(curve, bounds, 4);
		expect(columns[0]).toBeNull();
		expect(columns[1]).toBe(0.75);
		expect(columns[2]).toBe(0.5);
		expect(columns[3]).toBeNull();
	});
});

describe("the fail-point row", () => {
	test("a play with no curve at all admits it rather than claiming none", () => {
		expect(describeFailPoint(false, null)).toContain("no HP curve");
	});

	test("a play that never failed reads as none", () => {
		expect(describeFailPoint(true, null)).toBe("none");
	});

	test("a fail point states what it means, beside the time", () => {
		expect(describeFailPoint(true, "01:23.456")).toBe("01:23.456 — stable would have failed this play here");
	});
});
