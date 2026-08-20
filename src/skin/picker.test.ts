import { describe, expect, test } from "bun:test";
import type { SkinEntry, SkinLocator, SkinManifest } from "@/lib/scene-types";
import { fallbackNotice, rowLabel, sameSelection, sameSkin, skinRows, SOURCE_LABELS } from "./picker";

function entry(over: Partial<SkinEntry> = {}): SkinEntry {
	return {
		locator: { kind: "bundled" },
		name: "Argon",
		author: "osu!",
		source: "bundled",
		era: "lazer",
		refusal: null,
		...over
	};
}

function manifest(locator: SkinLocator, fellBack: SkinManifest["fellBack"] = null): SkinManifest {
	return {
		locator,
		name: "x",
		author: "y",
		source: locator.kind,
		era: locator.kind === "bundled" ? "lazer" : "legacy",
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
		fellBack
	};
}

describe("skinRows", () => {
	test("Argon is a row, and selecting it is selecting a skin", () => {
		// the decision that makes the rest coherent: "no skin selected" and
		// "Argon selected" are one row rather than two concepts
		const rows = skinRows([entry()], manifest({ kind: "bundled" }));
		expect(rows[0].selected).toBe(true);
		expect(rows[0].selectable).toBe(true);
		expect(SOURCE_LABELS[rows[0].source]).toBe("bundled");
	});

	test("the backend's order is preserved rather than re-sorted by name", () => {
		// sorting here would scatter the imported skins through the stable ones
		// and lose the grouping the source badge exists to make visible
		const rows = skinRows(
			[
				entry(),
				entry({ locator: { kind: "stable", path: "C:\\osu!\\Skins\\Zzz" }, name: "Zzz", source: "stable" }),
				entry({ locator: { kind: "stable", path: "C:\\osu!\\Skins\\Aaa" }, name: "Aaa", source: "stable" }),
				entry({ locator: { kind: "imported", path: "C:\\app\\skins\\Bbb" }, name: "Bbb", source: "imported" })
			],
			null
		);
		expect(rows.map((row) => row.name)).toEqual(["Argon", "Zzz", "Aaa", "Bbb"]);
		expect(rows.map((row) => row.source)).toEqual(["bundled", "stable", "stable", "imported"]);
	});

	test("a refused skin still appears, unselectable, with its reason", () => {
		const rows = skinRows(
			[
				entry({
					locator: { kind: "folder", path: "C:\\huge" },
					source: "folder",
					refusal: "exceeds MAX_SKIN_BYTES (limit 1, actual 2)"
				})
			],
			null
		);
		expect(rows[0].selectable).toBe(false);
		expect(rows[0].refusal).toContain("MAX_SKIN_BYTES");
	});

	test("the ACTIVE manifest decides the highlight, not the persisted selection", () => {
		// after a stale locator falls back, those two disagree: the selection
		// still names a folder that is gone while the manifest names the bundled
		// default. highlighting the missing folder would say the skin is loaded
		const missing: SkinLocator = { kind: "stable", path: "C:\\osu!\\Skins\\Deleted" };
		const rows = skinRows(
			[entry(), entry({ locator: missing, name: "Deleted", source: "stable" })],
			manifest({ kind: "bundled" }, { requested: missing, reason: "gone" })
		);
		expect(rows[0].selected).toBe(true);
		expect(rows[1].selected).toBe(false);
	});

	test("nothing is selected before the active skin resolves", () => {
		expect(skinRows([entry()], null).every((row) => !row.selected)).toBe(true);
	});
});

describe("sameSkin", () => {
	test("the KIND is part of the identity, not just the path", () => {
		const path = "C:\\osu!\\Skins\\Rafis";
		expect(sameSkin({ kind: "stable", path }, { kind: "folder", path })).toBe(false);
		expect(sameSkin({ kind: "stable", path }, { kind: "stable", path })).toBe(true);
	});

	test("paths compare case-insensitively, as windows does", () => {
		expect(sameSkin({ kind: "folder", path: "C:\\Skins\\A" }, { kind: "folder", path: "c:\\skins\\a" })).toBe(true);
	});

	test("bundled is bundled", () => {
		expect(sameSkin({ kind: "bundled" }, { kind: "bundled" })).toBe(true);
	});
});

describe("the fallback notice", () => {
	test("a stale locator surfaces as a notice naming what was asked for", () => {
		const notice = fallbackNotice(
			manifest(
				{ kind: "bundled" },
				{ requested: { kind: "stable", path: "C:\\osu!\\Skins\\Gone" }, reason: "no longer there" }
			)
		);
		expect(notice).toContain("C:\\osu!\\Skins\\Gone");
		expect(notice).toContain("bundled default");
	});

	test("an ordinary load raises no notice", () => {
		expect(fallbackNotice(manifest({ kind: "bundled" }))).toBeNull();
		expect(fallbackNotice(null)).toBeNull();
	});
});

describe("rowLabel", () => {
	test("an empty name falls back rather than rendering a blank row", () => {
		// the folder-name fallback happens backend-side, where the folder is;
		// this is the last-resort guard for a folder with no usable name either
		expect(rowLabel(entry({ name: "   " }))).toBe("(unnamed skin)");
		expect(rowLabel(entry({ name: "Rafis 2016" }))).toBe("Rafis 2016");
	});
});

describe("legacy skins are selectable", () => {
	const legacy = entry({
		locator: { kind: "stable", path: "C:\\osu!\\Skins\\Rafis" },
		name: "Rafis",
		source: "stable",
		era: "legacy"
	});

	test("a legacy skin is pickable in a shipped build", () => {
		// the development gate that used to sit here is GONE rather than
		// inverted: every element the playfield draws now has a legacy
		// implementation, which is the coverage condition it always named
		const [row] = skinRows([legacy], null);
		expect(row.selectable).toBe(true);
		expect(row.refusal).toBeNull();
	});

	test("Argon is selectable too -- it is the app's own look", () => {
		expect(skinRows([entry()], null)[0].selectable).toBe(true);
	});

	test("only the backend's own refusal makes a row unselectable", () => {
		const refused = entry({ ...legacy, refusal: "exceeds MAX_SKIN_BYTES (limit 1, actual 2)" });
		const [row] = skinRows([refused], null);
		expect(row.selectable).toBe(false);
		expect(row.refusal).toContain("MAX_SKIN_BYTES");
	});
});

describe("sameSelection", () => {
	test("null and the bundled manifest are the same selection", () => {
		// null is what the store holds before the skin resolves and it reads as
		// the bundled default everywhere, so the startup flip is not a change --
		// treating it as one tears down every drawable and drops every decoded
		// sample for a skin that never moved
		expect(sameSelection(null, manifest({ kind: "bundled" }))).toBe(true);
		expect(sameSelection(manifest({ kind: "bundled" }), null)).toBe(true);
		expect(sameSelection(null, null)).toBe(true);
	});

	test("re-resolving the SAME skin is a change, because its files may have moved under us", () => {
		// a skin is referenced in place: the user can edit it, and a re-import
		// replaces it outright (story 41). re-picking it is how they ask for that
		// to be picked up, so comparing locators alone would silently ignore it
		const before = manifest({ kind: "imported", path: "C:\\app\\skins\\Same" });
		const after = manifest({ kind: "imported", path: "C:\\app\\skins\\Same" });
		expect(sameSelection(before, after)).toBe(false);
		// but the identical object is not a new publication
		expect(sameSelection(before, before)).toBe(true);
	});

	test("bundled is exempt: it has no files on disk to change", () => {
		expect(sameSelection(manifest({ kind: "bundled" }), manifest({ kind: "bundled" }))).toBe(true);
	});

	test("a different skin is a change", () => {
		expect(
			sameSelection(manifest({ kind: "stable", path: "C:\\a" }), manifest({ kind: "stable", path: "C:\\b" }))
		).toBe(false);
		expect(sameSelection(null, manifest({ kind: "stable", path: "C:\\a" }))).toBe(false);
	});
});
