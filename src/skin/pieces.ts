// piece selection: what the active skin draws for each element the playfield
// has, as a pure function returning a spec.
//
// this is the one new seam this work adds, and it is a WIDENING of one that
// already existed rather than a new idea. the judgement piece already answered
// three-valued -- draw this, draw nothing, or let the next source answer -- and
// that answer is generalised here to cover every element, so that "what does
// this skin draw for a slider ball" is decidable without a canvas.
//
// two rules hold everywhere in this module and both are load-bearing:
//
// - **a preference set to off means NO LOOKUP IS MADE.** preferences decide
//   whether; the skin decides what. the skin is never asked whether the user
//   wants to see something, so a disabled element never reaches the chain and
//   the empty-versus-declined distinction never enters into it.
// - **an empty answer ends the chain.** a skin's blank asset is the standard
//   way a skinner REMOVES an element, and a fallthrough written on autopilot
//   resurrects exactly what the user chose their skin to remove.
//
// what a spec never carries is timing. an object's lifetime, its appear and
// vanish windows and its precomputed animation timelines are shared across
// eras and stay in the `*-tracks.ts` modules; only the piece inside the
// drawable swaps (lazer's own boundary -- `SkinnableDrawable` replaces the
// piece, never the `DrawableHitObject` around it)

import type { SkinManifest } from "@/lib/scene-types";
import { CLASSIC_SLIDER_BALL, DEFAULT_HIT_CIRCLE_OVERLAP } from "./legacy/constants";
import { findProvider, type SourceAnswer } from "@/playback/lookup-chain";
import {
	frameLength,
	resolveTexture,
	textureRequest,
	type ResolvedTexture,
	type TextureRequest,
	type TextureSource
} from "./texture-sources";

/**
 * what a drawable should build for one element.
 *
 * - `textured` -- composite these frames.
 * - `procedural` -- draw the era's own procedural piece. only ever answered in
 *   the lazer era, where Argon's art is code rather than files.
 * - `hidden` -- draw nothing. either the source answered EMPTY (the skin
 *   removed the element) or a preference is off (the user did).
 *
 * `hidden` deliberately does not record which of the two it was: a consumer
 * that branched on it would be re-deciding something already decided here
 */
export type PieceSpec =
	| { kind: "textured"; texture: ResolvedTexture; frameLength: number; loop: boolean }
	| { kind: "procedural" }
	| { kind: "hidden" };

/**
 * a judgement popup's spec.
 *
 * the one element whose procedural answer needs a discriminator, because argon
 * draws two different popups -- the grade text and the tick-miss dot -- and
 * which of them a result gets is the skin's decision, not the drawable's
 */
export type JudgementPieceSpec =
	| { kind: "textured"; texture: ResolvedTexture; frameLength: number; loop: boolean }
	| { kind: "procedural"; style: "text" | "tickMiss" }
	| { kind: "hidden" };

export const HIDDEN = { kind: "hidden" } as const satisfies PieceSpec;
/** the ten glyph slots of a circle that carries no number at all */
const DIGITS_HIDDEN: readonly PieceSpec[] = Array.from({ length: 10 }, () => HIDDEN);
export const PROCEDURAL = { kind: "procedural" } as const satisfies PieceSpec;

/** how one element is looked up, beyond its name: lazer's own `GetAnimation`
 * arguments, kept together so each element declares them once */
interface ElementRules {
	animatable: boolean;
	/**
	 * what the LAZER era answers when nothing in the chain does.
	 *
	 * `procedural` for almost everything -- argon's art is code rather than
	 * files, so it is selected here rather than resolved off disk. `hidden` for
	 * the handful argon deliberately answers EMPTY for, which is the existing
	 * three-valued judgement answer generalised rather than duplicated: the
	 * slider tail (drawableslidertail.cs -- argon supplies no circle piece), hit
	 * lighting (argonskin.cs:93-94 -- `Drawable.Empty()`), and the great and
	 * large-tick-hit judgements (osuargonskintransformer.cs:26-34)
	 */
	lazerDefault?: "procedural" | "hidden";
	/** what sits between the name and a frame index; `-` everywhere except the
	 * slider ball, whose frames are `sliderb0`.. (legacysliderball.cs:48) */
	separator?: string;
	looping?: boolean;
	/** whether the skin's `AnimationFramerate` reaches this element at all
	 * (legacyskinextensions.cs:228-240 -- the CALLER decides, not the skin) */
	applyConfigFrameRate?: boolean;
}

/**
 * the preferences that decide WHETHER an element is drawn.
 *
 * every one of these already existed as an effect toggle except the last. they
 * are read here rather than at the draw site so that the no-lookup rule is a
 * property of resolution, which is where it is testable
 */
export interface PiecePreferences {
	followPoints: boolean;
	cursorTrail: boolean;
	/** gates the judgement popups AND hit lighting, as it already did */
	hitEffects: boolean;
	/**
	 * whether a great draws a judgement popup at all.
	 *
	 * greats drew nothing before any skin existed, implemented honestly as the
	 * skin answering empty -- precisely so a skin that draws greats gets them
	 * back with no code change. a legacy skin ships `hit300` and WILL answer
	 * found, so under the authority rule alone picking any legacy skin
	 * reintroduces a popup on every 300, which is the thing that hides the 100s
	 * and 50s the replay was opened to find. the analysis-motivated choice is
	 * therefore an explicit preference rather than an artifact of which skin is
	 * loaded; the skin still owns what a 300 LOOKS like when it is shown
	 */
	show300Judgements: boolean;
}

export const ALL_PIECES_ENABLED: PiecePreferences = {
	followPoints: true,
	cursorTrail: true,
	hitEffects: true,
	show300Judgements: true
};

export interface PieceContext {
	skin: SkinManifest;
	/** the ordered source list from `textureSources` -- beatmap, user skin, the
	 * era's floor. never re-ordered here: the list IS the precedence */
	sources: readonly TextureSource[];
	prefs: PiecePreferences;
}

/**
 * every result a judgement popup can be asked about.
 *
 * the skin is asked about a RESULT, never about this app's own event kinds,
 * exactly as `SkinComponentLookup<HitResult>` is (hitresult.cs) -- the same set
 * `judgement-tracks.ts` already named, moved here now that one resolver answers
 * for every era
 */
export const JUDGEMENT_RESULTS = ["miss", "meh", "ok", "great", "largeTickHit", "largeTickMiss"] as const;
export type JudgedResult = (typeof JUDGEMENT_RESULTS)[number];

/** legacyskin.cs:517-535 -- one texture name per result. the two large-tick
 * rows are `null` rather than a name because stable's slider-tick score popups
 * are out of scope: `getJudgementAnimation` returns null for LargeTickHit, and
 * `slidertickmiss` is the only miss texture in the ruleset this app draws */
const JUDGEMENT_TEXTURES: Record<JudgedResult, string | null> = {
	miss: "hit0",
	meh: "hit50",
	ok: "hit100",
	great: "hit300",
	largeTickHit: null,
	largeTickMiss: "slidertickmiss"
};

/**
 * osuargonskintransformer.cs:23-42 on the `isPro` branch -- what ARGON answers
 * for each result, which is the lazer era's own default.
 *
 * :26-28 answers `Drawable.Empty()` for Great, which is why a 300 draws no
 * popup under argon. the popup is missing because THE SKIN ANSWERED EMPTY, not
 * because the app decided a 300 is noisy -- a skin that draws greats gets them
 * back with no code change here, which is exactly what a legacy skin's `hit300`
 * plus the show-300s preference now does
 */
const ARGON_JUDGEMENT_STYLE: Record<JudgedResult, "text" | "tickMiss" | null> = {
	// :40-41
	miss: "text",
	meh: "text",
	ok: "text",
	// :26-28 -- Drawable.Empty()
	great: null,
	// :32-34 -- large tick hits and slider tail hits get no piece at all
	largeTickHit: null,
	// :36-38
	largeTickMiss: "tickMiss"
};

export interface CursorPieces {
	/** legacycursor.cs:41 -- the sprite that expands and spins */
	cursor: PieceSpec;
	/** legacycursor.cs:47 -- drawn over it and never spun */
	middle: PieceSpec;
	trail: PieceSpec;
	/** osuskinconfiguration.cs:9 -- CursorCentre, default true. false origins
	 * the sprite at its top-left instead of its centre */
	centre: boolean;
	/** osuskinconfiguration.cs:10 -- CursorExpand, default true
	 * (osucursor.cs:118). false suppresses the press expansion entirely */
	expand: boolean;
	/** osuskinconfiguration.cs:11 -- CursorRotate, default true
	 * (legacycursor.cs:35). false stops the slow revolution */
	rotate: boolean;
	/** osuskinconfiguration.cs:12 -- CursorTrailRotate, default true
	 * (legacycursortrail.cs:37) */
	trailRotate: boolean;
	/**
	 * legacycursortrail.cs:44-45 -- whether the trail is spawned by TIME rather
	 * than by distance travelled.
	 *
	 * stable picks this off the source that provided `cursor`, not off the
	 * selected skin, so the test is asked of that provider alone: a skin with a
	 * cursor but no cursor middle gets the disjoint trail even when a later
	 * source in the chain has a `cursormiddle` of its own
	 */
	disjointTrail: boolean;
}

export interface HitCirclePieces {
	/** the circle, combo-tinted */
	circle: PieceSpec;
	/** drawn over it and NOT tinted (legacymaincirclepiece.cs:100-105) */
	overlay: PieceSpec;
	/** whether the overlay draws above the combo number
	 * (osuskinconfiguration.cs:13, default true) */
	overlayAboveNumber: boolean;
	/** the ten digit glyphs, indexed 0-9; `hidden` where the skin ships none */
	digits: readonly PieceSpec[];
	/** legacyskinextensions.cs:180 -- osu!px of overlap between two glyphs,
	 * negative meaning a gap */
	digitOverlap: number;
}

export interface SpinnerPieces {
	/**
	 * which of the two legacy layouts this skin's ASSETS call for.
	 *
	 * osulegacyskintransformer.cs:268-274: the old-style spinner when a spinner
	 * background exists, the new-style one when a spinner top exists without
	 * it. this is ASSET PRESENCE and is NOT the `[General] Version` field --
	 * the two mechanisms coexist in this work and conflating them would pick
	 * the wrong layout for every skin that declares one and ships the other
	 */
	layout: "old" | "new" | "none";
	/** `[Colours] SpinnerBackground` from the layout's provider, or null for
	 * the drawable's flat grey (legacyoldstylespinner.cs:44) */
	backgroundTint: [number, number, number, number] | null;
	background: PieceSpec;
	circle: PieceSpec;
	metre: PieceSpec;
	glow: PieceSpec;
	bottom: PieceSpec;
	top: PieceSpec;
	middle: PieceSpec;
	middle2: PieceSpec;
	approachCircle: PieceSpec;
	spin: PieceSpec;
	clear: PieceSpec;
	/** osuskinconfiguration.cs:18 -- SpinnerNoBlink; the metre blinks unless the
	 * skin switched it off (legacyoldstylespinner.cs:35) */
	blink: boolean;
}

export interface SliderPieces {
	/** legacymaincirclepiece.cs via LegacySliderHeadHitCircle -- the head's own
	 * circle assets, already resolved through the `sliderstartcircle` prefix */
	head: HitCirclePieces;
	/** osulegacyskintransformer.cs:187 -- the tail, drawn WITHOUT a number */
	tail: HitCirclePieces;
	ball: PieceSpec;
	/** legacysliderball.cs:56 -- the un-rotated dark underlay */
	ballNd: PieceSpec;
	/** legacysliderball.cs:69 -- the un-rotated additive specular highlight */
	ballSpec: PieceSpec;
	followCircle: PieceSpec;
	scorePoint: PieceSpec;
	reverseArrow: PieceSpec;
	/**
	 * legacysliderball.cs:91 -- whether the combo accent may tint the ball at
	 * all, read from the ball's own provider
	 */
	allowBallTint: boolean;
	/** `[Colours] SliderBall` from the ball's provider -- the BASE colour the
	 * accent replaces only on the opt-in (legacysliderball.cs:47), null for
	 * white */
	ballTint: [number, number, number, number] | null;
	/** legacyreversearrow.cs:56 -- version <= 1 skins swing the arrow as well as
	 * pulsing it */
	reverseRotates: boolean;
}

export interface SkinPieces {
	era: SkinManifest["era"];
	cursor: CursorPieces;
	hitCircle: HitCirclePieces;
	approachCircle: PieceSpec;
	slider: SliderPieces;
	spinner: SpinnerPieces;
	followPoint: PieceSpec;
	/** one spec per result; a great is `hidden` unless the user asked for it */
	judgements: Record<JudgedResult, JudgementPieceSpec>;
	hitLighting: PieceSpec;
	/** legacyskinextensions.cs:52 (case 1) -- true when the body should draw
	 * through the legacy colour ramp rather than argon's. a body is procedural
	 * in BOTH eras, so it is the only element whose spec is not a texture */
	body: SliderBodySpec;
}

/**
 * the slider body, which is the one element in the inventory that is not a
 * texture: it stays procedural in both eras and goes on drawing through the
 * existing path-lookup-table and shader route. what the era decides is the
 * colour ramp and the ribbon's width, not who rasterises it
 */
export interface SliderBodySpec {
	/**
	 * which ramp the body draws through.
	 *
	 * derived from whether the HIT CIRCLE resolved to a texture rather than
	 * from the selected skin's era, and that is lazer's own rule:
	 * `osulegacyskintransformer.cs:179-183` gates `SliderBody` on
	 * `hasHitCircle`, so a beatmap that ships its own circles over an argon
	 * skin gets a legacy body to go with them. reading the era directly would
	 * put an argon ribbon under legacy circles, which is precisely the mixed
	 * look the floor rule exists to prevent
	 */
	era: SkinManifest["era"];
	/** legacysliderbody.cs:19 -- the declared border colour, or null for the
	 * era's own default */
	border: [number, number, number, number] | null;
	/** legacysliderbody.cs:23 -- SliderTrackOverride, which REPLACES the combo
	 * accent for the track (and only the track) when the skin declares one */
	trackOverride: [number, number, number, number] | null;
}

function answerToSpec(
	answer: SourceAnswer<ResolvedTexture>,
	skin: SkinManifest,
	rules: ElementRules,
	era: SkinManifest["era"]
): PieceSpec {
	if (answer.answer === "empty") return HIDDEN;
	if (answer.answer === "none") {
		// the legacy era has already been past its own floor by this point, so a
		// decline there is genuinely nothing -- and never argon, since eras must
		// not mix on screen. the lazer era falls to whatever argon answers for
		// this element, which is usually its procedural piece and sometimes empty
		return era === "lazer" ? ((rules.lazerDefault ?? "procedural") === "hidden" ? HIDDEN : PROCEDURAL) : HIDDEN;
	}
	return {
		kind: "textured",
		texture: answer.value,
		frameLength: frameLength(skin, answer.value, rules.applyConfigFrameRate ?? false),
		loop: rules.looping ?? false
	};
}

function resolveElement(ctx: PieceContext, names: readonly string[], rules: ElementRules): PieceSpec {
	const request: TextureRequest = {
		names,
		animatable: rules.animatable,
		animationSeparator: rules.separator ?? "-"
	};
	return answerToSpec(resolveTexture(ctx.sources, request), ctx.skin, rules, ctx.skin.era);
}

/** the sprite case, which is most of the inventory */
function sprite(ctx: PieceContext, name: string): PieceSpec {
	return resolveElement(ctx, [name], { animatable: false });
}

/**
 * the selected skin's configuration, answered only when the PROVIDER is that
 * skin.
 *
 * lazer's legacy pieces read their options from the skin that supplied their
 * texture -- each is constructed with its own transformer's skin -- so an
 * option the SELECTED skin declares must not reach a piece the beatmap or the
 * classic floor provided. neither of those carries a `skin.ini` here, so their
 * answer is "declared nothing"; the floor's two hardcoded declarations
 * (defaultlegacyskin.cs:45-48) are applied by the one caller they concern
 */
function providerConfig(ctx: PieceContext, provider: { id: string } | null): SkinManifest["config"] | null {
	return provider !== null && provider.id === "skin" ? ctx.skin.config : null;
}

/**
 * the hit circle family, resolved against ONE prefix.
 *
 * legacymaincirclepiece.cs:68-88 is the whole subtlety and it is worth stating
 * plainly: the prefix precondition is asked of whichever source provides the
 * base `hitcircle`, so a beatmap that ships `hitcircle` and a user skin that
 * ships `sliderstartcircle` draws slider heads with the BEATMAP's hit circle
 * rather than the user's override. once the name is decided the final lookups
 * run the whole chain as usual, which is what keeps the ordinary fallback cases
 * working.
 *
 * the second half of that comment is the reason the overlay is looked up under
 * the SAME chosen name: a skin shipping `sliderendcircle.png` without a
 * `sliderendcircleoverlay.png` should show no overlay, not the hit circle's
 */
function hitCircleFamily(
	ctx: PieceContext,
	priorityPrefix: string | null,
	withNumber: boolean,
	lazerDefault: "procedural" | "hidden" = "procedural"
): HitCirclePieces {
	const base = "hitcircle";
	const provider = findProvider(ctx.sources, textureRequest(base));
	const prefixAnswered =
		priorityPrefix !== null &&
		provider !== null &&
		provider.lookup(textureRequest(priorityPrefix)).answer !== "none";
	const circleName = prefixAnswered ? priorityPrefix : base;

	return {
		circle: resolveElement(ctx, [circleName], { animatable: false, lazerDefault }),
		// NOT animated, deliberately. lazer builds this as a plain `Sprite`
		// (legacymaincirclepiece.cs:100-105) with no GetAnimation call anywhere
		// on the path, so a skin shipping `hitcircleoverlay-0.png` draws a static
		// sprite there and must draw one here. animating it would be inventing
		// behaviour rather than porting it
		overlay: resolveElement(ctx, [`${circleName}overlay`], { animatable: false, lazerDefault }),
		overlayAboveNumber: ctx.skin.config.hitCircleOverlayAboveNumber ?? true,
		digits: withNumber ? comboDigits(ctx) : DIGITS_HIDDEN,
		digitOverlap: ctx.skin.config.hitCircleOverlap ?? DEFAULT_HIT_CIRCLE_OVERLAP
	};
}

/** legacyskinextensions.cs:140-155 -- `default` unless the skin renamed the hit
 * circle font, and each glyph is `<prefix>-<digit>` */
function comboDigits(ctx: PieceContext): PieceSpec[] {
	const prefix = ctx.skin.config.hitCirclePrefix ?? "default";
	return Array.from({ length: 10 }, (_, digit) => sprite(ctx, `${prefix}-${digit}`));
}

function cursorPieces(ctx: PieceContext): CursorPieces {
	// legacycursortrail.cs:44-45 -- the disjoint test is asked of the source that
	// provided `cursor`, never of the whole chain
	const cursorProvider = findProvider(ctx.sources, textureRequest("cursor"));
	const disjointTrail =
		cursorProvider === null || cursorProvider.lookup(textureRequest("cursormiddle")).answer === "none";
	// each option belongs to its element's PROVIDER: the cursor's own keys to
	// whichever source supplied `cursor` (legacycursor.cs:34-35), the trail key
	// to the `cursortrail` provider (legacycursortrail.cs:36) -- so a selected
	// skin's `CursorRotate: 0` cannot stop a cursor the floor or the beatmap
	// provided
	const cursorConfig = providerConfig(ctx, cursorProvider);
	// asked only while the trail preference is on: with it off the trail is
	// never looked up at all, and a provider probe would break that rule
	const trailConfig = ctx.prefs.cursorTrail
		? providerConfig(ctx, findProvider(ctx.sources, textureRequest("cursortrail")))
		: null;
	return {
		cursor: sprite(ctx, "cursor"),
		middle: sprite(ctx, "cursormiddle"),
		// the one cursor element behind a preference: the ring and dot are the
		// cursor itself and are never gated
		trail: ctx.prefs.cursorTrail ? sprite(ctx, "cursortrail") : HIDDEN,
		centre: cursorConfig?.cursorCentre ?? true,
		expand: cursorConfig?.cursorExpand ?? true,
		rotate: cursorConfig?.cursorRotate ?? true,
		trailRotate: trailConfig?.cursorTrailRotate ?? true,
		disjointTrail
	};
}

function spinnerPieces(ctx: PieceContext): SpinnerPieces {
	// osulegacyskintransformer.cs:268-274, and this is ASSET PRESENCE rather
	// than the version field -- see SpinnerPieces.layout. presence is asked PER
	// SOURCE, exactly as the transformer's `GetTexture` asks its own skin: the
	// first source holding either layer decides the layout from what IT holds,
	// so a skin shipping only `spinner-top` is new-style even though the classic
	// floor behind it holds a `spinner-background`. no source holding either --
	// the bundled argon default -- is no legacy layout at all, which is what
	// draws argon's placeholder rather than a stack of empty sprites
	let layout: SpinnerPieces["layout"] = "none";
	let layoutProvider: { id: string } | null = null;
	for (const source of ctx.sources) {
		const hasBackground = source.lookup(textureRequest("spinner-background")).answer !== "none";
		const hasTop = source.lookup(textureRequest("spinner-top")).answer !== "none";
		if (hasTop || hasBackground) {
			layout = hasTop && !hasBackground ? "new" : "old";
			layoutProvider = source;
			break;
		}
	}
	return {
		layout,
		// legacyoldstylespinner.cs:44 reads the colour off the skin providing
		// the spinner, so the layout's provider answers; the floor declares
		// none, which is what leaves the drawable's flat grey
		backgroundTint: providerConfig(ctx, layoutProvider)?.spinnerBackground ?? null,
		background: sprite(ctx, "spinner-background"),
		circle: sprite(ctx, "spinner-circle"),
		metre: sprite(ctx, "spinner-metre"),
		glow: sprite(ctx, "spinner-glow"),
		bottom: sprite(ctx, "spinner-bottom"),
		top: sprite(ctx, "spinner-top"),
		middle: sprite(ctx, "spinner-middle"),
		middle2: sprite(ctx, "spinner-middle2"),
		approachCircle: sprite(ctx, "spinner-approachcircle"),
		spin: sprite(ctx, "spinner-spin"),
		clear: sprite(ctx, "spinner-clear"),
		blink: ctx.skin.config.spinnerNoBlink !== true
	};
}

function sliderPieces(ctx: PieceContext): SliderPieces {
	// the ball's colour AND its tint permission belong to whichever source
	// supplies the ball (legacysliderball.cs:36-47 -- it is constructed with
	// its own transformer's skin). the classic floor is lazer's
	// DefaultLegacySkin, whose two declarations are exactly these
	// (defaultlegacyskin.cs:45-48): the classic blue ball, tint allowed
	const ballProvider = findProvider(ctx.sources, {
		names: ["sliderb"],
		animatable: true,
		animationSeparator: ""
	});
	const ballConfig = providerConfig(ctx, ballProvider);
	const ballFromFloor = ballProvider?.id === "classic";
	return {
		// legacysliderheadhitcircle.cs:20 / osulegacyskintransformer.cs:187 --
		// the two ends have their own prefixes and fall back to the hit circle's
		// assets when the skin ships none, which is the prefix precondition doing
		// its job rather than a separate rule
		head: hitCircleFamily(ctx, "sliderstartcircle", true),
		// drawableslidertail.cs -- argon supplies no circle piece for the tail, so
		// the lazer era's tail is the body's own round cap and nothing else
		tail: hitCircleFamily(ctx, "sliderendcircle", false, "hidden"),
		// legacysliderball.cs:48 -- `sliderb0`, `sliderb1`, ... with NOTHING
		// between the name and the index, which is why the separator is a
		// parameter at all
		ball: resolveElement(ctx, ["sliderb"], { animatable: true, separator: "", looping: true }),
		ballNd: sprite(ctx, "sliderb-nd"),
		ballSpec: sprite(ctx, "sliderb-spec"),
		followCircle: resolveElement(ctx, ["sliderfollowcircle"], {
			animatable: true,
			looping: true,
			applyConfigFrameRate: true
		}),
		// osulegacyskintransformer.cs:164 -- animatable: FALSE. most skins ship
		// none of these, which makes it a live test of the classic floor
		scorePoint: resolveElement(ctx, ["sliderscorepoint"], { animatable: false }),
		reverseArrow: sprite(ctx, "reversearrow"),
		allowBallTint: ballFromFloor || ballConfig?.allowSliderBallTint === true,
		ballTint: ballConfig?.sliderBall ?? (ballFromFloor ? CLASSIC_SLIDER_BALL : null),
		reverseRotates: ctx.skin.config.version <= 1
	};
}

function judgementPieces(ctx: PieceContext): Record<JudgedResult, JudgementPieceSpec> {
	const specs = {} as Record<JudgedResult, JudgementPieceSpec>;
	for (const result of JUDGEMENT_RESULTS) {
		// two gates, in this order: the effects toggle covers every popup, and
		// the show-300s preference covers the great alone. neither consults the
		// skin, which is the point -- a great stays out of the way whatever the
		// skin would have answered
		const wanted = ctx.prefs.hitEffects && (result !== "great" || ctx.prefs.show300Judgements);
		specs[result] = wanted ? judgementPiece(ctx, result) : HIDDEN;
	}
	return specs;
}

/** one result's piece, once the preferences have allowed it to be asked for at
 * all. `argonStyle` is the lazer era's answer and is reached exactly where a
 * `lazerDefault` would be for every other element -- it is spelled out here
 * only because argon draws two different popups and the rest draw one thing */
function judgementPiece(ctx: PieceContext, result: JudgedResult): JudgementPieceSpec {
	const argonStyle = ARGON_JUDGEMENT_STYLE[result];
	const argonAnswer: JudgementPieceSpec =
		ctx.skin.era === "lazer" && argonStyle !== null ? { kind: "procedural", style: argonStyle } : HIDDEN;

	const name = JUDGEMENT_TEXTURES[result];
	// no texture name at all: stable's slider-tick score popups are out of
	// scope, so a large tick HIT is never looked up in either era
	if (name === null) return argonAnswer;

	// legacyskin.cs:519-535 -- animatable, non-looping
	const spec = resolveElement(ctx, [name], { animatable: true, looping: false });
	// only a DECLINE reaches argon's own answer. an `empty` -- a beatmap or skin
	// shipping a blank `hit300.png` -- has already ended the chain, and mapping
	// it to argon's text popup here would resurrect exactly what that blank
	// asset removed
	if (spec.kind === "procedural") return argonAnswer;
	return spec;
}

/**
 * every element the playfield draws, for the skin that is active.
 *
 * resolved in one pass and published in one step: a per-element progressive
 * swap would momentarily produce exactly the mixed-era playfield the classic
 * floor exists to prevent
 */
export function resolvePieces(ctx: PieceContext): SkinPieces {
	const hitCircle = hitCircleFamily(ctx, null, true);
	return {
		era: ctx.skin.era,
		cursor: cursorPieces(ctx),
		hitCircle,
		approachCircle: sprite(ctx, "approachcircle"),
		slider: sliderPieces(ctx),
		spinner: spinnerPieces(ctx),
		// followpointconnection.cs is the drawable; the toggle already owned
		// whether it runs, and the skin owns only what a chevron looks like
		followPoint: ctx.prefs.followPoints
			? resolveElement(ctx, ["followpoint"], { animatable: true, looping: true, applyConfigFrameRate: true })
			: HIDDEN,
		judgements: judgementPieces(ctx),
		// drawableosujudgement.cs:29-36 -- lighting is a sprite the judgement
		// carries, so it rides the same effects toggle the popups do.
		// argonskin.cs:93-94 answers `Drawable.Empty()` for it, which is why the
		// lazer era draws none: there is no procedural lighting to fall back to
		hitLighting: ctx.prefs.hitEffects
			? resolveElement(ctx, ["lighting"], { animatable: false, lazerDefault: "hidden" })
			: HIDDEN,
		body: {
			era: hitCircle.circle.kind === "procedural" ? "lazer" : "legacy",
			border: ctx.skin.config.sliderBorder,
			trackOverride: ctx.skin.config.sliderTrackOverride
		}
	};
}

/** every distinct frame url the specs can ask for.
 *
 * the preload list, and the reason the swap can be atomic: skin textures load
 * asynchronously, unlike anything else in the rebuild path, so the whole
 * manifest resolves and loads BEFORE the one publication rather than each
 * element appearing as it arrives */
export function pieceTextureUrls(pieces: SkinPieces): string[] {
	const urls = new Set<string>();
	const visit = (spec: PieceSpec): void => {
		if (spec.kind === "textured") for (const frame of spec.texture.frames) urls.add(frame);
	};
	visit(pieces.cursor.cursor);
	visit(pieces.cursor.middle);
	visit(pieces.cursor.trail);
	for (const family of [pieces.hitCircle, pieces.slider.head, pieces.slider.tail]) {
		visit(family.circle);
		visit(family.overlay);
		for (const digit of family.digits) visit(digit);
	}
	visit(pieces.approachCircle);
	for (const spec of [
		pieces.slider.ball,
		pieces.slider.ballNd,
		pieces.slider.ballSpec,
		pieces.slider.followCircle,
		pieces.slider.scorePoint,
		pieces.slider.reverseArrow,
		pieces.followPoint,
		pieces.hitLighting
	]) {
		visit(spec);
	}
	for (const result of JUDGEMENT_RESULTS) visit(pieces.judgements[result]);
	for (const spec of [
		pieces.spinner.background,
		pieces.spinner.circle,
		pieces.spinner.metre,
		pieces.spinner.glow,
		pieces.spinner.bottom,
		pieces.spinner.top,
		pieces.spinner.middle,
		pieces.spinner.middle2,
		pieces.spinner.approachCircle,
		pieces.spinner.spin,
		pieces.spinner.clear
	]) {
		visit(spec);
	}
	return [...urls];
}
