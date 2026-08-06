import { describe, expect, test } from "bun:test";
import { none, outQuint } from "./easing";
import { jump, trackValueAt, tween } from "./transforms";

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
