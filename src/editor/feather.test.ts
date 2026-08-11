import { describe, expect, test } from "bun:test";
import type { FrameDto } from "../lib/scene-types";
import type { Lattice } from "../lib/lattice";
import { featherMoveOps, featherWeights, smoothstep01 } from "./feather";

function frame(time: number, x: number, y: number): FrameDto {
	return { time, x, y, buttons: 0 };
}

/** frames every 10ms along y=100 */
const frames: FrameDto[] = Array.from({ length: 11 }, (_, i) => frame(i * 10, 100 + i * 10, 100));

function movesOf(ops: ReturnType<typeof featherMoveOps>): Map<number, { x: number; y: number }> {
	const map = new Map<number, { x: number; y: number }>();
	if (ops === null) return map;
	for (const op of ops) {
		if (op.kind === "moveFrames") for (const m of op.moves) map.set(m.index, { x: m.x, y: m.y });
	}
	return map;
}

describe("smoothstep01", () => {
	test("is the hermite smoothstep, clamped", () => {
		expect(smoothstep01(0)).toBe(0);
		expect(smoothstep01(1)).toBe(1);
		expect(smoothstep01(0.5)).toBe(0.5);
		expect(smoothstep01(0.25)).toBeCloseTo(0.15625, 12);
		expect(smoothstep01(-1)).toBe(0);
		expect(smoothstep01(2)).toBe(1);
	});
});

describe("featherMoveOps identity", () => {
	test("a zero translation commits nothing, snap and off-lattice frames notwithstanding", () => {
		const lattice: Lattice = { scale: 2, step: 0.5, conformance: 1 };
		const offLattice = [frame(0, 100.3, 100.2), frame(10, 110.3, 100.2)];
		expect(featherMoveOps(offLattice, [1], 0, 0, 40, lattice, true)).toBeNull();
	});
});

describe("featherWeights", () => {
	test("selected frames weigh 1; frames beyond the window weigh nothing", () => {
		const weights = featherWeights(frames, [5], 25);
		expect(weights.get(5)).toBe(1);
		// 30ms away: outside the 25ms window
		expect(weights.has(2)).toBe(false);
		expect(weights.has(8)).toBe(false);
	});

	test("weight falls off by smoothstep over time distance to the nearest selected frame", () => {
		const weights = featherWeights(frames, [5], 25);
		// frame 4 is 10ms from the selection: w = smoothstep(1 - 10/25)
		expect(weights.get(4)).toBeCloseTo(smoothstep01(1 - 10 / 25), 12);
		expect(weights.get(6)).toBeCloseTo(smoothstep01(1 - 10 / 25), 12);
		// 20ms away, weaker
		expect(weights.get(3)).toBeCloseTo(smoothstep01(1 - 20 / 25), 12);
		expect(weights.get(3)!).toBeLessThan(weights.get(4)!);
	});

	test("a contiguous selection reproduces the edge falloff on both flanks only", () => {
		const weights = featherWeights(frames, [4, 5, 6], 15);
		expect(weights.get(4)).toBe(1);
		expect(weights.get(5)).toBe(1);
		expect(weights.get(6)).toBe(1);
		// one frame out on each side, 10ms from the nearest edge
		expect(weights.get(3)).toBeCloseTo(smoothstep01(1 - 10 / 15), 12);
		expect(weights.get(7)).toBeCloseTo(smoothstep01(1 - 10 / 15), 12);
		expect(weights.has(2)).toBe(false);
		expect(weights.has(8)).toBe(false);
	});

	test("a disjoint selection blends its gap by distance to the nearest selected side", () => {
		const weights = featherWeights(frames, [2, 8], 35);
		// frame 4 sits 20ms from frame 2 and 40ms from frame 8: nearest is 2
		expect(weights.get(4)).toBeCloseTo(smoothstep01(1 - 20 / 35), 12);
		// frame 5 is 30ms from both sides
		expect(weights.get(5)).toBeCloseTo(smoothstep01(1 - 30 / 35), 12);
		// the gap interior never reaches zero while inside the window
		expect(weights.get(5)!).toBeGreaterThan(0);
	});

	test("feather 0 weighs only the selected frames", () => {
		const weights = featherWeights(frames, [3, 4], 0);
		expect([...weights.keys()].sort((a, b) => a - b)).toEqual([3, 4]);
	});

	test("an unselected frame sharing a selected time moves fully", () => {
		const tied = [frame(0, 0, 0), frame(10, 10, 0), frame(10, 11, 0), frame(20, 20, 0)];
		const weights = featherWeights(tied, [1], 5);
		expect(weights.get(2)).toBe(1);
	});
});

describe("featherMoveOps", () => {
	test("feather 0 moves exactly the selected frames by the translation", () => {
		const ops = featherMoveOps(frames, [4, 5], 7, -3, 0, null, false);
		const moves = movesOf(ops);
		expect([...moves.keys()].sort((a, b) => a - b)).toEqual([4, 5]);
		expect(moves.get(4)).toEqual({ x: Math.fround(140 + 7), y: Math.fround(97) });
	});

	test("feathered frames move by their weighted fraction", () => {
		const ops = featherMoveOps(frames, [5], 20, 0, 25, null, false);
		const moves = movesOf(ops);
		const w = smoothstep01(1 - 10 / 25);
		expect(moves.get(4)!.x).toBeCloseTo(Math.fround(140 + 20 * w), 5);
		expect(moves.get(6)!.x).toBeCloseTo(Math.fround(160 + 20 * w), 5);
		// beyond the window: not in the batch at all
		expect(moves.has(2)).toBe(false);
	});

	test("snap lands both fully-moved and feathered frames on the lattice", () => {
		const lattice: Lattice = { scale: 2, step: 0.5, conformance: 1 };
		const ops = featherMoveOps(frames, [5], 0.35, 0.2, 25, lattice, true);
		const moves = movesOf(ops);
		for (const move of moves.values()) {
			expect(Math.abs(move.x / 0.5 - Math.round(move.x / 0.5))).toBeLessThan(1e-3);
			expect(Math.abs(move.y / 0.5 - Math.round(move.y / 0.5))).toBeLessThan(1e-3);
		}
	});

	test("snap off leaves the raw translation, f32-truncated to the wire", () => {
		const ops = featherMoveOps(frames, [5], 0.1, 0, 0, { scale: 2, step: 0.5, conformance: 1 }, false);
		const moves = movesOf(ops);
		expect(moves.get(5)!.x).toBe(Math.fround(150.1));
	});

	test("a zero translation (or all-identity after snap) is null: nothing to send", () => {
		expect(featherMoveOps(frames, [4, 5], 0, 0, 40, null, false)).toBeNull();
		// a sub-step nudge that snaps back onto the same lattice points
		const lattice: Lattice = { scale: 2, step: 0.5, conformance: 1 };
		expect(featherMoveOps(frames, [4], 0.05, 0.05, 0, lattice, true)).toBeNull();
	});

	test("empty targets are null", () => {
		expect(featherMoveOps(frames, [], 10, 10, 40, null, false)).toBeNull();
	});
});
