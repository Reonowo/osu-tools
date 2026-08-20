// the hit circle: one era-invariant drawable over two pieces.
//
// what stays in the drawable is the object's own timing -- when it appears,
// when the dim releases, the approach circle, the container's lifetime -- all of
// which belongs to `DrawableHitCircle` in lazer and to neither skin. what swaps
// is the piece: argon's procedural gradient stack or a legacy skin's composited
// `hitcircle` + overlay + combo glyphs.
//
// the piece is chosen by the SPEC rather than by the era, deliberately: a
// beatmap can answer a texture lookup over an argon skin, and what draws a
// texture is the composited piece whichever skin is selected.
//
// pixi appliers for the argon circle: sprites sized from argon.ts constants,
// values copied from circle-tracks every frame. layer order matches
// argonmaincirclepiece.cs:56-113 (outerfill, outergradient, innergradient,
// innerfill, number, flash, border); the approach circle stays a logical
// child of `view` (so it inherits position/scale and destroy()) but is
// additionally attached to the renderer's approach RenderLayer so it draws
// above every circle piece regardless of z-order -- mirrors
// drawablehitcircle.cs's ProxiedLayer without ever parenting outside `view`

import { Container, Sprite, Text } from "pixi.js";
import { OBJECT_RADIUS } from "../../engine/game-constants";
import { BORDER_THICKNESS, INNER_FILL_SIZE, INNER_GRADIENT_SIZE, OUTER_GRADIENT_SIZE } from "@/skin/argon/constants";
import { HIT_CIRCLE_TEXT_SCALE } from "@/skin/legacy/constants";
import type { HitCirclePieces, PieceSpec } from "@/skin/pieces";
import { darken, toNumber, type Rgba } from "../../engine/color";
import { trackValueAt } from "../../engine/transforms";
import type { ObjectDrawable, RenderContext } from "../GameplayRenderer";
import { SkinSprite } from "../skin-sprite";
import { APPROACH_CIRCLE_SIZE } from "../textures";
import {
	circleTracks,
	legacyCircleTracks,
	resolveCircleResult,
	type CircleTracks,
	type LegacyCircleTracks
} from "./circle-tracks";

/** osuhitobject.cs:27 -- OBJECT_DIMENSIONS, the circle's full osu!px size */
const CIRCLE_SIZE = OBJECT_RADIUS * 2;

/** flashpiece: a 64px invisible body whose glow spans 64 + 2*76.8 px (edge
 * effect radius = radius * 1.2, hit lighting on) */
const FLASH_SIZE = OBJECT_RADIUS + 2 * (OBJECT_RADIUS * 1.2);

function sprite(texture: import("pixi.js").Texture, sizeOsuPx: number): Sprite {
	const s = new Sprite(texture);
	s.anchor.set(0.5);
	s.width = sizeOsuPx;
	s.height = sizeOsuPx;
	return s;
}

function mix(a: number, b: number, k: number): number {
	return a + (b - a) * k;
}

function mixedTint(accent: Rgba, k: number): number {
	return toNumber({ r: mix(1, accent.r, k), g: mix(1, accent.g, k), b: mix(1, accent.b, k), a: 1 });
}

/**
 * what a circle drawable needs from whichever piece is installed.
 *
 * one verb: apply this time. the tracks a piece animates against are its own --
 * the two eras do not agree on a single value of them -- while the object's own
 * timing stays in the drawable, where it belongs
 */
export interface CirclePiece {
	readonly view: Container;
	apply(t: number): void;
}

/** which implementation a spec calls for. `procedural` is argon's stack;
 * anything else -- a texture, or a blank asset that answered empty -- is drawn
 * by the composited piece, which handles an absent sprite by drawing nothing */
export function texturedPiece(spec: PieceSpec): boolean {
	return spec.kind !== "procedural";
}

export interface CirclePieceOptions {
	family: HitCirclePieces;
	accent: Rgba;
	indexInCombo: number;
	/** argon only: the slider head omits the outer fill
	 * (osuargonskintransformer.cs -- ArgonMainCirclePiece(false)) */
	withOuterFill: boolean;
	obj: { startTime: number; preempt: number; fadeIn: number };
	result: ReturnType<typeof resolveCircleResult>;
	hitAnimations: boolean;
	/** the shared tracks, already built by the caller -- the piece reads the
	 * dim off them so both eras apply the same pre-hit tint */
	shared: CircleTracks;
}

/** the one place a circle's era fork is taken */
export function createCirclePiece(ctx: RenderContext, options: CirclePieceOptions): CirclePiece {
	if (!texturedPiece(options.family.circle)) return new ArgonCirclePiece(ctx, options);
	return new LegacyCirclePiece(ctx, options);
}

export class ArgonCirclePiece implements CirclePiece {
	readonly view = new Container();
	private readonly outerFill: Sprite | null;
	private readonly outerGradient: Sprite;
	private readonly outerGradientWhite: Sprite;
	private readonly innerGradient: Sprite;
	private readonly innerFill: Sprite;
	private readonly number: Text;
	private readonly flash: Sprite;
	private readonly border: Sprite;
	private readonly accent: Rgba;

	private readonly tracks: CircleTracks;

	constructor(ctx: RenderContext, options: CirclePieceOptions) {
		const { accent, indexInCombo, withOuterFill } = options;
		this.tracks = options.shared;
		this.accent = accent;
		const dark = toNumber(darken(accent, 4));
		const t = ctx.textures;

		// slightly inset to prevent bleeding outside the ring (argonmaincirclepiece.cs:70)
		this.outerFill = withOuterFill ? sprite(t.circleTexture(CIRCLE_SIZE), CIRCLE_SIZE - 1) : null;
		if (this.outerFill !== null) this.outerFill.tint = dark;

		const key = toNumber(accent).toString(16);
		this.outerGradient = sprite(
			t.gradientCircleTexture(OUTER_GRADIENT_SIZE, `outer:${key}`, accent, darken(accent, 0.1)),
			OUTER_GRADIENT_SIZE
		);
		this.outerGradientWhite = sprite(t.circleTexture(OUTER_GRADIENT_SIZE), OUTER_GRADIENT_SIZE);
		this.innerGradient = sprite(
			t.gradientCircleTexture(INNER_GRADIENT_SIZE, `inner:${key}`, darken(accent, 0.5), darken(accent, 0.6)),
			INNER_GRADIENT_SIZE
		);
		this.innerFill = sprite(t.circleTexture(INNER_FILL_SIZE), INNER_FILL_SIZE);
		this.innerFill.tint = dark;

		this.number = new Text({
			text: String(indexInCombo + 1),
			style: { fontFamily: "Inter Variable", fontWeight: "700", fontSize: 52, fill: 0xffffff }
		});
		this.number.anchor.set(0.5);
		this.number.y = -2;

		// hard core fraction = 32 / (32 + 76.8)
		this.flash = sprite(t.glowTexture(FLASH_SIZE, 32 / 108.8), FLASH_SIZE);
		this.flash.tint = toNumber(accent);
		this.flash.blendMode = "add";

		this.border = sprite(t.ringTexture(CIRCLE_SIZE, BORDER_THICKNESS), CIRCLE_SIZE);

		for (const child of [
			this.outerFill,
			this.outerGradient,
			this.outerGradientWhite,
			this.innerGradient,
			this.innerFill,
			this.number,
			this.flash,
			this.border
		]) {
			if (child !== null) this.view.addChild(child);
		}
	}

	apply(t: number): void {
		const tracks = this.tracks;
		const dim = trackValueAt(tracks.dim, t, 1);
		this.view.tint = toNumber({ r: dim, g: dim, b: dim, a: 1 });
		this.view.alpha = trackValueAt(tracks.pieceAlpha, t, 0);

		if (this.outerFill !== null) this.outerFill.alpha = trackValueAt(tracks.fillAlpha, t, 1);
		this.innerFill.alpha = trackValueAt(tracks.fillAlpha, t, 1);
		this.innerGradient.alpha = trackValueAt(tracks.innerGradientAlpha, t, 1);

		const gradientScale = trackValueAt(tracks.outerGradientScale, t, 1);
		const gradientAlpha = trackValueAt(tracks.outerGradientAlpha, t, 1);
		const white = trackValueAt(tracks.outerGradientWhite, t, 0);
		this.outerGradient.scale.set((OUTER_GRADIENT_SIZE / this.outerGradient.texture.width) * gradientScale);
		this.outerGradientWhite.scale.set(
			(OUTER_GRADIENT_SIZE / this.outerGradientWhite.texture.width) * gradientScale
		);
		this.outerGradient.alpha = gradientAlpha * (1 - white);
		this.outerGradientWhite.alpha = gradientAlpha * white;

		this.number.alpha = trackValueAt(tracks.numberAlpha, t, 1);
		this.flash.alpha = trackValueAt(tracks.flashAlpha, t, 0);

		this.border.scale.set((CIRCLE_SIZE / this.border.texture.width) * trackValueAt(tracks.borderScale, t, 1));
		this.border.alpha = trackValueAt(tracks.borderAlpha, t, 1);
		this.border.tint = mixedTint(this.accent, trackValueAt(tracks.borderAccentMix, t, 0));
	}
}

/**
 * legacymaincirclepiece.cs -- the composited circle: `hitcircle` tinted by the
 * combo accent, its overlay drawn over and NOT tinted, and the combo number
 * composited from the skin's own digit glyphs.
 *
 * the overlay is a plain sprite rather than an animation, exactly as lazer
 * builds it (:100-105 constructs a `Sprite`, with no `GetAnimation` call
 * anywhere on this path). a skin shipping `hitcircleoverlay-0.png` therefore
 * draws a static overlay here as it does in game
 */
export class LegacyCirclePiece implements CirclePiece {
	readonly view = new Container();
	private readonly shared: CircleTracks;
	private readonly tracks: LegacyCircleTracks;
	private readonly circle: SkinSprite;
	private readonly overlay: SkinSprite;
	private readonly number: Container | null;
	private readonly numberScale: number;

	constructor(ctx: RenderContext, options: CirclePieceOptions) {
		const { family, accent, indexInCombo } = options;
		this.shared = options.shared;
		this.tracks = legacyCircleTracks(options.obj, options.result, options.hitAnimations, ctx.skin.config.version);

		this.circle = new SkinSprite(ctx.skinTexture, family.circle);
		// :150 -- the accent tints the CIRCLE only; the overlay is left white so
		// a skin can draw an unlit rim over any combo colour
		this.circle.drawable.tint = toNumber(accent);
		this.overlay = new SkinSprite(ctx.skinTexture, family.overlay);

		this.number = legacyComboNumber(ctx, family, indexInCombo + 1);
		// osulegacyskintransformer.cs:259-264 -- stable applies a blanket 0.8x to
		// the hit circle font, which is the font's scale rather than the piece's
		this.numberScale = HIT_CIRCLE_TEXT_SCALE;

		// :123-126 -- HitCircleOverlayAboveNumber (default true) puts the overlay
		// at the FRONT of the overlay layer, above the number; false leaves the
		// number on top of it
		const overlayLayer: Container[] = [];
		if (this.number !== null) overlayLayer.push(this.number);
		if (family.overlayAboveNumber) overlayLayer.push(this.overlay.view);
		else overlayLayer.unshift(this.overlay.view);
		this.view.addChild(this.circle.view, ...overlayLayer);
	}

	apply(t: number): void {
		const dim = trackValueAt(this.shared.dim, t, 1);
		this.view.tint = toNumber({ r: dim, g: dim, b: dim, a: 1 });

		const alpha = trackValueAt(this.tracks.pieceAlpha, t, 0);
		const scale = trackValueAt(this.tracks.pieceScale, t, 1);
		for (const piece of [this.circle, this.overlay]) {
			piece.view.alpha = alpha;
			piece.view.scale.set(scale);
		}
		if (this.number !== null) {
			// the number's track alone, never multiplied by the piece alpha: the
			// number is a SIBLING of the circle sprites in lazer, so the 240ms
			// hit fade the version fork routes around it must not be reapplied
			// here (and a version-1 number must fade once, not squared)
			this.number.alpha = trackValueAt(this.tracks.numberAlpha, t, 1);
			this.number.scale.set(this.numberScale * trackValueAt(this.tracks.numberScale, t, 1));
		}
	}
}

/**
 * the combo number, composited from the skin's own digit glyphs.
 *
 * legacyspritetext.cs draws each glyph at its own display size with the font's
 * overlap folded into the advance, so a skin whose digits are meant to touch
 * lays out the way it does in game. an absent glyph contributes nothing rather
 * than a gap -- the skin has no art for that digit and there is nothing sensible
 * to substitute
 */
function legacyComboNumber(ctx: RenderContext, family: HitCirclePieces, value: number): Container | null {
	const digits = [...String(value)].map((character) => Number(character));
	const sprites = digits.map((digit) => new SkinSprite(ctx.skinTexture, family.digits[digit] ?? { kind: "hidden" }));
	if (sprites.every((sprite) => sprite.empty)) return null;

	const overlap = family.digitOverlap;
	const width = sprites.reduce((total, sprite) => total + sprite.width, 0) - overlap * (sprites.length - 1);
	const container = new Container();
	let x = -width / 2;
	for (const sprite of sprites) {
		sprite.drawable.anchor.set(0, 0.5);
		sprite.view.x = x;
		x += sprite.width - overlap;
		container.addChild(sprite.view);
	}
	return container;
}

/**
 * the approach circle, which is the same element in both eras and a different
 * sprite in each: argon's procedural ring (defaultapproachcircle.cs) or the
 * skin's own `approachcircle` (legacyapproachcircle.cs).
 *
 * combo-tinted in both, and in both the tint is the whole of the skin's say --
 * the alpha and the shrink are `DrawableHitCircle`'s and belong to the object
 */
export interface ApproachCirclePiece {
	readonly view: Container;
	/** `scale` is the object's own, already including the cs scale */
	apply(alpha: number, scale: number): void;
}

/** defaultapproachcircle.cs:28-32 -- argon draws the sprite expanded by
 * 128/118, since the visible ring sits at 118/128 of a 128px sprite. a legacy
 * `approachcircle.png` is already sized to meet the circle and takes no such
 * correction */
const ARGON_APPROACH_EXPANSION = 128 / 118;

export function createApproachCircle(ctx: RenderContext, accent: Rgba): ApproachCirclePiece {
	const spec = ctx.pieces.approachCircle;
	if (!texturedPiece(spec)) {
		const sprite = new Sprite(ctx.textures.approachCircleTexture());
		sprite.anchor.set(0.5);
		sprite.tint = toNumber(accent);
		// against the texture's *logical* size, not its canvas size: the bake
		// grows with the density bucket while the sprite must not
		const base = (CIRCLE_SIZE / APPROACH_CIRCLE_SIZE) * ARGON_APPROACH_EXPANSION;
		return {
			view: sprite,
			apply(alpha, scale) {
				sprite.alpha = alpha;
				sprite.scale.set(base * scale);
			}
		};
	}
	const skinned = new SkinSprite(ctx.skinTexture, spec);
	// legacyapproachcircle.cs:35 -- the accent tints it, and nothing else does
	skinned.drawable.tint = toNumber(accent);
	return {
		view: skinned.view,
		apply(alpha, scale) {
			skinned.view.alpha = alpha;
			skinned.view.scale.set(scale);
		}
	};
}

export class CircleDrawable implements ObjectDrawable {
	readonly view = new Container();
	private readonly piece: CirclePiece;
	private readonly approach: ApproachCirclePiece;
	private readonly tracks: CircleTracks;

	constructor(ctx: RenderContext, objectIndex: number) {
		const obj = ctx.scene.renderPlan.objects[objectIndex];
		const accent = ctx.accents[objectIndex];
		const result = resolveCircleResult(ctx.derived.judgementsByObject[objectIndex], obj.startTime);
		this.tracks = circleTracks(obj, result, true, ctx.getEffects().hitAnimations);

		this.piece = createCirclePiece(ctx, {
			family: ctx.pieces.hitCircle,
			accent,
			indexInCombo: obj.indexInCombo,
			withOuterFill: true,
			obj,
			result,
			hitAnimations: ctx.getEffects().hitAnimations,
			shared: this.tracks
		});
		this.view.addChild(this.piece.view);
		this.view.position.set(obj.position[0], obj.position[1]);
		this.view.scale.set(ctx.scene.renderPlan.scale);
		ctx.layers.objects.addChild(this.view);

		// accent-tinted, whichever era drew it; kept a logical child of `view`
		// (inherits position + renderPlan.scale, and is released by view.destroy())
		// and merely *attached* to the approach RenderLayer so it draws above
		// every object regardless of draw order
		this.approach = createApproachCircle(ctx, accent);
		this.view.addChild(this.approach.view);
		ctx.layers.approach.attach(this.approach.view);
	}

	update(t: number): void {
		this.view.alpha = trackValueAt(this.tracks.containerAlpha, t, 0);
		this.piece.apply(t);
		// approach.alpha compounds with view.alpha through the normal container
		// hierarchy (it is a real child of view), matching how ApproachCircle's
		// alpha compounds with its DrawableHitCircle parent's in source
		this.approach.apply(
			trackValueAt(this.tracks.approachAlpha, t, 0),
			trackValueAt(this.tracks.approachScale, t, 4)
		);
	}

	destroy(): void {
		this.view.destroy({ children: true });
	}
}
