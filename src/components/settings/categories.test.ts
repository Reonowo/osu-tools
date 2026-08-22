// the settings dialog's seam: does every pref the store can set have a home
// in the ui, and does opening settings land on the right category. the panels
// themselves are jsx with no decision in them -- this is the whole of what is
// worth pinning. prior art: TabRail.test.ts, the same data-plus-one-pure-
// function split against the real defaults

import { describe, expect, test } from "bun:test";
import {
	DEFAULT_AUDIO,
	DEFAULT_EDITING,
	DEFAULT_EFFECTS,
	DEFAULT_GAMEPLAY,
	DEFAULT_OVERLAYS,
	DEFAULT_TIMELINE
} from "../../state/defaults";
import { OVERLAY_TOGGLES, TIMELINE_TOGGLES } from "./AnalysisCategory";
import { AUDIO_CHANNELS, AUDIO_TOGGLES, GAMEPLAY_TOGGLES } from "./AudioCategory";
import { CATEGORY_PREFS, resolveOpenCategory, SETTINGS_CATEGORIES } from "./categories";
import { EDITING_TOGGLES } from "./EditingCategory";
import { EFFECT_TOGGLES, SLIDER_TOGGLES } from "./GameplayCategory";

/** every key the four viewer-pref groups actually carry, read off the
 * DEFAULT_* objects rather than written out here: adding a pref to the store
 * puts it in this list without anyone remembering to update the test, which
 * is the whole point of the coverage assertions below */
const STORE_PREF_KEYS: string[] = [
	...Object.keys(DEFAULT_AUDIO).map((key) => `audio.${key}`),
	...Object.keys(DEFAULT_GAMEPLAY).map((key) => `gameplay.${key}`),
	...Object.keys(DEFAULT_OVERLAYS).map((key) => `overlays.${key}`),
	...Object.keys(DEFAULT_TIMELINE).map((key) => `timeline.${key}`),
	...Object.keys(DEFAULT_EFFECTS).map((key) => `effects.${key}`),
	...Object.keys(DEFAULT_EDITING).map((key) => `editing.${key}`)
];

const COVERED_KEYS: string[] = Object.values(CATEGORY_PREFS).flat();

/** every pref a category component actually puts a control on screen, read
 * off the same descriptor arrays the components map over. this is the half
 * that makes CATEGORY_PREFS more than a hand-written restatement of the
 * store: without it, deleting a ToggleRow's descriptor leaves every other
 * assertion green while the pref silently loses its ui.
 *
 * the audio offset, display length, the playfield grid and background dim are
 * the entries written out by hand, because they are the rendered prefs with no
 * descriptor -- two NumberFields, a toggle group and a slider, none of them a
 * ToggleRow --
 * which is the same reason coverage is keyed on pref keys rather than on
 * descriptors (categories.ts). general renders no per-key pref at all */
const RENDERED_PREF_KEYS: string[] = [
	...AUDIO_CHANNELS.map(({ key }) => `audio.${key}`),
	...AUDIO_TOGGLES.map(({ key }) => `audio.${key}`),
	"audio.offsetMs",
	// the audio category's hit-samples section, which renders two prefs out of
	// the `gameplay` group -- the prefix is the group they persist under, not
	// the tab they appear in (categories.ts)
	...GAMEPLAY_TOGGLES.map(({ key }) => `gameplay.${key}`),
	"gameplay.positionalHitsoundLevel",
	// the gameplay category's sliders section renders two more prefs out of
	// the same group (GameplayCategory.tsx)
	...SLIDER_TOGGLES.map(({ key }) => `gameplay.${key}`),
	...OVERLAY_TOGGLES.map(({ key }) => `overlays.${key}`),
	"overlays.displayLength",
	"overlays.playfieldGrid",
	...TIMELINE_TOGGLES.map(({ key }) => `timeline.${key}`),
	...EFFECT_TOGGLES.map(({ key }) => `effects.${key}`),
	"effects.backgroundDim",
	...EDITING_TOGGLES.map(({ key }) => `editing.${key}`)
];

describe("pref coverage", () => {
	test("every pref the store can set is claimed by a category", () => {
		const orphaned = STORE_PREF_KEYS.filter((key) => !COVERED_KEYS.includes(key));
		// the assertion is on the list, not on a count, so the failure names
		// the pref that was wired into the store and never rendered
		expect(orphaned).toEqual([]);
	});

	test("coverage names no pref the store no longer has", () => {
		const stale = COVERED_KEYS.filter((key) => !STORE_PREF_KEYS.includes(key));
		expect(stale).toEqual([]);
	});

	test("coverage claims exactly the prefs the categories render", () => {
		// both directions in one assertion: a claimed pref with no control, and
		// a rendered control no category claims. sorted because the map is
		// grouped by category and the descriptors are grouped by surface
		expect([...COVERED_KEYS].sort()).toEqual([...RENDERED_PREF_KEYS].sort());
	});

	test("no pref is claimed by two categories", () => {
		const duplicated = COVERED_KEYS.filter((key, index) => COVERED_KEYS.indexOf(key) !== index);
		expect(duplicated).toEqual([]);
	});
});

describe("category registry", () => {
	test("ids are unique", () => {
		const ids = SETTINGS_CATEGORIES.map((category) => category.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	test("registry and coverage describe the same categories", () => {
		const ids = SETTINGS_CATEGORIES.map((category) => category.id).sort();
		expect(Object.keys(CATEGORY_PREFS).sort()).toEqual(ids);
	});

	test("general is first, which is what the no-target open path falls back to", () => {
		expect(SETTINGS_CATEGORIES[0]?.id).toBe("general");
	});

	test("the bespoke categories claim no per-key pref, and say so by claiming none", () => {
		// general's install path and keybinds' override map are single controls
		// over one setting each, not sets of per-key setters -- listing a key
		// for either would make the coverage assertions above lie about what a
		// ToggleRow-shaped category is
		expect(CATEGORY_PREFS.general).toEqual([]);
		expect(CATEGORY_PREFS.keybinds).toEqual([]);
		// the skin selection is one discriminated locator behind a bespoke
		// picker, on the same terms as the install path and the keybind map
		expect(CATEGORY_PREFS.skin).toEqual([]);
	});

	test("every registry entry is a category the dialog can render", () => {
		// the registry is what the nav column maps over, so an id with no panel
		// would render an empty body rather than failing anywhere
		expect(SETTINGS_CATEGORIES.map((category) => category.id)).toEqual([
			"general",
			"gameplay",
			"skin",
			"audio",
			"analysis",
			"editing",
			"keybinds"
		]);
	});
});

describe("resolveOpenCategory", () => {
	test("an explicit target wins over the last-used category", () => {
		expect(resolveOpenCategory("general", "editing")).toBe("general");
	});

	test("no target reopens where the user last was", () => {
		expect(resolveOpenCategory(null, "editing")).toBe("editing");
	});

	test("neither falls back to the first registry entry", () => {
		expect(resolveOpenCategory(null, null)).toBe(SETTINGS_CATEGORIES[0].id);
	});
});
