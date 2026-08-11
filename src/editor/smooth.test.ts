import { describe, expect, test } from "bun:test";
import type { FrameDto } from "../lib/scene-types";
import type { Lattice } from "../lib/lattice";
import { SMOOTH_SIGMA_MS, SMOOTH_WINDOW_MS, smoothMoveOps } from "./smooth";

function frame(time: number, x: number, y: number): FrameDto {
	return { time, x, y, buttons: 0 };
}

function movesOf(ops: ReturnType<typeof smoothMoveOps>): Map<number, { x: number; y: number }> {
	const map = new Map<number, { x: number; y: number }>();
	if (ops === null) return map;
	for (const op of ops) {
		if (op.kind === "moveFrames") for (const m of op.moves) map.set(m.index, { x: m.x, y: m.y });
	}
	return map;
}

/** the pinned kernel by hand: gaussian weights over the frames within the
 * window, renormalized over the samples present, in f64 */
function expectedSmoothed(frames: readonly FrameDto[], index: number): { x: number; y: number } {
	const centre = frames[index].time;
	let sum = 0;
	let x = 0;
	let y = 0;
	for (const f of frames) {
		const dt = f.time - centre;
		if (Math.abs(dt) > SMOOTH_WINDOW_MS) continue;
		const w = Math.exp(-(dt * dt) / (2 * SMOOTH_SIGMA_MS * SMOOTH_SIGMA_MS));
		sum += w;
		x += w * f.x;
		y += w * f.y;
	}
	return { x: x / sum, y: y / sum };
}

describe("the pinned kernel", () => {
	test("the constants are the design spec's", () => {
		expect(SMOOTH_SIGMA_MS).toBe(16);
		expect(SMOOTH_WINDOW_MS).toBe(48);
	});

	// a spiky middle frame between straight neighbours, 16ms apart
	const spiky = [
		frame(0, 100, 100),
		frame(16, 116, 100),
		frame(32, 132, 160), // the spike
		frame(48, 148, 100),
		frame(64, 164, 100)
	];

	test("a full-strength smooth writes the renormalized gaussian average, f32-truncated", () => {
		const moves = movesOf(smoothMoveOps(spiky, [2], 100, null, false));
		const expected = expectedSmoothed(spiky, 2);
		expect(moves.get(2)!.x).toBe(Math.fround(expected.x));
		expect(moves.get(2)!.y).toBe(Math.fround(expected.y));
	});

	test("every frame inside the window contributes; outputs land only on the targets", () => {
		const moves = movesOf(smoothMoveOps(spiky, [2], 100, null, false));
		expect([...moves.keys()]).toEqual([2]);
		// the spike pulls its neighbours' influence in: the smoothed y sits
		// strictly between the flat 100 and the spike 160
		expect(moves.get(2)!.y).toBeGreaterThan(100);
		expect(moves.get(2)!.y).toBeLessThan(160);
	});

	test("frames beyond the ±48ms window do not contribute", () => {
		const withFar = [...spiky, frame(32 + SMOOTH_WINDOW_MS + 1, 9999, 9999)];
		const withoutFar = movesOf(smoothMoveOps(spiky, [2], 100, null, false));
		const withFarMoves = movesOf(smoothMoveOps(withFar, [2], 100, null, false));
		expect(withFarMoves.get(2)).toEqual(withoutFar.get(2)!);
	});

	test("a frame exactly at the window edge still contributes", () => {
		const atEdge = [frame(0, 0, 0), frame(SMOOTH_WINDOW_MS, 480, 0)];
		const moves = movesOf(smoothMoveOps(atEdge, [0], 100, null, false));
		expect(moves.get(0)!.x).toBeGreaterThan(0);
	});

	test("a stream boundary clips the window and renormalizes over what is present", () => {
		const short = [frame(0, 100, 200), frame(16, 132, 100)];
		const moves = movesOf(smoothMoveOps(short, [0], 100, null, false));
		const expected = expectedSmoothed(short, 0);
		expect(moves.get(0)!.x).toBe(Math.fround(expected.x));
		expect(moves.get(0)!.y).toBe(Math.fround(expected.y));
	});

	test("duplicate-time frames each contribute and are each smoothed", () => {
		const tied = [frame(0, 100, 100), frame(16, 120, 100), frame(16, 120, 140), frame(32, 140, 100)];
		const moves = movesOf(smoothMoveOps(tied, [1, 2], 100, null, false));
		expect(moves.has(1)).toBe(true);
		expect(moves.has(2)).toBe(true);
		// both tied frames see the same window, so both smooth to the same point
		expect(moves.get(1)).toEqual(moves.get(2)!);
	});
});

describe("strength", () => {
	const spiky = [frame(0, 100, 100), frame(16, 116, 160), frame(32, 132, 100)];

	test("strength 0 is an identity and commits nothing", () => {
		expect(smoothMoveOps(spiky, [1], 0, null, false)).toBeNull();
	});

	test("strength blends original toward smoothed", () => {
		const full = movesOf(smoothMoveOps(spiky, [1], 100, null, false)).get(1)!;
		const half = movesOf(smoothMoveOps(spiky, [1], 50, null, false)).get(1)!;
		expect(half.y).toBeCloseTo((160 + full.y) / 2, 4);
	});
});

describe("snap and identity", () => {
	const lattice: Lattice = { scale: 2, step: 0.5, conformance: 1 };
	const spiky = [frame(0, 100, 100), frame(16, 116, 160.3), frame(32, 132, 100)];

	test("snap applies after the blend when the preference is on", () => {
		const moves = movesOf(smoothMoveOps(spiky, [1], 100, lattice, true));
		const move = moves.get(1)!;
		expect(Math.abs(move.x / 0.5 - Math.round(move.x / 0.5))).toBeLessThan(1e-3);
		expect(Math.abs(move.y / 0.5 - Math.round(move.y / 0.5))).toBeLessThan(1e-3);
	});

	test("an already-smooth run is an identity and commits nothing", () => {
		// an evenly-spaced straight run is symmetric about every interior
		// frame, so the gaussian average reproduces it exactly
		const straight = [frame(0, 100, 100), frame(16, 116, 100), frame(32, 132, 100)];
		expect(smoothMoveOps(straight, [1], 100, null, false)).toBeNull();
		// break the symmetry and the same call moves the frame
		const bent = [frame(0, 100, 100), frame(16, 116, 100), frame(32, 200, 100)];
		expect(smoothMoveOps(bent, [1], 100, null, false)).not.toBeNull();
	});

	test("empty targets are null", () => {
		expect(smoothMoveOps(spiky, [], 100, null, false)).toBeNull();
	});
});
