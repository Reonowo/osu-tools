import { describe, expect, test } from "bun:test";
import type { Lattice } from "../lib/lattice";
import { editTargets, insertOps, offsetOps, snapOps, snapToLatticePoint } from "./ops";
import type { FrameDto } from "../lib/scene-types";

// 1080p fullscreen: scale 2.25, step 4/9 -- TODO.md's case-study lattice
const lattice: Lattice = { scale: 2.25, step: 4 / 9, conformance: 1 };

function frame(time: number, x: number, y: number, buttons = 0): FrameDto {
	return { time, x, y, buttons };
}

describe("snapToLatticePoint", () => {
	test("rounds to the nearest lattice multiple", () => {
		expect(snapToLatticePoint(1.0, 4 / 9)).toBeCloseTo(8 / 9, 10);
		// 100.22 / (4/9) = 225.495, which rounds down to 225 (225*4/9 = 100), not
		// up to 226 (100.4444) -- the brief this test was transcribed from named
		// the wrong nearest multiple, corrected here
		expect(snapToLatticePoint(100.22, 4 / 9)).toBeCloseTo(100, 5);
	});
});

describe("editTargets", () => {
	test("a selection is its own targets", () => {
		expect(editTargets([3, 7, 9], 5)).toEqual([3, 7, 9]);
	});

	test("an empty selection falls back to the frame-cursor frame", () => {
		expect(editTargets([], 5)).toEqual([5]);
	});
});

describe("offsetOps", () => {
	const frames = [frame(0, 100, 100), frame(16, 200, 200)];

	test("moves by the delta, snapped when the preference is on", () => {
		const ops = offsetOps(frames, [1], 1, 0, lattice, true);
		expect(ops).not.toBeNull();
		const move = ops![0];
		if (move.kind !== "moveFrames") throw new Error("expected moveFrames");
		expect(move.moves[0].index).toBe(1);
		expect(move.moves[0].x).toBeCloseTo(snapToLatticePoint(201, 4 / 9), 10);
		expect(move.moves[0].y).toBeCloseTo(200, 10);
	});

	test("raw deltas when snapping is off or no lattice was inferred", () => {
		const ops = offsetOps(frames, [0], 2.5, -1, lattice, false);
		if (ops![0].kind !== "moveFrames") throw new Error("expected moveFrames");
		expect(ops![0].moves[0].x).toBe(102.5);
		expect(ops![0].moves[0].y).toBe(99);
		expect(offsetOps(frames, [0], 2.5, -1, null, true)![0]).toMatchObject({ kind: "moveFrames" });
	});

	test("a zero offset is an identity", () => {
		expect(offsetOps(frames, [0, 1], 0, 0, null, false)).toBeNull();
	});

	test("out-of-range indices are skipped", () => {
		expect(offsetOps(frames, [7], 1, 1, null, false)).toBeNull();
	});
});

describe("snapOps", () => {
	test("moves only off-lattice frames onto the grid", () => {
		const on = frame(0, 8 / 9, 4 / 9);
		const off = frame(16, 100.2, 50.1);
		const ops = snapOps([on, off], [0, 1], lattice);
		if (ops![0].kind !== "moveFrames") throw new Error("expected moveFrames");
		expect(ops![0].moves).toHaveLength(1);
		expect(ops![0].moves[0].index).toBe(1);
		expect(ops![0].moves[0].x).toBeCloseTo(snapToLatticePoint(100.2, 4 / 9), 10);
	});

	test("no lattice or nothing off-lattice means no op", () => {
		expect(snapOps([frame(0, 8 / 9, 4 / 9)], [0], lattice)).toBeNull();
		expect(snapOps([frame(0, 100.2, 50.1)], [0], null)).toBeNull();
	});
});

describe("insertOps", () => {
	const frames = [frame(0, 0, 0, 5), frame(100, 100, 100, 0)];

	test("interpolates the position, inherits the previous buttons, snaps", () => {
		const ops = insertOps(frames, 50, lattice);
		if (ops![0].kind !== "insertFrames") throw new Error("expected insertFrames");
		const inserted = ops![0].frames[0];
		expect(inserted.time).toBe(50);
		// the cursor-interpolation port lerps halfway, then the lattice snaps
		expect(inserted.x).toBeCloseTo(snapToLatticePoint(50, 4 / 9), 10);
		expect(inserted.buttons).toBe(5);
	});

	test("times round to integral milliseconds", () => {
		const ops = insertOps(frames, 49.7, null);
		if (ops![0].kind !== "insertFrames") throw new Error("expected insertFrames");
		expect(ops![0].frames[0].time).toBe(50);
	});

	test("synthetic frames snap regardless of the preference, but only when a lattice exists", () => {
		const raw = insertOps(frames, 50, null);
		if (raw![0].kind !== "insertFrames") throw new Error("expected insertFrames");
		expect(raw![0].frames[0].x).toBe(50);
	});

	test("an empty stream admits no insert", () => {
		expect(insertOps([], 50, null)).toBeNull();
	});
});
