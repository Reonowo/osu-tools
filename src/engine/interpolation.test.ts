import { describe, expect, test } from "bun:test";
import type { FrameDto } from "../lib/scene-types";
import { loadFixture } from "../test/fixtures";
import { K1, K2, M1, M2, isLeft, isRight } from "./buttons";
import { buttonEdges, cursorStateAt, holdSpans, holdSpansFlat, pressEdges, sliceSpansFlat } from "./interpolation";

interface CursorFixture {
	cases: {
		name: string;
		frames: { time: number; pos: [number, number]; left: boolean; right: boolean }[];
		samples: { time: number; pos: [number, number]; left: boolean; right: boolean }[];
	}[];
}

function frame(time: number, x: number, y: number, buttons: number): FrameDto {
	return { time, x, y, buttons };
}

describe("cursor interpolation parity (lazer is the oracle)", () => {
	test("all fixture cases reproduce the settled handler state", async () => {
		const fixture = await loadFixture<CursorFixture>("replays", "cursor_interpolation.json");
		expect(fixture.cases.length).toBeGreaterThan(0);
		for (const c of fixture.cases) {
			const frames: FrameDto[] = c.frames.map((f) =>
				frame(f.time, f.pos[0], f.pos[1], (f.left ? M1 : 0) | (f.right ? M2 : 0))
			);
			expect(c.samples.length).toBeGreaterThan(0);
			for (const s of c.samples) {
				const state = cursorStateAt(frames, s.time);
				expect(state, `${c.name} t=${s.time}`).not.toBeNull();
				expect(Math.abs(state!.x - s.pos[0]), `${c.name} t=${s.time} x`).toBeLessThanOrEqual(1e-4);
				expect(Math.abs(state!.y - s.pos[1]), `${c.name} t=${s.time} y`).toBeLessThanOrEqual(1e-4);
				expect(isLeft(state!.buttons), `${c.name} t=${s.time} left`).toBe(s.left);
				expect(isRight(state!.buttons), `${c.name} t=${s.time} right`).toBe(s.right);
			}
		}
	});
});

describe("cursorStateAt edge semantics (mirrors interpolation.rs)", () => {
	test("empty frames yield null", () => {
		expect(cursorStateAt([], 0)).toBeNull();
	});

	test("before the first frame the first position holds and nothing is pressed", () => {
		const frames = [frame(100, 10, 20, M1), frame(200, 30, 40, M1)];
		const s = cursorStateAt(frames, -50)!;
		expect([s.x, s.y]).toEqual([10, 20]);
		expect(s.buttons).toBe(0);
	});

	test("exactly at the first frame's own time its actual state holds", () => {
		const frames = [frame(100, 10, 20, M1), frame(200, 30, 40, 0)];
		const s = cursorStateAt(frames, 100)!;
		expect([s.x, s.y]).toEqual([10, 20]);
		expect(isLeft(s.buttons)).toBe(true);
	});

	test("interpolates between frames in float space, buttons uninterpolated", () => {
		const frames = [frame(0, 0, 0, 0), frame(100, 10, 20, M1)];
		const s = cursorStateAt(frames, 25)!;
		const t = Math.fround(25) / Math.fround(100);
		expect(s.x).toBeCloseTo(Math.fround(t * 10), 6);
		expect(s.y).toBeCloseTo(Math.fround(t * 20), 6);
		expect(s.buttons).toBe(0);
	});

	test("duplicate-time frames resolve to the last of the run", () => {
		const frames = [frame(0, 0, 0, 0), frame(100, 10, 10, M1), frame(100, 90, 90, M2)];
		const s = cursorStateAt(frames, 100)!;
		expect([s.x, s.y]).toEqual([90, 90]);
		expect(isRight(s.buttons)).toBe(true);
	});

	test("after the last frame the last state holds", () => {
		const frames = [frame(0, 0, 0, 0), frame(100, 10, 20, M2)];
		const s = cursorStateAt(frames, 5000)!;
		expect([s.x, s.y]).toEqual([10, 20]);
		expect(isRight(s.buttons)).toBe(true);
	});
});

describe("press edges", () => {
	test("fire once per action, left before right within one frame", () => {
		const frames = [
			frame(0, 0, 0, 0),
			frame(16, 0, 0, M1 | M2),
			frame(32, 0, 0, M1 | K1 | M2), // k1 joins m1: still left, no new edge
			frame(48, 0, 0, 0),
			frame(64, 0, 0, K1)
		];
		const presses = pressEdges(frames);
		expect(presses.map((p) => [p.time, p.action])).toEqual([
			[16, "left"],
			[16, "right"],
			[64, "left"]
		]);
		expect(presses[2].frameIndex).toBe(4);
	});

	test("buttonEdges tracks raw bits independently", () => {
		const frames = [
			frame(0, 0, 0, 0),
			frame(16, 0, 0, M1),
			frame(32, 0, 0, M1 | K1),
			frame(48, 0, 0, K1),
			frame(64, 0, 0, K1 | K2),
			frame(80, 0, 0, 0),
			frame(96, 0, 0, M2)
		];
		const edges = buttonEdges(frames);
		expect(edges.m1).toEqual([16]);
		expect(edges.k1).toEqual([32]);
		expect(edges.k2).toEqual([64]);
		expect(edges.m2).toEqual([96]);
	});
});

describe("holdSpans", () => {
	test("pairs each rising edge with its release", () => {
		const frames = [
			{ time: 0, x: 0, y: 0, buttons: 0 },
			{ time: 10, x: 0, y: 0, buttons: 4 },
			{ time: 40, x: 0, y: 0, buttons: 0 }
		];
		expect(holdSpans(frames, 4)).toEqual([{ start: 10, end: 40 }]);
	});

	test("closes a still-held button at the final frame", () => {
		const frames = [
			{ time: 0, x: 0, y: 0, buttons: 4 },
			{ time: 30, x: 0, y: 0, buttons: 4 }
		];
		expect(holdSpans(frames, 4)).toEqual([{ start: 0, end: 30 }]);
	});

	test("a never-pressed button has no spans", () => {
		expect(holdSpans([{ time: 0, x: 0, y: 0, buttons: 0 }], 4)).toEqual([]);
	});
});

describe("holdSpansFlat", () => {
	test("packs exactly the spans holdSpans produces, as start/end pairs", () => {
		const frames = [
			{ time: 0, x: 0, y: 0, buttons: 0 },
			{ time: 10, x: 0, y: 0, buttons: 4 },
			{ time: 40, x: 0, y: 0, buttons: 0 },
			{ time: 60, x: 0, y: 0, buttons: 4 },
			{ time: 90, x: 0, y: 0, buttons: 4 }
		];
		expect(Array.from(holdSpansFlat(frames, 4))).toEqual(holdSpans(frames, 4).flatMap((s) => [s.start, s.end]));
		expect(Array.from(holdSpansFlat(frames, 4))).toEqual([10, 40, 60, 90]);
	});

	test("an empty frame stream packs no spans", () => {
		expect(holdSpansFlat([], 4).length).toBe(0);
	});
});

describe("sliceSpansFlat", () => {
	test("returns only spans overlapping the range", () => {
		const flat = new Float64Array([0, 10, 20, 30, 40, 50]);
		expect(sliceSpansFlat(flat, 15, 35, 0)).toEqual([{ start: 20, end: 30 }]);
	});

	test("coalesces spans separated by at most the merge gap", () => {
		const flat = new Float64Array([0, 10, 12, 20, 100, 110]);
		expect(sliceSpansFlat(flat, 0, 200, 5)).toEqual([
			{ start: 0, end: 20 },
			{ start: 100, end: 110 }
		]);
	});

	test("bounds a duplicate-time span flood to one rendered span", () => {
		// duplicate frame times are legal, so a crafted replay can alternate a
		// button millions of times at one timestamp -- the slice must coalesce
		// that flood instead of materializing an object (and dom node) per span
		const flood = new Float64Array(10_000);
		flood.fill(500);
		expect(sliceSpansFlat(flood, 0, 1000, 1)).toEqual([{ start: 500, end: 500 }]);
	});
});
