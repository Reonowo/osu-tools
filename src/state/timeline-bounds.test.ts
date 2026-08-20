// the timeline-bounds split: derived.bounds keep breathing with the
// simulation (the clock needs the fade past a re-judged last object
// covered), while the store's timelineBounds -- what both timeline tiers
// and the status bar map against -- are judgement-invariant (derive.ts
// bounds them by the last object's miss deadline, which no re-judgement
// can exceed) and fold widen-only across deltas. the regression here is
// the press-drag shift: with the last circle hit late, its judgement time
// rides the judging press, so dragging that press moved the live maxTime
// and every mark on screen slid with it once the detail window sat pinned
// against the end -- in both directions, since a press dragged out of the
// window turns the hit into a miss whose event fires at the window's
// close, later than the late hit it replaces
import { expect, test } from "bun:test";
import { CLICK_SLOP_SCREEN_PX } from "../editor/gesture-controller";
import { pressRunCommit } from "../editor/press-commits";
import { PressDragController } from "../editor/press-drag";
import { expandRetimePress } from "../editor/press-ops";
import type { EditDelta, EditOp, FrameDto, IndexedFrame, LoadedScene, Settings } from "../lib/scene-types";
import { audioExtendedBounds } from "../lib/timeline";
import { timeToPixels, windowAround } from "../lib/timeline-view";
import { testScene } from "../test/scene";
import {
	DEFAULT_AUDIO,
	DEFAULT_EDITING,
	DEFAULT_EFFECTS,
	DEFAULT_GAMEPLAY,
	DEFAULT_OVERLAYS,
	DEFAULT_SKIN,
	DEFAULT_TIMELINE
} from "./defaults";
import { createViewerStore, type IpcDeps, type ViewerState } from "./store";
import type { StoreApi } from "zustand";
import type { SkinManifest } from "@/lib/scene-types";

/** the manifest a store test's ipc stub answers with: the app's own look,
 * which is what a fresh install resolves to */
function bundledManifest(): SkinManifest {
	return {
		locator: DEFAULT_SKIN,
		name: "Argon",
		author: "osu!",
		source: "bundled",
		era: "lazer",
		files: {},
		blank: [],
		config: {
			version: 1,
			isLatestVersion: false,
			comboColours: [],
			sliderBorder: null,
			sliderTrackOverride: null,
			animationFramerate: null,
			layeredHitSounds: null,
			allowSliderBallTint: null,
			comboPrefix: null,
			comboOverlap: null,
			hitCirclePrefix: null,
			hitCircleOverlap: null,
			cursorCentre: null,
			cursorExpand: null,
			cursorRotate: null,
			cursorTrailRotate: null,
			hitCircleOverlayAboveNumber: null,
			spinnerFrequencyModulate: null,
			spinnerNoBlink: null,
			settings: {}
		},
		fellBack: null
	};
}

const K1_BITS = 5; // k1 rides with m1, stable's own encoding
const K2_BITS = 10;

// frames every 50ms, 0..9350. K1 held 9100..9300 (fall at 9350) -- a LATE
// hit on the last circle at 9000, so the judgement time rides the press
// past the object's own end. K2 held 8000..8100 judges the circle at 8000.
// the replay ends right after the last input, as stable replays do, which
// is what leaves lastEvent + fade (9100 + 800) governing the live maxTime
function buildFrames(): FrameDto[] {
	const frames: FrameDto[] = [];
	for (let t = 0; t <= 9350; t += 50) {
		const k1 = t >= 9100 && t <= 9300 ? K1_BITS : 0;
		const k2 = t >= 8000 && t <= 8100 ? K2_BITS : 0;
		frames.push({ time: t, x: 100, y: 100, buttons: k1 | k2 });
	}
	return frames;
}

function circle(startTime: number): LoadedScene["renderPlan"]["objects"][number] {
	return {
		startTime,
		endTime: startTime,
		position: [100, 100],
		stackHeight: 0,
		comboColourIndex: 1,
		comboIndex: 1,
		indexInCombo: 0,
		preempt: 600,
		fadeIn: 400,
		samples: [],
		kind: { type: "circle" }
	};
}

// the fake engine's re-judgement: each circle judged at its claiming press's
// rising edge (obj0 has no press and keeps a fixed event; obj1 <- K2 rise,
// obj2 <- K1 rise), which is what the real simulation does for hits
function simulate(frames: readonly FrameDto[]): LoadedScene["simulation"] {
	const riseNear = (bit: number, near: number): number => {
		for (let i = 0; i < frames.length; i++) {
			const held = (frames[i].buttons & bit) !== 0;
			const prevHeld = i > 0 && (frames[i - 1].buttons & bit) !== 0;
			if (held && !prevHeld && Math.abs(frames[i].time - near) < 1000) return frames[i].time;
		}
		return near;
	};
	const event = (time: number, objectIndex: number) => ({
		time,
		objectIndex,
		kind: { type: "circle", grade: "great" } as const,
		comboAfter: objectIndex + 1,
		accuracyAfter: 1
	});
	return {
		status: "authoritative",
		events: [event(1002, 0), event(riseNear(2, 8000), 1), event(riseNear(4, 9100), 2)],
		totals: { count300: 3, count100: 0, count50: 0, countMiss: 0, maxCombo: 3 }
	};
}

function applyOps(
	frames: FrameDto[],
	ops: EditOp[]
): { next: FrameDto[]; updated: IndexedFrame[]; inserted: IndexedFrame[] } {
	const next = frames.map((f) => ({ ...f }));
	const updated: IndexedFrame[] = [];
	const inserted: IndexedFrame[] = [];
	for (const op of ops) {
		if (op.kind === "insertFrames") {
			for (const frame of op.frames) {
				let at = next.findIndex((f) => f.time > frame.time);
				if (at === -1) at = next.length;
				next.splice(at, 0, { ...frame });
				inserted.push({ index: at, frame: next[at] });
			}
			continue;
		}
		if (op.kind !== "setButtons") throw new Error(`unexpected op ${op.kind} in this harness`);
		for (const s of op.sets) {
			next[s.index] = { ...next[s.index], buttons: s.buttons };
			updated.push({ index: s.index, frame: next[s.index] });
		}
	}
	return { next, updated, inserted };
}

const settings: Settings = {
	osuStablePath: null,
	volume: 100,
	audio: DEFAULT_AUDIO,
	gameplay: DEFAULT_GAMEPLAY,
	overlays: DEFAULT_OVERLAYS,
	recents: [],
	editing: DEFAULT_EDITING,
	effects: DEFAULT_EFFECTS,
	timeline: DEFAULT_TIMELINE,
	keybinds: {},
	skin: DEFAULT_SKIN
};

// the DetailLanes draw math, verbatim: paused clock at 9200 -- parked where
// the drag is happening, so the window sits pinned against the end, exactly
// the regime that exposed the shift -- span 4000ms over an 800px track
const SPAN_MS = 4000;
const TRACK_PX = 800;
const PLAYHEAD_T = 9200;

type Store = StoreApi<ViewerState>;

async function openTestScene(): Promise<Store> {
	const scene = testScene({
		frames: buildFrames(),
		renderPlan: {
			...testScene().renderPlan,
			objects: [circle(1000), circle(8000), circle(9000)]
		},
		simulation: simulate(buildFrames())
	});
	// the fake backend document, mutated exactly by the dispatched ops and
	// reset by every load, mirroring the rust session's lifecycle
	let engineFrames = buildFrames();
	const load = async () => {
		engineFrames = buildFrames();
		return scene;
	};
	const deps: IpcDeps = {
		loadReplay: load,
		loadReplayWithBeatmap: load,
		getSettings: async () => settings,
		setOsuStablePath: async () => settings,
		setViewerPrefs: async () => settings,
		clearRecents: async () => settings,
		// the skin deps: a test that does not exercise skinning still needs them,
		// since hydrateSettings resolves the persisted locator on every startup
		listSkins: async () => [],
		getSkin: async () => bundledManifest(),
		setSkin: async () => bundledManifest(),
		importSkin: async () => bundledManifest(),
		applyEdit: async (_epoch, baseRevision, ops, _label): Promise<EditDelta> => {
			const { next, updated, inserted } = applyOps(engineFrames, ops);
			engineFrames = next;
			return {
				revision: baseRevision + 1,
				frames: { updated, inserted, removed: [] },
				playerName: "p",
				timestampTicks: "0",
				dirty: true,
				framesDirty: true,
				metadataDirty: false,
				canUndo: true,
				canRedo: false,
				history: { labels: ["drag"], cursor: 1 },
				simulation: simulate(next)
			};
		},
		undo: async () => {
			throw new Error("unused");
		},
		redo: async () => {
			throw new Error("unused");
		},
		revertAll: async () => {
			throw new Error("unused");
		},
		resync: async () => {
			throw new Error("unused");
		},
		exportReplay: async () => ({ path: "", bytes: 0, regenerated: null })
	};
	const store = createViewerStore(deps);
	await store.getState().openReplay("C:\\r.osr");
	return store;
}

/** a mark's on-screen x through the mapping the lanes actually draw with */
function markPixel(store: Store, markTime: number): number {
	const state = store.getState();
	const bounds = audioExtendedBounds(state.timelineBounds!, state.audioDurationMs);
	const view = windowAround(bounds, PLAYHEAD_T, SPAN_MS);
	return timeToPixels(view, markTime, TRACK_PX);
}

/** a genuine frame-stream extension: a bare frame appended past the last
 * one, the only kind of edit that may legitimately move the mapping */
async function appendFrame(store: Store, time: number): Promise<void> {
	await store.getState().commitEdit({
		label: "append frame",
		payload: { kind: "ops", ops: [{ kind: "insertFrames", frames: [{ time, x: 100, y: 100, buttons: 0 }] }] }
	});
}

/** one whole hold-lane gesture on the K1 press, DetailLanes' own wiring:
 * PressDragController samples in lane time, the released edit dispatches
 * through pressRunCommit + commitEdit */
async function dragK1(store: Store, downTime: number, upTime: number): Promise<void> {
	const drag = new PressDragController();
	drag.pointerDown(downTime, {
		key: "K1",
		frames: store.getState().scene!.frames,
		msPerPx: SPAN_MS / TRACK_PX,
		slopPx: CLICK_SLOP_SCREEN_PX,
		edgeZonePx: 5,
		lattice: store.getState().editor!.lattice
	});
	drag.pointerMove(upTime);
	const fx = drag.pointerUp(upTime);
	expect(fx.commit).toBeDefined();
	const commit = fx.commit!;
	await store
		.getState()
		.commitEdit(
			pressRunCommit("drag k1", commit.key, commit.runStartTime, (frames, run, ed) =>
				expandRetimePress(frames, run, commit.edit, ed.lattice, "this drag")
			)
		);
}

test("a landed press drag leaves untouched marks where they were", async () => {
	const store = await openTestScene();
	// the mapping's install-time max is the judgement deadline bound, not
	// the live event-driven one: lastEnd 9000 + miss window 400 + fade 800
	expect(store.getState().timelineBounds?.maxTime).toBe(10_200);

	const obj1Before = markPixel(store, 8000); // untouched circle mid-window
	const k2Before = markPixel(store, 8000); // untouched K2 press rise

	// grab the press's body, drag 100ms left, let go: the last circle is now
	// judged at 9000 instead of 9100
	await dragK1(store, 9200, 9100);
	const moved = store.getState().scene!.frames.find((f) => (f.buttons & 4) !== 0);
	expect(moved?.time).toBe(9000);

	// the live playback bounds follow the re-judgement (the clock's side of
	// the split)...
	expect(store.getState().derived?.bounds.maxTime).toBe(9800);
	// ...while the mapping holds, so nothing at an untouched time moves
	expect(store.getState().timelineBounds?.maxTime).toBe(10_200);
	expect(markPixel(store, 8000)).toBe(obj1Before);
	expect(markPixel(store, 8000)).toBe(k2Before);
});

test("a drag that lands the last judgement later does not move untouched marks either", async () => {
	// the first fix froze shrinks but still widened on growth, and a
	// re-judgement can grow the live bounds without the frames outgrowing
	// anything: dragging the judging press later, or dragging it earlier
	// until the hit becomes a miss, whose event fires at the hit window's
	// close -- later than the late hit it replaces. the mapping must be
	// judgement-invariant, not merely shrink-proof
	const store = await openTestScene();
	const before = markPixel(store, 8000);

	await dragK1(store, 9200, 9300);
	expect(store.getState().derived?.bounds.maxTime).toBe(10000);
	expect(markPixel(store, 8000)).toBe(before);
});

test("a genuine frame extension widens the mapping, and it never shrinks back", async () => {
	const store = await openTestScene();

	// a frame appended past everything: the document's own extent outgrew
	// the mapping, which must widen or the new content would sit beyond the
	// drawable, seekable timeline
	await appendFrame(store, 12_000);
	expect(store.getState().derived?.bounds.maxTime).toBe(12_000);
	expect(store.getState().timelineBounds?.maxTime).toBe(12_000);

	// dragging the press afterwards shrinks nothing: the mapping keeps the
	// widest frame it has shown -- stability wins over tightness for the
	// rest of the session
	await dragK1(store, 9200, 9100);
	expect(store.getState().timelineBounds?.maxTime).toBe(12_000);
});

test("a new scene install re-derives the mapping from the pristine document", async () => {
	const store = await openTestScene();
	await appendFrame(store, 12_000);
	expect(store.getState().timelineBounds?.maxTime).toBe(12_000);

	// through the discard prompt, since appendFrame left the document dirty --
	// that guard is what stands between any open and an edited document now
	// (state/store.ts), so this is the walk a user actually takes here
	await store.getState().openReplay("C:\\other.osr");
	await store.getState().confirmDiscard();
	expect(store.getState().timelineBounds?.maxTime).toBe(10_200);
});
