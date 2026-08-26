import { describe, expect, test } from "bun:test";
import type { EditDelta, LoadedSceneWarning, Settings } from "@/lib/scene-types";
import {
	DEFAULT_AUDIO,
	DEFAULT_EDITING,
	DEFAULT_EFFECTS,
	DEFAULT_GAMEPLAY,
	DEFAULT_OVERLAYS,
	DEFAULT_TIMELINE
} from "@/state/defaults";
import { createViewerStore, type ViewerState } from "@/state/store";
import { testScene } from "@/test/scene";
import { fakeRendererStatus } from "@/test/video";
import { selectWarnings, warningList, warningText } from "./warnings";
import type { SkinManifest } from "@/lib/scene-types";
import { DEFAULT_SKIN, DEFAULT_VIDEO } from "@/state/defaults";

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
	skin: { kind: "bundled" },
	video: DEFAULT_VIDEO,
	rendererOptions: {}
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
		getSettings: async () => settings,
		setOsuStablePath: async () => settings,
		setViewerPrefs: async () => settings,
		clearRecents: async () => settings,
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
		exportVideo: async () => ({ path: "", bytes: 0 }),
		cancelVideoExport: async () => {},
		getVideoRendererStatus: async () => fakeRendererStatus(),
		installVideoRenderer: async () => ({ ...fakeRendererStatus(), installed: true }),
		setVideoPrefs: async () => settings,
		redetectVideoEncoder: async () => settings
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
