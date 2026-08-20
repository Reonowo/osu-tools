import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import type { SkinManifest } from "@/lib/scene-types";
import { CLASSIC_FLOOR_FILES } from "./legacy/floor-manifest";
import {
	classicFloorTextureSource,
	expandNames,
	frameLength,
	resolveTexture,
	SIXTY_FRAME_TIME,
	textureRequest,
	textureSources
} from "./texture-sources";

function skin(files: Record<string, string>, options: Partial<SkinManifest> = {}): SkinManifest {
	return {
		locator: { kind: "folder", path: "C:\\skin" },
		name: "Test Skin",
		author: "nobody",
		source: "folder",
		era: "legacy",
		files,
		blank: [],
		config: {
			version: 2.7,
			isLatestVersion: true,
			comboColours: [],
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
		...options,
		fellBack: options.fellBack ?? null
	};
}

/** a file map whose values are the absolute paths the manifest carries */
function paths(...names: string[]): Record<string, string> {
	return Object.fromEntries(names.map((name) => [name, `C:\\skin\\${name}`]));
}

const toUrl = (path: string) => `asset://${path}`;

describe("an empty answer ends the chain", () => {
	// written first, deliberately. killing an element by shipping a blank
	// asset is standard practice in real skins, and a fallthrough written on
	// autopilot resurrects exactly what the user chose their skin to remove
	test("a blank sprite stops the chain instead of falling to the floor", () => {
		const manifest = skin(paths("followpoint.png"), { blank: ["followpoint.png"] });
		const sources = textureSources({ beatmap: null, skin: manifest, toUrl });

		expect(resolveTexture(sources, textureRequest("followpoint"))).toEqual({ answer: "empty" });
		// and the floor DOES ship one, so this is not an accident of absence
		expect(CLASSIC_FLOOR_FILES).toContain("followpoint@2x.png");
	});

	test("a blank FIRST frame kills the whole animation", () => {
		const manifest = skin(paths("followpoint-0.png", "followpoint-1.png"), {
			blank: ["followpoint-0.png"]
		});
		const answer = resolveTexture(
			textureSources({ beatmap: null, skin: manifest, toUrl }),
			textureRequest("followpoint", true)
		);
		expect(answer).toEqual({ answer: "empty" });
	});

	test("an empty answer is never collapsed into a decline", () => {
		const manifest = skin(paths("hit300.png"), { blank: ["hit300.png"] });
		const answer = resolveTexture(
			textureSources({ beatmap: null, skin: manifest, toUrl }),
			textureRequest("hit300")
		);
		expect(answer.answer).toBe("empty");
		expect(answer.answer).not.toBe("none");
	});
});

describe("legacy skin texture resolution", () => {
	test("a skin's own file answers ahead of the floor", () => {
		const manifest = skin(paths("cursor.png"));
		const answer = resolveTexture(
			textureSources({ beatmap: null, skin: manifest, toUrl }),
			textureRequest("cursor")
		);
		expect(answer).toEqual({
			answer: "found",
			value: {
				sourceId: "skin",
				name: "cursor",
				frames: ["asset://C:\\skin\\cursor.png"],
				resolutionFactors: [1],
				animated: false
			}
		});
	});

	test("an @2x asset wins and carries its resolution factor out", () => {
		const manifest = skin(paths("cursor.png", "cursor@2x.png"));
		const answer = resolveTexture(
			textureSources({ beatmap: null, skin: manifest, toUrl }),
			textureRequest("cursor")
		);
		expect(answer).toMatchObject({
			answer: "found",
			value: { frames: ["asset://C:\\skin\\cursor@2x.png"], resolutionFactors: [2] }
		});
	});

	test("an @2x written into the lookup name itself is stripped", () => {
		// legacyskin.cs:566 -- stable strips it, so lazer does too
		const manifest = skin(paths("cursor.png"));
		const answer = resolveTexture(
			textureSources({ beatmap: null, skin: manifest, toUrl }),
			textureRequest("cursor@2x")
		);
		expect(answer).toMatchObject({ answer: "found", value: { name: "cursor" } });
	});

	test("extension preference decides when a skin ships both spellings", () => {
		const manifest = skin(paths("cursor.jpg", "cursor.png"));
		const answer = resolveTexture(
			textureSources({ beatmap: null, skin: manifest, toUrl }),
			textureRequest("cursor")
		);
		expect(answer).toMatchObject({ answer: "found", value: { frames: ["asset://C:\\skin\\cursor.png"] } });
	});

	test("a path-qualified name reaches a flat skin folder by its last piece", () => {
		const manifest = skin(paths("hitcircle.png"));
		const answer = resolveTexture(
			textureSources({ beatmap: null, skin: manifest, toUrl }),
			textureRequest("Gameplay/osu/hitcircle")
		);
		expect(answer).toMatchObject({ answer: "found", value: { name: "hitcircle" } });
	});

	test("a texture lookup has no bank suffix and no universal fallback", () => {
		// the two rules a reader coming from the sample half will look for.
		// both belong to a hit sample's identity, not to an element name, and
		// inventing texture analogues would be inventing lazer behaviour
		const manifest = skin(paths("hitcircle.png"));
		const sources = textureSources({ beatmap: null, skin: manifest, toUrl });
		expect(resolveTexture(sources, textureRequest("hitcircle2")).answer).toBe("none");
		expect(expandNames(["normal-hitcircle"])).toEqual(["normal-hitcircle"]);
	});

	test("candidate names are tried in order, and a later one still answers", () => {
		const manifest = skin(paths("hitcircle.png"));
		const answer = resolveTexture(textureSources({ beatmap: null, skin: manifest, toUrl }), {
			names: ["sliderstartcircle", "hitcircle"],
			animatable: false,
			animationSeparator: "-"
		});
		expect(answer).toMatchObject({ answer: "found", value: { name: "hitcircle" } });
	});
});

describe("animation frame sets", () => {
	test("frames are discovered as a set, in frame order, up to the first gap", () => {
		const manifest = skin(
			paths("followpoint-0.png", "followpoint-1.png", "followpoint-2.png", "followpoint-4.png")
		);
		const answer = resolveTexture(
			textureSources({ beatmap: null, skin: manifest, toUrl }),
			textureRequest("followpoint", true)
		);
		expect(answer).toMatchObject({
			answer: "found",
			value: {
				frames: [
					"asset://C:\\skin\\followpoint-0.png",
					"asset://C:\\skin\\followpoint-1.png",
					"asset://C:\\skin\\followpoint-2.png"
				],
				animated: true
			}
		});
	});

	test("the slider ball's frames carry NO separator", () => {
		// legacysliderball.cs:48 passes "" -- a skin's frames are sliderb0..9
		// with nothing between them, and defaulting to "-" here would turn every
		// skin's slider ball into a static sprite
		const manifest = skin(paths("sliderb0.png", "sliderb1.png", "sliderb2.png"));
		const sources = textureSources({ beatmap: null, skin: manifest, toUrl });

		expect(resolveTexture(sources, textureRequest("sliderb", true, ""))).toMatchObject({
			answer: "found",
			value: {
				animated: true,
				frames: [expect.stringContaining("sliderb0"), expect.any(String), expect.any(String)]
			}
		});
		// with the default separator the same skin answers nothing at all
		expect(resolveTexture(sources, textureRequest("sliderb", true)).answer).toBe("none");
	});

	test("a single frame is NOT mistaken for an animation", () => {
		// legacyskinextensions.cs:33-41 -- GetAnimation switches on the count
		// and hands back a plain Sprite for one
		const manifest = skin(paths("followpoint-0.png"));
		const answer = resolveTexture(
			textureSources({ beatmap: null, skin: manifest, toUrl }),
			textureRequest("followpoint", true)
		);
		expect(answer).toMatchObject({
			answer: "found",
			value: { animated: false, frames: ["asset://C:\\skin\\followpoint-0.png"] }
		});
	});

	test("the animation is tried before the single sprite", () => {
		const manifest = skin(paths("followpoint.png", "followpoint-0.png", "followpoint-1.png"));
		const answer = resolveTexture(
			textureSources({ beatmap: null, skin: manifest, toUrl }),
			textureRequest("followpoint", true)
		);
		expect(answer).toMatchObject({ answer: "found", value: { animated: true } });
	});

	test("a non-animatable request ignores a stray frame zero", () => {
		const manifest = skin(paths("hitcircle.png", "hitcircle-0.png"));
		const answer = resolveTexture(
			textureSources({ beatmap: null, skin: manifest, toUrl }),
			textureRequest("hitcircle", false)
		);
		expect(answer).toMatchObject({ answer: "found", value: { frames: ["asset://C:\\skin\\hitcircle.png"] } });
	});

	test("a frame set resolves each frame's own resolution rather than frame zero's", () => {
		// lazer calls GetTexture per frame and each call runs its own
		// @2x-then-plain fallback, writing ScaleAdjust on the texture it returns
		// -- so a set whose frames are not uniformly @2x plays in FULL, each frame
		// at its own scale, rather than being cut short at the mismatch
		const manifest = skin(paths("sliderb-0@2x.png", "sliderb-1@2x.png", "sliderb-2.png"));
		const answer = resolveTexture(
			textureSources({ beatmap: null, skin: manifest, toUrl }),
			textureRequest("sliderb", true)
		);
		expect(answer).toMatchObject({
			answer: "found",
			value: {
				resolutionFactors: [2, 2, 1],
				frames: [
					"asset://C:\\skin\\sliderb-0@2x.png",
					"asset://C:\\skin\\sliderb-1@2x.png",
					"asset://C:\\skin\\sliderb-2.png"
				]
			}
		});
	});

	test("a frame set still stops at the first genuinely missing frame", () => {
		// the gap rule is unchanged: what widened is which spellings answer a
		// frame, not how far the walk runs
		const manifest = skin(paths("sliderb-0.png", "sliderb-1@2x.png", "sliderb-3.png"));
		const answer = resolveTexture(
			textureSources({ beatmap: null, skin: manifest, toUrl }),
			textureRequest("sliderb", true)
		);
		expect(answer).toMatchObject({
			answer: "found",
			value: {
				resolutionFactors: [1, 2],
				frames: ["asset://C:\\skin\\sliderb-0.png", "asset://C:\\skin\\sliderb-1@2x.png"]
			}
		});
	});
});

describe("the classic floor", () => {
	test("a skin that declines falls to the classic floor, never to Argon", () => {
		const manifest = skin(paths("cursor.png"));
		const answer = resolveTexture(
			textureSources({ beatmap: null, skin: manifest, toUrl }),
			textureRequest("followpoint", true)
		);
		expect(answer).toMatchObject({
			answer: "found",
			value: { sourceId: "classic", resolutionFactors: [2], frames: ["/skins/legacy/followpoint@2x.png"] }
		});
	});

	test("the floor declines rather than answering empty for an element it lacks", () => {
		// "this set does not have it" is not "this set says there is nothing
		// here" -- a source inserted after it would be entitled to answer
		expect(classicFloorTextureSource().lookup(textureRequest("sliderstartcircle"))).toEqual({ answer: "none" });
	});

	test("a lazer-era skin resolves no texture files at all", () => {
		// Argon's art is procedural and is selected by the piece resolver, so
		// there is nothing between the beatmap and the piece for it to answer
		const argon = skin({}, { era: "lazer", source: "bundled", locator: { kind: "bundled" } });
		expect(textureSources({ beatmap: null, skin: argon, toUrl })).toHaveLength(0);
	});

	test("the checked-in floor manifest matches the vendored directory", () => {
		const onDisk = readdirSync("public/skins/legacy").sort();
		expect([...CLASSIC_FLOOR_FILES].sort()).toEqual(onDisk);
	});

	test("the floor covers every element the inventory names", () => {
		// what the vendoring was FOR: the elements real skins routinely omit
		const floor = classicFloorTextureSource();
		for (const [element, animatable, separator] of [
			["cursor", false],
			["cursormiddle", false],
			["cursortrail", false],
			["hitcircle", false],
			["hitcircleoverlay", true],
			["approachcircle", false],
			["default-0", false],
			["sliderb", true, ""],
			["sliderfollowcircle", true],
			["sliderscorepoint", false],
			["reversearrow", false],
			["followpoint", true],
			["hit0", true],
			["hit50", true],
			["hit100", true],
			["hit300", true],
			["lighting", false],
			["spinner-top", false],
			["spinner-circle", false],
			["spinner-approachcircle", false]
		] as const) {
			expect(floor.lookup(textureRequest(element, animatable, separator ?? "-")).answer).toBe("found");
		}
	});

	test("the floor draws the NEW-style spinner, by asset presence", () => {
		// osulegacyskintransformer.cs:268-270 -- a spinner background selects
		// the old layout and a spinner top without one selects the new. the
		// vendored set ships a top and no background, so the floor is new-style
		const floor = classicFloorTextureSource();
		expect(floor.lookup(textureRequest("spinner-background")).answer).toBe("none");
		expect(floor.lookup(textureRequest("spinner-top")).answer).toBe("found");
	});

	test("the geki and katu textures are deliberately absent", () => {
		// out of scope: neither is drawn per object in this ruleset
		const floor = classicFloorTextureSource();
		for (const element of ["hit300g", "hit100k", "hit300k", "hitcircleselect"]) {
			expect(floor.lookup(textureRequest(element)).answer).toBe("none");
		}
	});
});

describe("frame length", () => {
	const answered = (sourceId: string, frames: number) => ({
		sourceId,
		frames: Array.from({ length: frames }, (_, i) => `f${i}`)
	});

	test("a legacy animation runs at 60fps unless its caller reads the config", () => {
		const manifest = skin({}, { config: { ...skin({}).config, animationFramerate: 30 } });
		expect(frameLength(manifest, answered("skin", 8), false)).toBe(SIXTY_FRAME_TIME);
		expect(frameLength(manifest, answered("skin", 8), true)).toBe(1000 / 30);
	});

	test("with no declared framerate the whole animation plays in one second", () => {
		expect(frameLength(skin({}), answered("skin", 8), true)).toBe(1000 / 8);
		// a non-positive declaration is not a declaration
		const zero = skin({}, { config: { ...skin({}).config, animationFramerate: 0 } });
		expect(frameLength(zero, answered("skin", 4), true)).toBe(1000 / 4);
	});

	test("the rate comes from the source that ANSWERED, not from the selected skin", () => {
		// lazer passes `FindProvider`'s result to getFrameLength. a skin
		// declaring 5fps that ships no slider ball must not slow the classic
		// floor's ten-frame one to half speed -- the floor has no skin.ini and
		// therefore declares no rate
		const manifest = skin({}, { config: { ...skin({}).config, animationFramerate: 5 } });
		expect(frameLength(manifest, answered("skin", 10), true)).toBe(1000 / 5);
		expect(frameLength(manifest, answered("classic", 10), true)).toBe(1000 / 10);
	});
});
