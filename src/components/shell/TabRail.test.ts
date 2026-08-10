// the rail's click semantics against the real store: base-ui owns selecting
// an inactive tab, but "what does clicking the tab I am already on do" is
// this file's own decision, and it is the one that used to force the panel
// open forever

import { describe, expect, test } from "bun:test";
import type { EditDelta, Settings } from "../../lib/scene-types";
import { testScene } from "../../test/scene";
import { DEFAULT_EDITING, DEFAULT_EFFECTS, DEFAULT_OVERLAYS } from "../../state/defaults";
import { createViewerStore, type IpcDeps } from "../../state/store";
import { railTabClick } from "./TabRail";

const baseSettings: Settings = {
	osuStablePath: null,
	volume: 100,
	overlays: DEFAULT_OVERLAYS,
	recents: [],
	editing: DEFAULT_EDITING,
	effects: DEFAULT_EFFECTS
};

const identityDelta: EditDelta = {
	revision: 0,
	frames: null,
	playerName: "p",
	timestampTicks: "0",
	dirty: false,
	canUndo: false,
	canRedo: false,
	history: { labels: [], cursor: 0 },
	simulation: null
};

function deps(): IpcDeps {
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
		applyEdit: async () => identityDelta,
		undo: async () => identityDelta,
		redo: async () => identityDelta,
		revertAll: async () => identityDelta,
		resync: async () => identityDelta
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
