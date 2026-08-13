import { describe, expect, test } from "bun:test";
import type { EditDelta, LoadedSceneWarning, Settings } from "@/lib/scene-types";
import { DEFAULT_EDITING, DEFAULT_EFFECTS, DEFAULT_OVERLAYS, DEFAULT_TIMELINE } from "@/state/defaults";
import { createViewerStore, type ViewerState } from "@/state/store";
import { testScene } from "@/test/scene";
import { selectWarnings, warningList, warningText } from "./warnings";

const settings: Settings = {
	osuStablePath: null,
	volume: 100,
	overlays: DEFAULT_OVERLAYS,
	recents: [],
	editing: DEFAULT_EDITING,
	effects: DEFAULT_EFFECTS,
	timeline: DEFAULT_TIMELINE
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

// zustand's useStore drives useSyncExternalStore, which compares each
// getSnapshot() result to the previous one with Object.is. a selector that
// allocates a fresh value per call is therefore never equal to itself, so
// react re-renders forever and blows the update-depth limit at mount.
// scene is null on startup, which is exactly when a `?? []` default fires
describe("selectWarnings identity stability", () => {
	const deps = {
		loadReplay: async () => testScene(),
		loadReplayWithBeatmap: async () => testScene(),
		loadRecentReplay: async () => testScene(),
		getSettings: async () => settings,
		setOsuStablePath: async () => settings,
		setViewerPrefs: async () => settings,
		clearRecents: async () => settings,
		applyEdit: async () => identityDelta,
		undo: async () => identityDelta,
		redo: async () => identityDelta,
		revertAll: async () => identityDelta,
		resync: async () => identityDelta,
		exportReplay: async () => ({ path: "", bytes: 0, regenerated: null })
	};

	test("returns a referentially stable value with no scene loaded", () => {
		const state = createViewerStore(deps).getState();
		expect(state.scene).toBeNull();
		expect(selectWarnings(state)).toBe(selectWarnings(state));
	});

	test("returns a referentially stable value with a scene loaded", () => {
		const store = createViewerStore(deps);
		const state = { ...store.getState(), scene: testScene() } as ViewerState;
		expect(selectWarnings(state)).toBe(selectWarnings(state));
	});

	test("still reports the scene's warnings in backend order", () => {
		const warnings: LoadedSceneWarning[] = [
			{ kind: "beatmapMismatch", expectedMd5: "a", actualMd5: "b" },
			{ kind: "audioMissing" }
		];
		const state = { scene: testScene({ warnings }) } as ViewerState;
		expect(selectWarnings(state).map((w) => w.kind)).toEqual(["beatmapMismatch", "audioMissing"]);
	});
});

describe("warningText", () => {
	test("each warning kind gets distinct, informative copy", () => {
		expect(warningText({ kind: "audioMissing" })).toContain("audio file missing");
		expect(warningText({ kind: "modsNotSimulated", mods: 8 | 64 })).toBe(
			"mods not simulated (HD DT) — judgements, combo, and accuracy are hidden"
		);
		expect(warningText({ kind: "beatmapMismatch", expectedMd5: "a", actualMd5: "b" })).toContain(
			"doesn't match the replay"
		);
	});
});

describe("warningList", () => {
	test("preserves the backend's mismatch -> mods -> audio order exactly, never sorted", () => {
		// deliberately the real backend push order (load.rs), which is NOT
		// alphabetical by kind -- a test built from alphabetical input could
		// pass even if the code silently sorted by kind name
		const warnings: LoadedSceneWarning[] = [
			{ kind: "beatmapMismatch", expectedMd5: "a", actualMd5: "b" },
			{ kind: "modsNotSimulated", mods: 8 },
			{ kind: "audioMissing" }
		];
		expect(warningList(warnings).map((b) => b.kind)).toEqual([
			"beatmapMismatch",
			"modsNotSimulated",
			"audioMissing"
		]);
	});

	test("a single warning round-trips without being dropped or duplicated", () => {
		const warnings: LoadedSceneWarning[] = [{ kind: "audioMissing" }];
		expect(warningList(warnings)).toHaveLength(1);
		expect(warningList(warnings)[0].kind).toBe("audioMissing");
	});

	test("an empty list produces no banners", () => {
		expect(warningList([])).toEqual([]);
	});
});
