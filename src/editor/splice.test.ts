import { describe, expect, test } from "bun:test";
import type { FrameChanges, FrameDto } from "../lib/scene-types";
import { applyFrameChanges, remapIndex, remapQueuedOps, remapSelection } from "./splice";

function frame(time: number, x = 0): FrameDto {
	return { time, x, y: 0, buttons: 0 };
}

// pre-op stream [t0, t1, t2, t3]; the delta deletes t1 (pre 1), inserts at
// post 1, and rewrites the frame now at post 3 (previously t3)
const mixed: FrameChanges = {
	removed: [1],
	inserted: [{ index: 1, frame: frame(150) }],
	updated: [{ index: 3, frame: frame(300, 99) }]
};

describe("applyFrameChanges", () => {
	test("applies removals desc, then insertions, then updates", () => {
		const pre = [frame(0), frame(100), frame(200), frame(300)];
		const post = applyFrameChanges(pre, mixed);
		expect(post.map((f) => f.time)).toEqual([0, 150, 200, 300]);
		expect(post[3].x).toBe(99);
		// the input array is untouched
		expect(pre[3].x).toBe(0);
	});

	test("fullFrames replaces wholesale", () => {
		const post = applyFrameChanges([frame(0)], { fullFrames: [frame(1), frame(2)] });
		expect(post.map((f) => f.time)).toEqual([1, 2]);
	});
});

describe("remapIndex", () => {
	test("a deleted frame's index maps to null", () => {
		expect(remapIndex(1, mixed)).toBeNull();
	});

	test("indices shift down past removals and up past insertions", () => {
		// pre 0 -> post 0 (insert at 1 lands after it)
		expect(remapIndex(0, mixed)).toBe(0);
		// pre 2 -> minus the removal below (1), plus the insert at 1 (2)
		expect(remapIndex(2, mixed)).toBe(2);
		expect(remapIndex(3, mixed)).toBe(3);
	});

	test("fullFrames admits no remap", () => {
		expect(remapIndex(0, { fullFrames: [frame(0)] })).toBeNull();
	});
});

describe("remapSelection", () => {
	test("drops deleted members and keeps order", () => {
		expect(remapSelection([0, 1, 3], mixed)).toEqual([0, 3]);
	});
});

describe("remapQueuedOps", () => {
	test("remaps move and delete targets, dropping dead members", () => {
		const ops = remapQueuedOps(
			[
				{
					kind: "moveFrames",
					moves: [
						{ index: 1, x: 5, y: 5 },
						{ index: 2, x: 6, y: 6 }
					]
				},
				{ kind: "deleteFrames", indices: [3] }
			],
			mixed
		);
		expect(ops).toEqual([
			{ kind: "moveFrames", moves: [{ index: 2, x: 6, y: 6 }] },
			{ kind: "deleteFrames", indices: [3] }
		]);
	});

	test("a payload with nothing left reports null", () => {
		expect(remapQueuedOps([{ kind: "deleteFrames", indices: [1] }], mixed)).toBeNull();
	});

	test("inserts and metadata pass through untouched", () => {
		const ops = remapQueuedOps(
			[
				{ kind: "insertFrames", frames: [frame(500)] },
				{ kind: "setPlayerName", name: "p" }
			],
			mixed
		);
		expect(ops).toEqual([
			{ kind: "insertFrames", frames: [frame(500)] },
			{ kind: "setPlayerName", name: "p" }
		]);
	});
});
