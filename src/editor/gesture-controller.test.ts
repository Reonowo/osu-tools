import { describe, expect, test } from "bun:test";
import type { EditOp, FrameDto } from "../lib/scene-types";
import { GestureController, type GestureEnv } from "./gesture-controller";
import { smoothMoveOps } from "./smooth";

function frame(time: number, x: number, y: number, buttons = 0): FrameDto {
	return { time, x, y, buttons };
}

/** five frames strung left to right, 16ms apart, 50 osu!px spacing */
const frames: FrameDto[] = [
	frame(0, 100, 100),
	frame(16, 150, 100),
	frame(32, 200, 100),
	frame(48, 250, 100),
	frame(64, 300, 100)
];

function env(overrides: Partial<GestureEnv> = {}): GestureEnv {
	return {
		tool: "select",
		frames,
		candidates: [0, 1, 2, 3, 4],
		selection: [],
		hitRadius: 12,
		slop: 4,
		brushRadius: 24,
		featherMs: 40,
		strength: 100,
		snap: false,
		lattice: null,
		...overrides
	};
}

describe("select tool: click", () => {
	test("a click within the hit threshold replaces the selection with that frame", () => {
		const controller = new GestureController();
		controller.pointerDown({ x: 148, y: 103 }, false, env({ selection: [4] }));
		const fx = controller.pointerUp({ x: 148, y: 103 });
		expect(fx.selection).toEqual([1]);
		expect(controller.live).toBe(false);
	});

	test("a click picks the nearest frame when several are within the threshold", () => {
		const controller = new GestureController();
		const tight = env({
			frames: [frame(0, 100, 100), frame(16, 108, 100)],
			candidates: [0, 1]
		});
		controller.pointerDown({ x: 106, y: 100 }, false, tight);
		expect(controller.pointerUp({ x: 106, y: 100 }).selection).toEqual([1]);
	});

	test("an empty-space plain click clears the selection", () => {
		const controller = new GestureController();
		controller.pointerDown({ x: 400, y: 300 }, false, env({ selection: [1, 2] }));
		expect(controller.pointerUp({ x: 400, y: 300 }).selection).toEqual([]);
	});

	test("select gestures never ask for a pause", () => {
		const controller = new GestureController();
		const fx = controller.pointerDown({ x: 148, y: 100 }, false, env());
		expect(fx.pause).toBeUndefined();
	});
});

describe("select tool: shift-click", () => {
	test("toggles an unselected frame in", () => {
		const controller = new GestureController();
		controller.pointerDown({ x: 200, y: 100 }, true, env({ selection: [0] }));
		expect(controller.pointerUp({ x: 200, y: 100 }).selection).toEqual([0, 2]);
	});

	test("toggles a selected frame out", () => {
		const controller = new GestureController();
		controller.pointerDown({ x: 200, y: 100 }, true, env({ selection: [0, 2] }));
		expect(controller.pointerUp({ x: 200, y: 100 }).selection).toEqual([0]);
	});

	test("an empty-space shift-click leaves the selection alone", () => {
		const controller = new GestureController();
		controller.pointerDown({ x: 400, y: 300 }, true, env({ selection: [1] }));
		expect(controller.pointerUp({ x: 400, y: 300 }).selection).toBeUndefined();
	});
});

describe("candidate gating", () => {
	test("frames outside the candidate window cannot be selected, even under the pointer", () => {
		const controller = new GestureController();
		controller.pointerDown({ x: 100, y: 100 }, false, env({ candidates: [3, 4], selection: [3] }));
		// frame 0 sits exactly under the click but is not a candidate: the
		// click is an empty-space click and clears
		expect(controller.pointerUp({ x: 100, y: 100 }).selection).toEqual([]);
	});
});

describe("select tool: marquee", () => {
	test("pointer travel at or under the slop stays a click; past it, a marquee", () => {
		const atSlop = new GestureController();
		atSlop.pointerDown({ x: 148, y: 100 }, false, env());
		atSlop.pointerMove({ x: 152, y: 100 });
		expect(atSlop.pointerUp({ x: 152, y: 100 }).selection).toEqual([1]);

		const pastSlop = new GestureController();
		pastSlop.pointerDown({ x: 148, y: 100 }, false, env());
		const during = pastSlop.pointerMove({ x: 152.5, y: 100 });
		expect(during.shape).toEqual({ kind: "marquee", a: { x: 148, y: 100 }, b: { x: 152.5, y: 100 } });
	});

	test("a plain marquee replaces the selection with the contained frames", () => {
		const controller = new GestureController();
		controller.pointerDown({ x: 90, y: 90 }, false, env({ selection: [4] }));
		controller.pointerMove({ x: 210, y: 110 });
		const fx = controller.pointerUp({ x: 210, y: 110 });
		expect(fx.selection).toEqual([0, 1, 2]);
		expect(fx.shape).toBeNull();
	});

	test("a shift-marquee adds to the selection", () => {
		const controller = new GestureController();
		controller.pointerDown({ x: 90, y: 90 }, true, env({ selection: [4] }));
		controller.pointerMove({ x: 160, y: 110 });
		expect(controller.pointerUp({ x: 160, y: 110 }).selection).toEqual([0, 1, 4]);
	});

	test("the rectangle tracks the pointer while dragging and disappears on release", () => {
		const controller = new GestureController();
		controller.pointerDown({ x: 0, y: 0 }, false, env());
		controller.pointerMove({ x: 50, y: 50 });
		const during = controller.pointerMove({ x: 80, y: 60 });
		expect(during.shape).toEqual({ kind: "marquee", a: { x: 0, y: 0 }, b: { x: 80, y: 60 } });
		expect(controller.pointerUp({ x: 80, y: 60 }).shape).toBeNull();
	});

	test("only frozen candidates are eligible, whatever the rectangle covers", () => {
		const controller = new GestureController();
		controller.pointerDown({ x: 0, y: 0 }, false, env({ candidates: [1, 2] }));
		controller.pointerMove({ x: 512, y: 384 });
		expect(controller.pointerUp({ x: 512, y: 384 }).selection).toEqual([1, 2]);
	});

	test("an empty plain marquee clears; an empty shift-marquee changes nothing", () => {
		const plain = new GestureController();
		plain.pointerDown({ x: 0, y: 0 }, false, env({ selection: [3] }));
		plain.pointerMove({ x: 20, y: 20 });
		expect(plain.pointerUp({ x: 20, y: 20 }).selection).toEqual([]);

		const shifted = new GestureController();
		shifted.pointerDown({ x: 0, y: 0 }, true, env({ selection: [3] }));
		shifted.pointerMove({ x: 20, y: 20 });
		expect(shifted.pointerUp({ x: 20, y: 20 }).selection).toEqual([3]);
	});

	test("Escape mid-marquee drops the shape and leaves the selection alone", () => {
		const controller = new GestureController();
		controller.pointerDown({ x: 0, y: 0 }, false, env({ selection: [3] }));
		controller.pointerMove({ x: 100, y: 100 });
		const fx = controller.cancel();
		expect(fx.shape).toBeNull();
		expect(fx.selection).toBeUndefined();
	});
});

describe("lasso tool", () => {
	/** trace a triangle around frames 0 and 1 (x 100-150, y 100) */
	function traceTriangle(controller: GestureController, shift: boolean, base = env({ tool: "lasso" })) {
		controller.pointerDown({ x: 80, y: 80 }, shift, base);
		controller.pointerMove({ x: 180, y: 80 });
		controller.pointerMove({ x: 130, y: 160 });
		return controller.pointerUp({ x: 130, y: 160 });
	}

	test("a lasso drag traces a shape; release closes the polygon and selects the contained frames", () => {
		const controller = new GestureController();
		controller.pointerDown({ x: 80, y: 80 }, false, env({ tool: "lasso" }));
		const during = controller.pointerMove({ x: 180, y: 80 });
		expect(during.shape?.kind).toBe("lasso");
		const fx = controller.pointerUp({ x: 130, y: 160 });
		expect(fx.shape).toBeNull();
		expect(fx.selection).toEqual([0, 1]);
	});

	test("a plain lasso replaces; a shift-lasso adds", () => {
		expect(traceTriangle(new GestureController(), false, env({ tool: "lasso", selection: [4] })).selection).toEqual(
			[0, 1]
		);
		expect(traceTriangle(new GestureController(), true, env({ tool: "lasso", selection: [4] })).selection).toEqual([
			0, 1, 4
		]);
	});

	test("only frozen candidates are eligible inside the polygon", () => {
		const fx = traceTriangle(new GestureController(), false, env({ tool: "lasso", candidates: [1] }));
		expect(fx.selection).toEqual([1]);
	});

	test("a lasso tap with no travel is a degenerate polygon: plain clears, shift keeps", () => {
		const plain = new GestureController();
		plain.pointerDown({ x: 400, y: 300 }, false, env({ tool: "lasso", selection: [2] }));
		expect(plain.pointerUp({ x: 400, y: 300 }).selection).toEqual([]);

		const shifted = new GestureController();
		shifted.pointerDown({ x: 400, y: 300 }, true, env({ tool: "lasso", selection: [2] }));
		expect(shifted.pointerUp({ x: 400, y: 300 }).selection).toEqual([2]);
	});

	test("Escape mid-lasso drops the shape and commits nothing", () => {
		const controller = new GestureController();
		controller.pointerDown({ x: 80, y: 80 }, false, env({ tool: "lasso", selection: [2] }));
		controller.pointerMove({ x: 180, y: 80 });
		const fx = controller.cancel();
		expect(fx.shape).toBeNull();
		expect(fx.selection).toBeUndefined();
	});
});

describe("move tool", () => {
	function moveEnv(overrides: Partial<GestureEnv> = {}): GestureEnv {
		return env({ tool: "move", featherMs: 0, ...overrides });
	}

	function movesOf(ops: readonly { kind: string }[] | null | undefined): Map<number, { x: number; y: number }> {
		const map = new Map<number, { x: number; y: number }>();
		for (const op of ops ?? []) {
			if (op.kind === "moveFrames") {
				for (const m of (op as { kind: "moveFrames"; moves: { index: number; x: number; y: number }[] })
					.moves) {
					map.set(m.index, { x: m.x, y: m.y });
				}
			}
		}
		return map;
	}

	test("pointer-down on a frame pauses playback; on empty space the gesture edits nothing", () => {
		const onFrame = new GestureController();
		expect(onFrame.pointerDown({ x: 150, y: 100 }, false, moveEnv({ selection: [1] })).pause).toBe(true);

		const onEmpty = new GestureController();
		const fx = onEmpty.pointerDown({ x: 400, y: 300 }, false, moveEnv({ selection: [1] }));
		expect(fx.pause).toBeUndefined();
		expect(fx.selection).toBeUndefined();
		expect(onEmpty.pointerMove({ x: 410, y: 300 }).previewOps).toBeUndefined();
		expect(onEmpty.pointerUp({ x: 410, y: 300 }).commit).toBeUndefined();
	});

	test("an empty-space click clears the selection, without pausing playback", () => {
		// the same rule as the select tool's click-on-miss: letting go of a
		// selection should not need a tool switch or a reach for escape. no
		// pause -- pausing exists to stop the path animating under a mutating
		// drag, and this mutates nothing
		const controller = new GestureController();
		controller.pointerDown({ x: 400, y: 300 }, false, moveEnv({ selection: [1, 2] }));
		const fx = controller.pointerUp({ x: 400, y: 300 });
		expect(fx.selection).toEqual([]);
		expect(fx.pause).toBeUndefined();
		expect(fx.commit).toBeUndefined();
	});

	test("travel inside the slop is still a click, so a shaky press clears too", () => {
		const controller = new GestureController();
		controller.pointerDown({ x: 400, y: 300 }, false, moveEnv({ selection: [1, 2] }));
		controller.pointerMove({ x: 402, y: 301 });
		expect(controller.pointerUp({ x: 402, y: 301 }).selection).toEqual([]);
	});

	test("a drag from empty space leaves the selection alone", () => {
		// a stray drag past the path must not throw the work away
		const controller = new GestureController();
		controller.pointerDown({ x: 400, y: 300 }, false, moveEnv({ selection: [1, 2] }));
		controller.pointerMove({ x: 440, y: 300 });
		const fx = controller.pointerUp({ x: 440, y: 300 });
		expect(fx.selection).toBeUndefined();
		expect(fx.pause).toBeUndefined();
	});

	test("a release past the slop is a drag even when no move was delivered", () => {
		// a coalesced or throttled pointer stream can go straight from down to up:
		// the release is the last travel sample, so the selection survives
		const controller = new GestureController();
		controller.pointerDown({ x: 400, y: 300 }, false, moveEnv({ selection: [1, 2] }));
		const fx = controller.pointerUp({ x: 440, y: 300 });
		expect(fx.selection).toBeUndefined();
		expect(fx.pause).toBeUndefined();
	});

	test("a drag that comes back inside the slop stays a drag", () => {
		// the select tool's own press has the same rule: crossing the slop is
		// one-way, so returning near the origin does not demote it to a click
		const controller = new GestureController();
		controller.pointerDown({ x: 400, y: 300 }, false, moveEnv({ selection: [1, 2] }));
		controller.pointerMove({ x: 440, y: 300 });
		controller.pointerMove({ x: 400, y: 300 });
		expect(controller.pointerUp({ x: 400, y: 300 }).selection).toBeUndefined();
	});

	test("shift+click on empty space clears nothing", () => {
		// shift means refine, and the flag is frozen at pointer-down -- the move
		// tool used to discard it entirely
		const controller = new GestureController();
		controller.pointerDown({ x: 400, y: 300 }, true, moveEnv({ selection: [1, 2] }));
		const fx = controller.pointerUp({ x: 400, y: 300 });
		expect(fx.selection).toBeUndefined();
		expect(fx.pause).toBeUndefined();
	});

	test("a cancelled empty press clears nothing", () => {
		const controller = new GestureController();
		controller.pointerDown({ x: 400, y: 300 }, false, moveEnv({ selection: [1, 2] }));
		expect(controller.cancel().selection).toBeUndefined();
	});

	test("a click with zero travel commits nothing, snap and off-lattice frames notwithstanding", () => {
		const controller = new GestureController();
		const offLattice = [frame(0, 100.3, 100.2), frame(16, 150.3, 100.2)];
		controller.pointerDown(
			{ x: 100, y: 100 },
			false,
			moveEnv({
				frames: offLattice,
				candidates: [0, 1],
				snap: true,
				lattice: { scale: 2, step: 0.5, conformance: 1 }
			})
		);
		const fx = controller.pointerUp({ x: 100, y: 100 });
		expect(fx.commit).toBeUndefined();
		expect(fx.previewOps).toBeNull();
	});

	test("dragging a selected frame moves the whole selection by the translation", () => {
		const controller = new GestureController();
		controller.pointerDown({ x: 150, y: 100 }, false, moveEnv({ selection: [1, 3] }));
		const during = controller.pointerMove({ x: 160, y: 110 });
		const moves = movesOf(during.previewOps);
		expect(moves.get(1)).toEqual({ x: 160, y: 110 });
		expect(moves.get(3)).toEqual({ x: 260, y: 110 });
		expect(moves.has(2)).toBe(false);
	});

	test("dragging an unselected frame selects and moves just that frame, and it stays selected", () => {
		const controller = new GestureController();
		const down = controller.pointerDown({ x: 200, y: 100 }, false, moveEnv({ selection: [0, 1] }));
		expect(down.selection).toEqual([2]);
		controller.pointerMove({ x: 210, y: 100 });
		const fx = controller.pointerUp({ x: 210, y: 100 });
		expect([...movesOf(fx.commit?.ops).keys()]).toEqual([2]);
		// no selection effect on release: the down-time selection persists
		expect(fx.selection).toBeUndefined();
	});

	test("the committed ops equal the last preview's ops exactly", () => {
		const controller = new GestureController();
		controller.pointerDown({ x: 150, y: 100 }, false, moveEnv({ selection: [1] }));
		controller.pointerMove({ x: 155, y: 104 });
		const lastPreview = controller.pointerMove({ x: 157.3, y: 104.9 });
		const fx = controller.pointerUp({ x: 157.3, y: 104.9 });
		expect(fx.commit?.op).toBe("move");
		expect(fx.commit?.ops).toEqual(lastPreview.previewOps!);
		expect(movesOf(fx.commit?.ops).size).toBe(1);
	});

	test("with snap on and a lattice inferred, committed positions land on-lattice", () => {
		const lattice = { scale: 2, step: 0.5, conformance: 1 };
		const controller = new GestureController();
		controller.pointerDown({ x: 150, y: 100 }, false, moveEnv({ selection: [1], snap: true, lattice }));
		controller.pointerMove({ x: 150.3, y: 100.2 });
		const fx = controller.pointerUp({ x: 150.3, y: 100.2 });
		for (const move of movesOf(fx.commit?.ops).values()) {
			expect(Math.abs(move.x / 0.5 - Math.round(move.x / 0.5))).toBeLessThan(1e-3);
		}
	});

	test("a zero-travel press commits nothing and discards the preview", () => {
		const controller = new GestureController();
		controller.pointerDown({ x: 150, y: 100 }, false, moveEnv({ selection: [1] }));
		const fx = controller.pointerUp({ x: 150, y: 100 });
		expect(fx.commit).toBeUndefined();
		expect(fx.previewOps).toBeNull();
	});

	test("Escape mid-drag cancels: no commit, preview discarded, selection intact", () => {
		const controller = new GestureController();
		controller.pointerDown({ x: 150, y: 100 }, false, moveEnv({ selection: [1] }));
		controller.pointerMove({ x: 200, y: 150 });
		const fx = controller.cancel();
		expect(fx.previewOps).toBeNull();
		expect(fx.selection).toBeUndefined();
		expect(controller.pointerUp({ x: 200, y: 150 })).toEqual({});
	});

	test("feather pulls neighbours along, weighted, and they count in the commit", () => {
		// frames 16ms apart; feather 20ms reaches one neighbour each side
		const controller = new GestureController();
		controller.pointerDown({ x: 200, y: 100 }, false, moveEnv({ selection: [2], featherMs: 20 }));
		controller.pointerMove({ x: 200, y: 140 });
		const fx = controller.pointerUp({ x: 200, y: 140 });
		const moves = movesOf(fx.commit?.ops);
		expect(moves.get(2)!.y).toBe(140);
		expect(moves.get(1)!.y).toBeGreaterThan(100);
		expect(moves.get(1)!.y).toBeLessThan(140);
		expect(moves.get(3)!.y).toEqual(moves.get(1)!.y);
		// the feathered frames ride in the same batch, so the counted label
		// derived from these ops names all three
		expect(moves.size).toBe(3);
	});
});

describe("smooth brush", () => {
	// a jittery run: 16ms cadence with y wobbling around 100
	const jitter: FrameDto[] = [
		frame(0, 100, 100),
		frame(16, 116, 118),
		frame(32, 132, 84),
		frame(48, 148, 117),
		frame(64, 164, 100),
		frame(80, 300, 100)
	];

	function smoothEnv(overrides: Partial<GestureEnv> = {}): GestureEnv {
		return env({ tool: "smooth", frames: jitter, candidates: [0, 1, 2, 3, 4, 5], ...overrides });
	}

	test("pointer-down pauses, shows the brush, and sweeps the frames under it", () => {
		const controller = new GestureController();
		const fx = controller.pointerDown({ x: 116, y: 110 }, false, smoothEnv());
		expect(fx.pause).toBe(true);
		expect(fx.brush).toEqual({ x: 116, y: 110 });
		// brushRadius 24 reaches frames 0-2 around that point
		expect(fx.previewOps).not.toBeNull();
	});

	test("dragging accumulates swept frames; the commit covers the union", () => {
		const controller = new GestureController();
		controller.pointerDown({ x: 116, y: 118 }, false, smoothEnv());
		controller.pointerMove({ x: 148, y: 117 });
		const fx = controller.pointerUp({ x: 148, y: 117 });
		expect(fx.commit?.op).toBe("smooth");
		const targeted = new Set<number>();
		for (const op of fx.commit?.ops ?? []) {
			if (op.kind === "moveFrames") for (const m of op.moves) targeted.add(m.index);
		}
		// both sweeps' frames are in the one batch
		expect(targeted.has(1)).toBe(true);
		expect(targeted.has(3)).toBe(true);
	});

	test("brushing the same spot twice does not double-smooth: weights read the pre-gesture positions", () => {
		const once = new GestureController();
		once.pointerDown({ x: 116, y: 118 }, false, smoothEnv());
		const single = once.pointerUp({ x: 116, y: 118 });

		const twice = new GestureController();
		twice.pointerDown({ x: 116, y: 118 }, false, smoothEnv());
		twice.pointerMove({ x: 300, y: 100 });
		twice.pointerMove({ x: 116, y: 118 });
		const doubled = twice.pointerUp({ x: 116, y: 118 });
		// the second pass over the same frames produces identical positions --
		// plus whatever the detour swept, which the first gesture never touched
		const movesBy = (ops: readonly EditOp[] | undefined) => {
			const map = new Map<number, { x: number; y: number }>();
			for (const op of ops ?? []) {
				if (op.kind === "moveFrames") for (const m of op.moves) map.set(m.index, { x: m.x, y: m.y });
			}
			return map;
		};
		const singleMoves = movesBy(single.commit?.ops);
		const doubledMoves = movesBy(doubled.commit?.ops);
		for (const [index, position] of singleMoves) {
			expect(doubledMoves.get(index)).toEqual(position);
		}
	});

	test("strength applies to the brush exactly as to the panel math", () => {
		const controller = new GestureController();
		controller.pointerDown({ x: 132, y: 84 }, false, smoothEnv({ strength: 50, brushRadius: 5 }));
		const fx = controller.pointerUp({ x: 132, y: 84 });
		expect(fx.commit?.ops).toEqual(smoothMoveOps(jitter, [2], 50, null, false)!);
	});

	test("the committed ops equal the last preview's", () => {
		const controller = new GestureController();
		controller.pointerDown({ x: 116, y: 118 }, false, smoothEnv());
		const last = controller.pointerMove({ x: 132, y: 90 });
		const fx = controller.pointerUp({ x: 132, y: 90 });
		expect(fx.commit?.ops).toEqual(last.previewOps!);
	});

	test("Escape cancels with nothing committed; the ring and preview clear", () => {
		const controller = new GestureController();
		controller.pointerDown({ x: 116, y: 118 }, false, smoothEnv());
		const fx = controller.cancel();
		expect(fx.previewOps).toBeNull();
		expect(fx.brush).toBeNull();
		expect(controller.pointerUp({ x: 116, y: 118 })).toEqual({});
	});

	test("a sweep that never touches a candidate commits nothing", () => {
		const controller = new GestureController();
		controller.pointerDown({ x: 400, y: 300 }, false, smoothEnv());
		const fx = controller.pointerUp({ x: 400, y: 300 });
		expect(fx.commit).toBeUndefined();
		expect(fx.previewOps).toBeNull();
		expect(fx.brush).toBeNull();
	});

	test("a drag faster than the event rate sweeps the frames between samples", () => {
		const controller = new GestureController();
		controller.pointerDown({ x: 100, y: 100 }, false, smoothEnv({ brushRadius: 20 }));
		// one sample jump across the run: the wobbly middle frames sit outside
		// both endpoint circles but under the stroke
		controller.pointerMove({ x: 164, y: 100 });
		const fx = controller.pointerUp({ x: 164, y: 100 });
		const targeted = new Set<number>();
		for (const op of fx.commit?.ops ?? []) {
			if (op.kind === "moveFrames") for (const m of op.moves) targeted.add(m.index);
		}
		expect(targeted.has(1)).toBe(true);
		expect(targeted.has(2)).toBe(true);
		expect(targeted.has(3)).toBe(true);
	});
});

describe("erase brush", () => {
	// a press at 16..48 with cursor frames around it
	const stream: FrameDto[] = [
		frame(0, 100, 100, 0),
		frame(16, 116, 100, 5),
		frame(32, 132, 100, 5),
		frame(48, 148, 100, 0),
		frame(64, 164, 100, 0)
	];

	function eraseEnv(overrides: Partial<GestureEnv> = {}): GestureEnv {
		return env({ tool: "erase", frames: stream, candidates: [0, 1, 2, 3, 4], brushRadius: 10, ...overrides });
	}

	test("pointer-down pauses and previews the sweep as deletions", () => {
		const controller = new GestureController();
		const fx = controller.pointerDown({ x: 164, y: 100 }, false, eraseEnv());
		expect(fx.pause).toBe(true);
		expect(fx.brush).toEqual({ x: 164, y: 100 });
		expect(fx.previewOps).toEqual([{ kind: "deleteFrames", indices: [4] }]);
	});

	test("the commit carries the swept targets and the hybrid-rule expansion", () => {
		const controller = new GestureController();
		controller.pointerDown({ x: 116, y: 100 }, false, eraseEnv());
		controller.pointerMove({ x: 132, y: 100 });
		const fx = controller.pointerUp({ x: 132, y: 100 });
		expect(fx.commit?.op).toBe("erase");
		if (fx.commit?.op !== "erase") throw new Error("expected an erase commit");
		expect(fx.commit.targets).toEqual([
			{ index: 1, time: 16 },
			{ index: 2, time: 32 }
		]);
		expect(fx.commit.ops.filter((op) => op.kind === "deleteFrames")).toEqual([
			{ kind: "deleteFrames", indices: [1, 2] }
		]);
		// the whole press was swept: a boundary frame preserves its rise
		const inserts = fx.commit.ops.filter((op) => op.kind === "insertFrames");
		expect(inserts).toHaveLength(1);
		expect(fx.brush).toBeNull();
	});

	test("a sweep that would collapse a press rejects on release: toast, snap-back, no commit", () => {
		const collapse: FrameDto[] = [
			frame(0, 100, 100, 0),
			frame(10, 110, 100, 5),
			frame(11, 111, 100, 5),
			frame(12, 112, 100, 0),
			frame(30, 130, 100, 0)
		];
		const controller = new GestureController();
		controller.pointerDown({ x: 110, y: 100 }, false, eraseEnv({ frames: collapse, brushRadius: 0.5 }));
		// the drag detours around the in-run survivor at (111, 100): the sweep
		// covers the stroke's whole travel, so a straight pass would take it too
		controller.pointerMove({ x: 110, y: 90 });
		controller.pointerMove({ x: 112, y: 90 });
		controller.pointerMove({ x: 112, y: 100 });
		const fx = controller.pointerUp({ x: 112, y: 100 });
		expect(fx.commit).toBeUndefined();
		expect(fx.reject).toContain("K1");
		expect(fx.previewOps).toBeNull();
		expect(fx.brush).toBeNull();
	});

	test("Escape cancels the sweep with nothing committed", () => {
		const controller = new GestureController();
		controller.pointerDown({ x: 116, y: 100 }, false, eraseEnv());
		const fx = controller.cancel();
		expect(fx.previewOps).toBeNull();
		expect(fx.brush).toBeNull();
	});

	test("an empty sweep commits nothing", () => {
		const controller = new GestureController();
		controller.pointerDown({ x: 400, y: 300 }, false, eraseEnv());
		const fx = controller.pointerUp({ x: 400, y: 300 });
		expect(fx.commit).toBeUndefined();
		expect(fx.previewOps).toBeNull();
	});
});

describe("gesture cancellation", () => {
	test("Escape mid-gesture drops the gesture without touching the selection", () => {
		const controller = new GestureController();
		controller.pointerDown({ x: 148, y: 100 }, false, env({ selection: [4] }));
		const fx = controller.cancel();
		expect(fx.selection).toBeUndefined();
		expect(controller.live).toBe(false);
		// a pointer-up after cancellation is a stray event, not a click
		expect(controller.pointerUp({ x: 148, y: 100 })).toEqual({});
	});

	test("pointer events with no live gesture are inert", () => {
		const controller = new GestureController();
		expect(controller.pointerMove({ x: 0, y: 0 })).toEqual({});
		expect(controller.pointerUp({ x: 0, y: 0 })).toEqual({});
		expect(controller.cancel()).toEqual({});
	});
});
