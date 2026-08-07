import { describe, expect, test } from "bun:test";
import type { IpcError, LoadedScene, RecentReplay, Settings } from "../lib/scene-types";
import { testScene } from "../test/scene";
import { VIEWPORT_ZOOM_MAX, VIEWPORT_ZOOM_MIN } from "../renderer/playfield";
import {
	DEFAULT_EDITING,
	DEFAULT_EFFECTS,
	DEFAULT_OVERLAYS,
	DETAIL_SPAN_MAX,
	DETAIL_SPAN_MIN,
	effectiveEffects
} from "./defaults";
import { createViewerStore, type IpcDeps } from "./store";

const baseSettings: Settings = {
	osuStablePath: null,
	volume: 100,
	overlays: DEFAULT_OVERLAYS,
	recents: [],
	editing: DEFAULT_EDITING,
	effects: DEFAULT_EFFECTS
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
		loadRecentReplay: async () => testScene(),
		getSettings: async () => baseSettings,
		setOsuStablePath: async (path) => ({ ...baseSettings, osuStablePath: path }),
		setViewerPrefs: async (volume, overlays, editing, effects) => ({
			...baseSettings,
			volume,
			overlays,
			editing,
			effects
		}),
		clearRecents: async () => ({ ...baseSettings, recents: [] }),
		...overrides
	};
}

const reject = (e: IpcError) => async (): Promise<LoadedScene> => {
	throw e;
};

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

	test("openRecent goes through load_recent_replay and sends only the entry's path", async () => {
		// the beatmap association lives in rust's settings file; sending it back
		// across the boundary would be a second copy to keep in sync, so the
		// entry's other fields must not reach the ipc call
		const calls: string[] = [];
		const openedRecent: string[] = [];
		const store = createViewerStore(
			deps({
				loadReplay: async (osrPath) => {
					calls.push(osrPath);
					return testScene();
				},
				loadRecentReplay: async (osrPath) => {
					openedRecent.push(osrPath);
					return testScene();
				}
			})
		);

		await store.getState().openRecent(sampleRecent);
		expect(openedRecent).toEqual([sampleRecent.osrPath]);
		expect(calls).toEqual([]);
		expect(store.getState().scene).not.toBeNull();
		expect(store.getState().osrPath).toBe(sampleRecent.osrPath);
	});

	test("a recent whose beatmap is gone surfaces the same picker recovery as any other load", async () => {
		// rust ends the resolution walk on beatmapNotFound precisely so this
		// path reaches the manual picker, exactly as a fresh open would
		const store = createViewerStore(deps({ loadRecentReplay: reject({ kind: "beatmapNotFound", md5: "abc" }) }));
		await store.getState().openRecent(sampleRecent);
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
			overlays: { ...DEFAULT_OVERLAYS, cursorPath: true, keyOverlay: false, displayLength: 1400 },
			recents: [],
			editing: { ...DEFAULT_EDITING, snapToLattice: false },
			effects: DEFAULT_EFFECTS
		};
		const store = createViewerStore(deps({ getSettings: async () => stored }));

		expect(store.getState().volume).toBe(100); // the default, before hydration
		await store.getState().hydrateSettings();

		expect(store.getState().volume).toBe(42);
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
		expect(store.getState().volume).toBe(60); // untouched fields still hydrate
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
				setViewerPrefs: async (volume, overlays, editing, effects) => {
					saved.push({ volume, editing });
					return { ...baseSettings, volume, overlays, editing, effects };
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
				setViewerPrefs: (volume, overlays, editing, effects) => {
					saved.push(editing);
					return new Promise<Settings>((resolve) => {
						resolvers.push(() => resolve({ ...baseSettings, volume, overlays, editing, effects }));
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
				setViewerPrefs: async (volume, overlays, editing, effects) => {
					saves += 1;
					return { ...baseSettings, volume, overlays, editing, effects };
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
});

describe("effect settings", () => {
	test("everything ships on, mirroring settings.rs EffectPrefs::default", () => {
		expect(createViewerStore(deps()).getState().effects).toEqual({
			enabled: true,
			hitAnimations: true,
			hitEffects: true,
			cursorGlow: true,
			cursorTrail: true,
			followPoints: true
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
			followPoints: false
		});

		// and switching the master back on restores exactly what was chosen
		store.getState().setEffect("enabled", true);
		const live = effectiveEffects(store.getState().effects);
		expect(live.hitEffects).toBe(true);
		expect(live.cursorTrail).toBe(false);
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
				setViewerPrefs: async (volume, overlays, editing, effects) => {
					saved.push(effects);
					return { ...baseSettings, volume, overlays, editing, effects };
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
				clearRecents: async () => ({ ...baseSettings, recents: [] })
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
