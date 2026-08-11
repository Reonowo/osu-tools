import { describe, expect, test } from "bun:test";
import type { FrameChanges, FrameDto } from "../lib/scene-types";
import type { Lattice } from "../lib/lattice";
import { expandErase, remapEraseTargets, type EraseTarget } from "./erase";

function frame(time: number, buttons: number, x = time, y = 100): FrameDto {
	return { time, x, y, buttons };
}

function targetsFor(frames: readonly FrameDto[], indices: number[]): EraseTarget[] {
	return indices.map((index) => ({ index, time: frames[index].time }));
}

function opsByKind(expansion: ReturnType<typeof expandErase>) {
	if ("rejected" in expansion) throw new Error(`unexpected rejection: ${expansion.rejected}`);
	const deletes: number[] = [];
	const sets: { index: number; buttons: number }[] = [];
	const inserts: FrameDto[] = [];
	for (const op of expansion.ops) {
		if (op.kind === "deleteFrames") deletes.push(...op.indices);
		if (op.kind === "setButtons") sets.push(...op.sets);
		if (op.kind === "insertFrames") inserts.push(...op.frames);
	}
	return { deletes, sets, inserts };
}

describe("plain deletion", () => {
	test("frames carrying no press edge delete with no compensation", () => {
		const frames = [frame(0, 0), frame(16, 0), frame(32, 0), frame(48, 0)];
		const { deletes, sets, inserts } = opsByKind(expandErase(frames, targetsFor(frames, [1, 2]), null));
		expect(deletes).toEqual([1, 2]);
		expect(sets).toEqual([]);
		expect(inserts).toEqual([]);
	});

	test("deleting an in-run interior frame leaves the press edges alone", () => {
		// k1 held across 16..48; deleting the interior frame moves no edge
		const frames = [frame(0, 0), frame(16, 5), frame(32, 5), frame(48, 5), frame(64, 0)];
		const { deletes, sets, inserts } = opsByKind(expandErase(frames, targetsFor(frames, [2]), null));
		expect(deletes).toEqual([2]);
		expect(sets).toEqual([]);
		expect(inserts).toEqual([]);
	});

	test("stale targets (frame moved out from under the intent) are dropped", () => {
		const frames = [frame(0, 0), frame(16, 0), frame(32, 0)];
		const expansion = expandErase(frames, [{ index: 1, time: 999 }], null);
		expect("rejected" in expansion).toBe(false);
		if (!("rejected" in expansion)) expect(expansion.ops).toEqual([]);
	});

	test("erasing every frame is rejected before any ipc", () => {
		const frames = [frame(0, 0), frame(16, 0)];
		const expansion = expandErase(frames, targetsFor(frames, [0, 1]), null);
		expect("rejected" in expansion).toBe(true);
	});
});

describe("the hybrid rule: rising edges", () => {
	test("a deleted rising frame with an in-run survivor within 1 ms needs no compensation", () => {
		const frames = [frame(0, 0), frame(10, 5), frame(11, 5), frame(26, 5), frame(42, 0)];
		const { deletes, sets, inserts } = opsByKind(expandErase(frames, targetsFor(frames, [1]), null));
		expect(deletes).toEqual([1]);
		expect(sets).toEqual([]);
		expect(inserts).toEqual([]);
	});

	test("a deleted rising frame with no survivor within 1 ms inserts a boundary at the exact ms", () => {
		const frames = [frame(0, 0, 0), frame(10, 5, 100), frame(26, 5, 260), frame(42, 0, 420)];
		const { deletes, inserts } = opsByKind(expandErase(frames, targetsFor(frames, [1]), null));
		expect(deletes).toEqual([1]);
		expect(inserts).toHaveLength(1);
		expect(inserts[0].time).toBe(10);
		// the deleted rising frame's own pattern: the press starts here
		expect(inserts[0].buttons).toBe(5);
		// position interpolated over the *surviving* stream (0 at t=0, 260 at
		// t=26): t=10 sits at 100 by linear interpolation in f32
		expect(inserts[0].x).toBeCloseTo(100, 3);
	});

	test("boundary positions lattice-snap whenever a lattice was inferred, no preference involved", () => {
		const lattice: Lattice = { scale: 2, step: 0.5, conformance: 1 };
		const frames = [frame(0, 0, 0.3), frame(10, 5, 100.3), frame(26, 5, 260.4), frame(42, 0, 420)];
		const { inserts } = opsByKind(expandErase(frames, targetsFor(frames, [1]), lattice));
		expect(inserts).toHaveLength(1);
		expect(Math.abs(inserts[0].x / 0.5 - Math.round(inserts[0].x / 0.5))).toBeLessThan(1e-3);
		expect(Math.abs(inserts[0].y / 0.5 - Math.round(inserts[0].y / 0.5))).toBeLessThan(1e-3);
	});
});

describe("the hybrid rule: falling edges", () => {
	test("a deleted falling frame whose next survivor is off within 1 ms needs no compensation", () => {
		const frames = [frame(0, 0), frame(16, 5), frame(32, 5), frame(33, 0), frame(34, 0), frame(48, 0)];
		const { deletes, sets, inserts } = opsByKind(expandErase(frames, targetsFor(frames, [3]), null));
		expect(deletes).toEqual([3]);
		expect(sets).toEqual([]);
		expect(inserts).toEqual([]);
	});

	test("a deleted falling frame rewrites the release onto an in-run survivor within 1 ms", () => {
		const frames = [frame(0, 0), frame(16, 5), frame(32, 5), frame(33, 5), frame(34, 0), frame(50, 0)];
		const { deletes, sets, inserts } = opsByKind(expandErase(frames, targetsFor(frames, [4]), null));
		expect(deletes).toEqual([4]);
		// the press now ends at t=33, one ms early: k1 and its paired m1 clear
		expect(sets).toEqual([{ index: 3, buttons: 0 }]);
		expect(inserts).toEqual([]);
	});

	test("a rewrite keeps the paired mouse bit when the mouse hold genuinely continues", () => {
		// 1 -> 5 -> 1: a k1 tap inside a continuing m1 hold; deleting the
		// release frame must not release the ongoing left action
		const frames = [frame(0, 1), frame(16, 5), frame(47, 5), frame(48, 1), frame(64, 1), frame(80, 0)];
		const { sets } = opsByKind(expandErase(frames, targetsFor(frames, [3]), null));
		expect(sets).toEqual([{ index: 2, buttons: 1 }]);
	});

	test("a deleted falling frame with no candidates inserts an off boundary at the exact ms", () => {
		const frames = [frame(0, 0, 0), frame(16, 5, 160), frame(32, 5, 320), frame(48, 0, 480), frame(64, 0, 640)];
		const { deletes, inserts } = opsByKind(expandErase(frames, targetsFor(frames, [3]), null));
		expect(deletes).toEqual([3]);
		expect(inserts).toHaveLength(1);
		expect(inserts[0].time).toBe(48);
		expect(inserts[0].buttons).toBe(0);
	});

	test("an off boundary inherits another key's continuing hold", () => {
		// k1 releases at t=48 while m2 keeps holding through it
		const frames = [frame(0, 2), frame(16, 7), frame(32, 7), frame(48, 2), frame(64, 2), frame(80, 0)];
		const { inserts } = opsByKind(expandErase(frames, targetsFor(frames, [3]), null));
		expect(inserts).toHaveLength(1);
		expect(inserts[0].buttons).toBe(2);
	});
});

describe("whole-press erasure", () => {
	test("a fully swept press survives as boundary frames at both exact edges", () => {
		const frames = [frame(0, 0, 0), frame(16, 5, 160), frame(32, 5, 320), frame(48, 0, 480), frame(64, 0, 640)];
		const { deletes, inserts } = opsByKind(expandErase(frames, targetsFor(frames, [1, 2, 3]), null));
		expect(deletes).toEqual([1, 2, 3]);
		expect(inserts.map((f) => [f.time, f.buttons])).toEqual([
			[16, 5],
			[48, 0]
		]);
	});

	test("sweeping a press's frames but not its release keeps the surviving release frame doing that job", () => {
		const frames = [frame(0, 0), frame(16, 5), frame(32, 5), frame(48, 0), frame(64, 0)];
		const { deletes, inserts } = opsByKind(expandErase(frames, targetsFor(frames, [1, 2]), null));
		expect(deletes).toEqual([1, 2]);
		expect(inserts.map((f) => [f.time, f.buttons])).toEqual([[16, 5]]);
	});
});

describe("degenerate rejection", () => {
	test("an erase whose rewrites would collapse a press to zero length is rejected", () => {
		// rise at 10 (deleted), one held survivor at 11, release at 12
		// (deleted): the start anchors at 11 and the release rewrites onto 11
		// -- a zero-length press, so the whole batch must refuse
		const frames = [frame(0, 0), frame(10, 5), frame(11, 5), frame(12, 0), frame(30, 0)];
		const expansion = expandErase(frames, targetsFor(frames, [1, 3]), null);
		expect("rejected" in expansion).toBe(true);
		if ("rejected" in expansion) expect(expansion.rejected).toContain("K1");
	});

	test("a surviving fall at the anchor's millisecond collapses the press and is rejected", () => {
		// rise at 10 (deleted) anchors onto the duplicate-time survivor at 11;
		// the surviving release is also at 11, so the realized press is
		// zero-length even though the falling edge itself is untouched
		const frames = [frame(0, 0), frame(10, 5), frame(11, 5), frame(11, 0), frame(30, 0)];
		const expansion = expandErase(frames, targetsFor(frames, [1]), null);
		expect("rejected" in expansion).toBe(true);
		if ("rejected" in expansion) expect(expansion.rejected).toContain("K1");
	});

	test("a naturally preserved release at the anchor's millisecond collapses the press and is rejected", () => {
		// rise at 10 (deleted) anchors at 11; the deleted fall's next survivor
		// is off at that same 11 ms -- naturally preserved, but zero-length
		const frames = [frame(0, 0), frame(10, 5), frame(11, 5), frame(11, 0), frame(11, 0), frame(30, 0)];
		const expansion = expandErase(frames, targetsFor(frames, [1, 3]), null);
		expect("rejected" in expansion).toBe(true);
		if ("rejected" in expansion) expect(expansion.rejected).toContain("K1");
	});

	test("an erase leaving an already-degenerate press alone is not rejected for it", () => {
		// the k1 press at 10 already has zero length; deleting a frame that
		// touches neither of its edges must not trip the collapse guard
		const frames = [frame(0, 0), frame(10, 5), frame(10, 0), frame(20, 0), frame(30, 0)];
		const expansion = expandErase(frames, targetsFor(frames, [3]), null);
		expect("rejected" in expansion).toBe(false);
	});

	test("a release boundary that would land behind a same-millisecond re-press is rejected", () => {
		// the fall at 48 is deleted with no in-run survivor within 1 ms, and a
		// surviving re-press sits at that same 48 ms: the engine inserts after
		// equal-time frames, so the boundary release would turn the re-press
		// off -- unrepresentable, so the batch refuses
		const frames = [
			frame(0, 0),
			frame(16, 5),
			frame(32, 5),
			frame(48, 0),
			frame(48, 5),
			frame(64, 5),
			frame(80, 0)
		];
		const expansion = expandErase(frames, targetsFor(frames, [3]), null);
		expect("rejected" in expansion).toBe(true);
		if ("rejected" in expansion) expect(expansion.rejected).toContain("re-press");
	});
});

describe("remapEraseTargets", () => {
	test("indices shift through a splice; removed targets drop", () => {
		const targets: EraseTarget[] = [
			{ index: 1, time: 16 },
			{ index: 3, time: 48 },
			{ index: 4, time: 64 }
		];
		const changes: FrameChanges = { updated: [], inserted: [], removed: [0, 3] };
		expect(remapEraseTargets(targets, changes)).toEqual([
			{ index: 0, time: 16 },
			{ index: 2, time: 64 }
		]);
	});

	test("a fullFrames splice drops every target", () => {
		const targets: EraseTarget[] = [{ index: 1, time: 16 }];
		expect(remapEraseTargets(targets, { fullFrames: [] })).toEqual([]);
	});
});

describe("presses outside the deleted span", () => {
	test("a press wholly after (or before) the deletions is left alone", () => {
		// plain frames deleted at the start; the k1 press later must neither
		// reject nor pick up compensation
		const frames = [
			frame(0, 0),
			frame(16, 0),
			frame(32, 0),
			frame(100, 5),
			frame(116, 5),
			frame(132, 0),
			frame(148, 0)
		];
		const after = opsByKind(expandErase(frames, targetsFor(frames, [1]), null));
		expect(after).toEqual({ deletes: [1], sets: [], inserts: [] });
		const before = opsByKind(expandErase(frames, targetsFor(frames, [6]), null));
		expect(before).toEqual({ deletes: [6], sets: [], inserts: [] });
	});
});

describe("multi-key edges on one frame", () => {
	test("one deleted frame carrying two keys' rising edges donates a single boundary frame", () => {
		// k1 and k2 both rise at t=16 on the same frame (raw 5|10 = 15)
		const frames = [frame(0, 0, 0), frame(16, 15, 160), frame(32, 15, 320), frame(48, 0, 480)];
		const { inserts } = opsByKind(expandErase(frames, targetsFor(frames, [1]), null));
		expect(inserts.map((f) => [f.time, f.buttons])).toEqual([[16, 15]]);
	});
});
