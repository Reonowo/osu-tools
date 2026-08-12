import { describe, expect, test } from "bun:test";
import {
	formatLatticeStep,
	inferLattice,
	isOnLattice,
	MAX_SUMMARY_RUNS,
	summarizeOffLattice,
	type Lattice
} from "./lattice";
import type { FrameDto } from "./scene-types";

/** frames quantised to 1/scale osu!px, as a real client emits them */
function quantised(scale: number, count: number): FrameDto[] {
	return Array.from({ length: count }, (_, i) => ({
		time: i * 16,
		x: Math.round((100 + i * 1.7) * scale) / scale,
		y: Math.round((80 + i * 0.9) * scale) / scale,
		buttons: 0
	}));
}

describe("inferLattice", () => {
	test("recovers scale 2.25 (1080p fullscreen) from quantised frames", () => {
		const lattice = inferLattice(quantised(2.25, 400));
		expect(lattice).not.toBeNull();
		expect(lattice!.scale).toBeCloseTo(2.25, 6);
		expect(lattice!.step).toBeCloseTo(4 / 9, 6);
		expect(lattice!.conformance).toBeGreaterThan(0.99);
	});

	test("recovers scale 1.5 (720p) too", () => {
		const lattice = inferLattice(quantised(1.5, 400));
		expect(lattice!.scale).toBeCloseTo(1.5, 6);
	});

	test("tolerates a minority of off-lattice frames and reports conformance", () => {
		const frames = quantised(2.25, 400);
		for (let i = 0; i < 20; i++) frames[i * 7].x += 0.031;
		const lattice = inferLattice(frames)!;
		expect(lattice.scale).toBeCloseTo(2.25, 6);
		expect(lattice.conformance).toBeLessThan(1);
		expect(lattice.conformance).toBeGreaterThan(0.9);
	});

	test("returns null when no candidate scale explains the frames", () => {
		const frames: FrameDto[] = Array.from({ length: 300 }, (_, i) => ({
			time: i * 16,
			x: Math.sin(i) * 173.31337,
			y: Math.cos(i) * 91.77771,
			buttons: 0
		}));
		expect(inferLattice(frames)).toBeNull();
	});

	test("returns null for too few frames to infer anything from", () => {
		expect(inferLattice(quantised(2.25, 4))).toBeNull();
	});
});

describe("isOnLattice", () => {
	test("accepts exact multiples and rejects values between them", () => {
		const step = 4 / 9;
		expect(isOnLattice(step * 12, step)).toBe(true);
		expect(isOnLattice(step * 12 + step / 2, step)).toBe(false);
	});

	test("absorbs float32 round-trip noise", () => {
		const step = 4 / 9;
		expect(isOnLattice(Math.fround(step * 173), step)).toBe(true);
	});
});

describe("formatLatticeStep", () => {
	test("names the step as the rational it is", () => {
		expect(formatLatticeStep({ scale: 2.25, step: 4 / 9, conformance: 1 })).toBe("4/9 px");
		expect(formatLatticeStep({ scale: 1.5, step: 2 / 3, conformance: 1 })).toBe("2/3 px");
		expect(formatLatticeStep({ scale: 1, step: 1, conformance: 1 })).toBe("1 px");
	});
});

describe("summarizeOffLattice", () => {
	const lattice: Lattice = { scale: 2, step: 0.5, conformance: 1 };

	/** frames on the scale-2 lattice, with the given indices knocked off it */
	function framesWithOffIndices(count: number, offX: number[], offY: number[] = []): FrameDto[] {
		const frames = Array.from({ length: count }, (_, i) => ({
			time: i * 16,
			x: i * 0.5,
			y: (i % 7) * 0.5,
			buttons: 0
		}));
		for (const i of offX) frames[i] = { ...frames[i], x: frames[i].x + 0.137 };
		for (const i of offY) frames[i] = { ...frames[i], y: frames[i].y + 0.137 };
		return frames;
	}

	test("a null lattice yields null, never an empty summary", () => {
		expect(summarizeOffLattice(framesWithOffIndices(10, []), null)).toBeNull();
	});

	test("a fully conformant stream summarises to zero runs", () => {
		const summary = summarizeOffLattice(framesWithOffIndices(40, []), lattice)!;
		expect(summary.runCount).toBe(0);
		expect(summary.offLatticeFrames).toBe(0);
		expect(summary.longestRuns).toEqual([]);
	});

	test("maximal contiguous ranges become runs with index and time spans", () => {
		const summary = summarizeOffLattice(framesWithOffIndices(40, [5, 6, 7, 20]), lattice)!;
		expect(summary.runCount).toBe(2);
		expect(summary.offLatticeFrames).toBe(4);
		// longest first, spans in both frame indices and milliseconds
		expect(summary.longestRuns).toEqual([
			{ startIndex: 5, endIndex: 7, startTime: 80, endTime: 112 },
			{ startIndex: 20, endIndex: 20, startTime: 320, endTime: 320 }
		]);
	});

	test("either axis alone puts a frame off the lattice", () => {
		const summary = summarizeOffLattice(framesWithOffIndices(40, [3], [10]), lattice)!;
		expect(summary.runCount).toBe(2);
		expect(summary.longestRuns.map((r) => r.startIndex)).toEqual([3, 10]);
	});

	test("edge runs at the stream's ends are closed correctly", () => {
		const summary = summarizeOffLattice(framesWithOffIndices(10, [0, 1, 8, 9]), lattice)!;
		expect(summary.runCount).toBe(2);
		expect(summary.longestRuns).toEqual([
			{ startIndex: 0, endIndex: 1, startTime: 0, endTime: 16 },
			{ startIndex: 8, endIndex: 9, startTime: 128, endTime: 144 }
		]);
	});

	test("adjacent off frames merge with no gap tolerance splitting them", () => {
		// a single on-lattice frame between two off frames splits the run
		const summary = summarizeOffLattice(framesWithOffIndices(10, [4, 6]), lattice)!;
		expect(summary.runCount).toBe(2);
	});

	test("the tolerance boundary matches the on-lattice predicate exactly", () => {
		const frames = framesWithOffIndices(40, []);
		// clearly inside the tolerance: on-lattice
		frames[5] = { ...frames[5], x: 2.5 + 0.5 * 5e-4 };
		expect(summarizeOffLattice(frames, lattice)!.runCount).toBe(0);
		// clearly past it: off
		frames[5] = { ...frames[5], x: 2.5 + 0.5 * 3e-3 };
		expect(summarizeOffLattice(frames, lattice)!.runCount).toBe(1);
		// and at the fuzzy boundary itself, detection agrees with the
		// predicate it is defined by -- the same call, the same answer
		const boundary = 2.5 + 0.5 * 1e-3;
		frames[5] = { ...frames[5], x: boundary };
		expect(summarizeOffLattice(frames, lattice)!.runCount).toBe(isOnLattice(boundary, lattice.step) ? 0 : 1);
	});

	test("counts stay exact past the stored-run cap, keeping the longest", () => {
		// eleven runs: one three-frame run among ten singles
		const offIndices = [2, 3, 4, ...Array.from({ length: 10 }, (_, i) => 10 + i * 2)];
		const summary = summarizeOffLattice(framesWithOffIndices(60, offIndices), lattice)!;
		expect(summary.runCount).toBe(11);
		expect(summary.offLatticeFrames).toBe(13);
		expect(summary.longestRuns).toHaveLength(MAX_SUMMARY_RUNS);
		expect(summary.longestRuns[0]).toMatchObject({ startIndex: 2, endIndex: 4 });
	});
});
