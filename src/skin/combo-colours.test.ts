import { describe, expect, test } from "bun:test";
import { loadFixture } from "@/test/fixtures";
import type { RenderPlan, SkinManifest } from "@/lib/scene-types";
import { ARGON_COMBO_COLOURS, CLASSIC_COMBO_COLOURS, comboPalette, objectAccents } from "./combo-colours";

function skin(over: Partial<SkinManifest> = {}, comboColours: [number, number, number, number][] = []): SkinManifest {
	return {
		locator: { kind: "bundled" },
		name: "Argon",
		author: "osu!",
		source: "bundled",
		era: "lazer",
		files: {},
		blank: [],
		config: {
			version: 1,
			isLatestVersion: false,
			comboColours,
			sliderBorder: null,
			sliderTrackOverride: null,
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
		fellBack: null,
		...over
	};
}

const plan = (comboColours: RenderPlan["comboColours"]) => ({ comboColours });

describe("comboPalette", () => {
	test("a beatmap that declares a palette wins over the skin's", () => {
		const declared: [number, number, number, number][] = [[1, 2, 3, 255]];
		expect(comboPalette(plan(declared), skin({}, [[9, 9, 9, 255]]))).toEqual(declared);
	});

	test("a null palette resolves against the active skin's declared colours", () => {
		const skinColours: [number, number, number, number][] = [
			[10, 10, 10, 255],
			[20, 20, 20, 255]
		];
		expect(comboPalette(plan(null), skin({}, skinColours))).toEqual(skinColours);
	});

	test("a skin declaring none falls back to ITS OWN era's default", () => {
		// per era, for the same reason every other fallthrough is: a legacy skin
		// on argon's palette would put lazer colours on a legacy playfield
		expect(comboPalette(plan(null), skin({ era: "lazer" }))).toEqual(ARGON_COMBO_COLOURS);
		expect(comboPalette(plan(null), skin({ era: "legacy", source: "stable" }))).toEqual(CLASSIC_COMBO_COLOURS);
	});

	test("no resolved skin reads as the bundled default rather than as no skin", () => {
		expect(comboPalette(plan(null), null)).toEqual(ARGON_COMBO_COLOURS);
	});

	test("an empty declared list is treated as no declaration on both sides", () => {
		expect(comboPalette(plan([]), skin({}, []))).toEqual(ARGON_COMBO_COLOURS);
	});
});

describe("objectAccents", () => {
	const objects = [0, 1, 2, 3, 4, 5, 6].map((comboColourIndex) => ({ comboColourIndex })) as RenderPlan["objects"];

	test("the modulo is applied consumer-side, so a palette's length can change freely", () => {
		// argon's six and the classic four index the same per-object data
		const six = objectAccents({ comboColours: null, objects }, skin({ era: "lazer" }));
		const four = objectAccents({ comboColours: null, objects }, skin({ era: "legacy", source: "stable" }));
		expect(six).toHaveLength(objects.length);
		expect(four).toHaveLength(objects.length);
		expect(six[6]).toEqual(ARGON_COMBO_COLOURS[0]);
		expect(four[4]).toEqual(CLASSIC_COMBO_COLOURS[0]);
		expect(four[6]).toEqual(CLASSIC_COMBO_COLOURS[2]);
	});

	test("a one-colour palette still indexes correctly", () => {
		const single: [number, number, number, number] = [7, 7, 7, 255];
		expect(objectAccents({ comboColours: [single], objects }, null).every((accent) => accent === single)).toBe(
			true
		);
	});
});

describe("the era defaults are the palettes lazer's own decoder reports", () => {
	// moving substitution out of the engine put both palettes in typescript,
	// where nothing pinned them. the classic four have an oracle already: a
	// skin with no skin.ini at all, dumped through a real LegacySkin, whose
	// configuration reports exactly the era default
	test("the classic four match the absent-ini golden dump", async () => {
		const dump = await loadFixture<{ combo_colours: { r: number; g: number; b: number; a: number }[] }>(
			"skin",
			"absent-ini.json"
		);
		expect(dump.combo_colours.map((c) => [c.r, c.g, c.b, c.a])).toEqual(CLASSIC_COMBO_COLOURS.map((c) => [...c]));
	});
});
