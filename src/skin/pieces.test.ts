import { describe, expect, test } from "bun:test";
import type { SkinManifest } from "@/lib/scene-types";
import type { LookupSource, SourceAnswer } from "@/playback/lookup-chain";
import { skinFiles, testSkin, testToUrl } from "@/test/skin";
import {
	ALL_PIECES_ENABLED,
	JUDGEMENT_RESULTS,
	pieceTextureUrls,
	resolvePieces,
	type PieceContext,
	type PiecePreferences,
	type SkinPieces
} from "./pieces";
import {
	classicFloorTextureSource,
	textureSources,
	type ResolvedTexture,
	type TextureRequest
} from "./texture-sources";

function context(skin: SkinManifest, prefs: Partial<PiecePreferences> = {}): PieceContext {
	return {
		skin,
		sources: textureSources({ beatmap: null, skin, toUrl: testToUrl }),
		prefs: { ...ALL_PIECES_ENABLED, ...prefs }
	};
}

/** a source that records every request it is asked, so "no lookup is made" can
 * be asserted DIRECTLY rather than inferred from nothing being drawn */
function spySource(): LookupSource<TextureRequest, ResolvedTexture> & { asked: TextureRequest[] } {
	const asked: TextureRequest[] = [];
	return {
		id: "spy",
		asked,
		lookup(request): SourceAnswer<ResolvedTexture> {
			asked.push(request);
			return { answer: "none" };
		}
	};
}

const ARGON = testSkin({}, { era: "lazer", locator: { kind: "bundled" }, source: "bundled" });

describe("the era decides what a decline means", () => {
	test("a lazer skin resolves every element to its procedural piece", () => {
		const pieces = resolvePieces(context(ARGON));
		expect(pieces.era).toBe("lazer");
		expect(pieces.hitCircle.circle).toEqual({ kind: "procedural" });
		expect(pieces.cursor.cursor).toEqual({ kind: "procedural" });
		expect(pieces.slider.ball).toEqual({ kind: "procedural" });
		expect(pieces.followPoint).toEqual({ kind: "procedural" });
		expect(pieces.approachCircle).toEqual({ kind: "procedural" });
	});

	test("a legacy skin that ships nothing still draws the classic floor, never argon", () => {
		const pieces = resolvePieces(context(testSkin()));
		for (const spec of [
			pieces.hitCircle.circle,
			pieces.cursor.cursor,
			pieces.slider.ball,
			pieces.slider.followCircle,
			pieces.followPoint,
			pieces.approachCircle
		]) {
			expect(spec.kind).toBe("textured");
		}
		// and it is the floor answering, by name
		expect(pieces.hitCircle.circle).toMatchObject({
			kind: "textured",
			texture: { sourceId: "classic", frames: ["/skins/legacy/hitcircle@2x.png"] }
		});
	});

	test("an element neither the legacy skin nor the floor has is hidden, not argon", () => {
		// nothing in the vendored set is a spinner background: the floor is the
		// NEW-style layout, so the old style's assets genuinely decline
		const pieces = resolvePieces(context(testSkin()));
		expect(pieces.spinner.background).toEqual({ kind: "hidden" });
		expect(pieces.spinner.metre).toEqual({ kind: "hidden" });
	});
});

describe("an empty answer ends the chain", () => {
	test("a blank asset keeps the element hidden instead of falling to the floor", () => {
		const skin = testSkin(skinFiles("hitcircle.png"), { blank: ["hitcircle.png"] });
		expect(resolvePieces(context(skin)).hitCircle.circle).toEqual({ kind: "hidden" });
	});

	test("a blank asset in the lazer era hides rather than reverting to argon", () => {
		// the beatmap is the one texture source a lazer-era skin has above it
		const beatmap = {
			id: "beatmap",
			lookup: (): SourceAnswer<ResolvedTexture> => ({ answer: "empty" })
		};
		const pieces = resolvePieces({
			skin: ARGON,
			sources: [beatmap],
			prefs: ALL_PIECES_ENABLED
		});
		expect(pieces.hitCircle.circle).toEqual({ kind: "hidden" });
	});
});

describe("a preference set to off means no lookup is made", () => {
	test("follow points off asks the chain nothing at all", () => {
		const spy = spySource();
		const pieces = resolvePieces({
			skin: testSkin(),
			sources: [spy],
			prefs: { ...ALL_PIECES_ENABLED, followPoints: false }
		});
		expect(pieces.followPoint).toEqual({ kind: "hidden" });
		expect(spy.asked.map((request) => request.names[0])).not.toContain("followpoint");
	});

	test("follow points on DOES ask, so the assertion above is about the gate", () => {
		const spy = spySource();
		resolvePieces({ skin: testSkin(), sources: [spy], prefs: ALL_PIECES_ENABLED });
		expect(spy.asked.map((request) => request.names[0])).toContain("followpoint");
	});

	test("the cursor trail off leaves the cursor itself alone", () => {
		const spy = spySource();
		const pieces = resolvePieces({
			skin: testSkin(),
			sources: [spy],
			prefs: { ...ALL_PIECES_ENABLED, cursorTrail: false }
		});
		expect(pieces.cursor.trail).toEqual({ kind: "hidden" });
		const names = spy.asked.map((request) => request.names[0]);
		expect(names).not.toContain("cursortrail");
		expect(names).toContain("cursor");
	});

	test("hit effects off silences every judgement and the lighting", () => {
		const spy = spySource();
		const pieces = resolvePieces({
			skin: testSkin(),
			sources: [spy],
			prefs: { ...ALL_PIECES_ENABLED, hitEffects: false }
		});
		for (const result of JUDGEMENT_RESULTS) expect(pieces.judgements[result]).toEqual({ kind: "hidden" });
		expect(pieces.hitLighting).toEqual({ kind: "hidden" });
		const names = spy.asked.map((request) => request.names[0]);
		expect(names).not.toContain("hit300");
		expect(names).not.toContain("lighting");
	});
});

describe("the show-300s preference gates the great alone", () => {
	test("off hides the great whatever the skin would answer", () => {
		const spy = spySource();
		const pieces = resolvePieces({
			skin: testSkin(skinFiles("hit300.png")),
			sources: [spy],
			prefs: { ...ALL_PIECES_ENABLED, show300Judgements: false }
		});
		expect(pieces.judgements.great).toEqual({ kind: "hidden" });
		expect(spy.asked.map((request) => request.names[0])).not.toContain("hit300");
	});

	test("the other three grades are unaffected by it", () => {
		const pieces = resolvePieces(context(testSkin(), { show300Judgements: false }));
		expect(pieces.judgements.miss.kind).toBe("textured");
		expect(pieces.judgements.meh.kind).toBe("textured");
		expect(pieces.judgements.ok.kind).toBe("textured");
	});

	test("on, the skin's own great texture answers", () => {
		const pieces = resolvePieces(context(testSkin(skinFiles("hit300.png"))));
		expect(pieces.judgements.great).toMatchObject({
			kind: "textured",
			texture: { sourceId: "skin", frames: ["asset://C:\\skin\\hit300.png"] }
		});
	});
});

describe("the hit circle family", () => {
	test("the slider head prefers its own start circle when the skin ships one", () => {
		const skin = testSkin(skinFiles("hitcircle.png", "sliderstartcircle.png", "sliderstartcircleoverlay.png"));
		const pieces = resolvePieces(context(skin));
		expect(pieces.slider.head.circle).toMatchObject({ texture: { name: "sliderstartcircle" } });
		expect(pieces.slider.head.overlay).toMatchObject({ texture: { name: "sliderstartcircleoverlay" } });
	});

	test("a skin without the dedicated ends falls back to its own hit circle, not the floor", () => {
		const skin = testSkin(skinFiles("hitcircle.png", "hitcircleoverlay.png"));
		const pieces = resolvePieces(context(skin));
		expect(pieces.slider.head.circle).toMatchObject({ texture: { sourceId: "skin", name: "hitcircle" } });
		expect(pieces.slider.tail.circle).toMatchObject({ texture: { sourceId: "skin", name: "hitcircle" } });
	});

	test("the prefix precondition is asked of the source that provided the base circle", () => {
		// the beatmap provides `hitcircle`, the user skin provides
		// `sliderstartcircle`. lazer draws slider heads with the BEATMAP's hit
		// circle in that case, because the prefix is only honoured when the
		// provider of the base name has it
		const beatmap: LookupSource<TextureRequest, ResolvedTexture> = {
			id: "beatmap",
			lookup(request) {
				if (request.names[0] !== "hitcircle") return { answer: "none" };
				return {
					answer: "found",
					value: {
						sourceId: "beatmap",
						name: "hitcircle",
						frames: ["asset://map/hitcircle.png"],
						resolutionFactors: [1],
						animated: false
					}
				};
			}
		};
		const skin = testSkin(skinFiles("sliderstartcircle.png"));
		const pieces = resolvePieces({
			skin,
			sources: [beatmap, ...textureSources({ beatmap: null, skin, toUrl: testToUrl })],
			prefs: ALL_PIECES_ENABLED
		});
		expect(pieces.slider.head.circle).toMatchObject({ texture: { sourceId: "beatmap", name: "hitcircle" } });
	});

	test("the tail carries no combo number and the head does", () => {
		const pieces = resolvePieces(context(testSkin()));
		expect(pieces.hitCircle.digits.every((digit) => digit.kind === "textured")).toBe(true);
		expect(pieces.slider.head.digits.every((digit) => digit.kind === "textured")).toBe(true);
		expect(pieces.slider.tail.digits.every((digit) => digit.kind === "hidden")).toBe(true);
	});

	test("the hit circle prefix and overlap keys are honoured", () => {
		const skin = testSkin(skinFiles("mine-0.png"), {
			config: { hitCirclePrefix: "mine", hitCircleOverlap: 7 } as SkinManifest["config"]
		});
		const pieces = resolvePieces(context(skin));
		expect(pieces.hitCircle.digits[0]).toMatchObject({ texture: { sourceId: "skin", name: "mine-0" } });
		expect(pieces.hitCircle.digitOverlap).toBe(7);
	});

	test("an undeclared overlap is stable's own -2", () => {
		expect(resolvePieces(context(testSkin())).hitCircle.digitOverlap).toBe(-2);
	});

	test("the overlay is a sprite even when the skin ships frames, as lazer builds it", () => {
		const skin = testSkin(skinFiles("hitcircle.png", "hitcircleoverlay-0.png", "hitcircleoverlay-1.png"));
		// no `hitcircleoverlay.png`, only frames -- lazer's plain Sprite lookup
		// finds nothing, so the chain falls through to the floor's own overlay
		expect(resolvePieces(context(skin)).hitCircle.overlay).toMatchObject({
			texture: { sourceId: "classic", animated: false }
		});
	});
});

describe("the cursor's configuration keys", () => {
	test("all four default to true when the skin declares none", () => {
		const cursor = resolvePieces(context(testSkin())).cursor;
		expect(cursor.centre).toBe(true);
		expect(cursor.expand).toBe(true);
		expect(cursor.rotate).toBe(true);
		expect(cursor.trailRotate).toBe(true);
	});

	test("a declared false is honoured and is distinct from undeclared", () => {
		// the skin ships the cursor, so it is the PROVIDER its own keys apply to
		const skin = testSkin(skinFiles("cursor.png", "cursortrail.png"), {
			config: { cursorCentre: false, cursorExpand: false, cursorRotate: false } as SkinManifest["config"]
		});
		const cursor = resolvePieces(context(skin)).cursor;
		expect(cursor.centre).toBe(false);
		expect(cursor.expand).toBe(false);
		expect(cursor.rotate).toBe(false);
		expect(cursor.trailRotate).toBe(true);
	});

	test("a key is the provider's, so a declared false cannot stop a floor cursor", () => {
		// legacycursor.cs:34-35 -- the options are read off the skin that
		// supplied the texture. this skin ships no cursor, so the floor
		// provides one, and the floor declares nothing
		const skin = testSkin(
			{},
			{
				config: { cursorCentre: false, cursorExpand: false, cursorRotate: false } as SkinManifest["config"]
			}
		);
		const cursor = resolvePieces(context(skin)).cursor;
		expect(cursor.centre).toBe(true);
		expect(cursor.expand).toBe(true);
		expect(cursor.rotate).toBe(true);
	});

	test("a cursor without a middle gets the disjoint trail", () => {
		const skin = testSkin(skinFiles("cursor.png"));
		// the floor HAS a cursormiddle, so a chain-wide test would answer wrongly
		expect(resolvePieces(context(skin)).cursor.disjointTrail).toBe(true);
	});

	test("a cursor whose own provider has a middle does not", () => {
		const skin = testSkin(skinFiles("cursor.png", "cursormiddle.png"));
		expect(resolvePieces(context(skin)).cursor.disjointTrail).toBe(false);
	});

	test("the floor's own cursor is not disjoint", () => {
		expect(resolvePieces(context(testSkin())).cursor.disjointTrail).toBe(false);
	});
});

describe("the slider's own pieces", () => {
	test("the ball's frames run with no separator", () => {
		const skin = testSkin(skinFiles("sliderb0.png", "sliderb1.png", "sliderb2.png"));
		expect(resolvePieces(context(skin)).slider.ball).toMatchObject({
			kind: "textured",
			loop: true,
			texture: { animated: true, frames: [expect.any(String), expect.any(String), expect.any(String)] }
		});
	});

	test("the ball tint permission defaults to refused for the skin's own ball", () => {
		// the permission is the PROVIDER's (legacysliderball.cs:36-47), so the
		// skin must actually supply the ball for its silence to mean white
		expect(resolvePieces(context(testSkin(skinFiles("sliderb0.png")))).slider.allowBallTint).toBe(false);
		const opted = testSkin(skinFiles("sliderb0.png"), {
			config: { allowSliderBallTint: true } as SkinManifest["config"]
		});
		expect(resolvePieces(context(opted)).slider.allowBallTint).toBe(true);
	});

	test("a floor-provided ball is the classic blue and takes the combo tint", () => {
		// defaultlegacyskin.cs:45-48 -- lazer's DefaultLegacySkin declares
		// exactly these two things, and the selected skin's silence must not
		// override the provider's declarations
		const slider = resolvePieces(context(testSkin())).slider;
		expect(slider.allowBallTint).toBe(true);
		expect(slider.ballTint).toEqual([2, 170, 255, 255]);
	});

	test("a declared SliderBall colour is the skin's own ball's base", () => {
		// legacysliderball.cs:47 -- the base colour the accent replaces only on
		// the opt-in
		const skin = testSkin(skinFiles("sliderb0.png"), {
			config: { sliderBall: [10, 20, 30, 255] } as SkinManifest["config"]
		});
		expect(resolvePieces(context(skin)).slider.ballTint).toEqual([10, 20, 30, 255]);
	});

	test("the score point falls through to the classic floor when the skin ships none", () => {
		expect(resolvePieces(context(testSkin())).slider.scorePoint).toMatchObject({
			texture: { sourceId: "classic", name: "sliderscorepoint" }
		});
	});

	test("the reverse arrow swings only on a version 1 skin", () => {
		expect(resolvePieces(context(testSkin())).slider.reverseRotates).toBe(false);
		const old = testSkin({}, { config: { version: 1 } as SkinManifest["config"] });
		expect(resolvePieces(context(old)).slider.reverseRotates).toBe(true);
	});

	test("the body is procedural in both eras and carries the declared colours", () => {
		expect(resolvePieces(context(ARGON)).body).toEqual({ era: "lazer", border: null, trackOverride: null });
		const coloured = testSkin(
			{},
			{
				config: { sliderBorder: [1, 2, 3, 255], sliderTrackOverride: [4, 5, 6, 255] } as SkinManifest["config"]
			}
		);
		expect(resolvePieces(context(coloured)).body).toEqual({
			era: "legacy",
			border: [1, 2, 3, 255],
			trackOverride: [4, 5, 6, 255]
		});
	});
});

describe("the spinner layout is chosen by asset presence", () => {
	test("a spinner top without a background is the new style", () => {
		const skin = testSkin(skinFiles("spinner-top.png"));
		expect(resolvePieces(context(skin)).spinner.layout).toBe("new");
	});

	test("a background wins even when a top is present", () => {
		const skin = testSkin(skinFiles("spinner-top.png", "spinner-background.png"));
		expect(resolvePieces(context(skin)).spinner.layout).toBe("old");
	});

	test("a background alone is the old style", () => {
		// the floor ships a spinner-top, so this proves the fork is not reading
		// the chain's answer for `spinner-top` from the floor
		const skin = testSkin(skinFiles("spinner-background.png"));
		expect(resolvePieces(context(skin)).spinner.layout).toBe("old");
	});

	test("the vendored floor is the new style, and the version field is not consulted", () => {
		const v1 = testSkin({}, { config: { version: 1 } as SkinManifest["config"] });
		expect(resolvePieces(context(v1)).spinner.layout).toBe("new");
	});

	test("the bundled argon default has no legacy layout at all", () => {
		// a decline resolves procedural in the lazer era, and a procedural
		// answer must not read as asset presence: treating it as one built the
		// whole old-style sprite stack out of nothing and drew an invisible
		// spinner for the default skin
		expect(resolvePieces(context(ARGON)).spinner.layout).toBe("none");
	});

	test("a skin shipping neither layout's assets falls to the floor, which has one", () => {
		// nothing below the floor, and the floor answers -- so `none` is only
		// reachable by a source list with no floor in it at all
		const pieces = resolvePieces({ skin: testSkin(), sources: [], prefs: ALL_PIECES_ENABLED });
		expect(pieces.spinner.layout).toBe("none");
	});

	test("the spinner background colour is the layout provider's", () => {
		// legacyoldstylespinner.cs:44 -- read off the skin providing the
		// spinner; a floor-provided layout declares none, leaving the
		// drawable's flat grey
		const declared = testSkin(skinFiles("spinner-background.png"), {
			config: { spinnerBackground: [1, 2, 3, 255] } as SkinManifest["config"]
		});
		expect(resolvePieces(context(declared)).spinner.backgroundTint).toEqual([1, 2, 3, 255]);
		const floored = testSkin({}, { config: { spinnerBackground: [1, 2, 3, 255] } as SkinManifest["config"] });
		expect(resolvePieces(context(floored)).spinner.backgroundTint).toBeNull();
	});

	test("the blink flag reads SpinnerNoBlink inverted", () => {
		expect(resolvePieces(context(testSkin())).spinner.blink).toBe(true);
		const noBlink = testSkin({}, { config: { spinnerNoBlink: true } as SkinManifest["config"] });
		expect(resolvePieces(context(noBlink)).spinner.blink).toBe(false);
	});
});

describe("the preload list", () => {
	function urlsOf(pieces: SkinPieces): string[] {
		return pieceTextureUrls(pieces);
	}

	test("a lazer skin needs nothing loaded", () => {
		expect(urlsOf(resolvePieces(context(ARGON)))).toEqual([]);
	});

	test("every frame of an animation is listed, once", () => {
		const skin = testSkin(skinFiles("sliderb0.png", "sliderb1.png", "sliderb1.png"));
		const urls = urlsOf(resolvePieces(context(skin)));
		expect(urls.filter((url) => url.includes("sliderb0")).length).toBe(1);
		expect(new Set(urls).size).toBe(urls.length);
	});

	test("a hidden element contributes nothing to load", () => {
		const off = urlsOf(resolvePieces(context(testSkin(), { followPoints: false })));
		const on = urlsOf(resolvePieces(context(testSkin())));
		expect(on.length).toBe(off.length + 1);
		expect(off).not.toContain("/skins/legacy/followpoint@2x.png");
	});

	test("the whole floor's inventory resolves to loadable urls", () => {
		const urls = urlsOf(resolvePieces(context(testSkin())));
		expect(urls.length).toBeGreaterThan(20);
		for (const url of urls) expect(url.startsWith("/skins/legacy/")).toBe(true);
	});
});

describe("the floor source is the one that answers below a skin", () => {
	test("it declines rather than answering empty for what it does not ship", () => {
		expect(
			classicFloorTextureSource().lookup({ names: ["nothing"], animatable: false, animationSeparator: "-" })
		).toEqual({
			answer: "none"
		});
	});
});

describe("the judgement piece's three-valued answer, generalised", () => {
	test("argon answers empty for a great and a piece for the rest", () => {
		const pieces = resolvePieces(context(ARGON));
		expect(pieces.judgements.great).toEqual({ kind: "hidden" });
		expect(pieces.judgements.miss).toEqual({ kind: "procedural", style: "text" });
		expect(pieces.judgements.meh).toEqual({ kind: "procedural", style: "text" });
		expect(pieces.judgements.largeTickMiss).toEqual({ kind: "procedural", style: "tickMiss" });
		expect(pieces.judgements.largeTickHit).toEqual({ kind: "hidden" });
	});

	test("a great under argon stays hidden even with the preference on", () => {
		// the preference decides whether the app ASKS; argon's own answer is
		// still empty, so turning it on cannot conjure a piece argon does not have
		expect(resolvePieces(context(ARGON, { show300Judgements: true })).judgements.great).toEqual({
			kind: "hidden"
		});
	});

	test("a blank judgement texture is not resurrected by argon's own answer", () => {
		// the case the empty-versus-declined distinction exists for: a beatmap
		// shipping a 1x1 `hit100.png` under an argon skin must draw nothing, not
		// argon's text popup
		const beatmap: LookupSource<TextureRequest, ResolvedTexture> = {
			id: "beatmap",
			lookup: (request) => (request.names[0] === "hit100" ? { answer: "empty" } : { answer: "none" })
		};
		const pieces = resolvePieces({ skin: ARGON, sources: [beatmap], prefs: ALL_PIECES_ENABLED });
		expect(pieces.judgements.ok).toEqual({ kind: "hidden" });
		// while a result the beatmap said nothing about still gets argon's
		expect(pieces.judgements.meh).toEqual({ kind: "procedural", style: "text" });
	});

	test("hit lighting is empty under argon and textured under a legacy skin", () => {
		expect(resolvePieces(context(ARGON)).hitLighting).toEqual({ kind: "hidden" });
		expect(resolvePieces(context(testSkin())).hitLighting).toMatchObject({
			kind: "textured",
			texture: { sourceId: "classic", name: "lighting" }
		});
	});

	test("argon draws no slider tail piece, and a legacy skin does", () => {
		expect(resolvePieces(context(ARGON)).slider.tail.circle).toEqual({ kind: "hidden" });
		expect(resolvePieces(context(testSkin())).slider.tail.circle.kind).toBe("textured");
	});
});
