import { describe, expect, test } from "bun:test";
import type { RecentReplay } from "./scene-types";
import { menuRecents } from "./open-menu";

function recent(osrPath: string): RecentReplay {
	return {
		osrPath,
		title: "map",
		version: "Insane",
		playerName: "p",
		accuracy: 0.98,
		maxCombo: 400,
		openedAtMs: 1_770_000_000_000,
		beatmapPath: null,
		beatmapDir: null,
		beatmapMd5: null,
		allowMismatch: false
	};
}

const paths = (entries: readonly RecentReplay[]) => entries.map((entry) => entry.osrPath);

describe("the open menu's recents", () => {
	test("every row is a replay other than the one being watched", () => {
		// record_recent puts the loaded replay at recents[0] on every successful
		// load, so this is the entry the naive list would always lead with
		const list = [recent("C:\\loaded.osr"), recent("C:\\a.osr"), recent("C:\\b.osr")];
		expect(paths(menuRecents(list, "C:\\loaded.osr"))).toEqual(["C:\\a.osr", "C:\\b.osr"]);
	});

	test("a history of one, already open, leaves the menu with nothing to offer", () => {
		// which is what the empty state has to be honest about: it is a fact
		// about this user's history, not a failure to read it
		expect(menuRecents([recent("C:\\loaded.osr")], "C:\\loaded.osr")).toEqual([]);
	});

	test("before anything is loaded nothing is excluded", () => {
		const list = [recent("C:\\a.osr"), recent("C:\\b.osr")];
		expect(paths(menuRecents(list, null))).toEqual(["C:\\a.osr", "C:\\b.osr"]);
	});

	test("a failed open leaves the still-displayed replay excluded, not the one that failed", () => {
		// osrPath mirrors `scene`'s lifecycle exactly: a failed load never
		// installs, so it keeps naming the replay still on screen (state/store.ts)
		const list = [recent("C:\\loaded.osr"), recent("C:\\failed.osr")];
		expect(paths(menuRecents(list, "C:\\loaded.osr"))).toEqual(["C:\\failed.osr"]);
	});
});
