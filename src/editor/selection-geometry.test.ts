import { describe, expect, test } from "bun:test";
import type { FrameDto } from "../lib/scene-types";
import {
	framesInPolygon,
	framesInRect,
	framesNearSegment,
	framesWithinRadius,
	hitTestFrame,
	toggleIndex,
	unionSelection
} from "./selection-geometry";

function frame(time: number, x: number, y: number): FrameDto {
	return { time, x, y, buttons: 0 };
}

const frames: FrameDto[] = [
	frame(0, 100, 100),
	frame(16, 110, 100),
	frame(32, 200, 200),
	frame(48, 201, 201),
	frame(64, 400, 50)
];
const all = [0, 1, 2, 3, 4];

describe("hitTestFrame", () => {
	test("picks the nearest candidate within the radius", () => {
		expect(hitTestFrame(frames, all, { x: 102, y: 101 }, 12)).toBe(0);
		expect(hitTestFrame(frames, all, { x: 108, y: 100 }, 12)).toBe(1);
	});

	test("misses when nothing is inside the radius", () => {
		expect(hitTestFrame(frames, all, { x: 300, y: 300 }, 12)).toBeNull();
	});

	test("the radius boundary is inclusive", () => {
		expect(hitTestFrame(frames, all, { x: 112, y: 100 }, 12)).not.toBeNull();
		expect(hitTestFrame(frames, all, { x: 112.001, y: 100 }, 12)).toBe(1);
		expect(hitTestFrame(frames, [4], { x: 400, y: 62 }, 12)).toBe(4);
		expect(hitTestFrame(frames, [4], { x: 400, y: 62.01 }, 12)).toBeNull();
	});

	test("only candidate frames are hittable, whatever overlaps geometrically", () => {
		// frame 0 sits right under the pointer but is not a candidate
		expect(hitTestFrame(frames, [2, 3], { x: 100, y: 100 }, 12)).toBeNull();
	});

	test("an exact distance tie resolves to the lower index", () => {
		const tied: FrameDto[] = [frame(0, 90, 100), frame(16, 110, 100)];
		expect(hitTestFrame(tied, [0, 1], { x: 100, y: 100 }, 12)).toBe(0);
	});
});

describe("framesWithinRadius", () => {
	test("sweeps every candidate inside the radius, edge inclusive", () => {
		expect(framesWithinRadius(frames, all, { x: 105, y: 100 }, 12)).toEqual([0, 1]);
		expect(framesWithinRadius(frames, all, { x: 112, y: 100 }, 2)).toEqual([1]);
	});

	test("non-candidates under the brush stay out", () => {
		expect(framesWithinRadius(frames, [2, 3], { x: 100, y: 100 }, 12)).toEqual([]);
	});
});

describe("framesNearSegment", () => {
	test("collects candidates along the whole stroke, not only at the sample points", () => {
		// frames 2 and 3 lie on the diagonal but outside a 12px circle around
		// either endpoint -- only the segment reaches them
		expect(framesNearSegment(frames, all, { x: 100, y: 100 }, { x: 210, y: 210 }, 12)).toEqual([0, 1, 2, 3]);
	});

	test("a degenerate segment is the plain circle sweep", () => {
		expect(framesNearSegment(frames, all, { x: 105, y: 100 }, { x: 105, y: 100 }, 12)).toEqual(
			framesWithinRadius(frames, all, { x: 105, y: 100 }, 12)
		);
	});

	test("the stroke does not extend past its endpoints", () => {
		// frame 0 sits on the segment's infinite line, 10px past its end
		expect(framesNearSegment(frames, all, { x: 60, y: 100 }, { x: 90, y: 100 }, 5)).toEqual([]);
	});

	test("non-candidates along the stroke stay out", () => {
		expect(framesNearSegment(frames, [4], { x: 100, y: 100 }, { x: 210, y: 210 }, 12)).toEqual([]);
	});
});

describe("framesInRect", () => {
	test("selects candidate frames inside, corners given in any order", () => {
		expect(framesInRect(frames, all, { x: 90, y: 90 }, { x: 210, y: 210 })).toEqual([0, 1, 2, 3]);
		expect(framesInRect(frames, all, { x: 210, y: 210 }, { x: 90, y: 90 })).toEqual([0, 1, 2, 3]);
	});

	test("edges are inclusive", () => {
		expect(framesInRect(frames, all, { x: 100, y: 100 }, { x: 110, y: 100 })).toEqual([0, 1]);
	});

	test("non-candidates inside the rectangle stay unselected", () => {
		expect(framesInRect(frames, [2], { x: 0, y: 0 }, { x: 512, y: 384 })).toEqual([2]);
	});
});

describe("framesInPolygon", () => {
	// a C-shape (concave): covers x 0..300, y 0..300 minus the bite x 100..300, y 100..200
	const cShape = [
		{ x: 0, y: 0 },
		{ x: 300, y: 0 },
		{ x: 300, y: 100 },
		{ x: 100, y: 100 },
		{ x: 100, y: 200 },
		{ x: 300, y: 200 },
		{ x: 300, y: 300 },
		{ x: 0, y: 300 }
	];

	test("selects the frames inside a concave polygon and not those in its bite", () => {
		const inTop = frame(0, 200, 50); // inside the C's upper arm
		const inBite = frame(16, 200, 150); // inside the concave bite
		const inLower = frame(32, 50, 150); // inside the C's spine
		expect(framesInPolygon([inTop, inBite, inLower], [0, 1, 2], cShape)).toEqual([0, 2]);
	});

	test("an unclosed point list is treated as closed", () => {
		const triangle = [
			{ x: 0, y: 0 },
			{ x: 100, y: 0 },
			{ x: 0, y: 100 }
		];
		expect(framesInPolygon([frame(0, 20, 20), frame(16, 90, 90)], [0, 1], triangle)).toEqual([0]);
	});

	test("a degenerate polygon selects nothing", () => {
		expect(framesInPolygon(frames, all, [{ x: 100, y: 100 }])).toEqual([]);
		expect(
			framesInPolygon(frames, all, [
				{ x: 100, y: 100 },
				{ x: 110, y: 100 }
			])
		).toEqual([]);
	});
});

describe("selection set helpers", () => {
	test("toggleIndex adds a missing index in sorted position", () => {
		expect(toggleIndex([1, 5], 3)).toEqual([1, 3, 5]);
	});

	test("toggleIndex removes a present index", () => {
		expect(toggleIndex([1, 3, 5], 3)).toEqual([1, 5]);
	});

	test("unionSelection merges sorted-unique", () => {
		expect(unionSelection([1, 4], [2, 4, 9])).toEqual([1, 2, 4, 9]);
		expect(unionSelection([], [3, 1])).toEqual([1, 3]);
	});
});
