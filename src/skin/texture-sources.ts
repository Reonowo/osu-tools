// the texture half of the lookup chain: how an element name becomes a file to
// draw, and in what order the sources get asked.
//
// this deliberately mirrors `playback/sample-sources.ts` one for one. the chain
// itself (`playback/lookup-chain.ts`) is unchanged by this file: it was written
// generic over what is being looked up precisely so that adding a texture kind
// would be a request builder plus source factories rather than a second
// precedence rule. the list IS the precedence, for textures exactly as for
// samples -- beatmap, then user skin, then the era's bundled default.

import type { SkinManifest } from "@/lib/scene-types";
import { resolveThroughChain, type LookupSource, type SourceAnswer } from "@/playback/lookup-chain";
import { CLASSIC_FLOOR_FILES } from "./legacy/floor-manifest";

/**
 * the bundled default, as a manifest.
 *
 * `null` on the store means the bundled default rather than "no skin" -- there
 * is no such state -- and every consumer that forks on the era needs a manifest
 * rather than a null. this is that manifest, and it is deliberately empty: the
 * lazer era resolves no textures off disk at all, so a file map with entries
 * would be a lie about where argon's art comes from
 */
export const BUNDLED_SKIN: SkinManifest = {
	locator: { kind: "bundled" },
	name: "Argon",
	author: "osu!",
	source: "bundled",
	era: "lazer",
	files: {},
	blank: [],
	config: {
		version: 2.7,
		isLatestVersion: true,
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

/** the extensions a texture lookup tries, in order.
 *
 * exactly what the framework's texture store registers
 * (textureloaderstore.cs:27-28 adds `png` then `jpg`, and `ResourceStore`
 * yields the bare name followed by each), so a skin shipping `hitcircle.jpeg`
 * falls through here as it would in lazer rather than answering only in this
 * app. the order decides which wins when a skin ships both spellings of one
 * element */
export const TEXTURE_EXTENSIONS = ["png", "jpg"] as const;

/** legacyskinextensions.cs:225 -- a legacy animation plays at 60fps unless its
 * skin says otherwise */
export const SIXTY_FRAME_TIME = 1000 / 60;

/**
 * what a source is asked for.
 *
 * `names` is the ordered candidate list, most preferred first -- the same shape
 * `SampleRequest` carries, and for the same reason: a source answers a NAME and
 * never sees where the name came from, which is what makes the source list
 * substitutable.
 */
export interface TextureRequest {
	/** ordered candidate element names, most preferred first, WITHOUT an
	 * extension and without an `@2x` suffix */
	names: readonly string[];
	/**
	 * whether an animation frame set may answer this lookup.
	 *
	 * legacyskinextensions.cs:73-88 -- when animation is allowed, the frame set
	 * is tried FIRST and the single sprite answers only if no frame `-0` exists.
	 * false for an element lazer never animates, so that a skin shipping a
	 * stray `<element>-0` cannot turn a static piece into an animation
	 */
	animatable: boolean;
	/**
	 * what sits between an element name and a frame index.
	 *
	 * lazer's own parameter (legacyskinextensions.cs:21-27), defaulting to `-`
	 * and passed as the EMPTY string by the slider ball, whose frames are
	 * `sliderb0`..`sliderb9` with nothing between (legacysliderball.cs:48).
	 * getting this wrong turns every skin's slider ball into a static sprite,
	 * which is exactly the kind of quiet wrongness a caller cannot see
	 */
	animationSeparator: string;
}

/** where a lookup's image is. one entry per FRAME, in frame order; a single
 * sprite is a one-frame set, which is what keeps every consumer on one shape */
export interface ResolvedTexture {
	/** which source answered. `frameLength` depends on it: lazer reads
	 * `AnimationFramerate` off the source that PROVIDED the frames
	 * (legacyskinextensions.cs:47 passes `retrievalSource`, the result of
	 * `FindProvider`), not off the selected skin */
	sourceId: string;
	/** the element name that actually answered, after candidate expansion --
	 * the identity the skin texture cache keys on */
	name: string;
	frames: readonly string[];
	/** one factor per entry in `frames`, in the same order: 2 where an `@2x`
	 * asset answered, 1 otherwise. carried out of the lookup exactly as the
	 * procedural textures already carry a resolution factor, so a consumer
	 * scales by it rather than assuming a pixel density.
	 *
	 * PER FRAME rather than per set, because that is what lazer does:
	 * `GetTextures` calls `GetTexture` once per frame and `GetTexture` runs its
	 * own `@2x`-then-plain fallback and writes `texture.ScaleAdjust` on each
	 * texture it returns (legacyskin.cs:560-580). a skin that updated some
	 * frames of an animation to `@2x` and not others therefore plays in full,
	 * each frame at its own scale, rather than being cut short at the first
	 * frame that does not match frame zero */
	resolutionFactors: readonly number[];
	/**
	 * true only when the source answered with an actual frame SET.
	 *
	 * a lone `<element>-0` is not an animation: lazer's `GetAnimation` switches
	 * on the frame count and returns a plain `Sprite` for one
	 * (legacyskinextensions.cs:33-41), so a skin that names its single sprite
	 * with a frame index still draws as a sprite
	 */
	animated: boolean;
}

export type TextureSource = LookupSource<TextureRequest, ResolvedTexture>;

/** an element with no alternative spellings -- the common case */
export function textureRequest(name: string, animatable = false, animationSeparator = "-"): TextureRequest {
	return { names: [name], animatable, animationSeparator };
}

export function resolveTexture(
	sources: readonly TextureSource[],
	request: TextureRequest
): SourceAnswer<ResolvedTexture> {
	return resolveThroughChain(sources, request);
}

/**
 * the ordered source list, for textures: beatmap, then user skin, then the
 * era's bundled default -- `SkinProvidingContainer`'s own order
 * (skinprovidingcontainer.cs:132-145 -- `GetTexture`'s own walk, the same
 * shape `GetSample`'s at 147-160 has), the same list the samples resolve
 * through.
 *
 * the floor is per ERA and that is the point: a legacy skin that declines falls
 * to the classic default, never to Argon. lazer never renders a legacy skin
 * against lazer art, and a playfield half legacy and half Argon has never
 * existed in any osu! client
 */
export function textureSources(options: {
	beatmap: TextureSource | null;
	skin: SkinManifest;
	/** how a resolved absolute path becomes a url the webview may fetch */
	toUrl: (path: string) => string;
}): readonly TextureSource[] {
	const sources: TextureSource[] = [];
	if (options.beatmap !== null) sources.push(options.beatmap);
	if (options.skin.era === "legacy") {
		sources.push(legacySkinTextureSource(options.skin, options.toUrl));
		sources.push(classicFloorTextureSource());
	}
	// a lazer-era skin has no texture files at all: Argon's art is procedural
	// and is selected by the piece resolver rather than resolved off disk, so
	// there is nothing between the beatmap and the piece for it to answer with
	return sources;
}

/**
 * a legacy skin's own files.
 *
 * three rules, all lazer's:
 *
 * - **`@2x` first.** legacyskin.cs:561-577 strips any `@2x` the caller wrote
 *   (stable does, so lazer matches it), tries `<name>@2x.<ext>`, and records a
 *   ratio of 2 when that answered.
 * - **animation before sprite.** legacyskinextensions.cs:73-88 tries
 *   `<name>-0`, `<name>-1`, ... first when animation is allowed and only falls
 *   back to the single sprite when frame zero is missing.
 * - **whole name, then last path piece.** a DELIBERATE widening, not a port:
 *   `getFallbackSampleNames` (legacyskin.cs:634-641) is on lazer's sample path
 *   only, and `LegacySkin.GetTexture` does no name expansion at all. it is
 *   applied here so a path-qualified lookup name reaches a flat skin folder's
 *   file, the way the beatmap sample source already needs -- one expansion rule
 *   for both halves of the chain rather than two.
 *
 * What a texture lookup does NOT have, and a reader coming from the sample half
 * will look for: a custom-bank suffix and a universal fallback. Both are
 * properties of a hit sample's identity, not of an element name, and inventing
 * texture analogues would be inventing behaviour lazer does not have.
 */
export function legacySkinTextureSource(skin: SkinManifest, toUrl: (path: string) => string): TextureSource {
	return {
		id: "skin",
		lookup(request) {
			return lookupInFiles(
				request,
				"skin",
				(file) => skin.files[file],
				toUrl,
				(file) => skin.blank.includes(file)
			);
		}
	};
}

/**
 * the classic default set, vendored from the same osu-resources tree the
 * bundled hit samples come from (`docs/adr/0006`).
 *
 * this is the FLOOR of the legacy era and nothing sits below it. it still
 * declines rather than answering empty when it has no such element, because
 * "this set does not have it" is not the same statement as "this set says there
 * is nothing here" -- the same distinction the bundled sample source keeps
 */
export function classicFloorTextureSource(files: readonly string[] = CLASSIC_FLOOR_FILES): TextureSource {
	const shipped = new Set(files);
	return {
		id: "classic",
		lookup(request) {
			return lookupInFiles(
				request,
				"classic",
				(file) => (shipped.has(file) ? `/skins/legacy/${file}` : undefined),
				(url) => url,
				// the vendored set ships no blank assets: it is the floor, and a
				// floor that hid an element would leave nothing below it to answer
				() => false
			);
		}
	};
}

/**
 * the shared resolution walk, over whatever map a source holds.
 *
 * the order is the whole contract: candidate names outermost, then the
 * animation-before-sprite fork, then `@2x` before plain, then the extension
 * order. an element found under a later candidate name at a worse resolution
 * still beats one found under an earlier name that does not exist at all --
 * resolution is per lookup, never per skin
 */
function lookupInFiles(
	request: TextureRequest,
	sourceId: string,
	find: (file: string) => string | undefined,
	toUrl: (path: string) => string,
	isBlank: (file: string) => boolean
): SourceAnswer<ResolvedTexture> {
	for (const name of expandNames(request.names)) {
		if (request.animatable) {
			const frames = findFrameSet(name, request.animationSeparator, find);
			if (frames !== null) {
				// a frame set whose FIRST frame is blank is the skin removing the
				// element, same as a blank sprite would be
				if (isBlank(frames.files[0].file)) return { answer: "empty" };
				return {
					answer: "found",
					value: {
						sourceId,
						name,
						frames: frames.files.map((frame) => toUrl(find(frame.file) as string)),
						resolutionFactors: frames.files.map((frame) => frame.resolutionFactor),
						// legacyskinextensions.cs:33-41 -- one frame is a Sprite,
						// not a TextureAnimation
						animated: frames.files.length > 1
					}
				};
			}
		}
		const sprite = findSprite(name, find);
		if (sprite !== null) {
			if (isBlank(sprite.file)) return { answer: "empty" };
			return {
				answer: "found",
				value: {
					sourceId,
					name,
					frames: [toUrl(find(sprite.file) as string)],
					resolutionFactors: [sprite.resolutionFactor],
					animated: false
				}
			};
		}
	}
	return { answer: "none" };
}

/** every candidate tried whole and as its last path piece, in that order, with
 * duplicates dropped. the shape is `getFallbackSampleNames`'s
 * (legacyskin.cs:634-641), which is lazer's SAMPLE path -- its texture path has
 * no equivalent, so applying it to textures is a deliberate widening */
export function expandNames(names: readonly string[]): string[] {
	const expanded: string[] = [];
	for (const name of names) {
		// legacyskin.cs:566 -- an `@2x` written into the lookup name itself is
		// stripped, because stable strips it and skins in the wild rely on that
		const stripped = name.replaceAll("@2x", "");
		for (const candidate of [stripped, stripped.split("/").pop() ?? stripped]) {
			const lowered = candidate.toLowerCase();
			if (lowered !== "" && !expanded.includes(lowered)) expanded.push(lowered);
		}
	}
	return expanded;
}

/** `<name><sep>0`, `<name><sep>1`, ... up to the first gap. null when frame
 * zero is missing, which is what makes the single-sprite fallback reachable */
function findFrameSet(
	name: string,
	separator: string,
	find: (file: string) => string | undefined
): { files: Sprite[] } | null {
	const first = findSprite(`${name}${separator}0`, find);
	if (first === null) return null;
	const files = [first];
	// every frame resolves through the SAME `@2x`-then-plain fallback frame zero
	// did, independently of it. lazer's `GetTextures` calls `GetTexture` per
	// frame and each call picks its own ratio (legacyskin.cs:560-580), so a set
	// whose frames are not uniformly `@2x` plays in full rather than stopping at
	// the first frame that disagrees with frame zero
	for (let frame = 1; ; frame++) {
		const next = findSprite(`${name}${separator}${frame}`, find);
		if (next === null) break;
		files.push(next);
	}
	return { files };
}

/** one resolved image file and the density it answered at */
interface Sprite {
	file: string;
	resolutionFactor: number;
}

/** `<name>@2x.<ext>` before `<name>.<ext>`, extensions in preference order */
function findSprite(name: string, find: (file: string) => string | undefined): Sprite | null {
	for (const factor of [2, 1] as const) {
		const file = findSpriteAt(name, factor, find);
		if (file !== null) return { file, resolutionFactor: factor };
	}
	return null;
}

function findSpriteAt(name: string, factor: number, find: (file: string) => string | undefined): string | null {
	const stem = factor === 2 ? `${name}@2x` : name;
	for (const extension of TEXTURE_EXTENSIONS) {
		const file = `${stem}.${extension}`;
		if (find(file) !== undefined) return file;
	}
	return null;
}

/**
 * legacyskinextensions.cs:228-240 -- how long each frame of an animation shows.
 *
 * `applyConfigFrameRate` is the caller's, not the skin's: only the elements
 * lazer passes it for read `AnimationFramerate`, and the rest run at a flat
 * 60fps whatever the skin declared
 */
export function frameLength(
	skin: SkinManifest,
	answered: Pick<ResolvedTexture, "sourceId" | "frames">,
	applyConfigFrameRate: boolean
): number {
	if (!applyConfigFrameRate) return SIXTY_FRAME_TIME;
	// the rate belongs to whichever source ANSWERED, not to the selected skin:
	// lazer hands `getFrameLength` the `FindProvider` result. the classic floor
	// ships no skin.ini, so frames that fell through to it declare no rate and
	// run at one second for the whole set -- a user skin's `AnimationFramerate`
	// must not reach an element that skin never supplied
	const declared = answered.sourceId === "skin" ? skin.config.animationFramerate : null;
	if (declared !== null && declared > 0) return 1000 / declared;
	// the whole animation in one second, however many frames it has
	return 1000 / Math.max(1, answered.frames.length);
}

/**
 * the beatmap's own art, which is the chain's FIRST texture source -- exactly
 * as its samples already are.
 *
 * two properties are worth stating because both are easy to get backwards:
 *
 * - **it DECLINES when the toggle is off, it does not answer empty.** the user
 *   refusing a map's art is a statement about this source, not about the
 *   element: the next source -- their own skin -- must answer instead. an empty
 *   answer here would hide the element outright, which is the opposite of what
 *   the toggle means.
 * - **it is asked in BOTH eras.** a mapset that ships its own hit circles draws
 *   with them whichever skin is selected, and the piece resolver draws whatever
 *   answered with the composited piece rather than argon's procedural stack.
 *   that is not a mixed-era look: the beatmap is authoring the element, and
 *   lazer's `BeatmapSkin` sits above the user skin for the same reason.
 *
 * the resolution rules are the legacy ones, unconditionally: a beatmap skin is
 * a legacy skin, whatever the user has selected
 */
export function beatmapTextureSource(options: {
	/** lowercased file name -> absolute path, as the scene carries it */
	files: Readonly<Record<string, string>>;
	toUrl: (path: string) => string;
	ignoreBeatmapSkin: boolean;
}): TextureSource {
	return {
		id: "beatmap",
		lookup(request) {
			if (options.ignoreBeatmapSkin) return { answer: "none" };
			return lookupInFiles(
				request,
				"beatmap",
				(file) => options.files[file],
				options.toUrl,
				// a beatmap's blank asset is a decision like any other skinner's,
				// but this map carries no size information -- the app crate does not
				// measure a beatmap's images the way `skin.rs` measures a skin's.
				// so a blank one here answers FOUND with a transparent texture,
				// which draws the same nothing; the distinction only matters for
				// whether a later source gets asked, and a beatmap that shipped the
				// file has already said it wants it
				() => false
			);
		}
	};
}
