import { describe, expect, test } from "bun:test";
import { isK1, isLeft } from "../engine/buttons";
import { spansWhere } from "../engine/interpolation";
import type { FrameDto } from "../lib/scene-types";
import { pressRunAt, pressRunFromIndex, pressRunsOfKey, runEndingWithin, runStartingWithin } from "./press-runs";

function frame(time: number, buttons: number): FrameDto {
	return { time, x: time, y: 100, buttons };
}

describe("pressRunsOfKey", () => {
	test("enumerates a key's maximal held-runs with (key, run-start index) identity", () => {
		const frames = [frame(0, 0), frame(16, 5), frame(32, 5), frame(48, 0), frame(64, 5), frame(80, 0)];
		const runs = pressRunsOfKey(frames, "K1");
		expect(runs).toEqual([
			{ key: "K1", startIndex: 1, fallIndex: 3, startTime: 16, endTime: 48, open: false },
			{ key: "K1", startIndex: 4, fallIndex: 5, startTime: 64, endTime: 80, open: false }
		]);
	});

	test("matches the detail lanes' own per-key span computation", () => {
		const frames = [frame(0, 1), frame(16, 5), frame(32, 5), frame(48, 1), frame(64, 0), frame(80, 5)];
		const spans = spansWhere(frames, isK1);
		const runs = pressRunsOfKey(frames, "K1");
		expect(runs.map((r) => ({ start: r.startTime, end: r.endTime }))).toEqual(
			spans.map((s) => ({ start: s.start, end: s.end }))
		);
	});

	test("a press held through the stream's end enumerates as an open run", () => {
		const frames = [frame(0, 0), frame(16, 5), frame(32, 5)];
		const runs = pressRunsOfKey(frames, "K1");
		expect(runs).toEqual([{ key: "K1", startIndex: 1, fallIndex: 3, startTime: 16, endTime: 32, open: true }]);
	});

	test("a mid-hold provenance run (1 -> 5 -> 1) enumerates like any other press", () => {
		// the m1 hold carries a k1 segment; the k1 run has no press row (the
		// left action never rose there) but the model still enumerates it
		const frames = [frame(0, 1), frame(16, 5), frame(32, 5), frame(48, 1), frame(64, 1), frame(80, 0)];
		expect(pressRunsOfKey(frames, "K1")).toEqual([
			{ key: "K1", startIndex: 1, fallIndex: 3, startTime: 16, endTime: 48, open: false }
		]);
		// the m1 predicate reads the k1 segment as a provenance gap, so the
		// hold splits into two independent m1 runs around it
		expect(pressRunsOfKey(frames, "M1").map((r) => [r.startTime, r.endTime])).toEqual([
			[0, 16],
			[48, 80]
		]);
	});
});

describe("realized run times vs press rows", () => {
	test("a run's realized end diverges from its row's displayed release on a provenance change", () => {
		// raw 1,1,5,5,1,1,0: one "left" press row at t=0 whose displayed
		// release is where the *action* falls (t=96) -- but the m1 run it
		// names realizes its falling edge at t=32, where the provenance
		// flips to keyboard
		const frames = [
			frame(0, 1),
			frame(16, 1),
			frame(32, 5),
			frame(48, 5),
			frame(64, 1),
			frame(80, 1),
			frame(96, 0)
		];
		const m1Run = pressRunAt(frames, "M1", 0);
		expect(m1Run?.endTime).toBe(32);
		// the row's displayed release: the first frame where the left action
		// reads false again (KeypressPanel's releaseTime rule)
		const rowRelease = frames.find((f, i) => i > 0 && !isLeft(f.buttons))?.time;
		expect(rowRelease).toBe(96);
		expect(m1Run?.endTime).not.toBe(rowRelease);
	});
});

describe("pressRunFromIndex", () => {
	test("normalizes any in-run index to its maximal run", () => {
		const frames = [frame(0, 0), frame(16, 5), frame(32, 5), frame(48, 5), frame(64, 0)];
		for (const index of [1, 2, 3]) {
			expect(pressRunFromIndex(frames, "K1", index)).toEqual({
				key: "K1",
				startIndex: 1,
				fallIndex: 4,
				startTime: 16,
				endTime: 64,
				open: false
			});
		}
	});

	test("null when the key is not held on that frame", () => {
		const frames = [frame(0, 0), frame(16, 5), frame(32, 0)];
		expect(pressRunFromIndex(frames, "K1", 0)).toBeNull();
		expect(pressRunFromIndex(frames, "K1", 2)).toBeNull();
		expect(pressRunFromIndex(frames, "K1", 99)).toBeNull();
	});
});

describe("pressRunAt containment", () => {
	const frames = [frame(0, 0), frame(16, 5), frame(32, 5), frame(48, 0), frame(64, 0)];

	test("contains its interior and its start, not its release instant", () => {
		expect(pressRunAt(frames, "K1", 16)?.startIndex).toBe(1);
		expect(pressRunAt(frames, "K1", 30)?.startIndex).toBe(1);
		expect(pressRunAt(frames, "K1", 47)?.startIndex).toBe(1);
		expect(pressRunAt(frames, "K1", 48)).toBeNull();
	});

	test("null outside any run and before the first frame", () => {
		expect(pressRunAt(frames, "K1", 8)).toBeNull();
		expect(pressRunAt(frames, "K1", 60)).toBeNull();
		expect(pressRunAt(frames, "K1", -5)).toBeNull();
	});

	test("a zero-length press contains exactly its own millisecond", () => {
		const tied = [frame(0, 0), frame(10, 5), frame(10, 0), frame(30, 0)];
		const run = pressRunAt(tied, "K1", 10);
		expect(run).toEqual({ key: "K1", startIndex: 1, fallIndex: 2, startTime: 10, endTime: 10, open: false });
	});

	test("a fall beside a same-millisecond re-press resolves to the re-press", () => {
		// off@48 then on@48: the state at 48 ms is the last frame's -- held
		const frames2 = [frame(0, 0), frame(16, 5), frame(48, 0), frame(48, 5), frame(64, 5), frame(80, 0)];
		expect(pressRunAt(frames2, "K1", 48)?.startIndex).toBe(3);
	});

	test("an open run contains through its last frame and nothing beyond", () => {
		const open = [frame(0, 0), frame(16, 5), frame(32, 5)];
		expect(pressRunAt(open, "K1", 32)?.open).toBe(true);
		expect(pressRunAt(open, "K1", 24)?.startIndex).toBe(1);
		expect(pressRunAt(open, "K1", 40)).toBeNull();
	});
});

describe("interval run lookup", () => {
	test("a run entirely inside the window is found from either side", () => {
		const frames = [frame(0, 0), frame(100, 5), frame(140, 5), frame(160, 0), frame(200, 0)];
		expect(runEndingWithin(frames, "K1", 200, 150)?.endTime).toBe(160);
		expect(runStartingWithin(frames, "K1", 20, 150)?.startTime).toBe(100);
	});

	test("a sparsely-sampled run is found when only its fall frame lies in the window", () => {
		// the last held frame sits at 0 ms, far outside the window -- the
		// fall edge at 95 ms is what the window catches
		const frames = [frame(0, 5), frame(95, 0), frame(200, 0)];
		expect(runEndingWithin(frames, "K1", 100, 50)?.endTime).toBe(95);
	});

	test("a fall exactly at the probe time is a zero-distance edge, not a miss", () => {
		const frames = [frame(0, 5), frame(100, 0), frame(200, 0)];
		expect(runEndingWithin(frames, "K1", 100, 5)?.endTime).toBe(100);
	});

	test("null when no edge lies inside the window", () => {
		const frames = [frame(0, 5), frame(95, 0), frame(300, 5), frame(340, 0)];
		expect(runEndingWithin(frames, "K1", 200, 50)).toBeNull();
		expect(runStartingWithin(frames, "K1", 200, 50)).toBeNull();
	});

	test("a run still held at the probe time is not an edge candidate", () => {
		const frames = [frame(0, 0), frame(16, 5), frame(32, 5), frame(48, 0)];
		expect(runEndingWithin(frames, "K1", 30, 100)).toBeNull();
		expect(runStartingWithin(frames, "K1", 30, 100)).toBeNull();
	});
});
