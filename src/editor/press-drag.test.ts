import { describe, expect, test } from "bun:test";
import type { FrameDto } from "../lib/scene-types";
import { PressDragController, type PressDragEnv } from "./press-drag";
import { expandRetimePress } from "./press-ops";
import { pressRunFromIndex } from "./press-runs";

function frame(time: number, buttons: number): FrameDto {
	return { time, x: time, y: 100, buttons };
}

// two K1 presses: [100, 160) and [300, 360), with plain frames between
const FRAMES = [
	frame(0, 0),
	frame(100, 5),
	frame(120, 5),
	frame(140, 5),
	frame(160, 0),
	frame(200, 0),
	frame(300, 5),
	frame(340, 5),
	frame(360, 0),
	frame(400, 0)
];

function env(overrides: Partial<PressDragEnv> = {}): PressDragEnv {
	return { key: "K1", frames: FRAMES, msPerPx: 1, slopPx: 4, edgeZonePx: 5, lattice: null, ...overrides };
}

describe("zone grammar and select-and-drag", () => {
	test("pointer-down on a span body selects its press and pauses in one gesture", () => {
		const controller = new PressDragController();
		const fx = controller.pointerDown(130, env());
		expect(fx.select).toEqual({ key: "K1", startIndex: 1 });
		expect(fx.pause).toBe(true);
		expect(controller.live).toBe(true);
	});

	test("a body drag moves the whole press, both edges frame-snapped, duration approximately preserved", () => {
		const controller = new PressDragController();
		controller.pointerDown(130, env());
		const fx = controller.pointerMove(170);
		// start 100+40 snaps to 140, end 160+40 snaps to 200
		expect(fx.preview?.span).toEqual({ start: 140, end: 200 });
		// the preview names the dragged run: a consumer keyed to the selection
		// must be able to ignore a preview that lingers (until its commit
		// settles) into another same-key run's selection
		expect(fx.preview?.runStartIndex).toBe(1);
		const up = controller.pointerUp(170);
		expect(up.commit?.edit).toEqual({ start: 140, end: 200 });
	});

	test("a drag near the start edge retimes that edge alone", () => {
		const controller = new PressDragController();
		controller.pointerDown(102, env());
		const fx = controller.pointerMove(122);
		expect(fx.preview?.span).toEqual({ start: 120, end: 160 });
		const up = controller.pointerUp(122);
		expect(up.commit?.edit).toEqual({ start: 120 });
	});

	test("a drag near the end edge retimes that edge alone", () => {
		const controller = new PressDragController();
		controller.pointerDown(158, env());
		const fx = controller.pointerMove(198);
		expect(fx.preview?.span).toEqual({ start: 100, end: 200 });
		expect(controller.pointerUp(198).commit?.edit).toEqual({ end: 200 });
	});

	test("a near-miss within the edge zone still grabs the nearer edge", () => {
		const controller = new PressDragController();
		const fx = controller.pointerDown(163, env());
		expect(fx.select).toEqual({ key: "K1", startIndex: 1 });
	});

	test("a run shorter than the edge zone is still grabbed from just outside it", () => {
		// edge zone = 150 ms: the whole [100, 160) run fits inside it, so a
		// point probe at time ± edgeMs would sample past the run entirely
		const controller = new PressDragController();
		const fx = controller.pointerDown(200, env({ msPerPx: 30 }));
		expect(fx.select).toEqual({ key: "K1", startIndex: 1 });
		// the grab is the end edge, and the commit names the dragged run
		controller.pointerMove(330);
		const up = controller.pointerUp(330);
		expect(up.commit).toEqual({ key: "K1", runStartTime: 100, edit: { end: 300 } });
	});
});

describe("click-vs-drag slop", () => {
	test("pointer travel within the slop stays a plain select: no preview, no commit", () => {
		const controller = new PressDragController();
		controller.pointerDown(130, env());
		expect(controller.pointerMove(133).preview).toBeUndefined();
		const up = controller.pointerUp(133);
		expect(up.commit).toBeUndefined();
		expect(up.preview).toBeUndefined();
	});

	test("a click on empty hold-lane space clears the selection; a drag from empty does nothing", () => {
		const controller = new PressDragController();
		expect(controller.pointerDown(250, env()).select).toBeUndefined();
		expect(controller.pointerUp(251).clearSelection).toBe(true);

		controller.pointerDown(250, env());
		controller.pointerMove(270);
		expect(controller.pointerUp(270)).toEqual({});
	});
});

describe("merged-outcome preview", () => {
	test("dragging an end into the next same-key press previews the merged span", () => {
		const controller = new PressDragController();
		controller.pointerDown(158, env());
		const fx = controller.pointerMove(298);
		// end lands on 300 -- the next press's start -- so the spans meet
		// and the preview shows the union through that press's fall
		expect(fx.preview?.span).toEqual({ start: 100, end: 360 });
		expect(fx.preview?.hide).toEqual([{ from: 100, to: 360 }]);
	});

	test("a body drag past a disjoint same-key press keeps that press outside the hidden ranges", () => {
		// presses [100, 140) and [200, 240): dragging the first to [300, 340)
		// flies over the second without touching it -- the hide ranges are
		// the old span and the landing, never the untouched press between
		const frames = [
			frame(0, 0),
			frame(100, 5),
			frame(120, 5),
			frame(140, 0),
			frame(200, 5),
			frame(220, 5),
			frame(240, 0),
			frame(300, 0),
			frame(320, 0),
			frame(340, 0),
			frame(400, 0)
		];
		const controller = new PressDragController();
		controller.pointerDown(120, env({ frames }));
		const fx = controller.pointerMove(320);
		expect(fx.preview?.span).toEqual({ start: 300, end: 340 });
		expect(fx.preview?.hide).toEqual([
			{ from: 100, to: 140 },
			{ from: 300, to: 340 }
		]);
	});
});

describe("sticky last-valid landing", () => {
	test("a landing the expansion refuses keeps the last valid preview, and release commits it", () => {
		const controller = new PressDragController();
		controller.pointerDown(102, env());
		const valid = controller.pointerMove(142);
		expect(valid.preview?.span).toEqual({ start: 140, end: 160 });
		// dragging the start onto the release frame would collapse the
		// press: the drag cannot reach it
		const refused = controller.pointerMove(162);
		expect(refused.preview?.span).toEqual({ start: 140, end: 160 });
		const up = controller.pointerUp(162);
		expect(up.commit?.edit).toEqual({ start: 140 });
		expect(up.preview?.span).toEqual({ start: 140, end: 160 });
	});
});

describe("cancellation", () => {
	test("Escape cancels a live drag: preview discarded, nothing committed, controller idle", () => {
		const controller = new PressDragController();
		controller.pointerDown(130, env());
		controller.pointerMove(170);
		const fx = controller.cancel();
		expect(fx.preview).toBeNull();
		expect(controller.live).toBe(false);
		expect(controller.pointerUp(170)).toEqual({});
	});
});

describe("preview equals commit", () => {
	test("the committed edit re-expands to exactly the previewed realized span", () => {
		const controller = new PressDragController();
		controller.pointerDown(130, env());
		const previewed = controller.pointerMove(170).preview;
		const up = controller.pointerUp(170);
		const run = pressRunFromIndex(FRAMES, "K1", 1);
		if (run === null || up.commit === undefined || previewed === undefined || previewed === null) {
			throw new Error("expected a live commit and preview");
		}
		const expansion = expandRetimePress(FRAMES, run, up.commit.edit, null, "this drag");
		if ("rejected" in expansion) throw new Error(expansion.rejected);
		expect(expansion.realized).toEqual({ startTime: previewed.span.start, endTime: previewed.span.end });
	});
});
