import { describe, expect, test } from "bun:test";
import type { FrameDto } from "../../lib/scene-types";
import { buildTrailPath, legacyTrailShape, trailAlpha, trailPartsAt, type TrailShape } from "./trail-parts";

const frame = (time: number, x: number, y = 100): FrameDto => ({ time, x, y, buttons: 0 });

/** round numbers instead of the argon constants: 2.5 osu!px per ms along a
 * straight line, a part every 10 osu!px, a 100ms fade */
/** the argon exponent and base, so the alpha assertions below keep pinning the
 * numbers they always did; the two eras disagree on both */
function shape(spawn: TrailShape["spawn"], fadeDuration: number, maxParts: number): TrailShape {
	return { spawn, fadeDuration, fadeExponent: 4, baseAlpha: 0.8, maxParts };
}

const SHAPE: TrailShape = shape({ by: "distance", interval: 10 }, 100, 64);
const straight = Array.from({ length: 21 }, (_, i) => frame(i * 16, i * 40));

describe("trail parts, the path", () => {
	test("parts sit on the cursor's own path, one interval apart, newest last", () => {
		const parts = trailPartsAt(buildTrailPath(straight), 160, SHAPE);

		// the window is the 100ms behind t=160: the cursor was at x=150 then and
		// x=400 now, so the lattice points strictly inside are 160..390
		expect(parts.map((p) => p.x)).toEqual(Array.from({ length: 24 }, (_, i) => 160 + i * 10));
		for (const part of parts) expect(part.y).toBe(100);
		// 2.5 osu!px per ms, so a part at x is a part the cursor reached at x/2.5
		for (const part of parts) expect(part.bornAt).toBeCloseTo(part.x / 2.5, 9);
	});

	test("a part lands where the cursor genuinely was, mid-segment included", () => {
		// 100 osu!px per frame with a 10 osu!px interval puts nine parts inside
		// every segment, none of them on a frame
		const path = buildTrailPath([frame(0, 0), frame(50, 100), frame(100, 200)]);
		const parts = trailPartsAt(path, 100, shape({ by: "distance", interval: 10 }, 1000, 64));
		expect(parts.map((p) => p.x)).toEqual(Array.from({ length: 19 }, (_, i) => 10 + i * 10));
		// 2 osu!px per ms across both segments
		for (const part of parts) expect(part.bornAt).toBeCloseTo(part.x / 2, 9);
	});

	test("a turn is traced round rather than cut across", () => {
		// out along x, back along y: a part at arc length 150 is 50 osu!px up the
		// second leg, not 150 osu!px along the straight line between the ends
		const path = buildTrailPath([frame(0, 0, 0), frame(100, 100, 0), frame(200, 100, 100)]);
		const parts = trailPartsAt(path, 200, shape({ by: "distance", interval: 50 }, 1000, 64));
		expect(parts).toHaveLength(3);
		expect(parts.map((p) => [p.x, p.y])).toEqual([
			[50, 0],
			[100, 0],
			[100, 50]
		]);
	});

	test("the lattice is anchored at the replay's start, so parts hold still as the window slides", () => {
		const path = buildTrailPath(straight);
		// two neighbouring times whose fade windows start on either side of a
		// frame: every part they share must have the identical position, or the
		// trail would shimmer by up to an interval each time a frame left it
		const before = trailPartsAt(path, 160, SHAPE);
		const after = trailPartsAt(path, 163, SHAPE);
		const shared = new Set(after.map((p) => p.x));
		const overlap = before.filter((p) => shared.has(p.x));
		expect(overlap.length).toBeGreaterThan(0);
		for (const part of overlap) {
			const match = after.find((p) => p.x === part.x)!;
			expect(match.bornAt).toBeCloseTo(part.bornAt, 9);
		}
	});
});

describe("trail parts, the fade window", () => {
	test("each part carries the alpha its age has earned", () => {
		const parts = trailPartsAt(buildTrailPath(straight), 160, SHAPE);
		for (const part of parts) expect(part.alpha).toBeCloseTo(trailAlpha((160 - part.bornAt) / 100, SHAPE), 12);
		// the newest part is the brightest and the oldest the dimmest, both
		// strictly inside the window
		expect(parts[parts.length - 1].alpha).toBeGreaterThan(parts[0].alpha);
		expect(parts[0].alpha).toBeGreaterThan(0);
	});

	test("nothing older than the fade duration survives, and nothing sits on the cursor", () => {
		const parts = trailPartsAt(buildTrailPath(straight), 160, SHAPE);
		for (const part of parts) {
			expect(part.bornAt).toBeGreaterThan(60);
			expect(part.bornAt).toBeLessThan(160);
		}
	});

	test("a stationary cursor sheds its trail and then has none", () => {
		const path = buildTrailPath([frame(0, 0), frame(100, 250), frame(1000, 250)]);
		const stationary = shape({ by: "distance", interval: 10 }, 100, 64);
		expect(trailPartsAt(path, 150, stationary).length).toBeGreaterThan(0);
		expect(trailPartsAt(path, 250, stationary)).toEqual([]);
	});

	test("the cap keeps the newest parts, not the oldest", () => {
		const path = buildTrailPath(straight);
		const uncapped = trailPartsAt(path, 160, SHAPE);
		const capped = trailPartsAt(path, 160, { ...SHAPE, maxParts: 5 });
		expect(capped).toEqual(uncapped.slice(-5));
	});
});

describe("trail parts, rebuild and seek equivalence", () => {
	test("the same frames and time always give the same parts", () => {
		const path = buildTrailPath(straight);
		expect(trailPartsAt(path, 160, SHAPE)).toEqual(trailPartsAt(path, 160, SHAPE));
		// and a path rebuilt from the same frames -- what a density rebake does
		// to the cursor drawable -- is indistinguishable from the original
		expect(trailPartsAt(buildTrailPath(straight), 160, SHAPE)).toEqual(trailPartsAt(path, 160, SHAPE));
	});

	test("computing cold at t equals having been called every step of the way there", () => {
		const path = buildTrailPath(straight);
		const cold = trailPartsAt(path, 250, SHAPE);
		for (let t = 0; t <= 250; t += 4) trailPartsAt(path, t, SHAPE);
		expect(trailPartsAt(path, 250, SHAPE)).toEqual(cold);
	});

	test("a paused viewer keeps exactly the trail it was paused with", () => {
		const path = buildTrailPath(straight);
		const paused = trailPartsAt(path, 199, SHAPE);
		expect(trailPartsAt(path, 199, SHAPE)).toEqual(paused);
		expect(paused.length).toBeGreaterThan(0);
	});

	test("a backward seek draws the destination's own trail, never a line across the screen", () => {
		const path = buildTrailPath(straight);
		trailPartsAt(path, 300, SHAPE);
		const seeked = trailPartsAt(path, 100, SHAPE);
		// the cursor is at x=250 at t=100; every part trails it within the fade
		// window, and none is left behind from the x=750 the seek jumped from
		expect(seeked.map((p) => p.x)).toEqual(Array.from({ length: 24 }, (_, i) => 10 + i * 10));
		expect(seeked).toEqual(trailPartsAt(buildTrailPath(straight), 100, SHAPE));
	});

	test("a large forward seek is the same story", () => {
		const path = buildTrailPath(straight);
		trailPartsAt(path, 20, SHAPE);
		const seeked = trailPartsAt(path, 300, SHAPE);
		for (const part of seeked) expect(part.bornAt).toBeGreaterThan(200);
	});
});

describe("trail parts, degenerate frame streams", () => {
	test("no frames at all yield no parts", () => {
		expect(trailPartsAt(buildTrailPath([]), 0, SHAPE)).toEqual([]);
	});

	test("a single frame has no path to spawn along", () => {
		expect(trailPartsAt(buildTrailPath([frame(0, 0)]), 0, SHAPE)).toEqual([]);
		expect(trailPartsAt(buildTrailPath([frame(0, 0)]), 5000, SHAPE)).toEqual([]);
	});

	test("movement under one interval spawns nothing", () => {
		const path = buildTrailPath([frame(0, 0), frame(16, 9)]);
		expect(trailPartsAt(path, 16, SHAPE)).toEqual([]);
	});

	test("before the first frame and long after the last, the trail is empty", () => {
		const path = buildTrailPath(straight);
		expect(trailPartsAt(path, -1000, SHAPE)).toEqual([]);
		expect(trailPartsAt(path, 5000, SHAPE)).toEqual([]);
	});

	test("a duplicate-time frame run neither divides by zero nor drops the parts around it", () => {
		// the shape interpolation.ts already treats as real input: two frames
		// sharing one timestamp
		const path = buildTrailPath([frame(0, 0), frame(50, 100), frame(50, 140), frame(100, 240)]);
		const parts = trailPartsAt(path, 100, shape({ by: "distance", interval: 20 }, 1000, 64));
		expect(parts.map((p) => p.x)).toEqual([20, 40, 60, 80, 100, 120, 140, 160, 180, 200, 220]);
		for (const part of parts) expect(Number.isFinite(part.bornAt)).toBe(true);
	});
});

describe("trail fade alpha (argoncursortrail.cs:16,26 -- 0.8 * clamp(1-age,0,1)^4)", () => {
	test("a fresh part renders at the base alpha", () => {
		expect(trailAlpha(0, SHAPE)).toBe(0.8);
	});

	test("a part halfway through its fade is dimmed by the fourth power, not linearly", () => {
		expect(trailAlpha(0.5, SHAPE)).toBeCloseTo(0.8 * 0.5 ** 4, 10);
		expect(trailAlpha(0.5, SHAPE)).not.toBeCloseTo(0.8 * 0.5, 3);
	});

	test("a fully aged part is invisible, and age past 1 clamps rather than going negative", () => {
		expect(trailAlpha(1, SHAPE)).toBe(0);
		expect(trailAlpha(1.5, SHAPE)).toBe(0);
	});
});

describe("a disjoint trail spawns by time, not by distance", () => {
	const disjoint = shape({ by: "time", separation: 20 }, 100, 64);

	test("a part sits at every tick inside the fade window", () => {
		const path = buildTrailPath(straight);
		const parts = trailPartsAt(path, 200, disjoint);
		// ticks strictly inside (100, 200]: 120, 140, 160, 180 -- and the open
		// interval keeps 200 itself off, since nothing spawns on the cursor
		expect(parts.map((p) => p.bornAt)).toEqual([120, 140, 160, 180]);
	});

	test("a stationary cursor keeps its trail rather than shedding it", () => {
		// the whole difference from the distance trail, and the reason lazer
		// picks between them: a cursor that stops still stacks parts on the spot
		const path = buildTrailPath([frame(0, 250), frame(1000, 250)]);
		const parts = trailPartsAt(path, 500, disjoint);
		// ticks strictly inside (400, 500]: 420, 440, 460, 480
		expect(parts.length).toBe(4);
		for (const part of parts) expect(part.x).toBe(250);
	});

	test("the cap keeps the newest ticks", () => {
		const path = buildTrailPath(straight);
		const capped = shape({ by: "time", separation: 1 }, 1000, 8);
		const parts = trailPartsAt(path, 300, capped);
		expect(parts).toHaveLength(8);
		expect(parts[parts.length - 1].bornAt).toBe(299);
	});

	test("the fade is linear at exponent 1 rather than argon's fourth power", () => {
		const legacy = { fadeExponent: 1, baseAlpha: 1 };
		expect(trailAlpha(0.5, legacy)).toBeCloseTo(0.5, 9);
		expect(trailAlpha(0.5, SHAPE)).toBeCloseTo(0.8 * 0.5 ** 4, 9);
	});
});

describe("the legacy trail shape", () => {
	test("a connected trail spaces parts by the texture's own width", () => {
		// cursortrail.cs:201 -- interval = DisplayWidth / 2.5 at cursor scale 1
		expect(legacyTrailShape(10, false)).toMatchObject({ spawn: { by: "distance", interval: 4 } });
	});

	test("disjointness picks both the spawn rule and the fade length", () => {
		expect(legacyTrailShape(10, true)).toMatchObject({
			spawn: { by: "time", separation: 1000 / 60 },
			fadeDuration: 150
		});
		expect(legacyTrailShape(10, false).fadeDuration).toBe(500);
	});
});
