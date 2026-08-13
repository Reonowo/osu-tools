import { describe, expect, test } from "bun:test";
import {
	ActiveSetTracker,
	anchoredZoomPan,
	clampViewportPan,
	clampViewportZoom,
	densityBucket,
	DENSITY_BUCKETS,
	maxViewportPan,
	NO_VIEWPORT_PAN,
	objectLifetime,
	playfieldTransform,
	reconcileActiveDrawables,
	steppedViewportZoom,
	textureDensity,
	viewportPointToPlayfield,
	viewportTransform,
	VIEWPORT_LEASH_PX,
	VIEWPORT_ZOOM_MAX,
	VIEWPORT_ZOOM_MIN,
	wheelZoomFactor
} from "./playfield";

describe("playfield fit (osuplayfieldadjustmentcontainer.cs)", () => {
	test("the reference 1024x768 target yields the stable magic 1.6 scale", () => {
		const t = playfieldTransform(1024, 768);
		expect(t.scale).toBeCloseTo(1.6, 9);
		expect(t.offsetX).toBeCloseTo((1024 - 512 * 1.6) / 2, 9);
		expect(t.offsetY).toBeCloseTo((768 - 384 * 1.6) / 2, 9);
	});

	test("width-constrained hosts fit by width", () => {
		const t = playfieldTransform(800, 3000);
		// fitW = min(800, 3000 * 4/3) = 800; scale = 800 * 0.8 / 512
		expect(t.scale).toBeCloseTo((800 * 0.8) / 512, 9);
	});

	test("height-constrained hosts fit by height", () => {
		const t = playfieldTransform(3000, 600);
		// fitW = 600 * 4/3 = 800
		expect(t.scale).toBeCloseTo((800 * 0.8) / 512, 9);
	});
});

describe("texture density buckets", () => {
	// the three factors compose multiplicatively: the backing store's ratio,
	// the 4:3 fit's osu!px -> css px scale, and the user's zoom
	const bucketFor = (dpr: number, hostW: number, hostH: number, zoom: number) =>
		densityBucket(textureDensity(dpr, playfieldTransform(hostW, hostH).scale, zoom));

	test("1080p at dpr 1 needs more than the fixed 2x the art used to bake at", () => {
		expect(playfieldTransform(1920, 1080).scale).toBeCloseTo(2.25, 9);
		expect(bucketFor(1, 1920, 1080, 1)).toBe(3);
	});

	test("the same window on a dpr 2 display doubles the requirement", () => {
		expect(bucketFor(2, 1920, 1080, 1)).toBe(6);
	});

	test("zoom multiplies exactly like dpr does", () => {
		expect(bucketFor(1, 1920, 1080, 2)).toBe(6); // 4.5, same as dpr 2 at zoom 1
		expect(bucketFor(1, 1920, 1080, 0.5)).toBe(2); // 1.125
	});

	test("a density past the last bucket clamps rather than baking unbounded", () => {
		expect(textureDensity(2, playfieldTransform(1920, 1080).scale, 4)).toBeCloseTo(18, 9);
		expect(bucketFor(2, 1920, 1080, 4)).toBe(8);
	});

	test("a bucket is chosen only when it covers the density, and the next one down would not", () => {
		// an exact hit takes that bucket rather than the one above
		expect(densityBucket(4)).toBe(4);
		expect(densityBucket(4.0001)).toBe(6);
		for (const density of [0.5, 1, 1.99, 2, 2.5, 3, 3.5, 5.9, 6, 7.5, 8]) {
			const bucket = densityBucket(density);
			expect(bucket).toBeGreaterThanOrEqual(density);
			for (const smaller of DENSITY_BUCKETS.filter((b) => b < bucket)) {
				expect(smaller).toBeLessThan(density);
			}
		}
	});

	test("a degenerate host (zero-size, mid-mount) falls back to the smallest bucket", () => {
		expect(bucketFor(1, 0, 0, 1)).toBe(2);
		expect(densityBucket(Number.NaN)).toBe(2);
	});
});

describe("objectLifetime", () => {
	test("vanish follows a late judgement, not just endTime", () => {
		const circle = { startTime: 1000, preempt: 450, endTime: 1000 };
		expect(objectLifetime(circle, [], 800)).toEqual({ appear: 550, vanish: 1800 });
		// a circle hit 180ms late animates until 1180 + fadeOut
		expect(objectLifetime(circle, [{ time: 1180 }], 800)).toEqual({ appear: 550, vanish: 1980 });
	});

	test("events before endTime never pull vanish earlier", () => {
		const slider = { startTime: 1000, preempt: 450, endTime: 2000 };
		expect(objectLifetime(slider, [{ time: 1500 }, { time: 2000 }], 800)).toEqual({ appear: 550, vanish: 2800 });
	});
});

describe("active set tracking", () => {
	const entries = [
		{ appear: 0, vanish: 100 },
		{ appear: 50, vanish: 150 },
		{ appear: 200, vanish: 300 }
	];

	test("forward playback adds and removes incrementally", () => {
		const tracker = new ActiveSetTracker(entries);
		expect(tracker.update(0)).toEqual({ added: [0], removed: [] });
		expect(tracker.update(60)).toEqual({ added: [1], removed: [] });
		expect(tracker.update(120)).toEqual({ added: [], removed: [0] });
		expect(tracker.update(250)).toEqual({ added: [2], removed: [1] });
		expect(tracker.update(400)).toEqual({ added: [], removed: [2] });
	});

	test("backward seeks rebuild", () => {
		const tracker = new ActiveSetTracker(entries);
		tracker.update(250);
		const result = tracker.update(60);
		expect(new Set(result.added)).toEqual(new Set([0, 1]));
		expect(result.removed).toEqual([2]);
	});

	test("unsorted entries are handled (sorted internally by appear)", () => {
		const tracker = new ActiveSetTracker([
			{ appear: 100, vanish: 200 },
			{ appear: 0, vanish: 50 }
		]);
		expect(tracker.update(10)).toEqual({ added: [1], removed: [] });
		expect(tracker.update(150)).toEqual({ added: [0], removed: [1] });
	});

	test("zero objects never adds or removes anything, at any t", () => {
		const tracker = new ActiveSetTracker([]);
		expect(tracker.update(-1000)).toEqual({ added: [], removed: [] });
		expect(tracker.update(0)).toEqual({ added: [], removed: [] });
		expect(tracker.update(1e9)).toEqual({ added: [], removed: [] });
		// seeking backward on an empty tracker must not throw (rebuild path with an empty active set)
		expect(tracker.update(-500)).toEqual({ added: [], removed: [] });
	});

	test("a forward query landing after everything has already died reports nothing (never seen alive)", () => {
		// starting a fresh tracker's first query past every entry's vanish time means
		// those entries were never observed alive, so nothing is created to destroy later
		const tracker = new ActiveSetTracker(entries);
		expect(tracker.update(10_000)).toEqual({ added: [], removed: [] });
	});

	test("querying the same t twice is idempotent (no duplicate add/remove)", () => {
		const tracker = new ActiveSetTracker(entries);
		tracker.update(60);
		expect(tracker.update(60)).toEqual({ added: [], removed: [] });
	});

	test("entries sharing identical appear and vanish times are all tracked independently", () => {
		const tied = [
			{ appear: 10, vanish: 20 },
			{ appear: 10, vanish: 20 },
			{ appear: 10, vanish: 20 }
		];
		const tracker = new ActiveSetTracker(tied);
		const onAppear = tracker.update(10);
		expect(new Set(onAppear.added)).toEqual(new Set([0, 1, 2]));
		expect(onAppear.removed).toEqual([]);
		const onVanish = tracker.update(20);
		expect(new Set(onVanish.removed)).toEqual(new Set([0, 1, 2]));
		expect(onVanish.added).toEqual([]);
	});

	test("a zero-length lifetime (appear === vanish) never becomes active", () => {
		const tracker = new ActiveSetTracker([
			{ appear: 5, vanish: 5 },
			{ appear: 0, vanish: 100 }
		]);
		// at t=5 the instant entry (index 0) is consumed by the appear scan but its
		// vanish <= t so it must not appear in `added`; index 1 is still alive
		const result = tracker.update(5);
		expect(result.added).toEqual([1]);
		expect(result.removed).toEqual([]);
		// it also never shows up later as a removal, since it was never added
		expect(tracker.update(200)).toEqual({ added: [], removed: [1] });
	});

	test("an entry alive both before and after a backward seek is reported only in `added`, never `removed`", () => {
		// this is the contract GameplayRenderer.render's bookkeeping must respect (see
		// reconcileActiveDrawables below): a wide-lived entry survives the rebuild without
		// ever leaving `active`, so callers must not treat every `added` index as brand new
		const wide = [
			{ appear: 0, vanish: 1000 }, // index 0: alive across the whole window below
			{ appear: 100, vanish: 200 }, // index 1: dead by t=450, alive again at t=150
			{ appear: 400, vanish: 500 } // index 2: alive at t=450, dead by t=150
		];
		const tracker = new ActiveSetTracker(wide);
		expect(tracker.update(450)).toEqual({ added: [0, 2], removed: [] });
		const result = tracker.update(150); // backward seek
		expect(new Set(result.added)).toEqual(new Set([0, 1]));
		expect(result.removed).toEqual([2]);
		// index 0 never appears in `removed` despite the full active-set rebuild
		expect(result.removed).not.toContain(0);
	});
});

describe("reconcileActiveDrawables (GameplayRenderer.render's map bookkeeping)", () => {
	interface StubDrawable {
		index: number;
		destroyed: boolean;
	}

	function stub(created: number[], destroyed: number[]) {
		return {
			create: (index: number): StubDrawable => {
				created.push(index);
				return { index, destroyed: false };
			},
			destroy: (drawable: StubDrawable): void => {
				drawable.destroyed = true;
				destroyed.push(drawable.index);
			}
		};
	}

	test("added creates, removed destroys, untouched indices are left alone", () => {
		const map = new Map<number, StubDrawable>();
		const created: number[] = [];
		const destroyed: number[] = [];
		const { create, destroy } = stub(created, destroyed);

		reconcileActiveDrawables(map, { added: [0, 1], removed: [] }, create, destroy);
		expect(created).toEqual([0, 1]);
		expect(map.size).toBe(2);

		reconcileActiveDrawables(map, { added: [], removed: [0] }, create, destroy);
		expect(destroyed).toEqual([0]);
		expect(map.has(0)).toBe(false);
		expect(map.has(1)).toBe(true);
	});

	test("a factory returning null (unrenderable kind) never enters the map", () => {
		const map = new Map<number, StubDrawable>();
		reconcileActiveDrawables(
			map,
			{ added: [0], removed: [] },
			() => null,
			() => {
				throw new Error("must not be called");
			}
		);
		expect(map.size).toBe(0);
	});

	test("regression: a backward-seek rebuild reporting an already-alive index in `added` does not leak the old drawable", () => {
		// reproduces the GameplayRenderer.render bug: ActiveSetTracker's backward-seek rebuild
		// reports an index in `added` without a matching `removed` when it was alive both before
		// and after the seek. the old render() blindly created a fresh drawable for every `added`
		// index and overwrote the map entry, leaking the previous drawable's view/GPU resources.
		const map = new Map<number, StubDrawable>();
		const created: number[] = [];
		const destroyed: number[] = [];
		const { create, destroy } = stub(created, destroyed);

		// forward playback reaches t=450: objects 0 and 2 are alive (mirrors the
		// ActiveSetTracker "wide" fixture above)
		reconcileActiveDrawables(map, { added: [0, 2], removed: [] }, create, destroy);
		const originalZero = map.get(0);
		expect(originalZero).toBeDefined();

		// backward seek to t=150: the tracker rebuilds and reports 0 as re-added (still alive,
		// never actually removed) and 1 as newly alive; 2 is genuinely removed
		reconcileActiveDrawables(map, { added: [0, 1], removed: [2] }, create, destroy);

		// index 0 must not have been recreated...
		expect(created).toEqual([0, 2, 1]);
		// ...its original drawable instance must still be the one in the map...
		expect(map.get(0)).toBe(originalZero);
		// ...and it must never have been destroyed
		expect(originalZero?.destroyed).toBe(false);
		expect(destroyed).not.toContain(0);
		// 1 was freshly created, 2 was destroyed and dropped
		expect(map.has(1)).toBe(true);
		expect(destroyed).toEqual([2]);
		expect(map.has(2)).toBe(false);
	});
});

describe("playfield fit edge cases", () => {
	test("a zero-size host collapses to a zero scale without NaN or throwing", () => {
		const t = playfieldTransform(0, 0);
		expect(t.scale).toBe(0);
		expect(t.offsetX).toBe(0);
		expect(t.offsetY).toBe(0);
	});

	test("an extremely wide host stays height-constrained and finite", () => {
		const t = playfieldTransform(1_000_000, 1);
		// fitW = min(1e6, 1 * 4/3) * 0.8 = (4/3) * 0.8
		const expectedScale = ((4 / 3) * 0.8) / 512;
		expect(t.scale).toBeCloseTo(expectedScale, 12);
		expect(Number.isFinite(t.offsetX)).toBe(true);
		expect(Number.isFinite(t.offsetY)).toBe(true);
	});

	test("an extremely tall square host at large magnitude stays finite and centred", () => {
		const t = playfieldTransform(10_000_000, 10_000_000);
		const expectedScale = (10_000_000 * 0.8) / 512;
		expect(t.scale).toBeCloseTo(expectedScale, 3);
		expect(t.offsetX).toBeCloseTo((10_000_000 - 512 * expectedScale) / 2, 3);
		expect(t.offsetY).toBeCloseTo((10_000_000 - 384 * expectedScale) / 2, 3);
	});
});

// a spread wide enough to exercise both fit branches and both extremes of aspect
const HOST_BOXES = [
	{ w: 1024, h: 768 },
	{ w: 1920, h: 1080 },
	{ w: 800, h: 3000 },
	{ w: 3000, h: 600 },
	{ w: 640, h: 481 },
	{ w: 1, h: 1 }
];

/** the osu!px under a host point, which is what a pointer-anchored zoom has
 * to leave alone */
function worldUnder(t: { scale: number; x: number; y: number }, point: { x: number; y: number }) {
	return { x: (point.x - t.x) / t.scale, y: (point.y - t.y) / t.scale };
}

describe("viewportTransform", () => {
	test("zoom 1 with no pan is exactly today's playfield fit", () => {
		// the whole point of the formulation: 100% must not nudge the framing the
		// app has always drawn, so this is exact equality rather than toBeCloseTo
		for (const { w, h } of HOST_BOXES) {
			const fit = playfieldTransform(w, h);
			const t = viewportTransform(w, h, 1, NO_VIEWPORT_PAN);
			expect(t.scale).toBe(fit.scale);
			expect(t.x).toBe(fit.offsetX);
			expect(t.y).toBe(fit.offsetY);
		}
	});

	test("zoom scales about the playfield centre, which stays on the viewport centre", () => {
		const t = viewportTransform(1024, 768, 2.5, NO_VIEWPORT_PAN);
		expect(t.scale).toBeCloseTo(playfieldTransform(1024, 768).scale * 2.5, 12);
		const centre = worldUnder(t, { x: 512, y: 384 });
		expect(centre.x).toBeCloseTo(256, 9);
		expect(centre.y).toBeCloseTo(192, 9);
	});

	test("pan translates in host pixels, one for one, at any zoom", () => {
		for (const zoom of [0.5, 1, 4]) {
			const base = viewportTransform(1280, 720, zoom, NO_VIEWPORT_PAN);
			const panned = viewportTransform(1280, 720, zoom, { x: -37, y: 91 });
			expect(panned.x - base.x).toBe(-37);
			expect(panned.y - base.y).toBe(91);
			expect(panned.scale).toBe(base.scale);
		}
	});
});

describe("screen point <-> playfield point inversion", () => {
	// the forward transform, local to the test: production only needs the
	// inverse (pointer -> osu!px); pixi applies the forward one when drawing
	function playfieldPointToViewport(
		w: number,
		h: number,
		zoom: number,
		pan: { x: number; y: number },
		point: { x: number; y: number }
	) {
		const t = viewportTransform(w, h, zoom, pan);
		return { x: t.x + point.x * t.scale, y: t.y + point.y * t.scale };
	}

	const CASES = [
		{ w: 1280, h: 720, zoom: 1, pan: NO_VIEWPORT_PAN },
		{ w: 1280, h: 720, zoom: 2.5, pan: { x: -80, y: 45 } },
		{ w: 1024, h: 768, zoom: 4, pan: { x: 300, y: -200 } },
		{ w: 640, h: 900, zoom: 0.5, pan: NO_VIEWPORT_PAN }
	];

	test("round-trips under zoom and pan, both directions", () => {
		for (const { w, h, zoom, pan } of CASES) {
			for (const point of [
				{ x: 0, y: 0 },
				{ x: 256, y: 192 },
				{ x: 512, y: 384 },
				{ x: 123.456, y: 77.7 }
			]) {
				const screen = playfieldPointToViewport(w, h, zoom, pan, point);
				const back = viewportPointToPlayfield(w, h, zoom, pan, screen)!;
				expect(back.x).toBeCloseTo(point.x, 9);
				expect(back.y).toBeCloseTo(point.y, 9);
			}
			const screenPoint = { x: 100, y: 200 };
			const world = viewportPointToPlayfield(w, h, zoom, pan, screenPoint)!;
			const forward = playfieldPointToViewport(w, h, zoom, pan, world);
			expect(forward.x).toBeCloseTo(screenPoint.x, 9);
			expect(forward.y).toBeCloseTo(screenPoint.y, 9);
		}
	});

	test("the playfield centre sits under the host centre plus the pan", () => {
		const world = viewportPointToPlayfield(1280, 720, 2, { x: -50, y: 30 }, { x: 1280 / 2 - 50, y: 720 / 2 + 30 })!;
		expect(world.x).toBeCloseTo(256, 9);
		expect(world.y).toBeCloseTo(192, 9);
	});

	test("a zero-size host has no world point under any pixel", () => {
		expect(viewportPointToPlayfield(0, 0, 1, NO_VIEWPORT_PAN, { x: 0, y: 0 })).toBeNull();
	});
});

describe("viewport zoom clamping", () => {
	test("the range is 50% to 400%", () => {
		expect(clampViewportZoom(0.1)).toBe(VIEWPORT_ZOOM_MIN);
		expect(clampViewportZoom(0.5)).toBe(0.5);
		expect(clampViewportZoom(1.37)).toBe(1.37);
		expect(clampViewportZoom(4)).toBe(4);
		expect(clampViewportZoom(1000)).toBe(VIEWPORT_ZOOM_MAX);
	});

	test("a non-finite zoom falls back to 100% rather than poisoning the transform", () => {
		expect(clampViewportZoom(Number.NaN)).toBe(1);
		expect(clampViewportZoom(Number.POSITIVE_INFINITY)).toBe(1);
	});
});

describe("the +/- buttons' zoom step", () => {
	test("one click is ten percentage points either way", () => {
		expect(steppedViewportZoom(1, 1)).toBe(1.1);
		expect(steppedViewportZoom(1, -1)).toBe(0.9);
	});

	test("a run of clicks stays on whole percentages instead of drifting", () => {
		let zoom = 1;
		for (let i = 0; i < 20; i += 1) zoom = steppedViewportZoom(zoom, 1);
		expect(zoom).toBe(3);
		for (let i = 0; i < 25; i += 1) zoom = steppedViewportZoom(zoom, -1);
		expect(zoom).toBe(0.5);
	});

	test("a step off a pointer zoom's fraction snaps onto whole percent", () => {
		expect(steppedViewportZoom(0.8734, 1)).toBe(0.97);
		expect(steppedViewportZoom(0.8734, -1)).toBe(0.77);
	});

	test("stepping past either end saturates", () => {
		expect(steppedViewportZoom(VIEWPORT_ZOOM_MAX, 1)).toBe(VIEWPORT_ZOOM_MAX);
		expect(steppedViewportZoom(VIEWPORT_ZOOM_MIN, -1)).toBe(VIEWPORT_ZOOM_MIN);
		// 0.55 - 0.1 would land under the floor
		expect(steppedViewportZoom(0.55, -1)).toBe(VIEWPORT_ZOOM_MIN);
	});
});

describe("the pan leash", () => {
	/** the rule the spec pins, per axis:
	 *   |pan| <= (playfieldExtent * scale + hostExtent) / 2 - sliver */
	function leashBound(hostW: number, hostH: number, zoom: number) {
		const scale = playfieldTransform(hostW, hostH).scale * zoom;
		return {
			x: (512 * scale + hostW) / 2 - VIEWPORT_LEASH_PX,
			y: (384 * scale + hostH) / 2 - VIEWPORT_LEASH_PX
		};
	}

	test("the bound is exactly the leash formula, at every zoom and host box", () => {
		for (const { w, h } of HOST_BOXES) {
			for (const zoom of [VIEWPORT_ZOOM_MIN, 1, 2.7, VIEWPORT_ZOOM_MAX]) {
				const expected = leashBound(w, h, zoom);
				const max = maxViewportPan(w, h, zoom);
				expect(max.x).toBeCloseTo(Math.max(0, expected.x), 9);
				expect(max.y).toBeCloseTo(Math.max(0, expected.y), 9);
			}
		}
	});

	test("a drag pans at every zoom, fit zoom included", () => {
		// the bound is positive on an axis as soon as the host can hold two
		// slivers, so every host box a window can actually be has pan room --
		// including at and below fit zoom, where the old clamp ignored drags
		const boxes = HOST_BOXES.filter((box) => box.w >= 2 * VIEWPORT_LEASH_PX && box.h >= 2 * VIEWPORT_LEASH_PX);
		for (const { w, h } of boxes) {
			for (const zoom of [VIEWPORT_ZOOM_MIN, 1, VIEWPORT_ZOOM_MAX]) {
				const max = maxViewportPan(w, h, zoom);
				expect(max.x).toBeGreaterThan(0);
				expect(max.y).toBeGreaterThan(0);
				expect(clampViewportPan(w, h, zoom, { x: 30, y: -30 })).toEqual({ x: 30, y: -30 });
			}
		}
	});

	test("at the bound, exactly the sliver of the playfield is still on canvas", () => {
		for (const { w, h } of [
			{ w: 1024, h: 768 },
			{ w: 1920, h: 1080 }
		]) {
			for (const zoom of [0.5, 1, 4]) {
				const right = viewportTransform(w, h, zoom, clampViewportPan(w, h, zoom, { x: 1e6, y: 0 }));
				// pushed as far right as the leash allows, the playfield's left edge
				// sits one sliver inside the canvas' right edge
				expect(w - right.x).toBeCloseTo(VIEWPORT_LEASH_PX, 9);

				const up = viewportTransform(w, h, zoom, clampViewportPan(w, h, zoom, { x: 0, y: -1e6 }));
				// and pushed up, the playfield's bottom edge sits one sliver below
				// the canvas' top
				expect(up.y + 384 * up.scale).toBeCloseTo(VIEWPORT_LEASH_PX, 9);
			}
		}
	});

	test("the bound is symmetric about centre on each axis", () => {
		const max = maxViewportPan(1024, 768, 2);
		expect(clampViewportPan(1024, 768, 2, { x: 1e6, y: 1e6 })).toEqual({ x: max.x, y: max.y });
		expect(clampViewportPan(1024, 768, 2, { x: -1e6, y: -1e6 })).toEqual({ x: -max.x, y: -max.y });
	});

	test("the axes clamp independently, so the playfield can be pushed into a corner", () => {
		const max = maxViewportPan(1024, 768, 3);
		expect(clampViewportPan(1024, 768, 3, { x: 1e6, y: 12 })).toEqual({ x: max.x, y: 12 });
		expect(clampViewportPan(1024, 768, 3, { x: -7, y: -1e6 })).toEqual({ x: -7, y: -max.y });
	});

	test("a pan already inside the leash is returned untouched", () => {
		const inside = { x: 12, y: -34 };
		expect(clampViewportPan(1024, 768, 4, inside)).toEqual(inside);
		expect(clampViewportPan(1024, 768, 1, inside)).toEqual(inside);
	});

	test("zooming out leaves the framing alone -- only the bound shrinks", () => {
		const framed = clampViewportPan(1024, 768, 4, { x: 300, y: -200 });
		expect(framed).toEqual({ x: 300, y: -200 });
		// stepping all the way back to fit zoom keeps it: no recentring, and the
		// leash at zoom 1 is still far wider than this pan
		expect(clampViewportPan(1024, 768, 1, framed)).toEqual({ x: 300, y: -200 });
	});

	test("a host box too small to show a sliver stays finite instead of going negative", () => {
		expect(maxViewportPan(0, 0, 4)).toEqual({ x: 0, y: 0 });
		expect(clampViewportPan(0, 0, 4, { x: 50, y: 50 })).toEqual({ x: 0, y: 0 });
		expect(clampViewportPan(1, 1, 1, { x: 50, y: -50 })).toEqual({ x: 0, y: 0 });
	});
});

describe("pointer-anchored zoom", () => {
	const anchors = [
		{ x: 0, y: 0 },
		{ x: 512, y: 384 },
		{ x: 1023, y: 767 },
		{ x: 300, y: 120 }
	];

	test("the osu!px under the pointer does not move across a zoom", () => {
		for (const anchor of anchors) {
			for (const [zoom, nextZoom] of [
				[1, 2],
				[1, 0.5],
				[2.7, 4],
				[4, 1]
			]) {
				const pan = { x: 40, y: -25 };
				const before = viewportTransform(1024, 768, zoom, pan);
				const after = viewportTransform(
					1024,
					768,
					nextZoom,
					anchoredZoomPan(1024, 768, zoom, pan, nextZoom, anchor)
				);
				const pinned = worldUnder(before, anchor);
				const moved = worldUnder(after, anchor);
				expect(moved.x).toBeCloseTo(pinned.x, 9);
				expect(moved.y).toBeCloseTo(pinned.y, 9);
			}
		}
	});

	test("zooming at the pointer and back returns to the pan it started from", () => {
		const anchor = { x: 700, y: 200 };
		const pan = { x: -10, y: 60 };
		const out = anchoredZoomPan(1024, 768, 1, pan, 3, anchor);
		const back = anchoredZoomPan(1024, 768, 3, out, 1, anchor);
		expect(back.x).toBeCloseTo(pan.x, 9);
		expect(back.y).toBeCloseTo(pan.y, 9);
	});

	test("a zoom that does not change leaves the pan exactly alone", () => {
		const pan = { x: 17.5, y: -3.25 };
		expect(anchoredZoomPan(1024, 768, 2, pan, 2, { x: 1, y: 900 })).toEqual(pan);
	});

	test("anchoring on the viewport centre keeps the framing centred", () => {
		expect(anchoredZoomPan(1024, 768, 1, NO_VIEWPORT_PAN, 4, { x: 512, y: 384 })).toEqual(NO_VIEWPORT_PAN);
	});

	test("a zero-size host has no world point to pin and returns the pan unchanged", () => {
		const pan = { x: 5, y: 5 };
		expect(anchoredZoomPan(0, 0, 1, pan, 2, { x: 0, y: 0 })).toBe(pan);
	});
});

describe("wheel zoom normalisation", () => {
	test("wheel-up zooms in, wheel-down zooms out", () => {
		expect(wheelZoomFactor(-100, 0)).toBeGreaterThan(1);
		expect(wheelZoomFactor(100, 0)).toBeLessThan(1);
		expect(wheelZoomFactor(0, 0)).toBe(1);
	});

	test("one notch is ten percent, and half a notch is its square root", () => {
		expect(wheelZoomFactor(-100, 0)).toBeCloseTo(1.1, 12);
		expect(wheelZoomFactor(-50, 0)).toBeCloseTo(Math.sqrt(1.1), 12);
	});

	test("four quarter-notches compose to one whole one, so a trackpad matches a wheel", () => {
		expect(wheelZoomFactor(-25, 0) ** 4).toBeCloseTo(wheelZoomFactor(-100, 0), 12);
	});

	test("line and page delta modes are normalised to pixels", () => {
		expect(wheelZoomFactor(-3, 1)).toBeCloseTo(wheelZoomFactor(-48, 0), 12);
		expect(wheelZoomFactor(-0.25, 2)).toBeCloseTo(wheelZoomFactor(-100, 0), 12);
	});

	test("a batched flick is capped rather than crossing the whole zoom range", () => {
		expect(wheelZoomFactor(-100_000, 0)).toBe(wheelZoomFactor(-150, 0));
		expect(wheelZoomFactor(100_000, 0)).toBe(wheelZoomFactor(150, 0));
	});

	test("a non-finite delta is a no-op factor, not NaN", () => {
		expect(wheelZoomFactor(Number.NaN, 0)).toBe(1);
		expect(wheelZoomFactor(Number.POSITIVE_INFINITY, 0)).toBe(1);
	});
});
