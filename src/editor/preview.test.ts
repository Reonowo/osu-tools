import { describe, expect, test } from "bun:test";
import type { EditOp, FrameDto } from "../lib/scene-types";
import {
	GesturePreview,
	opsToAuthoritative,
	previewedPathPoints,
	selectionToAuthoritative,
	snapshotIsEmpty
} from "./preview";

function frame(time: number, x = 0, y = 0, buttons = 0): FrameDto {
	return { time, x, y, buttons };
}

const frames: FrameDto[] = [frame(0, 10, 10), frame(16, 20, 20), frame(32, 30, 30), frame(48, 40, 40)];

function moveOp(index: number, x: number, y: number): EditOp {
	return { kind: "moveFrames", moves: [{ index, x, y }] };
}

describe("live gesture preview", () => {
	test("an empty preview returns the identity view without cloning", () => {
		const preview = new GesturePreview();
		const view = preview.displayed(frames);
		expect(view.frames).toBe(frames);
		expect(view.source).toBeNull();
		// the null map is the identity for both translations
		expect(selectionToAuthoritative([1, 3], null)).toEqual([1, 3]);
		const ops: EditOp[] = [moveOp(2, 9, 9)];
		expect(opsToAuthoritative(ops, null)).toBe(ops);
	});

	test("setLive ops show in the snapshot and displayed stream", () => {
		const preview = new GesturePreview();
		preview.setLive([moveOp(1, 99, 98)]);
		expect(preview.snapshot().moved.get(1)).toEqual({ x: 99, y: 98 });
		const { frames: displayed, source } = preview.displayed(frames);
		expect(displayed[1]).toEqual({ ...frames[1], x: 99, y: 98 });
		expect(source).toEqual([0, 1, 2, 3]);
	});

	test("setLive(null) discards; the snapshot epoch moves every write", () => {
		const preview = new GesturePreview();
		const before = preview.snapshot().epoch;
		preview.setLive([moveOp(0, 1, 1)]);
		const during = preview.snapshot().epoch;
		preview.setLive(null);
		const after = preview.snapshot();
		expect(during).toBeGreaterThan(before);
		expect(after.epoch).toBeGreaterThan(during);
		expect(after.moved.size).toBe(0);
	});
});

describe("pending entries", () => {
	test("freezeLive keeps the ops visible until the landed delta is rendered", () => {
		const preview = new GesturePreview();
		preview.setLive([moveOp(2, 7, 7)]);
		const id = preview.freezeLive();
		expect(preview.snapshot().moved.get(2)).toEqual({ x: 7, y: 7 });
		preview.settle(id, "landed");
		// still visible: the store installed the delta but the renderer has not
		// been re-fed, so removal now would flash the pre-edit state
		expect(preview.snapshot().moved.get(2)).toEqual({ x: 7, y: 7 });
		preview.settleRendered();
		expect(preview.snapshot().moved.size).toBe(0);
	});

	test("skipped, cancelled, and failed remove immediately (the snap-back)", () => {
		for (const outcome of ["skipped", "cancelled", "failed"] as const) {
			const preview = new GesturePreview();
			preview.setLive([moveOp(1, 5, 5)]);
			const id = preview.freezeLive();
			preview.settle(id, outcome);
			expect(preview.snapshot().moved.size).toBe(0);
		}
	});

	test("update() regenerates an entry from the dispatch payload; null discards", () => {
		const preview = new GesturePreview();
		preview.setLive([moveOp(1, 5, 5)]);
		const id = preview.freezeLive();
		preview.update(id, [moveOp(1, 6, 6)]);
		expect(preview.snapshot().moved.get(1)).toEqual({ x: 6, y: 6 });
		preview.update(id, null);
		expect(preview.snapshot().moved.size).toBe(0);
	});

	test("the pending displayed view is memoized per epoch and frames identity", () => {
		const preview = new GesturePreview();
		preview.setLive([moveOp(1, 5, 5)]);
		const first = preview.displayed(frames);
		expect(preview.displayed(frames)).toBe(first);
		// any write bumps the epoch and invalidates the memo
		preview.setLive([moveOp(1, 6, 6)]);
		expect(preview.displayed(frames)).not.toBe(first);
	});

	test("entries merge oldest-first, a newer gesture over an older one", () => {
		const preview = new GesturePreview();
		preview.setLive([moveOp(1, 5, 5)]);
		preview.freezeLive();
		preview.setLive([moveOp(1, 9, 9)]);
		expect(preview.snapshot().moved.get(1)).toEqual({ x: 9, y: 9 });
	});
});

describe("erase previews", () => {
	test("deleted frames hide and boundary frames merge into the displayed stream", () => {
		const preview = new GesturePreview();
		preview.setLive([
			{ kind: "deleteFrames", indices: [1, 2] },
			{ kind: "insertFrames", frames: [frame(24, 25, 25, 1)] }
		]);
		const { frames: displayed, source } = preview.displayed(frames);
		expect(displayed.map((f) => f.time)).toEqual([0, 24, 48]);
		expect(source).toEqual([0, null, 3]);
		expect(preview.snapshot().hidden).toEqual(new Set([1, 2]));
	});

	test("a boundary frame at an existing time lands after the surviving frame, like the engine's insert", () => {
		const preview = new GesturePreview();
		preview.setLive([{ kind: "insertFrames", frames: [frame(16, 1, 1)] }]);
		const { frames: displayed, source } = preview.displayed(frames);
		expect(displayed.map((f) => f.time)).toEqual([0, 16, 16, 32, 48]);
		expect(source).toEqual([0, 1, null, 2, 3]);
	});

	test("a press-edge rewrite reaches the snapshot and the displayed gesture base", () => {
		const preview = new GesturePreview();
		const stream = [frame(0, 10, 10, 5), frame(16, 20, 20, 5), frame(32, 30, 30, 0)];
		// an erase relocating the release onto the survivor at index 1
		preview.setLive([
			{ kind: "setButtons", sets: [{ index: 1, buttons: 0 }] },
			{ kind: "deleteFrames", indices: [2] }
		]);
		expect(preview.snapshot().buttons.get(1)).toBe(0);
		const { frames: displayed, source } = preview.displayed(stream);
		// the survivor shows its rewritten pattern before the delta lands, so a
		// following gesture computes against the press topology being committed
		expect(displayed[1].buttons).toBe(0);
		expect(source).toEqual([0, 1]);
	});

	test("a buttons-only preview is not empty", () => {
		const preview = new GesturePreview();
		preview.setLive([{ kind: "setButtons", sets: [{ index: 0, buttons: 2 }] }]);
		expect(snapshotIsEmpty(preview.snapshot())).toBe(false);
	});
});

describe("splice application", () => {
	test("a landing delta remaps still-pending entries like the store's queued ops", () => {
		const preview = new GesturePreview();
		preview.setLive([moveOp(2, 7, 7)]);
		preview.freezeLive();
		// an earlier commit's delta removes frame 0: pending indices shift down
		preview.applySplice({ updated: [], inserted: [], removed: [0] });
		expect(preview.snapshot().moved.get(1)).toEqual({ x: 7, y: 7 });
		expect(preview.snapshot().moved.has(2)).toBe(false);
	});

	test("a landed entry is not remapped through its own splice", () => {
		const preview = new GesturePreview();
		preview.setLive([{ kind: "deleteFrames", indices: [1] }]);
		const id = preview.freezeLive();
		preview.settle(id, "landed");
		preview.applySplice({ updated: [], inserted: [], removed: [1] });
		// still hiding authoritative index 1 until the renderer swap
		expect(preview.snapshot().hidden).toEqual(new Set([1]));
		preview.settleRendered();
		expect(preview.snapshot().hidden.size).toBe(0);
	});

	test("a fullFrames splice discards pending entries and the live gesture, and notifies", () => {
		const preview = new GesturePreview();
		let notified = 0;
		preview.onStructuralSplice(() => {
			notified += 1;
		});
		preview.setLive([moveOp(1, 5, 5)]);
		preview.freezeLive();
		preview.setLive([moveOp(2, 6, 6)]);
		preview.applySplice({ fullFrames: [frame(0)] });
		expect(preview.snapshot().moved.size).toBe(0);
		expect(notified).toBe(1);
	});

	test("structural splices notify; pure-update splices do not", () => {
		const preview = new GesturePreview();
		let notified = 0;
		preview.onStructuralSplice(() => {
			notified += 1;
		});
		preview.applySplice({ updated: [{ index: 0, frame: frame(0, 1, 1) }], inserted: [], removed: [] });
		expect(notified).toBe(0);
		preview.applySplice({ updated: [], inserted: [], removed: [2] });
		expect(notified).toBe(1);
	});
});

describe("previewedPathPoints", () => {
	function snapshotOf(preview: GesturePreview) {
		return preview.snapshot();
	}

	test("moved frames draw at their previewed positions", () => {
		const preview = new GesturePreview();
		preview.setLive([moveOp(1, 99, 98)]);
		const points = previewedPathPoints(frames, 0, 4, snapshotOf(preview), -1, 100);
		expect(points).toEqual([
			{ x: 10, y: 10 },
			{ x: 99, y: 98 },
			{ x: 30, y: 30 },
			{ x: 40, y: 40 }
		]);
	});

	test("hidden frames drop and boundary frames merge in time order", () => {
		const preview = new GesturePreview();
		preview.setLive([
			{ kind: "deleteFrames", indices: [1] },
			{ kind: "insertFrames", frames: [frame(24, 25, 26, 0)] }
		]);
		const points = previewedPathPoints(frames, 0, 4, snapshotOf(preview), -1, 100);
		expect(points).toEqual([
			{ x: 10, y: 10 },
			{ x: 25, y: 26 },
			{ x: 30, y: 30 },
			{ x: 40, y: 40 }
		]);
	});

	test("a boundary frame at a surviving frame's ms draws after it, like the engine's tie rule", () => {
		const preview = new GesturePreview();
		preview.setLive([{ kind: "insertFrames", frames: [frame(16, 1, 2, 0)] }]);
		const points = previewedPathPoints(frames, 0, 2, snapshotOf(preview), -1, 100);
		expect(points).toEqual([
			{ x: 10, y: 10 },
			{ x: 20, y: 20 },
			{ x: 1, y: 2 }
		]);
	});

	test("boundary frames outside the window stay out", () => {
		const preview = new GesturePreview();
		preview.setLive([{ kind: "insertFrames", frames: [frame(100, 1, 1, 0), frame(24, 2, 2, 0)] }]);
		const points = previewedPathPoints(frames, 0, 4, snapshotOf(preview), -1, 50);
		expect(points.map((p) => p.x)).toEqual([10, 20, 2, 30, 40]);
	});

	test("snapshotIsEmpty distinguishes an idle preview from a live one", () => {
		const preview = new GesturePreview();
		expect(snapshotIsEmpty(preview.snapshot())).toBe(true);
		preview.setLive([moveOp(0, 1, 1)]);
		expect(snapshotIsEmpty(preview.snapshot())).toBe(false);
	});
});

describe("displayed -> authoritative translation", () => {
	// a source map with a pending-deleted frame gone (auth 1 absent) and a
	// pending boundary insert (null) between survivors
	const source: (number | null)[] = [0, null, 2, 3];

	test("selection indices translate and pending inserts drop", () => {
		expect(selectionToAuthoritative([0, 1, 2], source)).toEqual([0, 2]);
		expect(selectionToAuthoritative([], source)).toEqual([]);
	});

	test("op indices translate per member; an op losing every target drops whole", () => {
		const ops: EditOp[] = [
			{
				kind: "moveFrames",
				moves: [
					{ index: 1, x: 5, y: 5 },
					{ index: 2, x: 6, y: 6 }
				]
			},
			{ kind: "deleteFrames", indices: [1] },
			{ kind: "setButtons", sets: [{ index: 3, buttons: 5 }] },
			{ kind: "insertFrames", frames: [frame(10, 1, 1)] }
		];
		expect(opsToAuthoritative(ops, source)).toEqual([
			{ kind: "moveFrames", moves: [{ index: 2, x: 6, y: 6 }] },
			{ kind: "setButtons", sets: [{ index: 3, buttons: 5 }] },
			{ kind: "insertFrames", frames: [frame(10, 1, 1)] }
		]);
	});

	test("an identity source map passes everything through", () => {
		const ops: EditOp[] = [{ kind: "moveFrames", moves: [{ index: 2, x: 1, y: 1 }] }];
		expect(opsToAuthoritative(ops, [0, 1, 2, 3])).toEqual(ops);
	});
});

describe("discardAll", () => {
	test("clears entries, the live gesture, and the chrome shapes", () => {
		const preview = new GesturePreview();
		preview.setLive([moveOp(0, 1, 1)]);
		preview.freezeLive();
		preview.setLive([moveOp(1, 2, 2)]);
		preview.setShape({ kind: "marquee", a: { x: 0, y: 0 }, b: { x: 1, y: 1 } });
		preview.setBrush({ x: 0, y: 0, radius: 5 });
		preview.discardAll();
		expect(preview.hasPending).toBe(false);
		expect(preview.snapshot().moved.size).toBe(0);
		expect(preview.shape).toBeNull();
		expect(preview.brush).toBeNull();
	});
});
