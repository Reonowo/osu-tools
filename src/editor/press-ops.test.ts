import { describe, expect, test } from "bun:test";
import type { Lattice } from "../lib/lattice";
import type { FrameDto } from "../lib/scene-types";
import {
	adjacentFrameTime,
	expandAddPress,
	expandDeletePress,
	expandRetimePress,
	medianPressDuration,
	nearestFrameTime,
	outcomeSelection,
	type PressExpansion
} from "./press-ops";
import { pressRunAt, pressRunFromIndex, type PressRun } from "./press-runs";

function frame(time: number, buttons: number, x = time, y = 100): FrameDto {
	return { time, x, y, buttons };
}

function runAt(frames: readonly FrameDto[], key: "K1" | "K2" | "M1" | "M2", index: number): PressRun {
	const run = pressRunFromIndex(frames, key, index);
	if (run === null) throw new Error(`no ${key} run at index ${index}`);
	return run;
}

function expansionParts(expansion: PressExpansion) {
	if ("rejected" in expansion) throw new Error(`unexpected rejection: ${expansion.rejected}`);
	const sets: { index: number; buttons: number }[] = [];
	const inserts: FrameDto[] = [];
	for (const op of expansion.ops) {
		if (op.kind === "setButtons") sets.push(...op.sets);
		if (op.kind === "insertFrames") inserts.push(...op.frames);
	}
	return { sets, inserts, expansion };
}

/** the post-edit frame stream an expansion produces, for asserting observable
 * outcomes rather than op shapes */
function applyExpansion(frames: readonly FrameDto[], expansion: PressExpansion): FrameDto[] {
	const { sets, inserts } = expansionParts(expansion);
	const next = frames.map((f, i) => {
		const set = sets.find((s) => s.index === i);
		return set === undefined ? f : { ...f, buttons: set.buttons };
	});
	for (const inserted of inserts) {
		// the engine inserts after all equal-time frames
		let at = next.length;
		while (at > 0 && next[at - 1].time > inserted.time) at -= 1;
		next.splice(at, 0, inserted);
	}
	return next;
}

describe("delete press: the paired-provenance contract", () => {
	test("deleting a keyboard tap (0 -> 5 -> 0) clears the paired mouse bit with it", () => {
		const frames = [frame(0, 0), frame(16, 5), frame(32, 5), frame(48, 0)];
		const after = applyExpansion(frames, expandDeletePress(frames, runAt(frames, "K1", 1)));
		expect(after.map((f) => f.buttons)).toEqual([0, 0, 0, 0]);
	});

	test("deleting a K segment inside a continuing M hold (1 -> 5 -> 1) leaves the hold intact", () => {
		const frames = [frame(0, 1), frame(16, 5), frame(32, 5), frame(48, 1), frame(64, 0)];
		const after = applyExpansion(frames, expandDeletePress(frames, runAt(frames, "K1", 1)));
		expect(after.map((f) => f.buttons)).toEqual([1, 1, 1, 1, 0]);
	});

	test("deleting an M press clears only its own bit", () => {
		const frames = [frame(0, 2), frame(16, 3), frame(32, 3), frame(48, 2), frame(64, 0)];
		const after = applyExpansion(frames, expandDeletePress(frames, runAt(frames, "M1", 1)));
		expect(after.map((f) => f.buttons)).toEqual([2, 2, 2, 2, 0]);
	});

	test("delete's outcome is null and its span is the affected range", () => {
		const frames = [frame(0, 0), frame(16, 5), frame(32, 5), frame(48, 0)];
		const expansion = expandDeletePress(frames, runAt(frames, "K1", 1));
		if ("rejected" in expansion) throw new Error(expansion.rejected);
		expect(expansion.outcome).toBeNull();
		expect(expansion.affected).toEqual({ from: 16, to: 48 });
	});
});

describe("add press: the paired-provenance contract", () => {
	test("a K press over its paired mouse hold writes the K bit with the mouse bit intact underneath", () => {
		const frames = [frame(0, 1), frame(16, 1), frame(32, 1), frame(48, 1), frame(64, 0)];
		const expansion = expandAddPress(frames, "K1", 16, 32, null, "adding this press");
		const after = applyExpansion(frames, expansion);
		// the span frames read K1 (raw 5): the m1 lane shows the provenance
		// gap while the underlying mouse bit stays -- reversibly
		expect(after.map((f) => f.buttons)).toEqual([1, 5, 5, 1, 0]);
	});

	test("the K-over-M write is reversible: deleting the added press restores the hold", () => {
		const frames = [frame(0, 1), frame(16, 5), frame(32, 5), frame(48, 1), frame(64, 0)];
		const after = applyExpansion(frames, expandDeletePress(frames, runAt(frames, "K1", 1)));
		expect(after.map((f) => f.buttons)).toEqual([1, 1, 1, 1, 0]);
	});

	test("an M press where the paired K is held is rejected", () => {
		const frames = [frame(0, 0), frame(16, 5), frame(32, 5), frame(48, 0)];
		const expansion = expandAddPress(frames, "M1", 16, 32, null, "adding this press");
		expect("rejected" in expansion).toBe(true);
		if ("rejected" in expansion) {
			expect(expansion.rejected).toContain("M1");
			expect(expansion.rejected).toContain("K1");
		}
	});

	test("an M press whose boundary would sit under a held paired K is rejected", () => {
		// no frames within 1 ms of the requested edges, but the underlying
		// state at the boundary millisecond carries K1
		const frames = [frame(0, 0), frame(16, 5), frame(200, 5), frame(300, 0)];
		const expansion = expandAddPress(frames, "M1", 100, 50, null, "adding this press");
		expect("rejected" in expansion).toBe(true);
	});
});

describe("add press: edges and defaults", () => {
	test("edges land on existing frames when within 1 ms, otherwise boundary frames at the exact ms", () => {
		const frames = [frame(0, 0), frame(101, 0), frame(200, 0), frame(300, 0)];
		// start 100 lands on the frame at 101 (within 1 ms forward); end 160
		// has nothing within [159, 160] and inserts at exactly 160
		const { inserts, expansion } = expansionParts(expandAddPress(frames, "K1", 100, 60, null, "add"));
		expect(expansion.realized).toEqual({ startTime: 101, endTime: 160 });
		expect(inserts.map((f) => [f.time, f.buttons])).toEqual([[160, 0]]);
	});

	test("synthesized frames inherit the other keys' hold state", () => {
		// m2 held across the whole region: both boundaries must carry bit 2
		const frames = [frame(0, 2), frame(300, 2), frame(400, 0)];
		const { inserts } = expansionParts(expandAddPress(frames, "K1", 100, 60, null, "add"));
		expect(inserts.map((f) => [f.time, f.buttons])).toEqual([
			[100, 2 | 5],
			[160, 2]
		]);
	});

	test("boundary positions interpolate over the stream, lattice-snap when inferred, f32-truncate", () => {
		const lattice: Lattice = { scale: 2, step: 0.5, conformance: 1 };
		const frames = [frame(0, 0, 0.3), frame(200, 0, 420.7), frame(400, 0, 500)];
		const { inserts } = expansionParts(expandAddPress(frames, "K1", 100, 60, lattice, "add"));
		expect(inserts).toHaveLength(2);
		for (const inserted of inserts) {
			expect(Math.abs(inserted.x / 0.5 - Math.round(inserted.x / 0.5))).toBeLessThan(1e-3);
			expect(inserted.x).toBe(Math.fround(inserted.x));
		}
	});

	test("the new press is the outcome, resolvable after the splice lands", () => {
		const frames = [frame(0, 0), frame(100, 0), frame(160, 0), frame(300, 0)];
		const expansion = expandAddPress(frames, "K1", 100, 60, null, "add");
		if ("rejected" in expansion) throw new Error(expansion.rejected);
		expect(expansion.outcome).toEqual({ key: "K1", startTime: 100 });
		const after = applyExpansion(frames, expansion);
		expect(outcomeSelection(after, expansion.outcome)).toEqual({ key: "K1", startIndex: 1 });
	});

	test("adding inside an existing same-key press is identity", () => {
		const frames = [frame(0, 0), frame(16, 5), frame(32, 5), frame(64, 5), frame(80, 0)];
		const expansion = expandAddPress(frames, "K1", 32, 20, null, "add");
		if ("rejected" in expansion) throw new Error(expansion.rejected);
		expect(expansion.ops).toEqual([]);
	});

	test("an overlap with an adjacent same-key press merges into one", () => {
		const frames = [frame(0, 0), frame(100, 0), frame(140, 5), frame(160, 5), frame(180, 0), frame(300, 0)];
		const expansion = expandAddPress(frames, "K1", 100, 60, null, "add");
		if ("rejected" in expansion) throw new Error(expansion.rejected);
		const after = applyExpansion(frames, expansion);
		expect(pressRunAt(after, "K1", 100)?.endTime).toBe(180);
		// the merged run's start is the outcome
		expect(expansion.outcome).toEqual({ key: "K1", startTime: 100 });
		expect(expansion.realized).toEqual({ startTime: 100, endTime: 180 });
	});
});

describe("median press duration", () => {
	test("odd count takes the middle, even count the rounded mean of the middles", () => {
		// k1 presses of 20, 40 and 90 ms
		const odd = [
			frame(0, 0),
			frame(10, 5),
			frame(30, 0),
			frame(100, 5),
			frame(140, 0),
			frame(200, 5),
			frame(290, 0)
		];
		expect(medianPressDuration(odd, "K1")).toBe(40);
		// 20 and 41 ms -> 30.5 rounds to 31
		const even = [frame(0, 0), frame(10, 5), frame(30, 0), frame(100, 5), frame(141, 0), frame(200, 0)];
		expect(medianPressDuration(even, "K1")).toBe(31);
	});

	test("falls back to 60 ms when the key has no observed presses", () => {
		const frames = [frame(0, 0), frame(16, 2), frame(32, 0)];
		expect(medianPressDuration(frames, "K1")).toBe(60);
	});

	test("an open press contributes no duration", () => {
		const frames = [frame(0, 0), frame(10, 5), frame(30, 0), frame(100, 5), frame(500, 5)];
		expect(medianPressDuration(frames, "K1")).toBe(20);
	});
});

describe("retime: hybrid landings and boundary synthesis", () => {
	test("a typed edge lands on an existing frame within 1 ms in the press's direction", () => {
		const frames = [frame(0, 0), frame(100, 5), frame(150, 5), frame(200, 0), frame(300, 0)];
		const run = runAt(frames, "K1", 1);
		// typed start 149: the in-run frame at 150 sits within [149, 150]
		const expansion = expandRetimePress(frames, run, { start: 149 }, null, "this retime");
		if ("rejected" in expansion) throw new Error(expansion.rejected);
		expect(expansion.realized?.startTime).toBe(150);
		const after = applyExpansion(frames, expansion);
		expect(pressRunAt(after, "K1", 150)).toMatchObject({ startTime: 150, endTime: 200 });
		expect(after.map((f) => f.buttons)).toEqual([0, 0, 5, 0, 0]);
	});

	test("a typed edge with no frame within 1 ms inserts a boundary at the exact millisecond", () => {
		const frames = [frame(0, 0), frame(100, 5), frame(200, 0), frame(300, 0)];
		const run = runAt(frames, "K1", 1);
		const { inserts, expansion } = expansionParts(
			expandRetimePress(frames, run, { start: 50 }, null, "this retime")
		);
		expect(inserts.map((f) => [f.time, f.buttons])).toEqual([[50, 5]]);
		expect(expansion.realized).toEqual({ startTime: 50, endTime: 200 });
	});

	test("a start landing backward is never taken: the search runs into the press only", () => {
		// a frame at 99 must not catch a typed start of 100 -- the press's
		// direction from a rising edge is forward
		const frames = [frame(0, 0), frame(99, 0), frame(150, 5), frame(200, 0), frame(300, 0)];
		const run = runAt(frames, "K1", 2);
		const { inserts } = expansionParts(expandRetimePress(frames, run, { start: 100 }, null, "this retime"));
		expect(inserts.map((f) => f.time)).toEqual([100]);
	});

	test("shrinking an end mid-run inserts a release boundary carrying the suffix's pairing rule", () => {
		// 1 -> 5 -> 1: the release boundary and the released suffix frames
		// both keep the continuing mouse bit
		const frames = [frame(0, 1), frame(100, 5), frame(148, 5), frame(200, 1), frame(300, 0)];
		const run = runAt(frames, "K1", 1);
		const { sets, inserts } = expansionParts(expandRetimePress(frames, run, { end: 130 }, null, "this retime"));
		expect(inserts.map((f) => [f.time, f.buttons])).toEqual([[130, 1]]);
		expect(sets).toEqual([{ index: 2, buttons: 1 }]);
	});

	test("a released prefix keeps the paired bit only where it connects left", () => {
		// pure keyboard tap: moving the start later must not leave a phantom
		// independent mouse press behind
		const frames = [frame(0, 0), frame(100, 5), frame(150, 5), frame(200, 0), frame(300, 0)];
		const run = runAt(frames, "K1", 1);
		const after = applyExpansion(frames, expandRetimePress(frames, run, { start: 150 }, null, "this retime"));
		expect(after.map((f) => f.buttons)).toEqual([0, 0, 5, 0, 0]);

		// the same shape inside a mouse hold keeps the bit: the hold connects
		const held = [frame(0, 1), frame(100, 5), frame(150, 5), frame(200, 1), frame(300, 0)];
		const heldRun = runAt(held, "K1", 1);
		const afterHeld = applyExpansion(held, expandRetimePress(held, heldRun, { start: 150 }, null, "this retime"));
		expect(afterHeld.map((f) => f.buttons)).toEqual([1, 1, 5, 1, 0]);
	});
});

describe("retime: nudges along existing frames", () => {
	const frames = [
		frame(0, 0),
		frame(84, 0),
		frame(100, 5),
		frame(116, 5),
		frame(132, 5),
		frame(148, 0),
		frame(164, 0)
	];

	test("stepping the start one frame earlier presses the previous frame, inserting nothing", () => {
		const run = runAt(frames, "K1", 2);
		const target = adjacentFrameTime(frames, run.startTime, -1);
		expect(target).toBe(84);
		const { sets, inserts } = expansionParts(
			expandRetimePress(frames, run, { start: target as number }, null, "this nudge")
		);
		expect(inserts).toEqual([]);
		expect(sets).toEqual([{ index: 1, buttons: 5 }]);
	});

	test("stepping the end one frame later presses the old fall frame", () => {
		const run = runAt(frames, "K1", 2);
		const target = adjacentFrameTime(frames, run.endTime, 1);
		expect(target).toBe(164);
		const { sets, inserts } = expansionParts(
			expandRetimePress(frames, run, { end: target as number }, null, "this nudge")
		);
		expect(inserts).toEqual([]);
		expect(sets).toEqual([{ index: 5, buttons: 5 }]);
	});

	test("the nudged edge's new identity is the outcome", () => {
		const run = runAt(frames, "K1", 2);
		const expansion = expandRetimePress(frames, run, { start: 116 }, null, "this nudge");
		if ("rejected" in expansion) throw new Error(expansion.rejected);
		expect(expansion.outcome).toEqual({ key: "K1", startTime: 116 });
		const after = applyExpansion(frames, expansion);
		expect(outcomeSelection(after, expansion.outcome)).toEqual({ key: "K1", startIndex: 3 });
	});
});

describe("retime: merges", () => {
	test("extending an end to meet the next same-key press merges them into one", () => {
		const frames = [frame(0, 0), frame(100, 5), frame(150, 0), frame(200, 5), frame(250, 0), frame(300, 0)];
		const run = runAt(frames, "K1", 1);
		const expansion = expandRetimePress(frames, run, { end: 200 }, null, "this retime");
		if ("rejected" in expansion) throw new Error(expansion.rejected);
		const after = applyExpansion(frames, expansion);
		expect(pressRunAt(after, "K1", 100)).toMatchObject({ startTime: 100, endTime: 250 });
		// no release boundary is written at the meeting point
		expect(expansionParts(expansion).inserts).toEqual([]);
		expect(expansion.realized).toEqual({ startTime: 100, endTime: 250 });
	});

	test("extending a start back over the previous press's fall merges backward, outcome at the merged start", () => {
		const frames = [frame(0, 0), frame(100, 5), frame(150, 0), frame(200, 5), frame(250, 0), frame(300, 0)];
		const run = runAt(frames, "K1", 3);
		const expansion = expandRetimePress(frames, run, { start: 150 }, null, "this retime");
		if ("rejected" in expansion) throw new Error(expansion.rejected);
		const after = applyExpansion(frames, expansion);
		expect(pressRunAt(after, "K1", 100)).toMatchObject({ startTime: 100, endTime: 250 });
		expect(expansion.outcome).toEqual({ key: "K1", startTime: 100 });
	});

	test("a release boundary past the gap does not merge with a later press", () => {
		// requested end 160 sits well before the next press at 200: the
		// boundary release separates them and no merge happens
		const frames = [frame(0, 0), frame(100, 5), frame(140, 5), frame(200, 5), frame(250, 0), frame(300, 0)];
		const run = runAt(frames, "K1", 1);
		// the run here spans 100..250 (frames at 140 and 200 are all held);
		// shrink the end to 160: released frames at 200 plus a boundary at 160
		const { sets, inserts } = expansionParts(expandRetimePress(frames, run, { end: 160 }, null, "this retime"));
		expect(inserts.map((f) => [f.time, f.buttons])).toEqual([[160, 0]]);
		expect(sets).toEqual([{ index: 3, buttons: 0 }]);
	});
});

describe("retime: degenerate rejection", () => {
	const frames = [frame(0, 0), frame(100, 5), frame(116, 0), frame(132, 0)];

	test("an edit collapsing the press to zero length is rejected before any ops are built", () => {
		const run = runAt(frames, "K1", 1);
		const expansion = expandRetimePress(frames, run, { start: 116 }, null, "this nudge");
		expect("rejected" in expansion).toBe(true);
		if ("rejected" in expansion) expect(expansion.rejected).toContain("K1");
	});

	test("crossing edges are rejected", () => {
		const run = runAt(frames, "K1", 1);
		const expansion = expandRetimePress(frames, run, { end: 50 }, null, "this retime");
		expect("rejected" in expansion).toBe(true);
	});
});

describe("retime: open runs", () => {
	test("leaving an open run's end untouched writes no release", () => {
		const frames = [frame(0, 0), frame(84, 0), frame(100, 5), frame(116, 5)];
		const run = runAt(frames, "K1", 2);
		const { sets, inserts } = expansionParts(expandRetimePress(frames, run, { start: 84 }, null, "this nudge"));
		expect(sets).toEqual([{ index: 1, buttons: 5 }]);
		expect(inserts).toEqual([]);
	});

	test("retiming an open run's end writes the release it never had", () => {
		const frames = [frame(0, 0), frame(100, 5), frame(116, 5), frame(132, 5)];
		const run = runAt(frames, "K1", 1);
		const after = applyExpansion(frames, expandRetimePress(frames, run, { end: 116 }, null, "this retime"));
		expect(after.map((f) => f.buttons)).toEqual([0, 5, 0, 0]);
	});
});

describe("retime: duplicate-time edge preservation", () => {
	test("an end-only retime leaves an unheld duplicate at the start's millisecond untouched", () => {
		// the run rises at the second frame of the 100 ms pair; retiming only
		// the end must not press the released duplicate before it
		const frames = [frame(0, 0), frame(100, 0), frame(100, 5), frame(140, 5), frame(160, 0), frame(200, 0)];
		const expansion = expandRetimePress(frames, runAt(frames, "K1", 2), { end: 200 }, null, "this retime");
		if ("rejected" in expansion) throw new Error(expansion.rejected);
		const after = applyExpansion(frames, expansion);
		expect(after.map((f) => f.buttons)).toEqual([0, 0, 5, 5, 5, 0]);
		expect(expansion.realized).toEqual({ startTime: 100, endTime: 200 });
	});

	test("a start-only retime leaves a held duplicate at the fall's millisecond held", () => {
		// the last held frame shares its millisecond with the fall; retiming
		// only the start must not release it
		const frames = [frame(0, 0), frame(100, 5), frame(140, 5), frame(160, 5), frame(160, 0), frame(200, 0)];
		const expansion = expandRetimePress(frames, runAt(frames, "K1", 1), { start: 140 }, null, "this retime");
		const after = applyExpansion(frames, expansion);
		expect(after.map((f) => f.buttons)).toEqual([0, 0, 5, 5, 0, 0]);
	});

	test("an untouched end does not merge with a re-press at the fall's millisecond", () => {
		// a re-press rises at the same millisecond the run falls; a
		// start-only retime must leave the neighbour a distinct press
		const frames = [
			frame(0, 0),
			frame(100, 5),
			frame(140, 5),
			frame(160, 0),
			frame(160, 5),
			frame(200, 5),
			frame(220, 0)
		];
		const expansion = expandRetimePress(frames, runAt(frames, "K1", 1), { start: 140 }, null, "this retime");
		if ("rejected" in expansion) throw new Error(expansion.rejected);
		expect(expansion.realized).toEqual({ startTime: 140, endTime: 160 });
		const after = applyExpansion(frames, expansion);
		expect(after.map((f) => f.buttons)).toEqual([0, 0, 5, 0, 5, 5, 0]);
	});

	test("an end-only retime is not rejected by a paired-key duplicate at the start's millisecond", () => {
		// a K1 tap hands off to an M1 press within one millisecond: the K1
		// duplicate sits before the M1 rise, outside the run
		const frames = [frame(0, 0), frame(100, 5), frame(100, 1), frame(140, 1), frame(160, 0), frame(200, 0)];
		const expansion = expandRetimePress(frames, runAt(frames, "M1", 2), { end: 200 }, null, "this retime");
		if ("rejected" in expansion) throw new Error(expansion.rejected);
		const after = applyExpansion(frames, expansion);
		expect(after.map((f) => f.buttons)).toEqual([0, 5, 1, 1, 1, 0]);
	});
});

describe("frame-time helpers", () => {
	const frames = [frame(0, 0), frame(16, 0), frame(16, 0), frame(48, 0)];

	test("adjacentFrameTime skips duplicate-time runs and stops at the stream's ends", () => {
		expect(adjacentFrameTime(frames, 16, 1)).toBe(48);
		expect(adjacentFrameTime(frames, 16, -1)).toBe(0);
		expect(adjacentFrameTime(frames, 0, -1)).toBeNull();
		expect(adjacentFrameTime(frames, 48, 1)).toBeNull();
	});

	test("nearestFrameTime picks the nearer frame, earlier on a tie", () => {
		expect(nearestFrameTime(frames, 20)).toBe(16);
		expect(nearestFrameTime(frames, 40)).toBe(48);
		expect(nearestFrameTime(frames, 32)).toBe(16);
		expect(nearestFrameTime(frames, -10)).toBe(0);
		expect(nearestFrameTime(frames, 100)).toBe(48);
		expect(nearestFrameTime([], 10)).toBeNull();
	});
});
