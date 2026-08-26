// the rail's click semantics against the real store: base-ui owns selecting
// an inactive tab, but "what does clicking the tab I am already on do" is
// this file's own decision, and it is the one that used to force the panel
// open forever

import { describe, expect, test } from "bun:test";
import type { EditDelta, Settings } from "../../lib/scene-types";
import { testScene } from "../../test/scene";
import { fakeRendererStatus } from "@/test/video";
import {
	DEFAULT_AUDIO,
	DEFAULT_EDITING,
	DEFAULT_EFFECTS,
	DEFAULT_GAMEPLAY,
	DEFAULT_OVERLAYS,
	DEFAULT_TIMELINE
} from "../../state/defaults";
import { createViewerStore, type IpcDeps } from "../../state/store";
import { railTabClick } from "./TabRail";
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

function deps(): IpcDeps {
	return {
		loadReplay: async () => testScene(),
		loadReplayWithBeatmap: async () => testScene(),
		getSettings: async () => baseSettings,
		setOsuStablePath: async (path) => ({ ...baseSettings, osuStablePath: path }),
		setViewerPrefs: async (volume, audio, gameplay, overlays, editing, effects) => ({
			...baseSettings,
			volume,
			audio,
			gameplay,
			overlays,
			editing,
			effects
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
		exportVideo: async () => ({ path: "", bytes: 0 }),
		cancelVideoExport: async () => {},
		getVideoRendererStatus: async () => fakeRendererStatus(),
		installVideoRenderer: async () => ({ ...fakeRendererStatus(), installed: true }),
		setVideoPrefs: async () => baseSettings,
		redetectVideoEncoder: async () => baseSettings
	};
}

/** the store's own actions, the same pair RailTrigger passes in */
function actions(store: ReturnType<typeof createViewerStore>) {
	const { setPanelTab, togglePanel } = store.getState();
	return { setPanelTab, togglePanel };
}

describe("railTabClick", () => {
	test("clicking the selected tab toggles the panel shut, and again to reopen", () => {
		const store = createViewerStore(deps());
		store.getState().setPanelTab("analysis");
		expect(store.getState().panelOpen).toBe(true);

		railTabClick(true, "analysis", actions(store));
		expect(store.getState().panelOpen).toBe(false);
		expect(store.getState().panelTab).toBe("analysis"); // still selected, just hidden

		railTabClick(true, "analysis", actions(store));
		expect(store.getState().panelOpen).toBe(true);
	});

	test("clicking a different tab selects it and opens the panel", () => {
		const store = createViewerStore(deps());
		store.getState().setPanelTab("analysis");
		store.getState().togglePanel(); // closed
		expect(store.getState().panelOpen).toBe(false);

		railTabClick(false, "frames", actions(store));
		expect(store.getState().panelTab).toBe("frames");
		expect(store.getState().panelOpen).toBe(true);
	});

	test("selecting an inactive tab is idempotent -- base-ui fires its own callback too", () => {
		// both base-ui's onValueChange and this handler run on an inactive tab,
		// so the second call must land on the same state as the first
		const store = createViewerStore(deps());
		railTabClick(false, "keys", actions(store));
		store.getState().setPanelTab("keys");
		expect(store.getState().panelTab).toBe("keys");
		expect(store.getState().panelOpen).toBe(true);
	});
});
