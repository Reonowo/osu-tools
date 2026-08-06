import { describe, expect, test } from "bun:test";
import type { LoadedSceneWarning, Settings } from "@/lib/scene-types";
import { DEFAULT_OVERLAYS } from "@/state/defaults";
import { createViewerStore, type ViewerState } from "@/state/store";
import { testScene } from "@/test/scene";
import { bannersFor, selectWarnings, warningText } from "./WarningBanners";

const settings: Settings = { osuStablePath: null, volume: 100, overlays: DEFAULT_OVERLAYS };

// zustand's useStore drives useSyncExternalStore, which compares each
// getSnapshot() result to the previous one with Object.is. a selector that
// allocates a fresh value per call is therefore never equal to itself, so
// react re-renders forever and blows the update-depth limit at mount.
// scene is null on startup, which is exactly when a `?? []` default fires
describe("selectWarnings identity stability", () => {
	const deps = {
		loadReplay: async () => testScene(),
		loadReplayWithBeatmap: async () => testScene(),
		getSettings: async () => settings,
		setOsuStablePath: async () => settings,
		setViewerPrefs: async () => settings
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

describe("bannersFor", () => {
	test("preserves the backend's mismatch -> mods -> audio order exactly, never sorted", () => {
		// deliberately the real backend push order (load.rs), which is NOT
		// alphabetical by kind -- a test built from alphabetical input could
		// pass even if the code silently sorted by kind name
		const warnings: LoadedSceneWarning[] = [
			{ kind: "beatmapMismatch", expectedMd5: "a", actualMd5: "b" },
			{ kind: "modsNotSimulated", mods: 8 },
			{ kind: "audioMissing" }
		];
		expect(bannersFor(warnings).map((b) => b.kind)).toEqual([
			"beatmapMismatch",
			"modsNotSimulated",
			"audioMissing"
		]);
	});

	test("a single warning round-trips without being dropped or duplicated", () => {
		const warnings: LoadedSceneWarning[] = [{ kind: "audioMissing" }];
		expect(bannersFor(warnings)).toHaveLength(1);
		expect(bannersFor(warnings)[0].kind).toBe("audioMissing");
	});

	test("an empty list produces no banners", () => {
		expect(bannersFor([])).toEqual([]);
	});
});
