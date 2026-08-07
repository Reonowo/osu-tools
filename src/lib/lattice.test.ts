import { describe, expect, test } from "bun:test";
import { formatLatticeStep, inferLattice, isOnLattice } from "./lattice";
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
