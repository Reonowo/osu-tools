import { describe, expect, test } from "bun:test";
import type { StoreApi } from "zustand";
import type { PhysicalKey } from "../engine/buttons";
import { PressDragController } from "../editor/press-drag";
import { adjacentFrameTime, expandDeletePress, expandRetimePress, outcomeSelection } from "../editor/press-ops";
import { pressRunAt, pressRunFromIndex } from "../editor/press-runs";
import { GesturePreview } from "../editor/preview";
import type {
	EditDelta,
	EditOp,
	FrameChanges,
	FrameDto,
	IpcError,
	LoadedScene,
	RecentReplay,
	Settings
} from "../lib/scene-types";
import { defaultKeybinds } from "../playback/keybinds";
import { testScene } from "../test/scene";
import { VIEWPORT_ZOOM_MAX, VIEWPORT_ZOOM_MIN } from "../renderer/playfield";
import {
	DEFAULT_AUDIO,
	DEFAULT_BACKGROUND_DIM,
	DEFAULT_EDITING,
	DEFAULT_EFFECTS,
	DEFAULT_GAMEPLAY,
	DEFAULT_OVERLAYS,
	DEFAULT_SKIN,
	DEFAULT_TIMELINE,
	DETAIL_SPAN_MAX,
	DETAIL_SPAN_MIN,
	effectiveEffects
} from "./defaults";
import { createViewerStore, type IpcDeps, type ViewerState } from "./store";
import type { SkinEntry, SkinLocator, SkinManifest } from "@/lib/scene-types";

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
			sliderBall: null,
			spinnerBackground: null,
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

const baseSettings: Settings = {
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

const sampleRecent: RecentReplay = {
	osrPath: "a.osr",
	title: "Reply",
	version: "Moonlit Applied",
	playerName: "adminuser",
	accuracy: 0.9651,
	maxCombo: 300,
	openedAtMs: 1_770_000_000_000,
	beatmapPath: "D:\\maps\\set\\map.osu",
	beatmapDir: "D:\\maps\\set",
	beatmapMd5: "0123456789abcdef0123456789abcdef",
	allowMismatch: false
};

function deps(overrides: Partial<IpcDeps> = {}): IpcDeps {
	return {
		loadReplay: async () => testScene(),
		loadReplayWithBeatmap: async () => testScene(),
		getSettings: async () => baseSettings,
		setOsuStablePath: async (path) => ({ ...baseSettings, osuStablePath: path }),
		setViewerPrefs: async (volume, audio, gameplay, overlays, editing, effects, timeline, keybinds) => ({
			...baseSettings,
			volume,
			audio,
			gameplay,
			overlays,
			editing,
			effects,
			timeline,
			keybinds
		}),
		clearRecents: async () => ({ ...baseSettings, recents: [] }),
		// the skin deps: the picker's rows, the resolved selection, and the two
		// writes. a test that does not exercise skinning still needs them, since
		// hydrateSettings resolves the persisted locator on every startup
		listSkins: async () => [],
		getSkin: async () => bundledManifest(),
		setSkin: async () => bundledManifest(),
		importSkin: async () => bundledManifest(),
		applyEdit: async () => identityDelta,
		undo: async () => identityDelta,
		redo: async () => identityDelta,
		revertAll: async () => identityDelta,
		resync: async () => identityDelta,
		exportReplay: async () => ({ path: "", bytes: 0, regenerated: null }),
		...overrides
	};
}

const reject = (e: IpcError) => async (): Promise<LoadedScene> => {
	throw e;
};

const identityDelta: EditDelta = {
	revision: 0,
	frames: null,
	playerName: "p",
	timestampTicks: "0",
	dirty: false,
	framesDirty: false,
	metadataDirty: false,
	canUndo: false,
	canRedo: false,
	history: { labels: [], cursor: 0 },
	simulation: null
};

/** 40 frames on the scale-2 lattice (step 0.5), 16ms apart */
function latticeScene(): LoadedScene {
	const frames = Array.from({ length: 40 }, (_, i) => ({
		time: i * 16,
		x: i * 0.5,
		y: (i % 7) * 0.5,
		buttons: 0
	}));
	return testScene({ frames });
}

function moveDelta(revision: number, index: number, frame: FrameDto, label: string): EditDelta {
	return {
		revision,
		frames: { updated: [{ index, frame }], inserted: [], removed: [] },
		playerName: "p",
		timestampTicks: "0",
		dirty: true,
		framesDirty: true,
		metadataDirty: false,
		canUndo: true,
		canRedo: false,
		history: { labels: [label], cursor: 1 },
		simulation: null
	};
}

describe("load flow", () => {
	test("openReplay success installs scene + derived and bumps sceneId", async () => {
		const store = createViewerStore(deps());
		await store.getState().openReplay("C:\\r.osr");
		const s = store.getState();
		expect(s.scene).not.toBeNull();
		expect(s.derived?.bounds.minTime).toBe(-1500);
		expect(s.sceneId).toBe(1);
		expect(s.loading).toBe(false);
		expect(s.lastError).toBeNull();
	});

	test("a successful load records the replay's path", async () => {
		const store = createViewerStore(deps());
		await store.getState().openReplay("C:/replays/a.osr");
		expect(store.getState().osrPath).toBe("C:/replays/a.osr");
	});

	test("opening a recents entry is the one open call, and sends only its path", async () => {
		// there is no second command to reopen a recent with: the beatmap
		// association lives in rust's settings file, keyed by the .osr path, and
		// sending it back across the boundary would be a second copy to keep in
		// sync -- so the entry's other fields must not reach the ipc call
		const calls: string[] = [];
		const store = createViewerStore(
			deps({
				loadReplay: async (osrPath) => {
					calls.push(osrPath);
					return testScene();
				}
			})
		);

		await store.getState().openReplay(sampleRecent.osrPath);
		expect(calls).toEqual([sampleRecent.osrPath]);
		expect(store.getState().scene).not.toBeNull();
		expect(store.getState().osrPath).toBe(sampleRecent.osrPath);
	});

	test("a recent whose beatmap is gone surfaces the same picker recovery as any other load", async () => {
		// rust ends the resolution walk on beatmapNotFound precisely so this
		// path reaches the manual picker, exactly as a fresh open would
		const store = createViewerStore(deps({ loadReplay: reject({ kind: "beatmapNotFound", md5: "abc" }) }));
		await store.getState().openReplay(sampleRecent.osrPath);
		const s = store.getState();
		expect(s.lastError?.error.kind).toBe("beatmapNotFound");
		expect(s.lastError?.osrPath).toBe(sampleRecent.osrPath);
		expect(s.pendingRecovery).toBe(sampleRecent.osrPath);
		expect(s.loading).toBe(false);
	});

	test("a failing load leaves osrPath pointing at the still-displayed scene, exactly like scene itself", async () => {
		// mirrors "a stale success followed by a failing newest load leaves the
		// stale scene displayed" below: a failed load never clears `scene`, so
		// osrPath (which HistoryPanel reads to name that same displayed scene's
		// .osr) must not diverge from it either
		let shouldFail = false;
		const store = createViewerStore(
			deps({
				loadReplay: async () => {
					if (shouldFail) throw { kind: "replayParse", message: "bad" } satisfies IpcError;
					return testScene();
				}
			})
		);
		await store.getState().openReplay("C:\\r.osr");
		expect(store.getState().osrPath).toBe("C:\\r.osr");

		shouldFail = true;
		await store.getState().openReplay("C:\\bad.osr");
		expect(store.getState().scene).not.toBeNull(); // the previous scene is still displayed
		expect(store.getState().osrPath).toBe("C:\\r.osr"); // and osrPath still names it, not the failed attempt
	});

	test("beatmapNotFound surfaces with the pickBeatmap recovery", async () => {
		const store = createViewerStore(
			deps({
				loadReplay: reject({ kind: "beatmapNotFound", md5: "abc" })
			})
		);
		await store.getState().openReplay("C:\\r.osr");
		const s = store.getState();
		expect(s.scene).toBeNull();
		expect(s.lastError?.error.kind).toBe("beatmapNotFound");
		expect(s.lastError?.osrPath).toBe("C:\\r.osr");
	});

	test("mismatch goes to pendingMismatch and confirm re-invokes with allowMismatch", async () => {
		// strengthened: records the full argument tuple (not just the allow
		// flag) so the test also catches a retry that drops or swaps the
		// remembered osrPath/beatmapPath, not only a retry that forgets to flip
		// allowMismatch
		const calls: { osrPath: string; beatmapPath: string; allow: boolean }[] = [];
		const store = createViewerStore(
			deps({
				loadReplayWithBeatmap: async (osrPath, beatmapPath, allow) => {
					calls.push({ osrPath, beatmapPath, allow });
					if (!allow) throw { kind: "beatmapMismatch", expectedMd5: "a", actualMd5: "b" } satisfies IpcError;
					return testScene();
				}
			})
		);
		await store.getState().openWithBeatmap("C:\\r.osr", "C:\\m.osu");
		const pending = store.getState().pendingMismatch;
		expect(pending?.expectedMd5).toBe("a");
		expect(pending?.actualMd5).toBe("b");
		expect(pending?.osrPath).toBe("C:\\r.osr");
		expect(pending?.beatmapPath).toBe("C:\\m.osu");
		expect(store.getState().scene).toBeNull();

		await store.getState().confirmMismatch();
		expect(calls).toEqual([
			{ osrPath: "C:\\r.osr", beatmapPath: "C:\\m.osu", allow: false },
			{ osrPath: "C:\\r.osr", beatmapPath: "C:\\m.osu", allow: true }
		]);
		expect(store.getState().scene).not.toBeNull();
		expect(store.getState().pendingMismatch).toBeNull();
	});

	test("a new load replaces the previous error and scene state", async () => {
		// strengthened: the original version only compared two independent
		// fresh store instances, which can't fail for the reason the test name
		// states (a load replacing *the same store's* prior error/scene). this
		// now also retries on the SAME store instance to prove that path.
		let shouldFail = true;
		const store = createViewerStore(
			deps({
				loadReplay: async () => {
					if (shouldFail) throw { kind: "replayParse", message: "bad" } satisfies IpcError;
					return testScene();
				}
			})
		);
		await store.getState().openReplay("C:\\r.osr");
		expect(store.getState().lastError?.error.kind).toBe("replayParse");
		expect(store.getState().scene).toBeNull();

		const ok = createViewerStore(deps());
		await ok.getState().openReplay("C:\\r.osr");
		expect(ok.getState().lastError).toBeNull();

		shouldFail = false;
		await store.getState().openReplay("C:\\r.osr");
		expect(store.getState().lastError).toBeNull();
		expect(store.getState().scene).not.toBeNull();
		expect(store.getState().derived?.bounds.minTime).toBe(-1500);
	});

	test("overlapping loads serialize their ipc calls and install in action order", async () => {
		// the drop handler doesn't gate on `loading` (src/lib/openers.ts), so a
		// second drop can start while the first ipc call is pending. the tauri
		// commands install the backend session as a side effect, so the calls
		// must never overlap (backend install order = user action order), and
		// every successful completion installs frontend-side to stay in
		// lockstep with the backend session
		const calls: string[] = [];
		let resolveFirst!: (scene: LoadedScene) => void;
		const store = createViewerStore(
			deps({
				loadReplay: (osrPath) => {
					calls.push(osrPath);
					if (calls.length === 1)
						return new Promise<LoadedScene>((resolve) => {
							resolveFirst = resolve;
						});
					return Promise.resolve(testScene());
				}
			})
		);
		const staleLoad = store.getState().openReplay("C:\\old.osr");
		await Promise.resolve(); // let the first ipc call actually start
		const newLoad = store.getState().openReplay("C:\\new.osr");
		expect(calls).toEqual(["C:\\old.osr"]); // the second call queues behind the first

		resolveFirst(testScene());
		await Promise.all([staleLoad, newLoad]);
		expect(calls).toEqual(["C:\\old.osr", "C:\\new.osr"]);
		expect(store.getState().sceneId).toBe(2); // both successes installed, newest last
		expect(store.getState().scene).not.toBeNull();
		expect(store.getState().loading).toBe(false);
	});

	test("a stale success followed by a failing newest load leaves the stale scene displayed (backend parity)", async () => {
		// the stale command already installed its session backend-side and
		// dropped the previous scene's cache lease; when the newest load then
		// fails, the frontend must show that stale scene rather than keep one
		// whose assets the backend has deleted
		const calls: string[] = [];
		let resolveFirst!: (scene: LoadedScene) => void;
		const store = createViewerStore(
			deps({
				loadReplay: (osrPath) => {
					calls.push(osrPath);
					if (calls.length === 1)
						return new Promise<LoadedScene>((resolve) => {
							resolveFirst = resolve;
						});
					return Promise.reject({ kind: "replayParse", message: "bad" } satisfies IpcError);
				}
			})
		);
		const staleLoad = store.getState().openReplay("C:\\a.osr");
		await Promise.resolve();
		const newLoad = store.getState().openReplay("C:\\b.osr");

		resolveFirst(testScene());
		await Promise.all([staleLoad, newLoad]);
		expect(store.getState().scene).not.toBeNull(); // the stale success is displayed
		expect(store.getState().sceneId).toBe(1);
		expect(store.getState().lastError?.error.kind).toBe("replayParse"); // the newest failure still surfaces
		expect(store.getState().lastError?.osrPath).toBe("C:\\b.osr");
		expect(store.getState().loading).toBe(false);
	});

	test("a stale failure cannot clobber a newer load's clean state", async () => {
		const calls: string[] = [];
		let rejectFirst!: (e: IpcError) => void;
		const store = createViewerStore(
			deps({
				loadReplay: (osrPath) => {
					calls.push(osrPath);
					if (calls.length === 1)
						return new Promise<LoadedScene>((_, reject2) => {
							rejectFirst = reject2;
						});
					return Promise.resolve(testScene());
				}
			})
		);
		const staleLoad = store.getState().openReplay("C:\\old.osr");
		await Promise.resolve();
		const newLoad = store.getState().openReplay("C:\\new.osr");

		rejectFirst({ kind: "replayParse", message: "bad" });
		await Promise.all([staleLoad, newLoad]);
		expect(store.getState().lastError).toBeNull();
		expect(store.getState().scene).not.toBeNull();
		expect(store.getState().loading).toBe(false);
	});

	test("a load superseded while still queued never issues its ipc call", async () => {
		const calls: string[] = [];
		let resolveFirst!: (scene: LoadedScene) => void;
		const store = createViewerStore(
			deps({
				loadReplay: (osrPath) => {
					calls.push(osrPath);
					if (calls.length === 1)
						return new Promise<LoadedScene>((resolve) => {
							resolveFirst = resolve;
						});
					return Promise.resolve(testScene());
				}
			})
		);
		const first = store.getState().openReplay("C:\\a.osr");
		await Promise.resolve();
		const second = store.getState().openReplay("C:\\b.osr");
		const third = store.getState().openReplay("C:\\c.osr");

		resolveFirst(testScene());
		await Promise.all([first, second, third]);
		// b was superseded by c before it ever started: its ipc call is skipped
		// outright, so the backend never installs a doomed session
		expect(calls).toEqual(["C:\\a.osr", "C:\\c.osr"]);
		expect(store.getState().sceneId).toBe(2); // a (stale success) then c
		expect(store.getState().loading).toBe(false);
	});

	test("audio duration publishes and resets on the next install", async () => {
		const store = createViewerStore(deps());
		await store.getState().openReplay("C:\\r.osr");
		store.getState().setAudioDuration(123_456);
		expect(store.getState().audioDurationMs).toBe(123_456);

		await store.getState().openReplay("C:\\r.osr");
		expect(store.getState().audioDurationMs).toBeNull();
	});

	test("settings round-trip through the injected ipc", async () => {
		const store = createViewerStore(deps());
		await store.getState().loadSettings();
		expect(store.getState().settings).toEqual(baseSettings);
		await store.getState().saveStablePath("D:\\osu!");
		expect(store.getState().settings).toEqual({ ...baseSettings, osuStablePath: "D:\\osu!" });
	});

	test("a failing settings save surfaces through lastError instead of rejecting", async () => {
		// the dialog buttons void this promise, so a rejection would otherwise
		// be unhandled and the user would never learn the save failed
		const store = createViewerStore(
			deps({
				setOsuStablePath: async () => {
					throw { kind: "io", message: "unwritable" } satisfies IpcError;
				}
			})
		);
		await store.getState().saveStablePath("D:\\osu!");
		expect(store.getState().lastError?.error.kind).toBe("io");
		expect(store.getState().settings).toBeNull();
	});
});

describe("viewer preferences", () => {
	test("hydrateSettings applies the persisted volume and overlays", async () => {
		const stored = {
			osuStablePath: "D:\\osu!",
			volume: 42,
			audio: { musicVolume: 55, hitsoundVolume: 20, offsetMs: -30, ignoreBeatmapHitsounds: true },
			gameplay: {
				positionalHitsoundLevel: 0.6,
				alwaysPlayFirstComboBreak: false,
				snakingInSliders: false,
				snakingOutSliders: true
			},
			overlays: { ...DEFAULT_OVERLAYS, cursorPath: true, keyOverlay: false, displayLength: 1400 },
			recents: [],
			editing: { ...DEFAULT_EDITING, snapToLattice: false },
			effects: DEFAULT_EFFECTS,
			timeline: DEFAULT_TIMELINE,
			keybinds: {},
			skin: DEFAULT_SKIN
		};
		const store = createViewerStore(deps({ getSettings: async () => stored }));

		expect(store.getState().volume).toBe(100); // the default, before hydration
		await store.getState().hydrateSettings();

		expect(store.getState().volume).toBe(42);
		expect(store.getState().audio).toEqual(stored.audio);
		expect(store.getState().gameplay).toEqual(stored.gameplay);
		expect(store.getState().overlays).toEqual(stored.overlays);
		expect(store.getState().editing).toEqual(stored.editing);
		expect(store.getState().settings).toEqual(stored);
	});

	test("hydrateSettings fills gaps from the defaults and survives a failure", async () => {
		// a settings file written by an older build can be missing overlay keys
		const partial = { osuStablePath: null, volume: 70, overlays: { cursorPath: true } };
		const store = createViewerStore(
			deps({
				getSettings: async () => partial as unknown as Settings
			})
		);
		await store.getState().hydrateSettings();
		expect(store.getState().overlays).toEqual({ ...DEFAULT_OVERLAYS, cursorPath: true });
		expect(store.getState().editing).toEqual(DEFAULT_EDITING); // a file missing editing entirely still hydrates

		// startup must not break when the settings read itself fails
		const failing = createViewerStore(
			deps({
				getSettings: async () => {
					throw { kind: "io", message: "unreadable" } satisfies IpcError;
				}
			})
		);
		await failing.getState().hydrateSettings();
		expect(failing.getState().volume).toBe(100);
		expect(failing.getState().overlays).toEqual(DEFAULT_OVERLAYS);
		expect(failing.getState().editing).toEqual(DEFAULT_EDITING);
	});

	test("a persisted rebinding is what the keyboard does after hydration", async () => {
		// the whole path in one assertion: the file's sparse map lands in the
		// store, folds onto the defaults, and the row the user moved is the row
		// that answers to their key
		const store = createViewerStore(
			deps({
				getSettings: async () => ({
					...baseSettings,
					keybinds: { selectTool: [{ hotkey: "N", codes: ["KeyN"] }], eraseTool: [] }
				})
			})
		);
		await store.getState().hydrateSettings();

		const row = (action: string) =>
			store.getState().effectiveKeybinds.find((candidate) => candidate.action === action)!;
		expect(row("selectTool").bindings.map((b) => b.hotkey)).toEqual(["N"]);
		expect(row("eraseTool").bindings).toEqual([]);
		// an action the user never touched keeps following the app's default
		expect(row("moveTool").bindings.map((b) => b.hotkey)).toEqual(["M"]);
	});

	test("a settings file written before keybinds existed leaves everything on its default", async () => {
		const legacy = { osuStablePath: null, volume: 70 } as unknown as Settings;
		const store = createViewerStore(deps({ getSettings: async () => legacy }));
		await store.getState().hydrateSettings();
		expect(store.getState().keybinds).toEqual({});
		expect(store.getState().effectiveKeybinds).toEqual(defaultKeybinds());
	});

	test("setKeybinds moves the table with the map", async () => {
		// the two are one fact: a consumer must never read a table the
		// persisted map does not describe
		const store = createViewerStore(deps());
		store.getState().setKeybinds({ moveTool: [{ hotkey: "N", codes: ["KeyN"] }] });
		expect(store.getState().keybinds).toEqual({ moveTool: [{ hotkey: "N", codes: ["KeyN"] }] });
		expect(
			store
				.getState()
				.effectiveKeybinds.find((row) => row.action === "moveTool")!
				.bindings.map((b) => b.hotkey)
		).toEqual(["N"]);
	});

	test("a volume edit made while hydration is in flight wins over the loaded value", async () => {
		// the volume slider is usable before the settings read resolves;
		// hydration must not visibly revert an edit the user just made
		let resolveSettings!: (s: Settings) => void;
		const store = createViewerStore(
			deps({
				getSettings: () =>
					new Promise<Settings>((resolve) => {
						resolveSettings = resolve;
					})
			})
		);

		const hydrating = store.getState().hydrateSettings();
		store.getState().setVolume(37);
		resolveSettings({ ...baseSettings, volume: 80 });
		await hydrating;

		expect(store.getState().volume).toBe(37); // the user's edit survives
		expect(store.getState().overlays).toEqual(DEFAULT_OVERLAYS); // untouched fields still hydrate
		// the preserved edit is written through, so settings mirrors the new
		// persisted state rather than the value the file held before it
		expect(store.getState().settings?.volume).toBe(37);
	});

	test("a volume edit that returns to the starting value still wins over the loaded value", async () => {
		// value comparison alone cannot see an edit that lands back on the
		// pre-hydration volume (drag away, drag back); the user still chose it
		let resolveSettings!: (s: Settings) => void;
		const store = createViewerStore(
			deps({
				getSettings: () =>
					new Promise<Settings>((resolve) => {
						resolveSettings = resolve;
					})
			})
		);

		const hydrating = store.getState().hydrateSettings();
		store.getState().setVolume(50);
		store.getState().setVolume(100); // back to the initial default
		resolveSettings({ ...baseSettings, volume: 42 });
		await hydrating;

		expect(store.getState().volume).toBe(100);
	});

	test("an overlay edit made while hydration is in flight wins over the loaded overlays", async () => {
		let resolveSettings!: (s: Settings) => void;
		const store = createViewerStore(
			deps({
				getSettings: () =>
					new Promise<Settings>((resolve) => {
						resolveSettings = resolve;
					})
			})
		);

		const hydrating = store.getState().hydrateSettings();
		store.getState().setOverlay("frameMarkers", true);
		resolveSettings({
			...baseSettings,
			volume: 60,
			overlays: { ...DEFAULT_OVERLAYS, cursorPath: true }
		});
		await hydrating;

		expect(store.getState().overlays.frameMarkers).toBe(true); // the edit survives
		expect(store.getState().overlays.cursorPath).toBe(true); // its own siblings hydrate around it
		expect(store.getState().volume).toBe(60); // untouched fields still hydrate
	});

	test("an audio edit in flight leaves the audio prefs the user did not touch at their persisted values", async () => {
		// one guard for the whole group would hold the other four at their
		// defaults around the edit and then WRITE those defaults, so a slider
		// touched during startup silently resets the offset, the other channel
		// and the beatmap-hitsound toggle
		const saved: { volume: number; audio: Settings["audio"] }[] = [];
		let resolveSettings!: (s: Settings) => void;
		const store = createViewerStore(
			deps({
				getSettings: () =>
					new Promise<Settings>((resolve) => {
						resolveSettings = resolve;
					}),
				setViewerPrefs: async (volume, audio, gameplay, overlays, editing, effects) => {
					saved.push({ volume, audio });
					return { ...baseSettings, volume, audio, gameplay, overlays, editing, effects };
				}
			})
		);
		const stored = { musicVolume: 55, hitsoundVolume: 20, offsetMs: -30, ignoreBeatmapHitsounds: true };

		const hydrating = store.getState().hydrateSettings();
		store.getState().setAudio("musicVolume", 12);
		resolveSettings({ ...baseSettings, volume: 80, audio: stored });
		await hydrating;

		expect(store.getState().audio).toEqual({ ...stored, musicVolume: 12 });
		expect(store.getState().volume).toBe(80); // the master is its own touch, not the group's
		expect(saved[0].audio).toEqual({ ...stored, musicVolume: 12 }); // and what reaches disk agrees
	});

	test("a master edit in flight does not hold the channels under it at their defaults", async () => {
		// the transport's slider and the audio group share a surface, not a
		// guard: the master is the only value a master drag chose
		let resolveSettings!: (s: Settings) => void;
		const store = createViewerStore(
			deps({
				getSettings: () =>
					new Promise<Settings>((resolve) => {
						resolveSettings = resolve;
					})
			})
		);
		const stored = { musicVolume: 55, hitsoundVolume: 20, offsetMs: -30, ignoreBeatmapHitsounds: true };

		const hydrating = store.getState().hydrateSettings();
		store.getState().setVolume(37);
		resolveSettings({ ...baseSettings, volume: 80, audio: stored });
		await hydrating;

		expect(store.getState().volume).toBe(37);
		expect(store.getState().audio).toEqual(stored);
	});

	test("a gameplay edit in flight leaves the gameplay prefs the user did not touch at their persisted values", async () => {
		// the two hitsound prefs render side by side in the audio category, so
		// the slider and the toggle are one reach apart -- moving one must not
		// reset the other
		let resolveSettings!: (s: Settings) => void;
		const store = createViewerStore(
			deps({
				getSettings: () =>
					new Promise<Settings>((resolve) => {
						resolveSettings = resolve;
					})
			})
		);

		const hydrating = store.getState().hydrateSettings();
		store.getState().setGameplay("positionalHitsoundLevel", 0.8);
		resolveSettings({
			...baseSettings,
			gameplay: {
				positionalHitsoundLevel: 0.1,
				alwaysPlayFirstComboBreak: false,
				snakingInSliders: true,
				snakingOutSliders: false
			}
		});
		await hydrating;

		expect(store.getState().gameplay).toEqual({
			positionalHitsoundLevel: 0.8,
			alwaysPlayFirstComboBreak: false,
			snakingInSliders: true,
			snakingOutSliders: false
		});
	});

	test("hydration does not stomp an editing pref changed while it was in flight", async () => {
		let resolveSettings!: (s: Settings) => void;
		const store = createViewerStore(
			deps({
				getSettings: () =>
					new Promise<Settings>((resolve) => {
						resolveSettings = resolve;
					})
			})
		);

		const hydrating = store.getState().hydrateSettings();
		store.getState().setEditing("snapToLattice", false);
		resolveSettings({ ...baseSettings, editing: { snapToLattice: true, warnOnOverwrite: true } });
		await hydrating;

		expect(store.getState().editing.snapToLattice).toBe(false); // the edit survives
	});

	test("an edit made while hydration is in flight is written through once it resolves", async () => {
		// the edit predates the persistence subscription (App installs it only
		// after hydration resolves) and the hydration guards re-emit nothing for
		// it, so hydrateSettings itself must save what it preserved -- otherwise
		// the pref silently reverts on the next launch
		const saved: { volume: number; editing: Settings["editing"] }[] = [];
		let resolveSettings!: (s: Settings) => void;
		const store = createViewerStore(
			deps({
				getSettings: () =>
					new Promise<Settings>((resolve) => {
						resolveSettings = resolve;
					}),
				setViewerPrefs: async (volume, audio, gameplay, overlays, editing, effects) => {
					saved.push({ volume, editing });
					return { ...baseSettings, volume, audio, gameplay, overlays, editing, effects };
				}
			})
		);

		const hydrating = store.getState().hydrateSettings();
		store.getState().setEditing("snapToLattice", false);
		resolveSettings({ ...baseSettings, volume: 80 });
		await hydrating;

		expect(saved).toHaveLength(1);
		expect(saved[0].editing.snapToLattice).toBe(false); // the preserved edit is persisted
		expect(saved[0].volume).toBe(80); // hydrated fields ride along unchanged
		expect(store.getState().settings?.editing.snapToLattice).toBe(false);
	});

	test("an edit made while the write-through save is in flight is saved as well", async () => {
		// the write-through has the same shape of gap as the settings read: its
		// own await. an edit landing inside it is absent from the in-flight
		// save and still predates the persistence subscription, so the store
		// must notice and save again with the fresh values
		const saved: Settings["editing"][] = [];
		const resolvers: (() => void)[] = [];
		let resolveSettings!: (s: Settings) => void;
		const store = createViewerStore(
			deps({
				getSettings: () =>
					new Promise<Settings>((resolve) => {
						resolveSettings = resolve;
					}),
				setViewerPrefs: (volume, audio, gameplay, overlays, editing, effects) => {
					saved.push(editing);
					return new Promise<Settings>((resolve) => {
						resolvers.push(() =>
							resolve({ ...baseSettings, volume, audio, gameplay, overlays, editing, effects })
						);
					});
				}
			})
		);

		const hydrating = store.getState().hydrateSettings();
		store.getState().setEditing("snapToLattice", false);
		resolveSettings(baseSettings);
		for (let i = 0; i < 20 && saved.length === 0; i++) await Promise.resolve();
		expect(saved).toHaveLength(1); // the first write-through is in flight

		store.getState().setEditing("warnOnOverwrite", false); // lands mid-save
		resolvers[0]();
		for (let i = 0; i < 20 && resolvers.length < 2; i++) await Promise.resolve();
		expect(saved).toHaveLength(2); // the mid-save edit forces a second save
		resolvers[1]();
		await hydrating;

		expect(saved[1]).toEqual({ snapToLattice: false, warnOnOverwrite: false });
		expect(store.getState().settings?.editing).toEqual({ snapToLattice: false, warnOnOverwrite: false });
	});

	test("hydration without in-flight edits writes nothing back", async () => {
		// the loaded values round-tripping straight back into settings.json is
		// exactly what installing persistence after hydration exists to prevent
		let saves = 0;
		const store = createViewerStore(
			deps({
				setViewerPrefs: async (volume, audio, gameplay, overlays, editing, effects) => {
					saves += 1;
					return { ...baseSettings, volume, audio, gameplay, overlays, editing, effects };
				}
			})
		);
		await store.getState().hydrateSettings();
		expect(saves).toBe(0);
	});

	test("loadSettings leaves volume and overlays alone", async () => {
		// the dialog reopens mid-debounce; re-applying disk values there would
		// silently revert changes the user just made
		const store = createViewerStore(
			deps({
				getSettings: async () => ({ ...baseSettings, volume: 10 })
			})
		);
		store.getState().setVolume(80);
		store.getState().setOverlay("cursorPath", true);

		await store.getState().loadSettings();

		expect(store.getState().volume).toBe(80);
		expect(store.getState().overlays.cursorPath).toBe(true);
		expect(store.getState().settings?.volume).toBe(10);
	});

	test("setVolume rounds and clamps, and rejects non-finite input", () => {
		const store = createViewerStore(deps());
		store.getState().setVolume(63.4);
		expect(store.getState().volume).toBe(63);
		store.getState().setVolume(250);
		expect(store.getState().volume).toBe(100);
		store.getState().setVolume(-5);
		expect(store.getState().volume).toBe(0);
		store.getState().setVolume(Number.NaN);
		expect(store.getState().volume).toBe(0); // unchanged
	});

	test("setAudio rounds and clamps each channel on the master's terms", () => {
		const store = createViewerStore(deps());
		store.getState().setAudio("musicVolume", 63.4);
		expect(store.getState().audio.musicVolume).toBe(63);
		store.getState().setAudio("hitsoundVolume", 250);
		expect(store.getState().audio.hitsoundVolume).toBe(100);
		store.getState().setAudio("hitsoundVolume", Number.NaN);
		expect(store.getState().audio.hitsoundVolume).toBe(100); // unchanged
		// the two channels are independent: setting one must not disturb the other
		expect(store.getState().audio.musicVolume).toBe(63);
	});

	test("setAudio clamps the offset on its own range, not the volumes'", () => {
		// the offset is signed and its neutral value is 0, so it shares neither
		// the 0-100 range nor the "fall back to a bound" rule
		const store = createViewerStore(deps());
		store.getState().setAudio("offsetMs", -120.4);
		expect(store.getState().audio.offsetMs).toBe(-120);
		store.getState().setAudio("offsetMs", 9000);
		expect(store.getState().audio.offsetMs).toBe(500);
		store.getState().setAudio("offsetMs", -9000);
		expect(store.getState().audio.offsetMs).toBe(-500);
		store.getState().setAudio("offsetMs", Number.NaN);
		expect(store.getState().audio.offsetMs).toBe(-500); // unchanged
	});

	test("a channel edit that returns to its starting value still wins over the loaded level", async () => {
		// the same property setVolume's guard has, one level down: a drag away
		// and back lands on the pre-hydration value, so only the record of the
		// touch can tell it apart from a channel nobody moved
		let resolveSettings!: (s: Settings) => void;
		const store = createViewerStore(
			deps({
				getSettings: () =>
					new Promise<Settings>((resolve) => {
						resolveSettings = resolve;
					})
			})
		);

		const hydrating = store.getState().hydrateSettings();
		store.getState().setAudio("musicVolume", 20);
		store.getState().setAudio("musicVolume", 100); // back to the initial default
		resolveSettings({
			...baseSettings,
			audio: { musicVolume: 90, hitsoundVolume: 90, offsetMs: 0, ignoreBeatmapHitsounds: false }
		});
		await hydrating;

		expect(store.getState().audio.musicVolume).toBe(100);
		expect(store.getState().audio.hitsoundVolume).toBe(90); // the channel beside it hydrates
	});

	test("setOverlay clamps displayLength on commit and ignores a blank field", () => {
		const store = createViewerStore(deps());
		store.getState().setOverlay("displayLength", 50);
		expect(store.getState().overlays.displayLength).toBe(200);
		store.getState().setOverlay("displayLength", 9999);
		expect(store.getState().overlays.displayLength).toBe(2000);
		store.getState().setOverlay("displayLength", 634.7);
		expect(store.getState().overlays.displayLength).toBe(635);
		// an empty number field emits NaN; the last good value must stand
		store.getState().setOverlay("displayLength", Number.NaN);
		expect(store.getState().overlays.displayLength).toBe(635);
		// booleans are untouched by the numeric guard
		store.getState().setOverlay("hideCursor", true);
		expect(store.getState().overlays.hideCursor).toBe(true);
	});

	test("the playfield grid ships off and only ever holds an allowed spacing", () => {
		const store = createViewerStore(deps());
		expect(store.getState().overlays.playfieldGrid).toBe(0);
		store.getState().setOverlay("playfieldGrid", 16);
		expect(store.getState().overlays.playfieldGrid).toBe(16);
		// off is one of the spacings, not a separate flag
		store.getState().setOverlay("playfieldGrid", 0);
		expect(store.getState().overlays.playfieldGrid).toBe(0);
		// out of the set: off rather than a value the renderer must interpret
		store.getState().setOverlay("playfieldGrid", 24);
		expect(store.getState().overlays.playfieldGrid).toBe(0);
	});
});

describe("effect settings", () => {
	test("everything ships on but the 300 popups, mirroring settings.rs EffectPrefs::default", () => {
		expect(createViewerStore(deps()).getState().effects).toEqual({
			enabled: true,
			hitAnimations: true,
			hitEffects: true,
			cursorGlow: true,
			cursorTrail: true,
			followPoints: true,
			ignoreBeatmapSkin: false,
			// the one that ships off: a popup on every great buries the 100s and
			// 50s a replay is opened to find
			show300Judgements: false,
			backgroundDim: DEFAULT_BACKGROUND_DIM
		});
	});

	test("the master gates every effect without erasing what is stored underneath", () => {
		const store = createViewerStore(deps());
		store.getState().setEffect("cursorTrail", false);
		store.getState().setEffect("enabled", false);

		// stored: only the one the user actually turned off is off
		expect(store.getState().effects.hitEffects).toBe(true);
		expect(store.getState().effects.cursorTrail).toBe(false);
		// effective: the master takes everything down with it
		expect(effectiveEffects(store.getState().effects)).toEqual({
			enabled: false,
			hitAnimations: false,
			hitEffects: false,
			cursorGlow: false,
			cursorTrail: false,
			followPoints: false,
			// not folded: refusing a map's art is a source decision, and the
			// master must not silently start drawing art the user turned down
			ignoreBeatmapSkin: false,
			show300Judgements: false,
			// not an effect: the master takes every toggle down and leaves the
			// background exactly as dim as the user set it
			backgroundDim: DEFAULT_BACKGROUND_DIM
		});

		// and switching the master back on restores exactly what was chosen
		store.getState().setEffect("enabled", true);
		const live = effectiveEffects(store.getState().effects);
		expect(live.hitEffects).toBe(true);
		expect(live.cursorTrail).toBe(false);
	});

	test("the background dim is clamped on the way in, like display length", () => {
		const store = createViewerStore(deps());
		store.getState().setEffect("backgroundDim", 140);
		expect(store.getState().effects.backgroundDim).toBe(100);
		store.getState().setEffect("backgroundDim", -20);
		expect(store.getState().effects.backgroundDim).toBe(0);
		store.getState().setEffect("backgroundDim", 63.4);
		expect(store.getState().effects.backgroundDim).toBe(63);
		// the last good value stands rather than a NaN reaching the scrim
		store.getState().setEffect("backgroundDim", Number.NaN);
		expect(store.getState().effects.backgroundDim).toBe(63);
		// booleans are untouched by the numeric guard
		store.getState().setEffect("cursorGlow", false);
		expect(store.getState().effects.cursorGlow).toBe(false);
	});

	test("effectiveEffects hands back the same object when the master is on", () => {
		// the renderer compares the resolved hitAnimations to decide on a scene
		// rebuild, so this must be a plain pass-through, never a rewrite
		const store = createViewerStore(deps());
		const effects = store.getState().effects;
		expect(effectiveEffects(effects)).toBe(effects);
	});

	test("hydrateSettings applies the persisted effects and fills gaps from the defaults", async () => {
		const stored = { ...baseSettings, effects: { ...DEFAULT_EFFECTS, enabled: false, cursorGlow: false } };
		const store = createViewerStore(deps({ getSettings: async () => stored }));
		await store.getState().hydrateSettings();
		expect(store.getState().effects).toEqual(stored.effects);

		// a settings file written before this section existed
		const legacy = createViewerStore(
			deps({
				getSettings: async () =>
					({ osuStablePath: null, volume: 70, overlays: {}, recents: [] }) as unknown as Settings
			})
		);
		await legacy.getState().hydrateSettings();
		expect(legacy.getState().effects).toEqual(DEFAULT_EFFECTS);
	});

	test("an effect toggled while hydration is in flight survives and is written through", async () => {
		const saved: Settings["effects"][] = [];
		let resolveSettings!: (s: Settings) => void;
		const store = createViewerStore(
			deps({
				getSettings: () =>
					new Promise<Settings>((resolve) => {
						resolveSettings = resolve;
					}),
				setViewerPrefs: async (volume, audio, gameplay, overlays, editing, effects) => {
					saved.push(effects);
					return { ...baseSettings, volume, audio, gameplay, overlays, editing, effects };
				}
			})
		);

		const hydrating = store.getState().hydrateSettings();
		store.getState().setEffect("hitAnimations", false);
		resolveSettings({ ...baseSettings, effects: DEFAULT_EFFECTS });
		await hydrating;

		expect(store.getState().effects.hitAnimations).toBe(false); // the edit wins over the loaded value
		expect(saved).toHaveLength(1);
		expect(saved[0].hitAnimations).toBe(false); // and it reaches disk
		expect(store.getState().settings?.effects.hitAnimations).toBe(false);
	});
});

describe("timeline settings", () => {
	test("every layer ships visible, mirroring settings.rs TimelinePrefs::default", () => {
		expect(createViewerStore(deps()).getState().timeline).toEqual({
			hitWindowBands: true,
			tethers: true,
			nestedMarks: true,
			severityTicks: true
		});
	});

	test("setTimeline flips one layer and leaves the rest alone", () => {
		const store = createViewerStore(deps());
		store.getState().setTimeline("tethers", false);
		expect(store.getState().timeline.tethers).toBe(false);
		expect(store.getState().timeline.hitWindowBands).toBe(true);
	});

	test("hydrateSettings applies the persisted timeline and fills gaps from the defaults", async () => {
		const stored = { ...baseSettings, timeline: { ...DEFAULT_TIMELINE, severityTicks: false } };
		const store = createViewerStore(deps({ getSettings: async () => stored }));
		await store.getState().hydrateSettings();
		expect(store.getState().timeline).toEqual(stored.timeline);

		// a settings file written before this section existed
		const legacy = createViewerStore(
			deps({
				getSettings: async () =>
					({ osuStablePath: null, volume: 70, overlays: {}, recents: [] }) as unknown as Settings
			})
		);
		await legacy.getState().hydrateSettings();
		expect(legacy.getState().timeline).toEqual(DEFAULT_TIMELINE);
	});

	test("a layer toggled while hydration is in flight survives and is written through", async () => {
		const saved: Settings["timeline"][] = [];
		let resolveSettings!: (s: Settings) => void;
		const store = createViewerStore(
			deps({
				getSettings: () =>
					new Promise<Settings>((resolve) => {
						resolveSettings = resolve;
					}),
				setViewerPrefs: async (volume, audio, gameplay, overlays, editing, effects, timeline) => {
					saved.push(timeline);
					return { ...baseSettings, volume, audio, gameplay, overlays, editing, effects, timeline };
				}
			})
		);

		const hydrating = store.getState().hydrateSettings();
		store.getState().setTimeline("hitWindowBands", false);
		resolveSettings({ ...baseSettings, timeline: DEFAULT_TIMELINE });
		await hydrating;

		expect(store.getState().timeline.hitWindowBands).toBe(false); // the edit wins over the loaded value
		expect(saved).toHaveLength(1);
		expect(saved[0].hitWindowBands).toBe(false); // and it reaches disk
		expect(store.getState().settings?.timeline.hitWindowBands).toBe(false);
	});
});

describe("pendingRecovery (openers.ts routes a dropped beatmap through this, not lastError)", () => {
	test("a pickBeatmap-recoverable error records the osrPath, and it survives clearError", async () => {
		// App.tsx's toast effect calls clearError() synchronously in the same
		// effect that raises the toast (src/App.tsx:35), so lastError is gone by
		// the time a user actually drags a beatmap onto the window. pendingRecovery
		// must have its own lifetime, independent of that toast-driven clear
		const store = createViewerStore(
			deps({
				loadReplay: reject({ kind: "beatmapNotFound", md5: "abc" })
			})
		);
		await store.getState().openReplay("C:\\r.osr");
		expect(store.getState().pendingRecovery).toBe("C:\\r.osr");

		store.getState().clearError();
		expect(store.getState().lastError).toBeNull();
		expect(store.getState().pendingRecovery).toBe("C:\\r.osr");
	});

	test("osuDbNotFound is pickBeatmap-recoverable too", async () => {
		const store = createViewerStore(
			deps({
				loadReplay: reject({ kind: "osuDbNotFound", searched: [] })
			})
		);
		await store.getState().openReplay("C:\\r.osr");
		expect(store.getState().pendingRecovery).toBe("C:\\r.osr");
	});

	test("a dropped beatmap after beatmapNotFound reaches openWithBeatmap with the recorded osrPath", async () => {
		// mirrors installDropHandler's routing (src/lib/openers.ts): reads
		// pendingRecovery, not lastError, to decide where a dropped beatmap goes
		const calls: { osrPath: string; beatmapPath: string }[] = [];
		const store = createViewerStore(
			deps({
				loadReplay: reject({ kind: "beatmapNotFound", md5: "abc" }),
				loadReplayWithBeatmap: async (osrPath, beatmapPath) => {
					calls.push({ osrPath, beatmapPath });
					return testScene();
				}
			})
		);
		await store.getState().openReplay("C:\\r.osr");
		store.getState().clearError();

		const { pendingRecovery } = store.getState();
		expect(pendingRecovery).not.toBeNull();
		await store.getState().openWithBeatmap(pendingRecovery!, "C:\\m.osu");

		expect(calls).toEqual([{ osrPath: "C:\\r.osr", beatmapPath: "C:\\m.osu" }]);
		expect(store.getState().scene).not.toBeNull();
	});

	test("a successful load clears pendingRecovery", async () => {
		let shouldFail = true;
		const store = createViewerStore(
			deps({
				loadReplay: async () => {
					if (shouldFail) throw { kind: "beatmapNotFound", md5: "abc" } satisfies IpcError;
					return testScene();
				}
			})
		);
		await store.getState().openReplay("C:\\r.osr");
		expect(store.getState().pendingRecovery).toBe("C:\\r.osr");

		shouldFail = false;
		await store.getState().openReplay("C:\\r.osr");
		expect(store.getState().pendingRecovery).toBeNull();
	});

	test("a later load attempt that fails without pickBeatmap recovery clears the stale pendingRecovery", async () => {
		// judgement call: pendingRecovery always reflects only the most recent
		// load attempt's outcome, so a second, unrelated failure (here a corrupt
		// replay, which has no recovery at all) invalidates the earlier
		// beatmapNotFound's recovery rather than leaving it dangling and
		// silently routing a later beatmap drop at the wrong replay
		let errorKind: "beatmapNotFound" | "replayParse" = "beatmapNotFound";
		const store = createViewerStore(
			deps({
				loadReplay: async () => {
					if (errorKind === "beatmapNotFound")
						throw { kind: "beatmapNotFound", md5: "abc" } satisfies IpcError;
					throw { kind: "replayParse", message: "corrupt" } satisfies IpcError;
				}
			})
		);
		await store.getState().openReplay("C:\\r.osr");
		expect(store.getState().pendingRecovery).toBe("C:\\r.osr");

		errorKind = "replayParse";
		await store.getState().openReplay("C:\\other.osr");
		expect(store.getState().lastError?.error.kind).toBe("replayParse");
		expect(store.getState().pendingRecovery).toBeNull();
	});

	test("starting a new load clears the stale pendingRecovery immediately", async () => {
		// a beatmap dropped while the new load is in flight must not route to
		// the previous replay's recovery (src/lib/openers.ts reads this field
		// live, and the drop handler is not gated by `loading`)
		let resolveNext!: (scene: LoadedScene) => void;
		let call = 0;
		const store = createViewerStore(
			deps({
				loadReplay: () => {
					call += 1;
					if (call === 1) return Promise.reject({ kind: "beatmapNotFound", md5: "abc" } satisfies IpcError);
					return new Promise<LoadedScene>((resolve) => {
						resolveNext = resolve;
					});
				}
			})
		);
		await store.getState().openReplay("C:\\a.osr");
		expect(store.getState().pendingRecovery).toBe("C:\\a.osr");

		const second = store.getState().openReplay("C:\\b.osr");
		expect(store.getState().pendingRecovery).toBeNull();
		await Promise.resolve(); // let the queued ipc call start so resolveNext exists
		resolveNext(testScene());
		await second;
		expect(store.getState().pendingRecovery).toBeNull();
	});

	test("a beatmapMismatch outcome does not set pendingRecovery (its own recovery is offerMismatch, not pickBeatmap)", async () => {
		const store = createViewerStore(
			deps({
				loadReplayWithBeatmap: reject({ kind: "beatmapMismatch", expectedMd5: "a", actualMd5: "b" })
			})
		);
		await store.getState().openWithBeatmap("C:\\r.osr", "C:\\m.osu");
		expect(store.getState().pendingMismatch).not.toBeNull();
		expect(store.getState().pendingRecovery).toBeNull();
	});
});

describe("the discard prompt", () => {
	// the rule, in one sentence: guard once, at the moment the user asks for a
	// different replay; every continuation of an already-guarded request loads
	// without re-asking. these assert what a user ends up with -- a document
	// that survived, or a replay that opened -- not which field moved

	/** a store showing a replay whose document has one landed edit, which is
	 * the only situation the prompt exists for */
	async function withUnsavedEdits(overrides: Partial<IpcDeps> = {}) {
		const store = createViewerStore(
			deps({
				loadReplay: async () => latticeScene(),
				applyEdit: async () => moveDelta(1, 1, { time: 16, x: 9.5, y: 0.5, buttons: 0 }, "move"),
				...overrides
			})
		);
		await store.getState().openReplay("C:\\loaded.osr");
		await store.getState().commitEdit({
			label: "move",
			payload: { kind: "ops", ops: [{ kind: "moveFrames", moves: [{ index: 1, x: 9.5, y: 0.5 }] }] }
		});
		expect(store.getState().editor!.dirty).toBe(true);
		return store;
	}

	test("an edit still in flight is guarded, not raced past", async () => {
		// `dirty` mirrors the last LANDED delta, so the first edit of a session
		// -- the one with nothing dirty before it -- is invisible to the guard
		// until its response arrives. reading it straight would let the open
		// through, and install() cancels the queue and drops the in-flight
		// response by epoch, so the edit would go without the question
		let landEdit!: () => void;
		const opened: string[] = [];
		const store = createViewerStore(
			deps({
				loadReplay: async (osrPath) => {
					opened.push(osrPath);
					return latticeScene();
				},
				applyEdit: async () => {
					await new Promise<void>((resolve) => {
						landEdit = resolve;
					});
					return moveDelta(1, 1, { time: 16, x: 9.5, y: 0.5, buttons: 0 }, "move");
				}
			})
		);
		await store.getState().openReplay("C:\\loaded.osr");

		const edit = store.getState().commitEdit({
			label: "move",
			payload: { kind: "ops", ops: [{ kind: "moveFrames", moves: [{ index: 1, x: 9.5, y: 0.5 }] }] }
		});
		await Promise.resolve(); // let the commit actually reach ipc
		expect(store.getState().editor!.dirty).toBe(false); // nothing has landed yet

		const open = store.getState().openReplay("C:\\other.osr");
		landEdit();
		await edit;
		await open;

		expect(opened).toEqual(["C:\\loaded.osr"]); // the open never reached ipc
		expect(store.getState().pendingOpen).toEqual({ osrPath: "C:\\other.osr" });
		expect(store.getState().editor!.dirty).toBe(true);
	});

	test("a cancelled open costs the user nothing: same replay, same edits, no load attempted", async () => {
		const opened: string[] = [];
		const store = await withUnsavedEdits({
			loadReplay: async (osrPath) => {
				opened.push(osrPath);
				return latticeScene();
			}
		});
		const before = store.getState();

		await store.getState().openReplay("C:\\other.osr");
		expect(opened).toEqual(["C:\\loaded.osr"]); // the request never reached ipc
		expect(store.getState().pendingOpen).toEqual({ osrPath: "C:\\other.osr" });

		store.getState().dismissDiscard();
		const after = store.getState();
		expect(after.pendingOpen).toBeNull();
		expect(opened).toEqual(["C:\\loaded.osr"]);
		expect(after.osrPath).toBe("C:\\loaded.osr");
		expect(after.scene).toBe(before.scene);
		expect(after.editor).toBe(before.editor);
		expect(after.editor!.dirty).toBe(true);
		expect(after.editor!.canUndo).toBe(true);
		expect(after.sceneId).toBe(before.sceneId);
	});

	test("confirming opens the replay that was asked for, and the edits are gone with it", async () => {
		const opened: string[] = [];
		const store = await withUnsavedEdits({
			loadReplay: async (osrPath) => {
				opened.push(osrPath);
				return latticeScene();
			}
		});

		await store.getState().openReplay("C:\\other.osr");
		await store.getState().confirmDiscard();

		expect(opened).toEqual(["C:\\loaded.osr", "C:\\other.osr"]);
		expect(store.getState().osrPath).toBe("C:\\other.osr");
		expect(store.getState().editor!.dirty).toBe(false);
		expect(store.getState().editor!.canUndo).toBe(false);
		expect(store.getState().pendingOpen).toBeNull();
	});

	test("a document with no edits opens straight through", async () => {
		const opened: string[] = [];
		const store = createViewerStore(
			deps({
				loadReplay: async (osrPath) => {
					opened.push(osrPath);
					return testScene();
				}
			})
		);
		await store.getState().openReplay("C:\\a.osr");
		await store.getState().openReplay("C:\\b.osr");

		expect(opened).toEqual(["C:\\a.osr", "C:\\b.osr"]);
		expect(store.getState().pendingOpen).toBeNull();
		expect(store.getState().osrPath).toBe("C:\\b.osr");
	});

	test("the start screen never prompts -- there is no document to discard", async () => {
		const store = createViewerStore(deps());
		expect(store.getState().editor).toBeNull();
		await store.getState().openReplay("C:\\first.osr");
		expect(store.getState().pendingOpen).toBeNull();
		expect(store.getState().scene).not.toBeNull();
	});

	test("opening the replay already on screen prompts too", async () => {
		// it is a discard either way. a same-path exemption is a special case
		// that would silently destroy an edit exactly once
		const store = await withUnsavedEdits();
		await store.getState().openReplay("C:\\loaded.osr");
		expect(store.getState().pendingOpen).toEqual({ osrPath: "C:\\loaded.osr" });
		expect(store.getState().editor!.dirty).toBe(true);
	});

	test("a load that fails after a confirmed discard leaves the edited document intact", async () => {
		// nothing is discarded by the consent itself: install() runs only on
		// success, so the user keeps their document and gets the usual toast
		let firstLoad = true;
		const store = await withUnsavedEdits({
			loadReplay: async () => {
				if (firstLoad) {
					firstLoad = false;
					return latticeScene();
				}
				throw { kind: "beatmapNotFound", md5: "abc" } satisfies IpcError;
			}
		});
		const before = store.getState();

		await store.getState().openReplay("C:\\other.osr");
		await store.getState().confirmDiscard();

		expect(store.getState().lastError?.error.kind).toBe("beatmapNotFound");
		expect(store.getState().scene).toBe(before.scene);
		expect(store.getState().osrPath).toBe("C:\\loaded.osr");
		expect(store.getState().editor).toBe(before.editor);
		expect(store.getState().editor!.dirty).toBe(true);
	});

	test("one decision is one dialog: the picker and the mismatch override after a discard never re-ask", async () => {
		// the whole walk a user takes when the replay they discarded for turns
		// out to need a beatmap picked, and the picked one does not match. the
		// document is still dirty for every step of it -- nothing was discarded,
		// because nothing has loaded -- so an unguarded continuation is the only
		// thing keeping this to a single prompt
		let firstLoad = true;
		const store = await withUnsavedEdits({
			loadReplay: async () => {
				if (firstLoad) {
					firstLoad = false;
					return latticeScene();
				}
				throw { kind: "beatmapNotFound", md5: "abc" } satisfies IpcError;
			},
			loadReplayWithBeatmap: async (_osr, _map, allow) => {
				if (!allow) throw { kind: "beatmapMismatch", expectedMd5: "a", actualMd5: "b" } satisfies IpcError;
				return latticeScene();
			}
		});

		await store.getState().openReplay("C:\\other.osr");
		await store.getState().confirmDiscard();
		expect(store.getState().pendingRecovery).toBe("C:\\other.osr");
		expect(store.getState().editor!.dirty).toBe(true);

		// the error toast's "pick beatmap" action, or a beatmap dropped onto the
		// window: a continuation, so no second prompt
		await store.getState().openWithBeatmap("C:\\other.osr", "C:\\m.osu");
		expect(store.getState().pendingOpen).toBeNull();
		expect(store.getState().pendingMismatch).not.toBeNull();
		expect(store.getState().editor!.dirty).toBe(true);

		// and neither does the override
		await store.getState().confirmMismatch();
		expect(store.getState().pendingOpen).toBeNull();
		expect(store.getState().osrPath).toBe("C:\\other.osr");
		expect(store.getState().editor!.dirty).toBe(false);
	});

	test("a scene install drops a prompt about the document it replaced", async () => {
		// the prompt asks whether to throw away THIS document; once another load
		// has replaced it the question no longer means anything
		const store = await withUnsavedEdits();
		await store.getState().openReplay("C:\\other.osr");
		expect(store.getState().pendingOpen).not.toBeNull();

		// an unguarded continuation lands a scene while the prompt is up
		await store.getState().openWithBeatmap("C:\\third.osr", "C:\\m.osu");
		expect(store.getState().pendingOpen).toBeNull();
	});

	test("a superseded load that still installs drops the prompt too", async () => {
		// a stale success installs here because its command already installed
		// backend-side, and it brings a fresh un-dirty document with it -- so a
		// prompt left standing would be asking about edits that no longer exist.
		// the newer load is held open, so only the stale install can be what
		// cleared it
		let resolveStale!: (scene: LoadedScene) => void;
		let calls = 0;
		const store = await withUnsavedEdits({
			loadReplayWithBeatmap: () => {
				calls += 1;
				if (calls === 1) {
					return new Promise<LoadedScene>((resolve) => {
						resolveStale = resolve;
					});
				}
				return new Promise<LoadedScene>(() => {});
			}
		});

		const stale = store.getState().openWithBeatmap("C:\\b.osr", "C:\\m.osu");
		await Promise.resolve(); // let the first ipc call actually start
		await store.getState().openReplay("C:\\c.osr");
		expect(store.getState().pendingOpen).not.toBeNull();

		void store.getState().openWithBeatmap("C:\\b.osr", "C:\\m.osu"); // supersedes it, never settles
		resolveStale(latticeScene());
		await stale;

		expect(store.getState().scene).not.toBeNull();
		expect(store.getState().editor!.dirty).toBe(false);
		expect(store.getState().pendingOpen).toBeNull();
	});

	test("a new request supersedes an outstanding mismatch offer instead of stacking on it", async () => {
		// both are <Dialog open> at the app root, so a mismatch left standing
		// would render alongside the prompt -- two modals, each asking about a
		// different replay. native drops are not blocked by a webview modal, so
		// this is reachable by dropping a .osr over the mismatch dialog
		const store = await withUnsavedEdits({
			loadReplayWithBeatmap: reject({ kind: "beatmapMismatch", expectedMd5: "a", actualMd5: "b" })
		});
		await store.getState().openWithBeatmap("C:\\b.osr", "C:\\m.osu");
		expect(store.getState().pendingMismatch).not.toBeNull();

		await store.getState().openReplay("C:\\c.osr");
		expect(store.getState().pendingOpen).toEqual({ osrPath: "C:\\c.osr" });
		expect(store.getState().pendingMismatch).toBeNull();
		// and the document the prompt is about is still there to be discarded
		expect(store.getState().editor!.dirty).toBe(true);
	});
});

describe("recents", () => {
	test("a successful load refreshes settings so the new recent is visible", async () => {
		let settingsCalls = 0;
		const store = createViewerStore(
			deps({
				getSettings: async () => {
					settingsCalls += 1;
					return { ...baseSettings, recents: settingsCalls > 1 ? [sampleRecent] : [] };
				}
			})
		);
		await store.getState().hydrateSettings();
		expect(store.getState().settings?.recents).toEqual([]);

		await store.getState().openReplay("a.osr");
		expect(store.getState().settings?.recents).toEqual([sampleRecent]);
	});

	test("a failed settings refresh leaves the loaded scene alone", async () => {
		const store = createViewerStore(
			deps({
				getSettings: async () => {
					throw new Error("unreadable");
				}
			})
		);
		await store.getState().openReplay("a.osr");
		expect(store.getState().scene).not.toBeNull();
		expect(store.getState().lastError).toBeNull();
	});

	test("a stale refresh cannot clobber a newer one when the two getSettings calls resolve out of order", async () => {
		// each load's post-install refresh issues its own independent
		// getSettings call -- unlike the loads themselves, those calls have no
		// queue ordering them, so ordinary ipc jitter can let an older load's
		// refresh resolve after a newer load's. resolving them out of order
		// here (newer first, older last) proves a sequence guard decides the
		// winner rather than whichever ipc call happens to land last
		let resolveOlder!: (settings: Settings) => void;
		let resolveNewer!: (settings: Settings) => void;
		let call = 0;
		const store = createViewerStore(
			deps({
				getSettings: () =>
					new Promise<Settings>((resolve) => {
						call += 1;
						if (call === 1) resolveOlder = resolve;
						else resolveNewer = resolve;
					})
			})
		);

		await store.getState().openReplay("a.osr");
		await store.getState().openReplay("b.osr");

		resolveNewer({ ...baseSettings, osuStablePath: "newer" });
		await Promise.resolve();
		await Promise.resolve();
		resolveOlder({ ...baseSettings, osuStablePath: "older" });
		await Promise.resolve();
		await Promise.resolve();

		expect(store.getState().settings?.osuStablePath).toBe("newer");
	});

	test("a pending refresh cannot clobber a settings write that lands before it resolves", async () => {
		// the post-install refresh has no ordering relationship to
		// saveStablePath either: a getSettings issued by the load can resolve
		// after the save's response and would otherwise publish its stale
		// snapshot over the path the user just saved
		let resolveRefresh!: (settings: Settings) => void;
		const store = createViewerStore(
			deps({
				getSettings: () =>
					new Promise<Settings>((resolve) => {
						resolveRefresh = resolve;
					})
			})
		);

		await store.getState().openReplay("a.osr");
		await store.getState().saveStablePath("D:\\osu!");
		expect(store.getState().settings?.osuStablePath).toBe("D:\\osu!");

		resolveRefresh(baseSettings); // the pre-save snapshot arrives late
		await Promise.resolve();
		await Promise.resolve();

		expect(store.getState().settings?.osuStablePath).toBe("D:\\osu!");
	});

	test("a slow hydration read cannot cancel or clobber a newer post-load refresh", async () => {
		// hydration claims its publication slot at initiation: when a replay
		// load's refresh starts after it, a late-resolving hydration read must
		// neither publish its older settings snapshot nor invalidate the newer
		// refresh -- while still applying the frontend-owned volume it loaded
		let resolveHydration!: (settings: Settings) => void;
		let resolveRefresh!: (settings: Settings) => void;
		let call = 0;
		const store = createViewerStore(
			deps({
				getSettings: () =>
					new Promise<Settings>((resolve) => {
						call += 1;
						if (call === 1) resolveHydration = resolve;
						else resolveRefresh = resolve;
					})
			})
		);

		const hydrating = store.getState().hydrateSettings();
		await store.getState().openReplay("a.osr"); // the refresh claims the newer slot
		resolveHydration({ ...baseSettings, volume: 55 });
		await hydrating;
		resolveRefresh({ ...baseSettings, recents: [sampleRecent] });
		await Promise.resolve();
		await Promise.resolve();

		expect(store.getState().volume).toBe(55); // frontend-owned prefs still hydrate
		expect(store.getState().settings?.recents).toEqual([sampleRecent]); // the newer refresh survives
	});

	test("clearRecents publishes the returned settings", async () => {
		const store = createViewerStore(
			deps({
				clearRecents: async () => ({ ...baseSettings, recents: [] }),
				// the skin deps: the picker's rows, the resolved selection, and the two
				// writes. a test that does not exercise skinning still needs them, since
				// hydrateSettings resolves the persisted locator on every startup
				listSkins: async () => [],
				getSkin: async () => bundledManifest(),
				setSkin: async () => bundledManifest(),
				importSkin: async () => bundledManifest()
			})
		);
		await store.getState().clearRecents();
		expect(store.getState().settings?.recents).toEqual([]);
	});
});

describe("shell state", () => {
	test("watch mode collapses the panel, edit mode opens it", () => {
		const store = createViewerStore(deps());
		expect(store.getState().mode).toBe("watch");
		store.getState().setMode("edit");
		expect(store.getState().panelOpen).toBe(true);
		store.getState().setMode("watch");
		expect(store.getState().panelOpen).toBe(false);
	});

	test("the rail toggle overrides the mode default in either direction", () => {
		const store = createViewerStore(deps());
		store.getState().setMode("watch");
		store.getState().togglePanel();
		expect(store.getState().panelOpen).toBe(true);
		expect(store.getState().mode).toBe("watch");
	});

	test("selecting a tab opens the panel -- a tab click with a closed panel does nothing otherwise", () => {
		const store = createViewerStore(deps());
		store.getState().setMode("watch");
		store.getState().setPanelTab("analysis");
		expect(store.getState().panelTab).toBe("analysis");
		expect(store.getState().panelOpen).toBe(true);
	});

	test("feather and strength are session tool parameters with clamps, never persisted", () => {
		const store = createViewerStore(deps());
		expect(store.getState().featherMs).toBe(40);
		expect(store.getState().smoothStrength).toBe(100);
		store.getState().setFeatherMs(120.6);
		expect(store.getState().featherMs).toBe(121);
		store.getState().setFeatherMs(-5);
		expect(store.getState().featherMs).toBe(0);
		store.getState().setFeatherMs(Number.NaN);
		expect(store.getState().featherMs).toBe(0);
		store.getState().setSmoothStrength(55.4);
		expect(store.getState().smoothStrength).toBe(55);
		store.getState().setSmoothStrength(300);
		expect(store.getState().smoothStrength).toBe(100);
		store.getState().setSmoothStrength(Number.NaN);
		expect(store.getState().smoothStrength).toBe(100);
	});

	test("the detail span is clamped to the allowed range", () => {
		const store = createViewerStore(deps());
		store.getState().setDetailSpan(10);
		expect(store.getState().detailSpanMs).toBe(DETAIL_SPAN_MIN);
		store.getState().setDetailSpan(1e9);
		expect(store.getState().detailSpanMs).toBe(DETAIL_SPAN_MAX);
		store.getState().setDetailSpan(Number.NaN);
		expect(store.getState().detailSpanMs).toBe(DETAIL_SPAN_MAX);
	});
});

describe("viewport framing", () => {
	test("a fresh store opens at 100%, centred", () => {
		const store = createViewerStore(deps());
		expect(store.getState().viewportZoom).toBe(1);
		expect(store.getState().viewportPan).toEqual({ x: 0, y: 0 });
	});

	test("the zoom is clamped to 50-400% however it is set", () => {
		const store = createViewerStore(deps());
		store.getState().setViewportZoom(9, { x: 0, y: 0 });
		expect(store.getState().viewportZoom).toBe(VIEWPORT_ZOOM_MAX);
		store.getState().setViewportZoom(0.01, { x: 0, y: 0 });
		expect(store.getState().viewportZoom).toBe(VIEWPORT_ZOOM_MIN);
	});

	test("zoom and pan land in one write, so no frame shows the new zoom at the old pan", () => {
		const store = createViewerStore(deps());
		let writes = 0;
		const unsubscribe = store.subscribe(() => (writes += 1));
		store.getState().setViewportZoom(2, { x: 40, y: -12 });
		unsubscribe();
		expect(writes).toBe(1);
		expect(store.getState().viewportZoom).toBe(2);
		expect(store.getState().viewportPan).toEqual({ x: 40, y: -12 });
	});

	test("panning moves the pan and leaves the zoom alone", () => {
		const store = createViewerStore(deps());
		store.getState().setViewportZoom(3, { x: 0, y: 0 });
		store.getState().panViewport({ x: -80, y: 15 });
		expect(store.getState().viewportZoom).toBe(3);
		expect(store.getState().viewportPan).toEqual({ x: -80, y: 15 });
	});

	test("reset puts both back to the default framing", () => {
		const store = createViewerStore(deps());
		store.getState().setViewportZoom(3.4, { x: -80, y: 15 });
		store.getState().resetViewport();
		expect(store.getState().viewportZoom).toBe(1);
		expect(store.getState().viewportPan).toEqual({ x: 0, y: 0 });
	});

	test("loading a replay resets the framing -- a held zoom would point at nothing", async () => {
		const store = createViewerStore(deps());
		store.getState().setViewportZoom(2.5, { x: 100, y: 100 });
		await store.getState().openReplay("C:\\r.osr");
		expect(store.getState().viewportZoom).toBe(1);
		expect(store.getState().viewportPan).toEqual({ x: 0, y: 0 });
	});
});

describe("editor slice and edit queue", () => {
	test("install seeds the editor slice and freezes the lattice", async () => {
		const store = createViewerStore(deps({ loadReplay: async () => latticeScene() }));
		await store.getState().openReplay("C:\\r.osr");
		const editor = store.getState().editor!;
		expect(editor.epoch).toBe(1);
		expect(editor.revision).toBe(0);
		expect(editor.lattice?.scale).toBe(2);
		expect(store.getState().editRevision).toBe(0);
		expect(editor.framesDirty).toBe(false);
		expect(editor.metadataDirty).toBe(false);
	});

	test("exportReplay dispatches against the session epoch and rethrows typed failures", async () => {
		const calls: { epoch: number; destPath: string; overwrite: boolean }[] = [];
		const store = createViewerStore(
			deps({
				exportReplay: async (epoch, destPath, overwrite) => {
					calls.push({ epoch, destPath, overwrite });
					if (overwrite) return { path: destPath, bytes: 42, regenerated: null };
					throw { kind: "fileExists", path: destPath } satisfies IpcError;
				}
			})
		);
		// without a session there is nothing to export
		await expect(store.getState().exportReplay("C:\\out.osr", false)).rejects.toMatchObject({
			kind: "staleSession"
		});

		await store.getState().openReplay("C:\\r.osr");
		await expect(store.getState().exportReplay("C:\\out.osr", false)).rejects.toMatchObject({
			kind: "fileExists"
		});
		const result = await store.getState().exportReplay("C:\\out.osr", true);
		expect(result.bytes).toBe(42);
		expect(calls).toEqual([
			{ epoch: 1, destPath: "C:\\out.osr", overwrite: false },
			{ epoch: 1, destPath: "C:\\out.osr", overwrite: true }
		]);
	});

	test("the integrity report describes the loaded file across edits", async () => {
		const integrity = {
			rows: [{ field: "count300", header: 1, simulated: 1, match: true }],
			crossCheck: { sections: 1, gekiKatsu: 1, sectionsWithoutBurst: 0, countMiss: 0, count50: 0 },
			lifeBarPresent: false
		};
		const store = createViewerStore(
			deps({
				loadReplay: async () => ({ ...latticeScene(), integrity }),
				applyEdit: async () => moveDelta(1, 1, { time: 16, x: 9.5, y: 0.5, buttons: 0 }, "move")
			})
		);
		await store.getState().openReplay("C:\\r.osr");
		await store.getState().commitEdit({
			label: "move",
			payload: { kind: "ops", ops: [{ kind: "moveFrames", moves: [{ index: 1, x: 9.5, y: 0.5 }] }] }
		});
		// the landed delta replaced the scene object, but never the report:
		// it stays the loaded file's, by reference
		expect(store.getState().scene!.integrity).toBe(integrity);
	});

	test("the dirty split mirrors off every delta", async () => {
		const metadataDelta: EditDelta = {
			...identityDelta,
			revision: 1,
			dirty: true,
			framesDirty: false,
			metadataDirty: true,
			canUndo: true,
			history: { labels: ["rename"], cursor: 1 }
		};
		const store = createViewerStore(
			deps({
				loadReplay: async () => latticeScene(),
				applyEdit: async (_e, _r, ops) =>
					ops[0]!.kind === "setPlayerName"
						? metadataDelta
						: moveDelta(2, 1, { time: 16, x: 9.5, y: 0.5, buttons: 0 }, "move")
			})
		);
		await store.getState().openReplay("C:\\r.osr");

		await store.getState().commitEdit({
			label: "rename",
			payload: { kind: "ops", ops: [{ kind: "setPlayerName", name: "renamed" }] }
		});
		let editor = store.getState().editor!;
		expect(editor.metadataDirty).toBe(true);
		expect(editor.framesDirty).toBe(false);
		expect(editor.dirty).toBe(true);

		await store.getState().commitEdit({
			label: "move",
			payload: { kind: "ops", ops: [{ kind: "moveFrames", moves: [{ index: 1, x: 9.5, y: 0.5 }] }] }
		});
		editor = store.getState().editor!;
		expect(editor.framesDirty).toBe(true);
		expect(editor.metadataDirty).toBe(false);
	});

	test("the dirty split mirrors through resync recovery", async () => {
		const fullDelta: EditDelta = {
			...identityDelta,
			revision: 3,
			frames: { fullFrames: [{ time: 0, x: 1, y: 2, buttons: 0 }] },
			dirty: true,
			framesDirty: true,
			metadataDirty: true,
			canUndo: true,
			history: { labels: ["x"], cursor: 1 }
		};
		const store = createViewerStore(
			deps({
				loadReplay: async () => latticeScene(),
				applyEdit: async () => {
					throw { kind: "staleSession" } satisfies IpcError;
				},
				resync: async () => fullDelta
			})
		);
		await store.getState().openReplay("C:\\r.osr");
		await store.getState().commitEdit({
			label: "move",
			payload: { kind: "ops", ops: [{ kind: "moveFrames", moves: [{ index: 1, x: 9.5, y: 0.5 }] }] }
		});
		const editor = store.getState().editor!;
		expect(editor.revision).toBe(3);
		expect(editor.framesDirty).toBe(true);
		expect(editor.metadataDirty).toBe(true);
	});

	test("a commit dispatches against the current revision and splices the delta", async () => {
		const calls: { baseRevision: number; ops: EditOp[]; label: string }[] = [];
		const moved = { time: 16, x: 9.5, y: 0.5, buttons: 0 };
		const store = createViewerStore(
			deps({
				loadReplay: async () => latticeScene(),
				applyEdit: async (_e, baseRevision, ops, label) => {
					calls.push({ baseRevision, ops, label });
					return moveDelta(1, 1, moved, label);
				}
			})
		);
		await store.getState().openReplay("C:\\r.osr");
		await store.getState().commitEdit({
			label: "move",
			payload: { kind: "ops", ops: [{ kind: "moveFrames", moves: [{ index: 1, x: 9.5, y: 0.5 }] }] }
		});
		expect(calls).toEqual([
			{ baseRevision: 0, ops: [{ kind: "moveFrames", moves: [{ index: 1, x: 9.5, y: 0.5 }] }], label: "move" }
		]);
		const state = store.getState();
		expect(state.scene!.frames[1]).toEqual(moved);
		expect(state.editor!.revision).toBe(1);
		expect(state.editor!.dirty).toBe(true);
		expect(state.editRevision).toBe(1);
		expect(state.lastSplice).not.toBeNull();
	});

	test("commits serialize behind the in-flight command", async () => {
		let resolveFirst!: (d: EditDelta) => void;
		const calls: number[] = [];
		const store = createViewerStore(
			deps({
				loadReplay: async () => latticeScene(),
				applyEdit: async (_e, baseRevision) => {
					calls.push(baseRevision);
					if (calls.length === 1)
						return new Promise<EditDelta>((resolve) => {
							resolveFirst = resolve;
						});
					return moveDelta(2, 2, { time: 32, x: 1, y: 1, buttons: 0 }, "b");
				}
			})
		);
		await store.getState().openReplay("C:\\r.osr");
		const first = store.getState().commitEdit({
			label: "a",
			payload: { kind: "ops", ops: [{ kind: "moveFrames", moves: [{ index: 1, x: 9.5, y: 0.5 }] }] }
		});
		const second = store.getState().commitEdit({
			label: "b",
			payload: { kind: "ops", ops: [{ kind: "moveFrames", moves: [{ index: 2, x: 1, y: 1 }] }] }
		});
		await Promise.resolve();
		expect(calls).toEqual([0]);
		resolveFirst(moveDelta(1, 1, { time: 16, x: 9.5, y: 0.5, buttons: 0 }, "a"));
		await Promise.all([first, second]);
		expect(calls).toEqual([0, 1]);
		expect(store.getState().editor!.revision).toBe(2);
	});

	test("an intent expands at dispatch against the landed frames", async () => {
		let resolveFirst!: (d: EditDelta) => void;
		const seen: number[] = [];
		const store = createViewerStore(
			deps({
				loadReplay: async () => latticeScene(),
				applyEdit: async (_e, baseRevision) => {
					if (baseRevision === 0)
						return new Promise<EditDelta>((resolve) => {
							resolveFirst = resolve;
						});
					return moveDelta(2, 3, { time: 48, x: 7, y: 7, buttons: 0 }, "b");
				}
			})
		);
		await store.getState().openReplay("C:\\r.osr");
		const first = store.getState().commitEdit({
			label: "a",
			payload: { kind: "ops", ops: [{ kind: "moveFrames", moves: [{ index: 1, x: 77, y: 0.5 }] }] }
		});
		const second = store.getState().commitEdit({
			label: "b",
			payload: {
				kind: "intent",
				expand: (frames) => {
					seen.push(frames[1].x);
					return [{ kind: "moveFrames", moves: [{ index: 3, x: 7, y: 7 }] }];
				}
			}
		});
		await Promise.resolve();
		resolveFirst(moveDelta(1, 1, { time: 16, x: 77, y: 0.5, buttons: 0 }, "a"));
		await Promise.all([first, second]);
		// the intent saw the first commit's landed value, never the stale 0.5
		expect(seen).toEqual([77]);
	});

	test("queued computed payloads remap through a landing delta", async () => {
		let resolveFirst!: (d: EditDelta) => void;
		const dispatched: EditOp[][] = [];
		const removalDelta: EditDelta = {
			...moveDelta(1, 0, { time: 0, x: 0, y: 0, buttons: 0 }, "a"),
			frames: { updated: [], inserted: [], removed: [0] }
		};
		const store = createViewerStore(
			deps({
				loadReplay: async () => latticeScene(),
				applyEdit: async (_e, baseRevision, ops) => {
					dispatched.push(ops);
					if (baseRevision === 0)
						return new Promise<EditDelta>((resolve) => {
							resolveFirst = resolve;
						});
					return moveDelta(2, 1, { time: 32, x: 5, y: 5, buttons: 0 }, "b");
				}
			})
		);
		await store.getState().openReplay("C:\\r.osr");
		const first = store.getState().commitEdit({
			label: "a",
			payload: { kind: "ops", ops: [{ kind: "deleteFrames", indices: [0] }] }
		});
		const second = store.getState().commitEdit({
			label: "b",
			payload: { kind: "ops", ops: [{ kind: "moveFrames", moves: [{ index: 2, x: 5, y: 5 }] }] }
		});
		await Promise.resolve();
		resolveFirst(removalDelta);
		await Promise.all([first, second]);
		// index 2 shifted down through the removal of index 0
		expect(dispatched[1]).toEqual([{ kind: "moveFrames", moves: [{ index: 1, x: 5, y: 5 }] }]);
	});

	test("a queued intent's remap hook carries its identities through a landing delta", async () => {
		let resolveFirst!: (d: EditDelta) => void;
		const dispatched: EditOp[][] = [];
		const seen: FrameChanges[] = [];
		const removalDelta: EditDelta = {
			...moveDelta(1, 0, { time: 0, x: 0, y: 0, buttons: 0 }, "a"),
			frames: { updated: [], inserted: [], removed: [0] }
		};
		const store = createViewerStore(
			deps({
				loadReplay: async () => latticeScene(),
				applyEdit: async (_e, baseRevision, ops) => {
					dispatched.push(ops);
					if (baseRevision === 0)
						return new Promise<EditDelta>((resolve) => {
							resolveFirst = resolve;
						});
					return moveDelta(2, 1, { time: 32, x: 5, y: 5, buttons: 0 }, "b");
				}
			})
		);
		await store.getState().openReplay("C:\\r.osr");
		const first = store.getState().commitEdit({
			label: "a",
			payload: { kind: "ops", ops: [{ kind: "deleteFrames", indices: [0] }] }
		});
		let target = 2;
		const second = store.getState().commitEdit({
			label: "b",
			payload: {
				kind: "intent",
				remap: (changes) => {
					seen.push(changes);
					if (!("fullFrames" in changes)) target -= changes.removed.filter((r) => r < target).length;
					return true;
				},
				expand: () => [{ kind: "moveFrames", moves: [{ index: target, x: 5, y: 5 }] }]
			}
		});
		await Promise.resolve();
		resolveFirst(removalDelta);
		await Promise.all([first, second]);
		expect(seen).toEqual([{ updated: [], inserted: [], removed: [0] }]);
		// the intent dispatched against the identity the splice shifted to
		expect(dispatched[1]).toEqual([{ kind: "moveFrames", moves: [{ index: 1, x: 5, y: 5 }] }]);
	});

	test("a queued intent whose remap reports nothing left cancels without dispatching", async () => {
		let resolveFirst!: (d: EditDelta) => void;
		let applyCalls = 0;
		let expanded = false;
		const outcomes: string[] = [];
		const removalDelta: EditDelta = {
			...moveDelta(1, 0, { time: 0, x: 0, y: 0, buttons: 0 }, "a"),
			frames: { updated: [], inserted: [], removed: [0] }
		};
		const store = createViewerStore(
			deps({
				loadReplay: async () => latticeScene(),
				applyEdit: async () => {
					applyCalls += 1;
					return new Promise<EditDelta>((resolve) => {
						resolveFirst = resolve;
					});
				}
			})
		);
		await store.getState().openReplay("C:\\r.osr");
		const first = store.getState().commitEdit({
			label: "a",
			payload: { kind: "ops", ops: [{ kind: "deleteFrames", indices: [0] }] }
		});
		const second = store.getState().commitEdit({
			label: "b",
			payload: {
				kind: "intent",
				remap: () => false,
				expand: () => {
					expanded = true;
					return null;
				}
			},
			onSettled: (outcome) => outcomes.push(outcome)
		});
		await Promise.resolve();
		resolveFirst(removalDelta);
		await Promise.all([first, second]);
		expect(outcomes).toEqual(["cancelled"]);
		expect(expanded).toBe(false);
		expect(applyCalls).toBe(1);
	});

	test("a fullFrames delta cancels the queue and clears the selection", async () => {
		let resolveFirst!: (d: EditDelta) => void;
		let applyCalls = 0;
		const store = createViewerStore(
			deps({
				loadReplay: async () => latticeScene(),
				applyEdit: async () => {
					applyCalls += 1;
					return new Promise<EditDelta>((resolve) => {
						resolveFirst = resolve;
					});
				}
			})
		);
		await store.getState().openReplay("C:\\r.osr");
		store.getState().setFrameSelection([1, 2, 3]);
		const first = store.getState().commitEdit({
			label: "a",
			payload: { kind: "ops", ops: [{ kind: "deleteFrames", indices: [0] }] }
		});
		const second = store.getState().commitEdit({
			label: "b",
			payload: { kind: "ops", ops: [{ kind: "moveFrames", moves: [{ index: 2, x: 5, y: 5 }] }] }
		});
		await Promise.resolve();
		resolveFirst({
			...moveDelta(1, 0, { time: 0, x: 0, y: 0, buttons: 0 }, "a"),
			frames: { fullFrames: latticeScene().frames.slice(1) }
		});
		await Promise.all([first, second]);
		// the queued commit was cancelled: only the first ever dispatched
		expect(applyCalls).toBe(1);
		expect(store.getState().editor!.frameSelection).toEqual([]);
		expect(store.getState().scene!.frames).toHaveLength(39);
	});

	test("preview-equals-commit: the ops crossing ipc are the frozen preview entry's, byte-equal", async () => {
		const preview = new GesturePreview();
		const dispatched: EditOp[][] = [];
		const store = createViewerStore(
			deps({
				loadReplay: async () => latticeScene(),
				applyEdit: async (_e, _r, ops) => {
					// what is on screen at this moment is the frozen entry; the
					// payload must be exactly it
					const shown = preview.snapshot().moved;
					for (const op of ops) {
						if (op.kind !== "moveFrames") continue;
						for (const move of op.moves) {
							expect(shown.get(move.index)).toEqual({ x: move.x, y: move.y });
						}
					}
					dispatched.push(ops);
					return moveDelta(1, 1, { time: 16, x: 9.5, y: 0.5, buttons: 0 }, "move 1 frame");
				}
			}),
			{ onSplice: (changes) => preview.applySplice(changes) }
		);
		await store.getState().openReplay("C:\\r.osr");
		const ops: EditOp[] = [{ kind: "moveFrames", moves: [{ index: 1, x: 9.5, y: 0.5 }] }];
		preview.setLive(ops);
		const id = preview.freezeLive();
		const outcomes: string[] = [];
		await store.getState().commitEdit({
			label: (sent) => `move ${sent.length} frame`,
			payload: { kind: "ops", ops },
			onSettled: (outcome) => {
				outcomes.push(outcome);
				preview.settle(id, outcome);
			}
		});
		expect(dispatched).toEqual([ops]);
		expect(outcomes).toEqual(["landed"]);
		// landed, not yet rendered: the preview still shows the edit until the
		// renderer is re-fed, then drops with the swap
		expect(preview.snapshot().moved.size).toBe(1);
		preview.settleRendered();
		expect(preview.snapshot().moved.size).toBe(0);
	});

	test("a label function resolves at dispatch against the ops actually sent", async () => {
		const labels: string[] = [];
		const store = createViewerStore(
			deps({
				loadReplay: async () => latticeScene(),
				applyEdit: async (_e, _r, _ops, label) => {
					labels.push(label);
					return moveDelta(1, 1, { time: 16, x: 1, y: 1, buttons: 0 }, label);
				}
			})
		);
		await store.getState().openReplay("C:\\r.osr");
		await store.getState().commitEdit({
			label: (ops) => `move ${ops.length === 1 && ops[0].kind === "moveFrames" ? ops[0].moves.length : 0} frames`,
			payload: {
				kind: "ops",
				ops: [
					{
						kind: "moveFrames",
						moves: [
							{ index: 1, x: 1, y: 1 },
							{ index: 2, x: 2, y: 2 }
						]
					}
				]
			}
		});
		expect(labels).toEqual(["move 2 frames"]);
	});

	test("an intent expanding to identity settles as skipped and dispatches nothing", async () => {
		let applyCalls = 0;
		const store = createViewerStore(
			deps({
				loadReplay: async () => latticeScene(),
				applyEdit: async () => {
					applyCalls += 1;
					return identityDelta;
				}
			})
		);
		await store.getState().openReplay("C:\\r.osr");
		const outcomes: string[] = [];
		await store.getState().commitEdit({
			label: "noop",
			payload: { kind: "intent", expand: () => null },
			onSettled: (outcome) => outcomes.push(outcome)
		});
		expect(applyCalls).toBe(0);
		expect(outcomes).toEqual(["skipped"]);
	});

	test("a failing dispatch settles as failed, which is the preview's snap-back", async () => {
		const preview = new GesturePreview();
		const store = createViewerStore(
			deps({
				loadReplay: async () => latticeScene(),
				applyEdit: async () => {
					throw { kind: "invalidEdit", message: "no" };
				}
			}),
			{ onSplice: (changes) => preview.applySplice(changes) }
		);
		await store.getState().openReplay("C:\\r.osr");
		const ops: EditOp[] = [{ kind: "moveFrames", moves: [{ index: 1, x: 9.5, y: 0.5 }] }];
		preview.setLive(ops);
		const id = preview.freezeLive();
		await store.getState().commitEdit({
			label: "move",
			payload: { kind: "ops", ops },
			onSettled: (outcome) => preview.settle(id, outcome)
		});
		expect(preview.snapshot().moved.size).toBe(0);
		expect(store.getState().lastError?.error.kind).toBe("invalidEdit");
	});

	test("a fullFrames delta cancels queued commits and discards their previews through the splice hook", async () => {
		const preview = new GesturePreview();
		let resolveFirst!: (d: EditDelta) => void;
		let applyCalls = 0;
		const store = createViewerStore(
			deps({
				loadReplay: async () => latticeScene(),
				applyEdit: async () => {
					applyCalls += 1;
					return new Promise<EditDelta>((resolve) => {
						resolveFirst = resolve;
					});
				}
			}),
			{ onSplice: (changes) => preview.applySplice(changes) }
		);
		await store.getState().openReplay("C:\\r.osr");
		const firstOps: EditOp[] = [{ kind: "deleteFrames", indices: [0] }];
		preview.setLive(firstOps);
		const firstId = preview.freezeLive();
		const first = store.getState().commitEdit({
			label: "a",
			payload: { kind: "ops", ops: firstOps },
			onSettled: (outcome) => preview.settle(firstId, outcome)
		});
		const secondOps: EditOp[] = [{ kind: "moveFrames", moves: [{ index: 2, x: 5, y: 5 }] }];
		preview.setLive(secondOps);
		const secondId = preview.freezeLive();
		const secondOutcomes: string[] = [];
		const second = store.getState().commitEdit({
			label: "b",
			payload: { kind: "ops", ops: secondOps },
			onSettled: (outcome) => {
				secondOutcomes.push(outcome);
				preview.settle(secondId, outcome);
			}
		});
		await Promise.resolve();
		resolveFirst({
			...moveDelta(1, 0, { time: 0, x: 0, y: 0, buttons: 0 }, "a"),
			frames: { fullFrames: latticeScene().frames.slice(1) }
		});
		await Promise.all([first, second]);
		expect(applyCalls).toBe(1);
		expect(secondOutcomes).toEqual(["cancelled"]);
		// the queued commit's preview died with it; the landed one holds until
		// the renderer swap
		expect(preview.snapshot().moved.size).toBe(0);
		expect(preview.snapshot().hidden).toEqual(new Set([0]));
		preview.settleRendered();
		expect(preview.snapshot().hidden.size).toBe(0);
	});

	test("an intent's re-expansion regenerates its preview entry with the dispatch payload itself", async () => {
		// the erase pipeline's shape: the expand closure rewrites the frozen
		// entry with the ops it returns, so what is displayed when the payload
		// crosses ipc is the payload -- byte-equal across the re-expansion
		const preview = new GesturePreview();
		const dispatched: EditOp[][] = [];
		const store = createViewerStore(
			deps({
				loadReplay: async () => latticeScene(),
				applyEdit: async (_e, _r, ops) => {
					const shown = preview.snapshot();
					for (const op of ops) {
						if (op.kind === "deleteFrames") {
							for (const index of op.indices) expect(shown.hidden.has(index)).toBe(true);
						}
					}
					dispatched.push(ops);
					return {
						...moveDelta(1, 0, { time: 0, x: 0, y: 0, buttons: 0 }, "erase 1 frame"),
						frames: { updated: [], inserted: [], removed: [3] }
					};
				}
			}),
			{ onSplice: (changes) => preview.applySplice(changes) }
		);
		await store.getState().openReplay("C:\\r.osr");
		preview.setLive([{ kind: "deleteFrames", indices: [3] }]);
		const id = preview.freezeLive();
		await store.getState().commitEdit({
			label: "erase 1 frame",
			payload: {
				kind: "intent",
				expand: (frames) => {
					// the re-expansion reads the then-current frames and rewrites
					// the entry from the concrete dispatch payload
					expect(frames).toHaveLength(40);
					const ops: EditOp[] = [{ kind: "deleteFrames", indices: [3] }];
					preview.update(id, ops);
					return ops;
				}
			},
			onSettled: (outcome) => preview.settle(id, outcome)
		});
		expect(dispatched).toHaveLength(1);
	});

	test("a landed deletion drops erased frames from the selection and shifts the rest", async () => {
		const store = createViewerStore(
			deps({
				loadReplay: async () => latticeScene(),
				applyEdit: async () => ({
					...moveDelta(1, 0, { time: 0, x: 0, y: 0, buttons: 0 }, "erase 2 frames"),
					frames: { updated: [], inserted: [], removed: [1, 2] }
				})
			})
		);
		await store.getState().openReplay("C:\\r.osr");
		store.getState().setFrameSelection([0, 2, 5]);
		await store.getState().commitEdit({
			label: "erase 2 frames",
			payload: { kind: "ops", ops: [{ kind: "deleteFrames", indices: [1, 2] }] }
		});
		// 2 was deleted; 5 shifted down past the two removals; 0 stays
		expect(store.getState().editor!.frameSelection).toEqual([0, 3]);
	});

	test("a response tagged with a replaced epoch is dropped", async () => {
		let resolveEdit!: (d: EditDelta) => void;
		let epoch = 0;
		const nextSession = async () => {
			epoch += 1;
			return { ...latticeScene(), epoch };
		};
		const store = createViewerStore(
			deps({
				loadReplay: nextSession,
				loadReplayWithBeatmap: nextSession,
				applyEdit: async () =>
					new Promise<EditDelta>((resolve) => {
						resolveEdit = resolve;
					})
			})
		);
		await store.getState().openReplay("C:\\r.osr");
		const commit = store.getState().commitEdit({
			label: "a",
			payload: { kind: "ops", ops: [{ kind: "moveFrames", moves: [{ index: 1, x: 9.5, y: 0.5 }] }] }
		});
		await Promise.resolve();
		// the replacement arrives through a continuation, which is the route
		// that installs over an in-flight edit: openReplay drains the queue
		// before it decides anything, so it could not reach an install with
		// this commit still outstanding
		await store.getState().openWithBeatmap("C:\\r2.osr", "C:\\m.osu");
		resolveEdit(moveDelta(1, 1, { time: 16, x: 9.5, y: 0.5, buttons: 0 }, "a"));
		await commit;
		// the second install's editor is untouched by the first session's delta
		expect(store.getState().editor!.epoch).toBe(2);
		expect(store.getState().editor!.revision).toBe(0);
		expect(store.getState().editor!.dirty).toBe(false);
	});

	test("staleSession recovers through resync, never a disk reload", async () => {
		let resynced = 0;
		const store = createViewerStore(
			deps({
				loadReplay: async () => latticeScene(),
				applyEdit: async () => {
					throw { kind: "staleSession" } satisfies IpcError;
				},
				resync: async () => {
					resynced += 1;
					return {
						...identityDelta,
						revision: 5,
						frames: { fullFrames: latticeScene().frames },
						simulation: latticeScene().simulation
					};
				}
			})
		);
		await store.getState().openReplay("C:\\r.osr");
		await store.getState().commitEdit({
			label: "a",
			payload: { kind: "ops", ops: [{ kind: "moveFrames", moves: [{ index: 1, x: 9.5, y: 0.5 }] }] }
		});
		expect(resynced).toBe(1);
		expect(store.getState().editor!.revision).toBe(5);
		expect(store.getState().lastError?.error.kind).toBe("staleSession");
	});

	test("metadata deltas update the replay meta without an editRevision bump", async () => {
		const store = createViewerStore(
			deps({
				loadReplay: async () => latticeScene(),
				applyEdit: async () => ({
					...identityDelta,
					revision: 1,
					dirty: true,
					canUndo: true,
					playerName: "renamed",
					timestampTicks: "42",
					history: { labels: ["player name"], cursor: 1 }
				})
			})
		);
		await store.getState().openReplay("C:\\r.osr");
		await store.getState().commitEdit({
			label: "player name",
			payload: { kind: "ops", ops: [{ kind: "setPlayerName", name: "renamed" }] }
		});
		const state = store.getState();
		expect(state.scene!.replay.playerName).toBe("renamed");
		expect(state.scene!.replay.timestampTicks).toBe("42");
		expect(state.editRevision).toBe(0);
		expect(state.editor!.dirty).toBe(true);
	});

	test("the lattice never re-derives across deltas", async () => {
		const store = createViewerStore(
			deps({
				loadReplay: async () => latticeScene(),
				applyEdit: async () => moveDelta(1, 1, { time: 16, x: 0.1234567, y: 0.7654321, buttons: 0 }, "off-grid")
			})
		);
		await store.getState().openReplay("C:\\r.osr");
		const before = store.getState().editor!.lattice;
		const summaryBefore = store.getState().editor!.offLattice;
		expect(summaryBefore).not.toBeNull();
		expect(summaryBefore!.runCount).toBe(0);
		await store.getState().commitEdit({
			label: "off-grid",
			payload: { kind: "ops", ops: [{ kind: "moveFrames", moves: [{ index: 1, x: 0.1234567, y: 0.7654321 }] }] }
		});
		expect(store.getState().editor!.lattice).toBe(before);
		// the off-lattice summary is frozen with it: the landed off-grid edit
		// must not appear as a run, because the summary describes the loaded
		// file rather than the edited document
		expect(store.getState().editor!.offLattice).toBe(summaryBefore);
	});

	test("undoEdit gates on canUndo and dispatches through the queue", async () => {
		let undos = 0;
		const store = createViewerStore(
			deps({
				loadReplay: async () => latticeScene(),
				applyEdit: async () => moveDelta(1, 1, { time: 16, x: 9.5, y: 0.5, buttons: 0 }, "move"),
				undo: async () => {
					undos += 1;
					return { ...identityDelta, revision: 2, canRedo: true, history: { labels: ["move"], cursor: 0 } };
				}
			})
		);
		await store.getState().openReplay("C:\\r.osr");
		await store.getState().undoEdit();
		// gated: nothing to undo yet
		expect(undos).toBe(0);
		await store.getState().commitEdit({
			label: "move",
			payload: { kind: "ops", ops: [{ kind: "moveFrames", moves: [{ index: 1, x: 9.5, y: 0.5 }] }] }
		});
		await store.getState().undoEdit();
		expect(undos).toBe(1);
		expect(store.getState().editor!.canRedo).toBe(true);
	});

	test("a second undo queued behind the first drops when the step count runs out", async () => {
		let resolveUndo!: (d: EditDelta) => void;
		let undos = 0;
		const store = createViewerStore(
			deps({
				loadReplay: async () => latticeScene(),
				applyEdit: async () => moveDelta(1, 1, { time: 16, x: 9.5, y: 0.5, buttons: 0 }, "move"),
				undo: async () => {
					undos += 1;
					return new Promise<EditDelta>((resolve) => {
						resolveUndo = resolve;
					});
				}
			})
		);
		await store.getState().openReplay("C:\\r.osr");
		await store.getState().commitEdit({
			label: "move",
			payload: { kind: "ops", ops: [{ kind: "moveFrames", moves: [{ index: 1, x: 9.5, y: 0.5 }] }] }
		});
		// the first undo is in flight, so canUndo still reads true and the
		// enqueue gate passes for a rapid second click
		const first = store.getState().undoEdit();
		const second = store.getState().undoEdit();
		await Promise.resolve();
		resolveUndo({ ...identityDelta, revision: 2, canRedo: true, history: { labels: ["move"], cursor: 0 } });
		await Promise.all([first, second]);
		// the dequeued second undo re-checked canUndo and dropped silently
		expect(undos).toBe(1);
		expect(store.getState().lastError).toBeNull();
	});
});

describe("press selection", () => {
	// two K1 presses: [16, 48) rising at index 1 and [64, 80) rising at 4
	function pressScene(): LoadedScene {
		const frames = [
			{ time: 0, x: 0, y: 0, buttons: 0 },
			{ time: 16, x: 16, y: 0, buttons: 5 },
			{ time: 32, x: 32, y: 0, buttons: 5 },
			{ time: 48, x: 48, y: 0, buttons: 0 },
			{ time: 64, x: 64, y: 0, buttons: 5 },
			{ time: 80, x: 80, y: 0, buttons: 0 }
		];
		return testScene({ frames });
	}

	/** echoes a dispatched setButtons batch back as its landed delta, the
	 * way the real engine would splice it */
	function echoingDeps(store: () => StoreApi<ViewerState>, revisions: { next: number }) {
		return deps({
			loadReplay: async () => pressScene(),
			applyEdit: async (_e, _r, ops) => {
				const frames = store().getState().scene!.frames;
				const updated = ops.flatMap((op) =>
					op.kind === "setButtons"
						? op.sets.map((s) => ({ index: s.index, frame: { ...frames[s.index], buttons: s.buttons } }))
						: []
				);
				revisions.next += 1;
				return {
					revision: revisions.next,
					frames: { updated, inserted: [], removed: [] },
					playerName: "p",
					timestampTicks: "0",
					dirty: true,
					framesDirty: true,
					metadataDirty: false,
					canUndo: true,
					canRedo: false,
					history: { labels: ["x"], cursor: 1 },
					simulation: null
				} satisfies EditDelta;
			}
		});
	}

	test("setPressSelection holds exactly one press, independent of the frame selection", async () => {
		const store = createViewerStore(deps({ loadReplay: async () => pressScene() }));
		await store.getState().openReplay("C:\\r.osr");
		store.getState().setFrameSelection([2, 3]);
		store.getState().setPressSelection({ key: "K1", startIndex: 1 });
		expect(store.getState().editor!.pressSelection).toEqual({ key: "K1", startIndex: 1 });
		expect(store.getState().editor!.frameSelection).toEqual([2, 3]);
		store.getState().setPressSelection(null);
		expect(store.getState().editor!.pressSelection).toBeNull();
		expect(store.getState().editor!.frameSelection).toEqual([2, 3]);
	});

	test("a scene install clears the press selection and the armed key", async () => {
		const store = createViewerStore(deps({ loadReplay: async () => pressScene() }));
		await store.getState().openReplay("C:\\r.osr");
		store.getState().setPressSelection({ key: "K1", startIndex: 1 });
		store.getState().setArmedKey("K2");
		await store.getState().openReplay("C:\\other.osr");
		expect(store.getState().editor!.pressSelection).toBeNull();
		expect(store.getState().armedKey).toBeNull();
	});

	test("a fullFrames delta clears the press selection", async () => {
		const store = createViewerStore(
			deps({
				loadReplay: async () => pressScene(),
				revertAll: async () => ({
					...identityDelta,
					revision: 1,
					frames: { fullFrames: pressScene().frames }
				})
			})
		);
		await store.getState().openReplay("C:\\r.osr");
		store.getState().setPressSelection({ key: "K1", startIndex: 1 });
		await store.getState().revertAll();
		expect(store.getState().editor!.pressSelection).toBeNull();
	});

	test("undo clears the selection when no run of its key contains the prior start", async () => {
		const store = createViewerStore(
			deps({
				loadReplay: async () => pressScene(),
				applyEdit: async () => ({
					...identityDelta,
					revision: 1,
					dirty: true,
					canUndo: true,
					frames: {
						updated: [{ index: 0, frame: { time: 0, x: 0, y: 0, buttons: 5 } }],
						inserted: [],
						removed: []
					}
				}),
				undo: async () => ({
					...identityDelta,
					revision: 2,
					frames: {
						updated: [{ index: 0, frame: { time: 0, x: 0, y: 0, buttons: 0 } }],
						inserted: [],
						removed: []
					}
				})
			})
		);
		await store.getState().openReplay("C:\\r.osr");
		// grow the press back to 0 ms, select the grown press, then undo it
		// away: the prior start (0 ms) is contained by no post-undo K1 run
		await store.getState().commitEdit({
			label: "grow",
			payload: { kind: "ops", ops: [{ kind: "setButtons", sets: [{ index: 0, buttons: 5 }] }] }
		});
		store.getState().setPressSelection({ key: "K1", startIndex: 0 });
		await store.getState().undoEdit();
		expect(store.getState().editor!.pressSelection).toBeNull();
	});

	test("undo keeps the selection while the same press still contains the prior start", async () => {
		const store = createViewerStore(
			deps({
				loadReplay: async () => pressScene(),
				applyEdit: async () => ({
					...identityDelta,
					revision: 1,
					dirty: true,
					canUndo: true,
					frames: {
						updated: [{ index: 2, frame: { time: 32, x: 32, y: 0, buttons: 0 } }],
						inserted: [],
						removed: []
					}
				}),
				undo: async () => ({
					...identityDelta,
					revision: 2,
					frames: {
						updated: [{ index: 2, frame: { time: 32, x: 32, y: 0, buttons: 5 } }],
						inserted: [],
						removed: []
					}
				})
			})
		);
		await store.getState().openReplay("C:\\r.osr");
		// shrink the press to [16, 32), select it, undo the shrink: the
		// prior start 16 is still contained by the restored [16, 48) run
		await store.getState().commitEdit({
			label: "shrink",
			payload: { kind: "ops", ops: [{ kind: "setButtons", sets: [{ index: 2, buttons: 0 }] }] }
		});
		store.getState().setPressSelection({ key: "K1", startIndex: 1 });
		await store.getState().undoEdit();
		expect(store.getState().editor!.pressSelection).toEqual({ key: "K1", startIndex: 1 });
	});

	test("a press commit's computed outcome overrides generic re-resolution", async () => {
		// nudging the start later: the prior start time (16 ms) is contained
		// by no post-delta run, so generic resolution would clear -- the
		// computed outcome carries the nudged edge's new identity instead
		const revisions = { next: 0 };
		const store: StoreApi<ViewerState> = createViewerStore(echoingDeps(() => store, revisions));
		await store.getState().openReplay("C:\\r.osr");
		store.getState().setPressSelection({ key: "K1", startIndex: 1 });
		let outcome: { key: PhysicalKey; startTime: number } | null = null;
		await store.getState().commitEdit({
			label: "nudge K1 press start",
			payload: {
				kind: "intent",
				expand: (frames, editor) => {
					const sel = editor.pressSelection;
					if (sel === null) return null;
					const run = pressRunFromIndex(frames, sel.key, sel.startIndex);
					if (run === null) return null;
					const expansion = expandRetimePress(frames, run, { start: 32 }, editor.lattice, "this nudge");
					if ("rejected" in expansion) return null;
					outcome = expansion.outcome;
					return expansion.ops;
				}
			},
			pressOutcome: (frames) => outcomeSelection(frames, outcome)
		});
		expect(store.getState().scene!.frames[1].buttons).toBe(0);
		expect(store.getState().editor!.pressSelection).toEqual({ key: "K1", startIndex: 2 });
	});

	test("queued press intents chase the selection: two nudges compound instead of repeating", async () => {
		const revisions = { next: 0 };
		const store: StoreApi<ViewerState> = createViewerStore(echoingDeps(() => store, revisions));
		await store.getState().openReplay("C:\\r.osr");
		store.getState().setPressSelection({ key: "K1", startIndex: 4 });
		const nudgeEarlier = () => {
			let outcome: { key: PhysicalKey; startTime: number } | null = null;
			return store.getState().commitEdit({
				label: "nudge K1 press start",
				payload: {
					kind: "intent",
					expand: (frames, editor) => {
						const sel = editor.pressSelection;
						if (sel === null) return null;
						const run = pressRunFromIndex(frames, sel.key, sel.startIndex);
						if (run === null) return null;
						const target = adjacentFrameTime(frames, run.startTime, -1);
						if (target === null) return null;
						const expansion = expandRetimePress(
							frames,
							run,
							{ start: target },
							editor.lattice,
							"this nudge"
						);
						if ("rejected" in expansion) return null;
						outcome = expansion.outcome;
						return expansion.ops;
					}
				},
				pressOutcome: (frames) => outcomeSelection(frames, outcome)
			});
		};
		// both queued before either lands: the second must step from the
		// first's outcome, not repeat the same expansion. the first step
		// presses the frame at 48 ms -- meeting the [16, 48) press, which
		// merges -- and the second steps the merged run's start to 0 ms
		const a = nudgeEarlier();
		const b = nudgeEarlier();
		await Promise.all([a, b]);
		const buttons = store.getState().scene!.frames.map((f) => f.buttons);
		expect(buttons).toEqual([5, 5, 5, 5, 5, 0]);
		expect(store.getState().editor!.pressSelection).toEqual({ key: "K1", startIndex: 0 });
	});

	test("a pure move-frames commit leaves the press selection untouched", async () => {
		const store = createViewerStore(
			deps({
				loadReplay: async () => pressScene(),
				applyEdit: async () => moveDelta(1, 2, { time: 32, x: 99, y: 9, buttons: 5 }, "move")
			})
		);
		await store.getState().openReplay("C:\\r.osr");
		store.getState().setPressSelection({ key: "K1", startIndex: 1 });
		await store.getState().commitEdit({
			label: "move",
			payload: { kind: "ops", ops: [{ kind: "moveFrames", moves: [{ index: 2, x: 99, y: 9 }] }] }
		});
		expect(store.getState().editor!.pressSelection).toEqual({ key: "K1", startIndex: 1 });
	});

	test("a released drag commits exactly the previewed expansion (preview equals commit)", async () => {
		const revisions = { next: 0 };
		const dispatched: EditOp[][] = [];
		const store: StoreApi<ViewerState> = createViewerStore(
			deps({
				loadReplay: async () => pressScene(),
				applyEdit: async (_e, _r, ops) => {
					dispatched.push(ops);
					const frames = store.getState().scene!.frames;
					const updated = ops.flatMap((op) =>
						op.kind === "setButtons"
							? op.sets.map((s) => ({
									index: s.index,
									frame: { ...frames[s.index], buttons: s.buttons }
								}))
							: []
					);
					revisions.next += 1;
					return {
						...identityDelta,
						revision: revisions.next,
						dirty: true,
						canUndo: true,
						frames: { updated, inserted: [], removed: [] }
					};
				}
			})
		);
		await store.getState().openReplay("C:\\r.osr");
		const frames = store.getState().scene!.frames;

		// the gesture: grab the [16, 48) press's body and slide it right by 15
		// ms, edges snapping to the frames at 32 and 64 -- meeting the second
		// press, so the previewed outcome is the merged span
		const controller = new PressDragController();
		const down = controller.pointerDown(30, {
			key: "K1",
			frames,
			msPerPx: 1,
			slopPx: 4,
			edgeZonePx: 3,
			lattice: null
		});
		expect(down.select).toEqual({ key: "K1", startIndex: 1 });
		store.getState().setPressSelection(down.select!);
		const moved = controller.pointerMove(45);
		expect(moved.preview?.span).toEqual({ start: 32, end: 80 });
		const up = controller.pointerUp(45);
		expect(up.commit?.edit).toEqual({ start: 32, end: 64 });

		// the shell's drag intent: re-expanded at dispatch from the dragged
		// run's time-space identity and the drag's final edit, exactly as
		// DetailLanes commits it through pressRunCommit
		let outcome: { key: PhysicalKey; startTime: number } | null = null;
		await store.getState().commitEdit({
			label: "drag K1 press",
			payload: {
				kind: "intent",
				expand: (dispatchFrames, editor) => {
					const run = pressRunAt(dispatchFrames, up.commit!.key, up.commit!.runStartTime);
					if (run === null) return null;
					const expansion = expandRetimePress(
						dispatchFrames,
						run,
						up.commit!.edit,
						editor.lattice,
						"this drag"
					);
					if ("rejected" in expansion) return null;
					outcome = expansion.outcome;
					return expansion.ops;
				}
			},
			pressOutcome: (postFrames) => outcomeSelection(postFrames, outcome)
		});

		// the dispatched ops are the previewed expansion, byte-equal
		const previewedExpansion = expandRetimePress(
			frames,
			pressRunFromIndex(frames, "K1", 1)!,
			up.commit!.edit,
			null,
			"this drag"
		);
		if ("rejected" in previewedExpansion) throw new Error(previewedExpansion.rejected);
		expect(dispatched).toEqual([previewedExpansion.ops]);
		// and the landed stream realizes exactly the previewed merged span
		const buttons = store.getState().scene!.frames.map((f) => f.buttons);
		expect(buttons).toEqual([0, 0, 5, 5, 5, 0]);
		expect(store.getState().editor!.pressSelection).toEqual({ key: "K1", startIndex: 2 });
	});

	test("a queued drag stays bound to the press it previewed, not the moved selection", async () => {
		let resolveFirst!: (d: EditDelta) => void;
		let call = 0;
		const revisions = { next: 1 };
		const echo = (ops: EditOp[]): EditDelta => {
			const frames = store.getState().scene!.frames;
			const updated = ops.flatMap((op) =>
				op.kind === "setButtons"
					? op.sets.map((s) => ({ index: s.index, frame: { ...frames[s.index], buttons: s.buttons } }))
					: []
			);
			revisions.next += 1;
			return {
				...identityDelta,
				revision: revisions.next,
				dirty: true,
				canUndo: true,
				frames: { updated, inserted: [], removed: [] }
			};
		};
		const store: StoreApi<ViewerState> = createViewerStore(
			deps({
				loadReplay: async () => pressScene(),
				applyEdit: async (_e, _r, ops) => {
					call += 1;
					if (call === 1)
						return new Promise<EditDelta>((resolve) => {
							resolveFirst = resolve;
						});
					return echo(ops);
				}
			})
		);
		await store.getState().openReplay("C:\\r.osr");

		// an unrelated commit in flight: the drag released behind it queues.
		// its delta carries no frame changes -- a splice would cancel the
		// queued drag instead (the next test)
		const first = store.getState().commitEdit({
			label: "hold",
			payload: { kind: "ops", ops: [{ kind: "moveFrames", moves: [{ index: 0, x: 1, y: 1 }] }] }
		});

		// the gesture: grab the [16, 48) press's start edge and slide it to 32
		const controller = new PressDragController();
		const down = controller.pointerDown(18, {
			key: "K1",
			frames: store.getState().scene!.frames,
			msPerPx: 1,
			slopPx: 4,
			edgeZonePx: 3,
			lattice: null
		});
		store.getState().setPressSelection(down.select!);
		controller.pointerMove(34);
		const up = controller.pointerUp(34);
		// the released commit names the dragged run in time-space
		expect(up.commit).toEqual({ key: "K1", runStartTime: 16, edit: { start: 32 } });

		// the drag intent queues behind the in-flight commit, bound to the
		// dragged run exactly as DetailLanes commits it through pressRunCommit
		let outcome: { key: PhysicalKey; startTime: number } | null = null;
		const drag = store.getState().commitEdit({
			label: "drag K1 press",
			payload: {
				kind: "intent",
				expand: (dispatchFrames, editor) => {
					const run = pressRunAt(dispatchFrames, up.commit!.key, up.commit!.runStartTime);
					if (run === null) return null;
					const expansion = expandRetimePress(
						dispatchFrames,
						run,
						up.commit!.edit,
						editor.lattice,
						"this drag"
					);
					if ("rejected" in expansion) return null;
					outcome = expansion.outcome;
					return expansion.ops;
				},
				remap: () => false
			},
			pressOutcome: (postFrames) => outcomeSelection(postFrames, outcome)
		});

		// before the queued drag expands, the user selects the other press
		store.getState().setPressSelection({ key: "K1", startIndex: 4 });
		await Promise.resolve();
		resolveFirst({ ...identityDelta, revision: 1 });
		await Promise.all([first, drag]);

		// the dragged press [16, 48) was retimed to [32, 48); the selected
		// press [64, 80) was never touched, and the selection follows the
		// dragged press's outcome
		expect(store.getState().scene!.frames.map((f) => f.buttons)).toEqual([0, 0, 5, 0, 5, 0]);
		expect(store.getState().editor!.pressSelection).toEqual({ key: "K1", startIndex: 2 });
	});

	test("a queued drag cancels when an intervening splice lands ahead of it", async () => {
		let resolveFirst!: (d: EditDelta) => void;
		const dispatched: EditOp[][] = [];
		const store: StoreApi<ViewerState> = createViewerStore(
			deps({
				loadReplay: async () => pressScene(),
				applyEdit: async (_e, _r, ops) => {
					dispatched.push(ops);
					return new Promise<EditDelta>((resolve) => {
						resolveFirst = resolve;
					});
				}
			})
		);
		await store.getState().openReplay("C:\\r.osr");

		const first = store.getState().commitEdit({
			label: "grow",
			payload: { kind: "ops", ops: [{ kind: "setButtons", sets: [{ index: 3, buttons: 5 }] }] }
		});

		const controller = new PressDragController();
		const down = controller.pointerDown(18, {
			key: "K1",
			frames: store.getState().scene!.frames,
			msPerPx: 1,
			slopPx: 4,
			edgeZonePx: 3,
			lattice: null
		});
		store.getState().setPressSelection(down.select!);
		controller.pointerMove(34);
		const up = controller.pointerUp(34);

		// the drag's frozen edit was previewed over pre-splice frames: the
		// queued intent must cancel rather than commit an expansion the
		// preview never showed, exactly as pressRunCommit's remap decides
		const settled: string[] = [];
		const drag = store.getState().commitEdit({
			label: "drag K1 press",
			payload: {
				kind: "intent",
				expand: (dispatchFrames, editor) => {
					const run = pressRunAt(dispatchFrames, up.commit!.key, up.commit!.runStartTime);
					if (run === null) return null;
					const expansion = expandRetimePress(
						dispatchFrames,
						run,
						up.commit!.edit,
						editor.lattice,
						"this drag"
					);
					if ("rejected" in expansion) return null;
					return expansion.ops;
				},
				remap: () => false
			},
			onSettled: (outcome) => settled.push(outcome)
		});
		await Promise.resolve();
		resolveFirst(moveDelta(1, 3, { time: 48, x: 48, y: 0, buttons: 5 }, "grow"));
		await Promise.all([first, drag]);

		expect(settled).toEqual(["cancelled"]);
		// only the first commit ever crossed ipc; the drag never dispatched
		expect(dispatched).toHaveLength(1);
		expect(store.getState().scene!.frames.map((f) => f.buttons)).toEqual([0, 5, 5, 5, 5, 0]);
	});

	test("an unrelated splice keeps the selection on its exact run across duplicate start times", async () => {
		// two K1 runs share the 10 ms start millisecond: a zero-length press
		// and a re-press; time containment alone resolves to the later one
		const frames = [
			{ time: 0, x: 0, y: 0, buttons: 0 },
			{ time: 10, x: 10, y: 0, buttons: 5 },
			{ time: 10, x: 10, y: 0, buttons: 0 },
			{ time: 10, x: 10, y: 0, buttons: 5 },
			{ time: 30, x: 30, y: 0, buttons: 5 },
			{ time: 40, x: 40, y: 0, buttons: 0 }
		];
		const store = createViewerStore(
			deps({
				loadReplay: async () => testScene({ frames }),
				applyEdit: async () => moveDelta(1, 0, { time: 0, x: 9, y: 9, buttons: 0 }, "move")
			})
		);
		await store.getState().openReplay("C:\\r.osr");
		store.getState().setPressSelection({ key: "K1", startIndex: 1 });
		await store.getState().commitEdit({
			label: "move",
			payload: { kind: "ops", ops: [{ kind: "moveFrames", moves: [{ index: 0, x: 9, y: 9 }] }] }
		});
		expect(store.getState().editor!.pressSelection).toEqual({ key: "K1", startIndex: 1 });
	});

	test("a delete press outcome clears the selection with the delta", async () => {
		const revisions = { next: 0 };
		const store: StoreApi<ViewerState> = createViewerStore(echoingDeps(() => store, revisions));
		await store.getState().openReplay("C:\\r.osr");
		store.getState().setPressSelection({ key: "K1", startIndex: 1 });
		await store.getState().commitEdit({
			label: "delete K1 press",
			payload: {
				kind: "intent",
				expand: (frames, editor) => {
					const sel = editor.pressSelection;
					if (sel === null) return null;
					const run = pressRunFromIndex(frames, sel.key, sel.startIndex);
					if (run === null) return null;
					const expansion = expandDeletePress(frames, run);
					if ("rejected" in expansion) return null;
					return expansion.ops;
				}
			},
			pressOutcome: () => null
		});
		expect(store.getState().scene!.frames.map((f) => f.buttons)).toEqual([0, 0, 0, 0, 5, 0]);
		expect(store.getState().editor!.pressSelection).toBeNull();
	});
});

describe("the active skin", () => {
	const legacyManifest = (path: string): SkinManifest => ({
		...bundledManifest(),
		locator: { kind: "stable", path },
		name: "Rafis 2016",
		author: "Rafis",
		source: "stable",
		era: "legacy",
		files: { "cursor.png": `${path}\\cursor.png` }
	});

	// LEGACY_SKINS_IMPLEMENTED is false, so every legacy selection below would
	// otherwise be refused by the gate. these tests are about what selection
	// DOES, not about whether it is allowed -- the gate has its own two tests

	test("the manifest is held BESIDE the scene, so a skin change is not a scene reload", async () => {
		const store = createViewerStore(deps());
		await store.getState().openReplay("a.osr");
		const sceneId = store.getState().sceneId;
		const scene = store.getState().scene;

		await store.getState().selectSkin({ kind: "stable", path: "C:\\skins\\Rafis" });

		expect(store.getState().skin?.name).toBe("Argon");
		// the stub answers with the bundled manifest whatever it is handed --
		// what matters here is that nothing about the SCENE moved
		expect(store.getState().sceneId).toBe(sceneId);
		expect(store.getState().scene).toBe(scene);
	});

	test("selecting a skin publishes the whole manifest in one step", async () => {
		// atomic by construction: the manifest resolves before anything is
		// published, so no observer can see a half-swapped skin. the SKIN and the
		// selection it came from are recorded per emission -- the pair is what
		// atomicity means here, and counting skin emissions alone would also count
		// the row-list publication that follows
		const manifest = legacyManifest("C:\\skins\\Rafis");
		const seen: [string | null, string | null][] = [];
		const store = createViewerStore(deps({ setSkin: async () => manifest }));
		// hydrated first so `settings` exists: the pair is only meaningful once
		// there is a selection to disagree with
		await store.getState().hydrateSettings();
		store.subscribe((state) => seen.push([state.skin?.name ?? null, state.settings?.skin.kind ?? null]));

		await store.getState().selectSkin(manifest.locator);
		expect(store.getState().skin).toEqual(manifest);

		// every emission carrying the new skin also carried the selection it came
		// from -- no observer saw one without the other, in either order
		const withSkin = seen.filter(([name]) => name === "Rafis 2016");
		expect(withSkin.length).toBeGreaterThan(0);
		expect(withSkin.every(([, kind]) => kind === "stable")).toBe(true);
		expect(seen.some(([name, kind]) => name !== "Rafis 2016" && kind === "stable")).toBe(false);
	});

	test("the persisted selection is what the user ASKED for, not what resolved", async () => {
		// the two disagree in exactly the case that matters: a folder that no
		// longer resolves falls back to the bundled default while the selection
		// keeps naming the folder, so restoring the folder restores the skin
		// without the user re-picking it. a stub answering with the requested
		// locator could not tell the two rules apart
		const requested: SkinLocator = { kind: "folder", path: "C:\\skins\\Gone" };
		const resolved: SkinManifest = {
			...bundledManifest(),
			fellBack: { requested, reason: "no longer there" }
		};
		const store = createViewerStore(deps({ setSkin: async () => resolved }));
		await store.getState().hydrateSettings();
		await store.getState().selectSkin(requested);

		expect(store.getState().skin?.locator).toEqual({ kind: "bundled" });
		expect(store.getState().settings?.skin).toEqual(requested);
	});

	test("a superseded pick neither writes nor publishes, even when it would be gated", async () => {
		// the gate branch issues a backend settings WRITE of its own. checking
		// the sequence only at publication time would let a stale refusal rewrite
		// the file under a newer selection that already landed -- leaving the
		// picker showing one skin and the settings naming another
		const legacy = legacyManifest("C:\\skins\\Slow");
		const setSkinCalls: string[] = [];
		let releaseSlow: (() => void) | null = null;
		const slow = new Promise<void>((resolve) => {
			releaseSlow = resolve;
		});
		const store = createViewerStore(
			deps({
				setSkin: async (locator) => {
					setSkinCalls.push(locator.kind);
					if (locator.kind === "folder") {
						await slow;
						return legacy;
					}
					return bundledManifest();
				}
			})
		);
		await store.getState().hydrateSettings();

		// the slow legacy pick starts, then a newer pick lands ahead of it
		const stale = store.getState().selectSkin({ kind: "folder", path: "C:\\skins\\Slow" });
		await store.getState().selectSkin({ kind: "bundled" });
		const afterNewer = store.getState().skin;
		releaseSlow!();
		await stale;

		// the stale refusal changed nothing: no notice over the newer selection,
		// and no third setSkin call undoing what the newer one persisted
		expect(store.getState().skin).toBe(afterNewer);
		expect(store.getState().skinNotice).toBeNull();
		expect(setSkinCalls).toEqual(["folder", "bundled"]);
	});

	test("browse selects a legacy skin exactly as a picker row does", async () => {
		// browse hands over a locator the row list never enumerated, and there is
		// no longer any rule that treats it differently: the development gate
		// that used to refuse both routes is gone, not inverted
		const chosen = legacyManifest("C:\\skins\\Rafis");
		const store = createViewerStore(
			deps({ setSkin: async (locator) => (locator.kind === "bundled" ? bundledManifest() : chosen) })
		);
		await store.getState().hydrateSettings();
		await store.getState().selectSkin({ kind: "folder", path: "C:\\skins\\Rafis" });

		expect(store.getState().skin?.era).toBe("legacy");
		expect(store.getState().settings?.skin).toEqual({ kind: "folder", path: "C:\\skins\\Rafis" });
		expect(store.getState().skinNotice).toBeNull();
		expect(store.getState().lastError).toBeNull();
	});

	test("a stale row list never lands over a newer one", async () => {
		// the walk behind listSkins is off-thread and unordered, and one caller
		// (a superseded import) fetches its list at a moment when the newer
		// operation has not landed yet -- so that list is guaranteed to be the
		// one MISSING the newer skin. it must not publish last
		const row = (name: string): SkinEntry => ({
			locator: { kind: "imported", path: `C:\\\\skins\\\\${name}` },
			name,
			author: "",
			source: "imported",
			era: "lazer",
			refusal: null
		});
		let call = 0;
		let releaseFirst: (() => void) | null = null;
		const firstListed = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const store = createViewerStore(
			deps({
				listSkins: async () => {
					call += 1;
					if (call === 1) {
						// the stale walk, which resolves LAST and knows only the old row
						await firstListed;
						return [row("Old")];
					}
					return [row("Old"), row("New")];
				}
			})
		);

		const stale = store.getState().refreshSkins();
		await store.getState().refreshSkins();
		expect(store.getState().skins.map((s) => s.name)).toEqual(["Old", "New"]);
		releaseFirst!();
		await stale;

		// the stale answer arrived last and was dropped
		expect(store.getState().skins.map((s) => s.name)).toEqual(["Old", "New"]);
	});

	test("a superseded import still re-lists, because the archive did land", async () => {
		// the selection and the row list are separate facts. the import wrote the
		// archive into the app-owned directory whatever happened to the
		// selection, so skipping the re-list would leave a skin that exists on
		// disk with no row anywhere until the dialog is reopened
		let listed = 0;
		const imported: SkinManifest = {
			...bundledManifest(),
			locator: { kind: "imported", path: "C:\\app\\skins\\New" },
			source: "imported"
		};
		const store = createViewerStore(
			deps({
				importSkin: async () => imported,
				setSkin: async () => bundledManifest(),
				listSkins: async () => {
					listed += 1;
					return [];
				}
			})
		);

		const stale = store.getState().importSkin("C:\\downloads\\skin.osk");
		// a newer pick claims the sequence while the import is in flight
		await store.getState().selectSkin({ kind: "bundled" });
		await stale;

		expect(listed).toBeGreaterThan(0);
	});

	test("an imported legacy skin becomes the active one", async () => {
		// an .osk is legacy essentially always, so this was the route the old
		// development gate leaked through most often. it now simply works
		const imported: SkinManifest = {
			...legacyManifest("C:\\app\\skins\\Downloaded"),
			locator: { kind: "imported", path: "C:\\app\\skins\\Downloaded" },
			source: "imported"
		};
		const store = createViewerStore(
			deps({
				importSkin: async () => imported,
				setSkin: async () => bundledManifest(),
				listSkins: async () => []
			})
		);
		await store.getState().importSkin("C:\\downloads\\skin.osk");

		expect(store.getState().skin?.era).toBe("legacy");
		expect(store.getState().skin?.source).toBe("imported");
		expect(store.getState().skinNotice).toBeNull();
		expect(store.getState().lastError).toBeNull();
	});

	test("a refused skin surfaces as an error and leaves the previous selection standing", async () => {
		const store = createViewerStore(
			deps({
				setSkin: async () => {
					throw { kind: "resourceLimit", cap: "MAX_SKIN_BYTES", limit: 1, actual: 2 };
				}
			})
		);
		await store.getState().hydrateSettings();
		const before = store.getState().skin;

		await store.getState().selectSkin({ kind: "folder", path: "C:\\huge" });

		expect(store.getState().skin).toBe(before);
		expect(store.getState().lastError?.error).toMatchObject({ kind: "resourceLimit", cap: "MAX_SKIN_BYTES" });
	});

	test("a persisted legacy locator comes back as the active skin", async () => {
		// hydration is the third route to an active skin, beside select and
		// import. all three now agree: a legacy skin is a skin like any other
		const store = createViewerStore(deps({ getSkin: async () => legacyManifest("C:\\skins\\Rafis") }));
		await store.getState().hydrateSettings();

		expect(store.getState().skin?.era).toBe("legacy");
		expect(store.getState().skinNotice).toBeNull();
	});

	test("a stale locator hydrates as the bundled default carrying its notice", async () => {
		const fellBack: SkinManifest = {
			...bundledManifest(),
			fellBack: { requested: { kind: "stable", path: "C:\\skins\\Gone" }, reason: "no longer there" }
		};
		const store = createViewerStore(deps({ getSkin: async () => fellBack }));
		await store.getState().hydrateSettings();
		expect(store.getState().skin?.fellBack?.requested).toEqual({ kind: "stable", path: "C:\\skins\\Gone" });
	});

	test("a superseded startup failure does not overwrite a newer working pick", async () => {
		// the catch publishes too, so it owes the same sequence guard the success
		// branch has: a slow persisted skin that fails must not drop its notice
		// over a skin the user has since picked successfully
		let releaseFailure: (() => void) | null = null;
		const slow = new Promise<void>((resolve) => {
			releaseFailure = resolve;
		});
		// signalled on ENTRY, so the pick below is guaranteed to claim its ticket
		// after hydration claimed its own -- otherwise the pick is the superseded
		// one and the test proves the opposite of what it says
		let enteredGetSkin: (() => void) | null = null;
		const resolving = new Promise<void>((resolve) => {
			enteredGetSkin = resolve;
		});
		const store = createViewerStore(
			deps({
				getSkin: async () => {
					enteredGetSkin!();
					await slow;
					throw { kind: "io", message: "unreadable" };
				},
				setSkin: async () => bundledManifest()
			})
		);

		const hydrating = store.getState().hydrateSettings();
		await resolving;
		await store.getState().selectSkin({ kind: "bundled" });
		releaseFailure!();
		await hydrating;

		// the newer pick stands, unannotated by the older failure
		expect(store.getState().skin).not.toBeNull();
		expect(store.getState().skinNotice).toBeNull();
	});

	test("a skin that will not resolve at all does not stop startup", async () => {
		const store = createViewerStore(
			deps({
				getSkin: async () => {
					throw new Error("disk on fire");
				}
			})
		);
		await store.getState().hydrateSettings();
		// the settings still landed, and the null skin reads as the bundled
		// default everywhere -- there is nothing to substitute
		expect(store.getState().settings).not.toBeNull();
		expect(store.getState().skin).toBeNull();
	});

	test("importing selects the imported skin and re-lists", async () => {
		const imported: SkinManifest = {
			...bundledManifest(),
			locator: { kind: "imported", path: "C:\\app\\skins\\Downloaded" },
			name: "Downloaded",
			source: "imported",
			era: "legacy"
		};
		const listed = [{ ...imported, refusal: null }];
		const store = createViewerStore(
			deps({
				importSkin: async () => imported,
				listSkins: async () =>
					listed.map(({ locator, name, author, source, era, refusal }) => ({
						locator,
						name,
						author,
						source,
						era,
						refusal
					}))
			})
		);
		await store.getState().importSkin("C:\\downloads\\skin.osk");
		expect(store.getState().skin?.name).toBe("Downloaded");
		expect(store.getState().skins.map((entry) => entry.name)).toEqual(["Downloaded"]);
	});

	test("refreshSkins publishes the picker's rows", async () => {
		const store = createViewerStore(
			deps({
				listSkins: async () => [
					{
						locator: { kind: "bundled" },
						name: "Argon",
						author: "osu!",
						source: "bundled",
						era: "lazer",
						refusal: null
					}
				]
			})
		);
		await store.getState().refreshSkins();
		expect(store.getState().skins).toHaveLength(1);
	});
});

describe("the persisted selection after a fallback", () => {
	test("picking a folder that does not resolve keeps naming the folder", async () => {
		// the manifest falls back to the bundled default, but the SELECTION is
		// what the user asked for -- which is what the backend persisted, and
		// what lets restoring the folder restore the skin without re-picking it
		const requested: SkinLocator = { kind: "folder", path: "C:\\gone" };
		const store = createViewerStore(
			deps({
				setSkin: async () => ({
					...bundledManifest(),
					fellBack: { requested, reason: "no longer there" }
				})
			})
		);
		await store.getState().hydrateSettings();
		await store.getState().selectSkin(requested);

		expect(store.getState().skin?.locator).toEqual({ kind: "bundled" });
		expect(store.getState().settings?.skin).toEqual(requested);
	});
});
