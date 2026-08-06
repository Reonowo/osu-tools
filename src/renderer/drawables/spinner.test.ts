import { describe, expect, test } from "bun:test";
import type { FrameDto } from "../../lib/scene-types";
import { spinnerRotationSamples } from "./spinner";

/** frames circling the playfield centre at 60ms per revolution step */
function circling(count: number, holding: boolean): FrameDto[] {
	const frames: FrameDto[] = [];
	for (let i = 0; i < count; i++) {
		const angle = (i / 20) * 2 * Math.PI;
		frames.push({
			time: i * 10,
			x: 256 + 100 * Math.cos(angle),
			y: 192 + 100 * Math.sin(angle),
			buttons: holding ? 1 : 0
		});
	}
	return frames;
}

describe("spinner rotation integration", () => {
	test("a full revolution while holding accumulates 360 degrees", () => {
		const { cumulative } = spinnerRotationSamples(circling(21, true), 0, 10_000);
		expect(cumulative[20]).toBeCloseTo(360, 6);
	});

	test("released cursor accumulates nothing", () => {
		const { cumulative } = spinnerRotationSamples(circling(21, false), 0, 10_000);
		expect(cumulative[20]).toBe(0);
	});

	test("frames outside the spinner window are ignored", () => {
		const { cumulative } = spinnerRotationSamples(circling(21, true), 90, 130);
		// only deltas between 90..130ms count: 4 steps of 18 degrees
		expect(cumulative[cumulative.length - 1]).toBeCloseTo(4 * 18, 6);
	});
});
