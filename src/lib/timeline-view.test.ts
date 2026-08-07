import { describe, expect, test } from "bun:test";
import { clampSpan, rulerTicks, windowAround, zoomFactor } from "./timeline-view";

const bounds = { minTime: -1000, maxTime: 99_000 };

describe("windowAround", () => {
	test("centres the window on the playhead", () => {
		expect(windowAround(bounds, 50_000, 10_000)).toEqual({ start: 45_000, end: 55_000 });
	});

	test("slides rather than shrinks at the head of the replay", () => {
		expect(windowAround(bounds, -900, 10_000)).toEqual({ start: -1000, end: 9000 });
	});

	test("slides rather than shrinks at the tail", () => {
		expect(windowAround(bounds, 98_900, 10_000)).toEqual({ start: 89_000, end: 99_000 });
	});

	test("a span wider than the replay collapses onto the full bounds", () => {
		expect(windowAround(bounds, 50_000, 1_000_000)).toEqual({ start: -1000, end: 99_000 });
	});
});

describe("clampSpan", () => {
	test("never exceeds the replay length", () => {
		expect(clampSpan(bounds, 1_000_000)).toBe(100_000);
	});

	test("never drops below the floor", () => {
		expect(clampSpan(bounds, 1)).toBe(250);
	});
});

describe("zoomFactor", () => {
	test("is the ratio of the whole replay to the visible span", () => {
		expect(zoomFactor(10_000, bounds)).toBeCloseTo(10, 6);
	});

	test("degenerate bounds do not produce Infinity", () => {
		expect(Number.isFinite(zoomFactor(10_000, { minTime: 0, maxTime: 0 }))).toBe(true);
	});
});

describe("rulerTicks", () => {
	test("picks a round interval and covers the window", () => {
		const ticks = rulerTicks({ start: 44_000, end: 64_000 }, 5);
		expect(ticks[0]).toBe(45_000);
		// 20s over ~5 ticks -> a 5s interval
		expect(ticks[1] - ticks[0]).toBe(5000);
		expect(ticks[ticks.length - 1]).toBeLessThanOrEqual(64_000);
	});

	test("starts on a multiple of the interval, not on the window edge", () => {
		const ticks = rulerTicks({ start: 44_300, end: 64_300 }, 5);
		expect(ticks[0] % 5000).toBe(0);
	});

	test("a degenerate window yields no ticks instead of looping", () => {
		expect(rulerTicks({ start: 10, end: 10 }, 5)).toEqual([]);
	});

	test("terminates at float magnitudes where the interval is below one ulp", () => {
		// frame deltas are unchecked backend-side, so a crafted replay can put
		// the window at magnitudes where tick addition stops advancing; the
		// ruler must stop rather than loop forever. 3e18 sits where the ulp is
		// 512, so the 250ms interval this window selects genuinely cannot move
		// t -- asserted as a precondition so the case never silently weakens
		const start = 3e18;
		expect(start + 250).toBe(start);
		const ticks = rulerTicks({ start, end: start + 600 }, 5);
		expect(ticks.length).toBeGreaterThan(0);
		expect(ticks.length).toBeLessThan(10);
	});
});
