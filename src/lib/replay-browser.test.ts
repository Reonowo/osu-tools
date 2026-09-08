import { describe, expect, test } from "bun:test";
import {
	browserFooter,
	isLoadedRow,
	matchesTerms,
	rowDifficulty,
	rowTitle,
	searchTerms,
	visibleRows
} from "./replay-browser";
import type { BrowserRow, BrowserSourceStatus, ReplayBrowserListing } from "./scene-types";

function row(overrides: Partial<BrowserRow> = {}): BrowserRow {
	return {
		path: "C:\\osu!\\Replays\\a.osr",
		replayMd5: "aa",
		beatmapMd5: "b".repeat(32),
		source: "replaysFolder",
		artist: "Aqours",
		artistUnicode: "Aqours",
		title: "Miracle Wave",
		titleUnicode: "ミラクルウェーブ",
		difficulty: "Insane",
		creator: "someone",
		titled: true,
		playerName: "Reonowo",
		accuracy: 0.98,
		maxCombo: 420,
		score: 1_234_567,
		mods: 0,
		timestampTicks: "638000000000000000",
		date: "2022-09-28",
		lazerWritten: false,
		...overrides
	};
}

const READ: BrowserSourceStatus = { status: "read", count: 0, unreadable: 0, truncated: false };

function listing(overrides: Partial<ReplayBrowserListing> = {}): ReplayBrowserListing {
	return {
		rows: [],
		localPlays: { ...READ },
		replaysFolder: { ...READ },
		listing: { ...READ },
		...overrides
	};
}

describe("searchTerms", () => {
	test("splits on any run of whitespace and lowercases", () => {
		expect(searchTerms("  Miracle   WAVE\tinsane ")).toEqual(["miracle", "wave", "insane"]);
	});

	test("an empty query has no terms", () => {
		expect(searchTerms("")).toEqual([]);
		expect(searchTerms("   ")).toEqual([]);
	});
});

describe("matchesTerms", () => {
	test("every term must match, which is how osu!'s own song select searches", () => {
		expect(matchesTerms(row(), searchTerms("miracle insane"))).toBe(true);
		// the second term matches nothing, so the row is out even though the
		// first one hit
		expect(matchesTerms(row(), searchTerms("miracle taiko"))).toBe(false);
	});

	test("matches either script of the artist and title", () => {
		expect(matchesTerms(row(), searchTerms("ミラクル"))).toBe(true);
		expect(matchesTerms(row(), searchTerms("miracle"))).toBe(true);
		// a row whose romanisation is absent is still findable by its own
		// script, which is the case the unicode fields exist for
		const japaneseOnly = row({ title: null, artist: null });
		expect(matchesTerms(japaneseOnly, searchTerms("ミラクル"))).toBe(true);
	});

	test("case-insensitive on both sides, and the player counts", () => {
		expect(matchesTerms(row(), searchTerms("AQOURS"))).toBe(true);
		expect(matchesTerms(row({ playerName: "peppy" }), searchTerms("PEPPY"))).toBe(true);
	});

	test("the creator is not searched: a browser identifies a play", () => {
		expect(matchesTerms(row({ creator: "Pawnables" }), searchTerms("pawnables"))).toBe(false);
	});

	test("an untitled row matches nothing but still exists", () => {
		const untitled = row({
			artist: null,
			artistUnicode: null,
			title: null,
			titleUnicode: null,
			difficulty: null,
			playerName: null
		});
		expect(matchesTerms(untitled, searchTerms("anything"))).toBe(false);
		expect(matchesTerms(untitled, searchTerms(""))).toBe(true);
	});
});

describe("visibleRows", () => {
	const local = row({ path: "local.osr", source: "localPlay", title: "Squall", titleUnicode: null });
	const folder = row({ path: "folder.osr", source: "replaysFolder" });
	const rows = [local, folder];

	test("the source toggle narrows to one half, and `both` keeps everything", () => {
		expect(visibleRows(rows, "", "both", null)).toEqual(rows);
		expect(visibleRows(rows, "", "localPlay", null)).toEqual([local]);
		expect(visibleRows(rows, "", "replaysFolder", null)).toEqual([folder]);
	});

	test("the search and the toggle both apply", () => {
		expect(visibleRows(rows, "squall", "both", null)).toEqual([local]);
		expect(visibleRows(rows, "squall", "replaysFolder", null)).toEqual([]);
	});

	test("the loaded row is kept whatever the search and the toggle say", () => {
		// neither filter would keep it, and it survives both -- the hole a
		// search would otherwise leave where "you are here" should be
		expect(visibleRows(rows, "miracle", "both", "local.osr")).toEqual([local, folder]);
		expect(visibleRows(rows, "nothing matches this", "localPlay", "folder.osr")).toEqual([folder]);
	});

	test("the order the backend chose is preserved", () => {
		expect(visibleRows(rows, "", "both", null).map((r) => r.path)).toEqual(["local.osr", "folder.osr"]);
	});
});

describe("isLoadedRow", () => {
	test("path equality, and nothing is loaded before the first open", () => {
		expect(isLoadedRow(row({ path: "a.osr" }), "a.osr")).toBe(true);
		expect(isLoadedRow(row({ path: "a.osr" }), "b.osr")).toBe(false);
		expect(isLoadedRow(row({ path: "a.osr" }), null)).toBe(false);
	});
});

describe("rowTitle", () => {
	test("artist and title when both are there", () => {
		expect(rowTitle(row())).toBe("Aqours - Miracle Wave");
	});

	test("the title alone when the artist is stable's own blank", () => {
		expect(rowTitle(row({ artist: "" }))).toBe("Miracle Wave");
		expect(rowTitle(row({ artist: null }))).toBe("Miracle Wave");
	});

	test("an untitled row falls back to its md5, which is what finds the map", () => {
		expect(rowTitle(row({ title: null, titled: false, beatmapMd5: "abc" }))).toBe("abc");
		expect(rowTitle(row({ title: null, titled: false, beatmapMd5: null }))).toBe("unknown beatmap");
	});

	test("the difficulty is its own answer, absent when the listing had none", () => {
		expect(rowDifficulty(row())).toBe("Insane");
		expect(rowDifficulty(row({ difficulty: "" }))).toBe(null);
		expect(rowDifficulty(row({ difficulty: null }))).toBe(null);
	});
});

describe("browserFooter", () => {
	test("the counts line reads shown, total and the per-source numbers", () => {
		const { counts, notes } = browserFooter(
			listing({
				rows: [row(), row()],
				localPlays: { status: "read", count: 1271, unreadable: 0, truncated: false },
				replaysFolder: { status: "read", count: 4382, unreadable: 0, truncated: false }
			}),
			2
		);
		expect(counts).toContain("2 of 2");
		expect(counts).toContain("1,271 local plays");
		expect(counts).toContain("4,382 in Replays");
		expect(notes).toEqual([]);
	});

	test("a failed source names the file and carries the reader's reason", () => {
		const { notes } = browserFooter(
			listing({
				localPlays: { status: "failed", path: "E:\\osu!\\scores.db", reason: "the file is missing" }
			}),
			0
		);
		expect(notes).toEqual(["local plays: E:\\osu!\\scores.db — the file is missing"]);
	});

	test("a read source with skipped files or a cut list says so too", () => {
		const { notes } = browserFooter(
			listing({
				replaysFolder: { status: "read", count: 3, unreadable: 2, truncated: true }
			}),
			3
		);
		expect(notes).toEqual(["Replays folder: 2 could not be read, the list was cut short"]);
	});

	test("each source explains its own skips in its own terms", () => {
		// a local play drops because stable pruned its replay file; a Replays
		// file drops because it will not decode. one phrasing would lie about
		// one of them
		const { notes } = browserFooter(
			listing({ localPlays: { status: "read", count: 4, unreadable: 3, truncated: false } }),
			4
		);
		expect(notes).toEqual(["local plays: 3 have no replay file left"]);
	});

	test("an unreadable listing is its own note, since it produces no rows", () => {
		const { notes } = browserFooter(
			listing({ listing: { status: "failed", path: "E:\\osu!\\osu!.db", reason: "walk stopped at byte 4" } }),
			0
		);
		expect(notes).toEqual(["titles: E:\\osu!\\osu!.db — walk stopped at byte 4"]);
	});

	test("every source can fail at once and each is still named", () => {
		const failed = (path: string): BrowserSourceStatus => ({ status: "failed", path, reason: "gone" });
		const { counts, notes } = browserFooter(
			listing({
				localPlays: failed("scores.db"),
				replaysFolder: failed("Replays"),
				listing: failed("osu!.db")
			}),
			0
		);
		expect(counts).toContain("0 local plays");
		expect(notes).toHaveLength(3);
	});
});
