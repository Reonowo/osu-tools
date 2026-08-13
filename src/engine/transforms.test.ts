import { describe, expect, test } from "bun:test";
import { none, outQuint } from "./easing";
import { jump, trackValueAt, tracksWithin, tween } from "./transforms";

describe("transform tracks", () => {
	const tracks = [tween(0, 100, 0, 1, none), jump(200, 0.5), tween(300, 100, 0.5, 0, outQuint)];

	test("initial before the first track, endpoints clamp, later tracks override", () => {
		expect(trackValueAt(tracks, -1, 7)).toBe(7);
		expect(trackValueAt(tracks, 0, 7)).toBe(0);
		expect(trackValueAt(tracks, 50, 7)).toBe(0.5);
		expect(trackValueAt(tracks, 150, 7)).toBe(1); // held between tracks
		expect(trackValueAt(tracks, 200, 7)).toBe(0.5); // duration-0 jump applies at its start
		expect(trackValueAt(tracks, 1e9, 7)).toBe(0);
	});

	test("easing shapes the interpolation", () => {
		const eased = trackValueAt(tracks, 350, 7);
		expect(eased).toBeCloseTo(0.5 + (0 - 0.5) * outQuint(0.5), 12);
	});

	test("zero-duration at t exactly equal to start applies the target", () => {
		expect(trackValueAt([jump(10, 3)], 10, 0)).toBe(3);
		expect(trackValueAt([jump(10, 3)], 9.999, 0)).toBe(0);
	});

	test("track order does not affect the result", () => {
		const unsorted = [tween(300, 100, 0.5, 0, outQuint), tween(0, 100, 0, 1, none), jump(200, 0.5)];

		expect(trackValueAt(unsorted, 50, 7)).toBe(0.5);
		expect(trackValueAt(unsorted, 150, 7)).toBe(1);
		expect(trackValueAt(unsorted, 350, 7)).toBeCloseTo(0.015625, 12);
	});
});

describe("narrowing a track set to a window", () => {
	const tracks = [tween(0, 100, 0, 1, none), jump(200, 0.5), tween(300, 100, 0.5, 0, outQuint), jump(900, 4)];

	test("the window answers exactly as the whole set does, everywhere inside it", () => {
		for (const [from, to] of [
			[0, 1000],
			[150, 400],
			[250, 260],
			[-50, 10],
			[1000, 2000]
		]) {
			const narrowed = tracksWithin(tracks, from, to);
			for (let t = from; t <= to; t += (to - from) / 20 || 1) {
				expect(trackValueAt(narrowed, t, 7)).toBe(trackValueAt(tracks, t, 7));
			}
		}
	});

	test("it keeps the one track already running at the window's start", () => {
		// nothing starts inside [150, 190], but the first tween still owns the
		// value there -- dropping it would fall back to the caller's initial
		expect(tracksWithin(tracks, 150, 190)).toEqual([tracks[0]]);
		expect(trackValueAt(tracksWithin(tracks, 150, 190), 150, 7)).toBe(1);
	});

	test("a window before every track keeps nothing", () => {
		expect(tracksWithin(tracks, -100, -1)).toEqual([]);
	});

	test("tied starts keep their array order, so the same one still wins", () => {
		const tied = [jump(100, 1), jump(100, 2), jump(500, 3)];
		expect(tracksWithin(tied, 100, 200)).toEqual([tied[0], tied[1]]);
		expect(trackValueAt(tracksWithin(tied, 100, 200), 150, 0)).toBe(2);
		expect(tracksWithin(tied, 200, 300)).toEqual([tied[1]]);
	});
});
