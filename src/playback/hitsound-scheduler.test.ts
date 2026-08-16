// the scheduler's decisions, which are all pure: which samples fall in the
// window, where the cursor resumes, and what audio-clock time a beatmap time
// maps to. the WebAudio node-building below them needs a real AudioContext and
// stays outside `bun test`, like Pixi's render path.

import { describe, expect, test } from "bun:test";
import {
	ANCHOR_DRIFT_MS,
	anchorHasDrifted,
	beatmapTimeAt,
	contextTimeFor,
	indexAtOrAfter,
	LOOKAHEAD_MS,
	windowOf
} from "./hitsound-scheduler";
import { namedRequest } from "./sample-sources";
import type { ScheduledSample } from "./hitsound-plan";

const at = (time: number): ScheduledSample => ({
	time,
	request: namedRequest(`t${time}`),
	gain: 1,
	balance: 0
});

const plan = [at(0), at(100), at(100), at(250), at(1000)];

describe("contextTimeFor", () => {
	test("maps beatmap ms onto the audio clock's seconds", () => {
		const anchor = { beatmapTime: 1000, contextTime: 5, rate: 1 };
		expect(contextTimeFor(1000, anchor)).toBe(5);
		expect(contextTimeFor(1500, anchor)).toBe(5.5);
		expect(contextTimeFor(500, anchor)).toBe(4.5);
	});

	test("a faster rate compresses the same beatmap span into less real time", () => {
		const anchor = { beatmapTime: 0, contextTime: 0, rate: 2 };
		expect(contextTimeFor(1000, anchor)).toBe(0.5);
		expect(contextTimeFor(1000, { ...anchor, rate: 0.5 })).toBe(2);
	});

	test("a stopped or nonsensical rate has no answer rather than an infinite one", () => {
		// an infinity handed to start() throws; nothing is arriving at rate 0
		expect(contextTimeFor(1000, { beatmapTime: 0, contextTime: 0, rate: 0 })).toBeNull();
		expect(contextTimeFor(1000, { beatmapTime: 0, contextTime: 0, rate: -1 })).toBeNull();
		expect(contextTimeFor(1000, { beatmapTime: 0, contextTime: 0, rate: Number.NaN })).toBeNull();
	});
});

describe("windowOf", () => {
	test("takes everything inside the window and reports where to resume", () => {
		const { items, nextIndex } = windowOf(plan, 0, 0, 250);
		expect(items.map((s) => s.time)).toEqual([0, 100, 100]);
		expect(nextIndex).toBe(3);
	});

	test("consumes a whole run of samples sharing one millisecond", () => {
		// a stack of objects judged on the same frame is one time and several
		// samples; a cursor kept as a TIME would either replay or skip the run
		const { items } = windowOf(plan, 1, 100, 101);
		expect(items.map((s) => s.time)).toEqual([100, 100]);
	});

	test("drops what the window has already passed rather than playing it late", () => {
		// a hit sound arriving after its hit is worse than one that does not
		// arrive: a stalled frame must not dump a backlog at the playhead
		const { items, nextIndex } = windowOf(plan, 0, 900, 1100);
		expect(items.map((s) => s.time)).toEqual([1000]);
		expect(nextIndex).toBe(5);
	});

	test("an exhausted plan keeps reporting its end", () => {
		const { items, nextIndex } = windowOf(plan, 5, 2000, 3000);
		expect(items).toEqual([]);
		expect(nextIndex).toBe(5);
	});

	test("a negative cursor is treated as the start rather than indexing backwards", () => {
		expect(windowOf(plan, -3, 0, 50).items.map((s) => s.time)).toEqual([0]);
	});
});

describe("indexAtOrAfter", () => {
	test("finds where a seek resumes, landing before a run rather than inside it", () => {
		expect(indexAtOrAfter(plan, -100)).toBe(0);
		expect(indexAtOrAfter(plan, 0)).toBe(0);
		expect(indexAtOrAfter(plan, 100)).toBe(1);
		expect(indexAtOrAfter(plan, 101)).toBe(3);
		expect(indexAtOrAfter(plan, 5000)).toBe(5);
	});

	test("an empty plan has one answer", () => {
		expect(indexAtOrAfter([], 1234)).toBe(0);
	});
});

describe("the lookahead itself", () => {
	test("is long enough to survive a stalled frame and short enough to throw away", () => {
		// three 60Hz frames is 50ms; a seek discards at most this much work
		expect(LOOKAHEAD_MS).toBeGreaterThanOrEqual(50);
		expect(LOOKAHEAD_MS).toBeLessThanOrEqual(500);
	});

	test("the window scales with rate, so 2x looks twice as far ahead in beatmap time", () => {
		// the window is a REAL-time budget; at 2x, twice as much beatmap time
		// passes inside it, and a window that did not scale would starve
		const dense = Array.from({ length: 20 }, (_, i) => at(i * 50));
		const atOneX = windowOf(dense, 0, 0, LOOKAHEAD_MS * 1).items.length;
		const atTwoX = windowOf(dense, 0, 0, LOOKAHEAD_MS * 2).items.length;
		expect(atTwoX).toBeGreaterThan(atOneX);
	});
});

describe("anchor drift", () => {
	// the playback clock interpolates against the music element while samples
	// are placed on the AudioContext's clock. the two are only nominally the
	// same device, and a hit sound sliding off its circle over a long map is
	// exactly what a re-anchor prevents
	const anchor = { beatmapTime: 10_000, contextTime: 20, rate: 1 };

	test("beatmapTimeAt inverts contextTimeFor", () => {
		expect(beatmapTimeAt(20, anchor)).toBe(10_000);
		expect(beatmapTimeAt(21, anchor)).toBe(11_000);
		expect(beatmapTimeAt(21, { ...anchor, rate: 2 })).toBe(12_000);
		expect(contextTimeFor(beatmapTimeAt(25, anchor), anchor)).toBeCloseTo(25, 9);
	});

	test("a mapping still inside the threshold is left alone", () => {
		// re-anchoring on every frame would be harmless but pointless; the
		// threshold is what keeps the anchor a stable reference
		expect(anchorHasDrifted(anchor, 11_000, 21)).toBe(false);
		expect(anchorHasDrifted(anchor, 11_000 + ANCHOR_DRIFT_MS, 21)).toBe(false);
	});

	test("a mapping past the threshold is re-taken", () => {
		expect(anchorHasDrifted(anchor, 11_000 + ANCHOR_DRIFT_MS + 1, 21)).toBe(true);
		expect(anchorHasDrifted(anchor, 11_000 - ANCHOR_DRIFT_MS - 1, 21)).toBe(true);
	});

	test("the threshold sits inside the tightest hit window", () => {
		// a correction that could be heard as a jump would be worse than the
		// drift it fixes; od10's great window is 20ms
		expect(ANCHOR_DRIFT_MS).toBeLessThanOrEqual(20);
	});
});
