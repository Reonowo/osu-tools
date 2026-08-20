import { describe, expect, test } from "bun:test";
import { DENSITY_BUCKETS, type DensityBucket } from "./playfield";
import {
	bakedTextureSize,
	bucketedKey,
	bucketOfKey,
	currentDensityBucket,
	dropAccentBakes,
	evictStaleBuckets,
	setDensityBucket
} from "./textures";

// canvasTexture itself needs `document.createElement("canvas")` and a gpu
// upload, neither of which bun test has (see slider/body.test.ts's note) --
// what is testable here is every decision it makes before touching either:
// which bucket, what canvas size, which cache key, and what gets evicted

describe("bake sizing", () => {
	test("canvas pixels are the logical osu!px size times the bucket", () => {
		expect(bakedTextureSize(128, 2).canvasPx).toBe(256);
		expect(bakedTextureSize(128, 4).canvasPx).toBe(512);
		expect(bakedTextureSize(12, 6)).toEqual({ canvasPx: 72, scale: 6 });
	});

	test("the canvas side is always an exact multiple of the sampling factor", () => {
		// pixi recovers the logical size by dividing the canvas by the source
		// resolution and multiplies it back out to check the canvas' own
		// dimensions; a side that does not survive that round trip gets
		// reassigned, which blanks everything drawn on it
		for (const logical of [11.2, 12, 28, 45.6, 51.2, 110.34, 128, 217.6]) {
			for (const bucket of DENSITY_BUCKETS) {
				const { canvasPx, scale } = bakedTextureSize(logical, bucket);
				expect(Number.isInteger(canvasPx)).toBe(true);
				expect(canvasPx % scale).toBe(0);
				expect((canvasPx / scale) * scale).toBe(canvasPx);
			}
		}
	});

	test("a fractional logical size rounds up, never down into softness", () => {
		expect(bakedTextureSize(217.6, 2)).toEqual({ canvasPx: 436, scale: 2 });
		expect(bakedTextureSize(11.2, 3)).toEqual({ canvasPx: 36, scale: 3 });
	});

	test("the dimension budget lowers the factor instead of the bake overflowing it", () => {
		// 218 osu!px (the hit circle's flash glow) cannot take the top buckets
		expect(bakedTextureSize(217.6, 8).canvasPx).toBeLessThanOrEqual(1024);
		expect(bakedTextureSize(217.6, 8).scale).toBe(4);
		expect(bakedTextureSize(217.6, 6).scale).toBe(4);
		// the 128px hit circle lands exactly on the budget at the top bucket
		expect(bakedTextureSize(128, 8)).toEqual({ canvasPx: 1024, scale: 8 });
	});

	test("an explicit cap (the approach circle's) binds ahead of the global budget", () => {
		expect(bakedTextureSize(128, 2, 512)).toEqual({ canvasPx: 256, scale: 2 });
		expect(bakedTextureSize(128, 4, 512)).toEqual({ canvasPx: 512, scale: 4 });
		expect(bakedTextureSize(128, 8, 512)).toEqual({ canvasPx: 512, scale: 4 });
	});

	test("a logical size past the cap still bakes at 1:1 rather than collapsing", () => {
		expect(bakedTextureSize(2000, 8)).toEqual({ canvasPx: 2000, scale: 1 });
		expect(bakedTextureSize(Number.NaN, 4)).toEqual({ canvasPx: 4, scale: 4 });
	});
});

describe("density-scoped cache keys", () => {
	test("the same shape at two buckets is two keys", () => {
		expect(bucketedKey("circle:128", 4)).toBe("circle:128:b4");
		expect(bucketedKey("ring:128:4.41", 2)).toBe("ring:128:4.41:b2");
		expect(bucketedKey("circle:128", 4)).not.toBe(bucketedKey("circle:128", 6));
	});

	test("the bucket reads back off the key, which is what eviction runs on", () => {
		for (const bucket of DENSITY_BUCKETS) {
			expect(bucketOfKey(bucketedKey("grad:ff00ff:110.34", bucket))).toBe(bucket);
		}
		// a shape key with its own trailing numbers must not be mistaken for one
		expect(bucketOfKey("glow:217.6:0.294")).toBe(null);
	});
});

describe("bucket eviction", () => {
	const fakeCache = (keys: string[]) => new Map(keys.map((key) => [key, { key }]));

	test("keeps the current and previous bucket, drops everything older", () => {
		const entries = fakeCache(["circle:128:b2", "ring:128:6:b3", "circle:128:b4", "approach:b4"]);
		evictStaleBuckets(entries, [4, 3]);

		expect([...entries.keys()]).toEqual(["ring:128:6:b3", "circle:128:b4", "approach:b4"]);
	});

	test("a dropped texture is never handed out again, and is left for pixi's gc to reclaim", () => {
		// destroying it here would strand a per-object drawable that is still on
		// screen from two buckets ago -- pixi's destroy() nulls the source's
		// resource and the next upload of that sprite throws
		const texture = { destroy: () => expect.unreachable("an evicted texture must not be destroyed") };
		const entries = new Map([["circle:128:b2", texture]]);
		evictStaleBuckets(entries, [6, 4]);

		expect(entries.size).toBe(0);
	});

	test("an unkeyed entry is dropped rather than kept forever", () => {
		const entries = fakeCache(["legacy-key-without-a-bucket"]);
		evictStaleBuckets(entries, [2]);

		expect(entries.size).toBe(0);
	});

	test("deleting while iterating still visits every entry", () => {
		const entries = fakeCache(["a:b2", "b:b2", "c:b2", "d:b4", "e:b2"]);
		evictStaleBuckets(entries, [4]);

		expect([...entries.keys()]).toEqual(["d:b4"]);
	});
});

describe("setDensityBucket", () => {
	// module-level state: restore whatever the bucket was so test order cannot
	// leak a bucket into another file's expectations
	function withBucket(run: () => void): void {
		const before = currentDensityBucket();
		try {
			run();
		} finally {
			setDensityBucket(before);
		}
	}

	test("reports whether the bucket actually moved -- the caller's rebuild cue", () => {
		withBucket(() => {
			const start = currentDensityBucket();
			const other: DensityBucket = start === 8 ? 6 : 8;

			expect(setDensityBucket(start)).toBe(false);
			expect(setDensityBucket(other)).toBe(true);
			expect(currentDensityBucket()).toBe(other);
			expect(setDensityBucket(other)).toBe(false);
		});
	});
});

describe("dropAccentBakes", () => {
	test("drops every accent-derived bake and nothing else", () => {
		// the accent is baked INTO the key and the accent is a skin decision, so
		// a skin swap kills these whatever bucket they sit at -- which is exactly
		// what bucket eviction cannot express
		const entries = new Map<string, number>([
			["grad:outer:ff8800ff:116:b4", 1],
			["grad:inner:ff8800ff:64:b4", 2],
			["grad:ball:0052f1ff:116:b8", 3],
			["circle:128:b4", 4],
			["ring:128:6:b4", 5],
			["glow:128:0.5:b8", 6]
		]);
		dropAccentBakes(entries);
		expect([...entries.keys()].sort()).toEqual(["circle:128:b4", "glow:128:0.5:b8", "ring:128:6:b4"]);
	});

	test("is a no-op when nothing accent-derived is cached", () => {
		const entries = new Map<string, number>([["circle:128:b4", 1]]);
		dropAccentBakes(entries);
		expect(entries.size).toBe(1);
	});
});
