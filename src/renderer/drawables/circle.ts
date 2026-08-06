// pixi appliers for the argon circle: sprites sized from argon.ts constants,
// values copied from circle-tracks every frame. layer order matches
// argonmaincirclepiece.cs:56-113 (outerfill, outergradient, innergradient,
// innerfill, number, flash, border); the approach circle stays a logical
// child of `view` (so it inherits position/scale and destroy()) but is
// additionally attached to the renderer's approach RenderLayer so it draws
// above every circle piece regardless of z-order -- mirrors
// drawablehitcircle.cs's ProxiedLayer without ever parenting outside `view`

import { Container, Sprite, Text } from "pixi.js";
import {
	BORDER_THICKNESS,
	INNER_FILL_SIZE,
	INNER_GRADIENT_SIZE,
	OBJECT_RADIUS,
	OUTER_GRADIENT_SIZE
} from "../../engine/argon";
import { darken, toNumber, type Rgba } from "../../engine/color";
import { trackValueAt } from "../../engine/transforms";
import type { ObjectDrawable, RenderContext } from "../GameplayRenderer";
import { circleTracks, resolveCircleResult, type CircleTracks } from "./circle-tracks";

/** osuhitobject.cs:27 -- OBJECT_DIMENSIONS, the circle's full osu!px size */
const CIRCLE_SIZE = OBJECT_RADIUS * 2;

/** bake textures at 2x the osu!px size so cs scaling stays crisp */
const TEXTURE_SCALE = 2;

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

export class ArgonCirclePiece {
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

	constructor(ctx: RenderContext, accent: Rgba, indexInCombo: number, withOuterFill: boolean) {
		this.accent = accent;
		const dark = toNumber(darken(accent, 4));
		const t = ctx.textures;

		// slightly inset to prevent bleeding outside the ring (argonmaincirclepiece.cs:70)
		this.outerFill = withOuterFill ? sprite(t.circleTexture(CIRCLE_SIZE * TEXTURE_SCALE), CIRCLE_SIZE - 1) : null;
		if (this.outerFill !== null) this.outerFill.tint = dark;

		const key = toNumber(accent).toString(16);
		this.outerGradient = sprite(
			t.gradientCircleTexture(OUTER_GRADIENT_SIZE * TEXTURE_SCALE, `outer:${key}`, accent, darken(accent, 0.1)),
			OUTER_GRADIENT_SIZE
		);
		this.outerGradientWhite = sprite(t.circleTexture(OUTER_GRADIENT_SIZE * TEXTURE_SCALE), OUTER_GRADIENT_SIZE);
		this.innerGradient = sprite(
			t.gradientCircleTexture(
				INNER_GRADIENT_SIZE * TEXTURE_SCALE,
				`inner:${key}`,
				darken(accent, 0.5),
				darken(accent, 0.6)
			),
			INNER_GRADIENT_SIZE
		);
		this.innerFill = sprite(t.circleTexture(INNER_FILL_SIZE * TEXTURE_SCALE), INNER_FILL_SIZE);
		this.innerFill.tint = dark;

		this.number = new Text({
			text: String(indexInCombo + 1),
			style: { fontFamily: "Inter Variable", fontWeight: "700", fontSize: 52, fill: 0xffffff }
		});
		this.number.anchor.set(0.5);
		this.number.y = -2;

		// flashpiece: a 64px invisible body whose glow spans 64 + 2*76.8 px;
		// hard core fraction = 32 / (32 + 76.8) (edge effect radius = radius * 1.2, hit lighting on)
		this.flash = sprite(t.glowTexture(256, 32 / 108.8), OBJECT_RADIUS + 2 * (OBJECT_RADIUS * 1.2));
		this.flash.tint = toNumber(accent);
		this.flash.blendMode = "add";

		this.border = sprite(t.ringTexture(CIRCLE_SIZE * TEXTURE_SCALE, BORDER_THICKNESS * TEXTURE_SCALE), CIRCLE_SIZE);

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

	apply(tracks: CircleTracks, t: number): void {
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

export class CircleDrawable implements ObjectDrawable {
	readonly view = new Container();
	private readonly piece: ArgonCirclePiece;
	private readonly approach: Sprite;
	private readonly tracks: CircleTracks;
	private readonly baseApproachScale: number;

	constructor(ctx: RenderContext, objectIndex: number) {
		const obj = ctx.scene.renderPlan.objects[objectIndex];
		const accent = ctx.accents[objectIndex];
		const result = resolveCircleResult(ctx.derived.judgementsByObject[objectIndex], obj.startTime);
		this.tracks = circleTracks(obj, result, true);

		this.piece = new ArgonCirclePiece(ctx, accent, obj.indexInCombo, true);
		this.view.addChild(this.piece.view);
		this.view.position.set(obj.position[0], obj.position[1]);
		this.view.scale.set(ctx.scene.renderPlan.scale);
		ctx.layers.objects.addChild(this.view);

		// defaultapproachcircle.cs: accent-tinted sprite, expanded by 128/118;
		// kept a logical child of `view` (inherits position + renderPlan.scale, and
		// is released by view.destroy()) and merely *attached* to the approach
		// RenderLayer so it draws above every object regardless of draw order
		this.approach = new Sprite(ctx.textures.approachCircleTexture());
		this.approach.anchor.set(0.5);
		this.approach.tint = toNumber(accent);
		this.view.addChild(this.approach);
		ctx.layers.approach.attach(this.approach);
		this.baseApproachScale = (CIRCLE_SIZE / 256) * (128 / 118);
	}

	update(t: number): void {
		this.view.alpha = trackValueAt(this.tracks.containerAlpha, t, 0);
		this.piece.apply(this.tracks, t);
		// approach.alpha compounds with view.alpha through the normal container
		// hierarchy (it is a real child of view), matching how ApproachCircle's
		// alpha compounds with its DrawableHitCircle parent's in source
		this.approach.alpha = trackValueAt(this.tracks.approachAlpha, t, 0);
		this.approach.scale.set(this.baseApproachScale * trackValueAt(this.tracks.approachScale, t, 4));
	}

	destroy(): void {
		this.view.destroy({ children: true });
	}
}
