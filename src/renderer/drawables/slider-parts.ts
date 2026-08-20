// argon slider companions: ball, follow circle, tick, reverse arrow.
// sizes cited: argonsliderball.cs (outer_gradient_size body, gradient
// thickness border, 48px chevron at (0.6,0.8)), argonfollowcircle.cs
// (border 4, fill alpha 0.3, additive), argonsliderscorepoint.cs (12px,
// border 3), argonreversearrow.cs (40x20 capsule, 16px double chevron)

import { Container, Graphics, Sprite } from "pixi.js";
import { GRADIENT_THICKNESS, OUTER_GRADIENT_SIZE } from "@/skin/argon/constants";
import { LEGACY_FOLLOW_CONTENT_SCALE, LEGACY_REVERSE_BRIGHT_THRESHOLD } from "@/skin/legacy/constants";
import { SIXTY_FRAME_TIME } from "@/skin/texture-sources";
import { darken, fromBytes, toNumber, type Rgba } from "../../engine/color";
import type { RenderContext } from "../GameplayRenderer";
import { SkinSprite } from "../skin-sprite";

/** the square the chevron glyphs are drawn on, in osu!px; the bake scales
 * with the density bucket, the logical size does not */
const CHEVRON_TEXTURE_SIZE = 64;

/** canvas-drawn chevron glyphs (decision 8): ">" and ">>" strokes */
function chevronTexture(ctx: RenderContext, key: string, double: boolean) {
	return ctx.textures.canvasTexture(CHEVRON_TEXTURE_SIZE, `chevron:${key}`, (c, size) => {
		c.strokeStyle = "#fff";
		c.lineWidth = size / 6;
		c.lineCap = "round";
		c.lineJoin = "round";
		const draw = (x: number) => {
			c.beginPath();
			c.moveTo(x - size / 8, size / 4);
			c.lineTo(x + size / 8, size / 2);
			c.lineTo(x - size / 8, (3 * size) / 4);
			c.stroke();
		};
		if (double) {
			draw(size * 0.4);
			draw(size * 0.65);
		} else draw(size / 2);
	});
}

/** argonsliderball.cs:24 -- the icon's 48px box, scaled to (0.6, 0.8) */
const ICON_SIZE = 48;
const ICON_ASPECT = { x: 0.6, y: 0.8 };
/** argonfollowcircle.cs -- the follow circle's border thickness */
const FOLLOW_BORDER_THICKNESS = 4;

export class ArgonSliderBall implements SliderBallPiece {
	readonly view = new Container();
	private readonly fill: Sprite;
	private readonly icon: Sprite;

	constructor(ctx: RenderContext, accent: Rgba) {
		const key = toNumber(accent).toString(16);
		this.fill = new Sprite(
			ctx.textures.gradientCircleTexture(OUTER_GRADIENT_SIZE, `ball:${key}`, accent, darken(accent, 0.5))
		);
		this.fill.anchor.set(0.5);
		this.fill.width = this.fill.height = OUTER_GRADIENT_SIZE;

		const ring = new Sprite(ctx.textures.ringTexture(OUTER_GRADIENT_SIZE, GRADIENT_THICKNESS));
		ring.anchor.set(0.5);
		ring.width = ring.height = OUTER_GRADIENT_SIZE;

		this.icon = new Sprite(chevronTexture(ctx, "single", false));
		this.icon.anchor.set(0.5);

		this.view.addChild(this.fill, ring, this.icon);
	}

	/** fill/ring stay upright; only the icon takes the travel rotation
	 * (argonsliderball.cs:107-114) */
	setRotation(radians: number): void {
		this.icon.rotation = radians;
	}

	setElapsed(): void {
		// argon's ball is procedural and has no frames
	}

	/** folds both the design aspect ratio and the chevron's baked-texture
	 * size into the animated 0->1 scale factor -- Sprite.width/height are
	 * pure scale.set() sugar (pixi's Sprite.js), so any later scale.set()
	 * call must include this ratio itself or it clobbers the (0.6, 0.8)
	 * aspect and the texture-to-design-size ratio entirely */
	setIconScale(v: number): void {
		const base = ICON_SIZE / CHEVRON_TEXTURE_SIZE;
		this.icon.scale.set(base * ICON_ASPECT.x * v, base * ICON_ASPECT.y * v);
	}
}

export class ArgonFollowCircle implements FollowCirclePiece {
	readonly view = new Container();

	constructor(ctx: RenderContext, accent: Rgba) {
		const key = toNumber(accent).toString(16);
		const fill = new Sprite(
			ctx.textures.gradientCircleTexture(OUTER_GRADIENT_SIZE, `follow:${key}`, accent, darken(accent, 0.5))
		);
		fill.anchor.set(0.5);
		fill.width = fill.height = OUTER_GRADIENT_SIZE;
		fill.alpha = 0.3;
		const ring = new Sprite(ctx.textures.ringTexture(OUTER_GRADIENT_SIZE, FOLLOW_BORDER_THICKNESS));
		ring.anchor.set(0.5);
		ring.width = ring.height = OUTER_GRADIENT_SIZE;
		ring.tint = toNumber(accent);
		this.view.addChild(fill, ring);
		this.view.blendMode = "add";
	}

	setElapsed(): void {
		// argon's follow circle is procedural and has no frames
	}
}

export class ArgonTick {
	readonly view: Graphics;

	constructor(accent: Rgba) {
		this.view = new Graphics().circle(0, 0, 6).stroke({ width: 3, color: toNumber(accent), alignment: 1 });
	}
}

export class ArgonReverseArrow implements ReverseArrowPiece {
	readonly view = new Container();
	readonly main = new Container();
	readonly icon: Sprite;

	constructor(ctx: RenderContext, accent: Rgba) {
		const capsule = new Graphics().roundRect(-20, -10, 40, 20, 10).fill(0xffffff);
		this.icon = new Sprite(chevronTexture(ctx, "double", true));
		this.icon.anchor.set(0.5);
		this.icon.width = this.icon.height = 16;
		this.icon.tint = toNumber(darken(accent, 4));
		this.main.addChild(capsule, this.icon);
		this.view.addChild(this.main);
	}
}

/**
 * what the slider drawable needs from whichever ball piece is installed.
 *
 * the ball's own timing -- when it appears, where on the curve it is, which
 * way it is travelling -- stays in the drawable, because none of it is a skin's
 * to decide. what a piece owns is the art and how much of it turns
 */
export interface SliderBallPiece {
	readonly view: Container;
	/** the travel direction, in radians */
	setRotation(radians: number): void;
	/** the animated 0 -> 1 the ball's icon grows through on appear. argon's
	 * chevron scales; a legacy ball has no such piece and ignores it */
	setIconScale(value: number): void;
	/** an animated ball's frame, `elapsed` ms into the slider */
	setElapsed(elapsed: number): void;
}

/**
 * legacysliderball.cs -- three layers: an un-rotated dark underlay, the
 * animated ball itself, and an un-rotated additive specular highlight.
 *
 * the ball's frame delay is the SLIDER's rather than the skin's (:118-120):
 * `max(0.15 / velocity * SIXTY_FRAME_TIME, SIXTY_FRAME_TIME)`, so a fast slider
 * spins its ball faster. that is why this piece takes the slider rather than
 * just the pieces
 */
export class LegacySliderBall implements SliderBallPiece {
	readonly view = new Container();
	private readonly ball: SkinSprite;

	constructor(ctx: RenderContext, accent: Rgba, velocity: number) {
		const pieces = ctx.pieces.slider;
		// :56-57 -- Color4(5, 5, 5, 255), and never rotated with the ball
		const nd = new SkinSprite(ctx.skinTexture, pieces.ballNd);
		nd.drawable.tint = toNumber({ r: 5 / 255, g: 5 / 255, b: 5 / 255, a: 1 });

		this.ball = new SkinSprite(ctx.skinTexture, pieces.ball, {
			frameLength: legacyBallFrameLength(velocity)
		});
		// :47,91-95 -- the provider's declared SliderBall colour is the BASE
		// (white when it declared none), and the combo accent replaces it only
		// on the tint opt-in
		if (pieces.allowBallTint) this.ball.drawable.tint = toNumber(accent);
		else if (pieces.ballTint !== null) this.ball.drawable.tint = toNumber(fromBytes(pieces.ballTint));

		// :69-71 -- additive, and also never rotated
		const spec = new SkinSprite(ctx.skinTexture, pieces.ballSpec);
		spec.drawable.blendMode = "add";

		this.view.addChild(nd.view, this.ball.view, spec.view);
	}

	setRotation(radians: number): void {
		// :103-107 -- the nd and spec layers undo the parent's rotation, which
		// here is simply never applying it to them
		this.ball.view.rotation = radians;
	}

	setIconScale(): void {
		// a legacy ball is one sprite; there is no chevron to grow
	}

	setElapsed(elapsed: number): void {
		this.ball.setElapsed(elapsed);
	}
}

/** legacysliderball.cs:118-123 -- the ball's frame delay, derived from the
 * slider's velocity in osu!px per ms and floored at one 60fps frame */
export function legacyBallFrameLength(velocity: number): number {
	if (!(velocity > 0)) return SIXTY_FRAME_TIME;
	return Math.max((0.15 / velocity) * SIXTY_FRAME_TIME, SIXTY_FRAME_TIME);
}

/** the follow circle, whichever era drew it: one container the drawable scales
 * and fades, with the era's own art inside */
export interface FollowCirclePiece {
	readonly view: Container;
	setElapsed(elapsed: number): void;
}

/**
 * legacyfollowcircle.cs:12-21 -- the skin's own `sliderfollowcircle`, halved
 * because legacy follow circles are drawn at twice the hit circle's resolution
 * and are scaled down from there
 */
export class LegacySliderFollowCircle implements FollowCirclePiece {
	readonly view = new Container();
	private readonly sprite: SkinSprite;

	constructor(ctx: RenderContext) {
		this.sprite = new SkinSprite(ctx.skinTexture, ctx.pieces.slider.followCircle);
		this.sprite.view.scale.set(LEGACY_FOLLOW_CONTENT_SCALE);
		this.view.addChild(this.sprite.view);
	}

	setElapsed(elapsed: number): void {
		this.sprite.setElapsed(elapsed);
	}
}

/** the slider's tick marker: argon's ring or the skin's own `sliderscorepoint` */
export function createSliderTick(ctx: RenderContext, accent: Rgba): { view: Container } {
	const spec = ctx.pieces.slider.scorePoint;
	if (spec.kind === "procedural") return new ArgonTick(accent);
	const container = new Container();
	container.addChild(new SkinSprite(ctx.skinTexture, spec).view);
	return { view: container };
}

/** what the slider drawable needs from a reverse arrow: the whole piece, and
 * the inner container the idle pulse scales. argon pulses only `main` while the
 * hit scales the whole thing (argonreversearrow.cs:80-89); the legacy arrow has
 * one sprite and pulses it, so `main` is that sprite's own container */
export interface ReverseArrowPiece {
	readonly view: Container;
	readonly main: Container;
}

/**
 * the reverse arrow.
 *
 * legacyreversearrow.cs:69-72 -- the arrow is drawn BLACK over a bright combo
 * colour and white otherwise, and only when the texture came from the default
 * legacy set. that provider test is ported as "the classic floor answered": it
 * is the same statement about which source supplied the art, expressed in this
 * chain's own terms
 */
export class LegacyReverseArrow implements ReverseArrowPiece {
	readonly view = new Container();
	readonly main = new Container();
	private readonly sprite: SkinSprite;

	constructor(ctx: RenderContext, accent: Rgba) {
		const spec = ctx.pieces.slider.reverseArrow;
		this.sprite = new SkinSprite(ctx.skinTexture, spec);
		const fromFloor = spec.kind === "textured" && spec.texture.sourceId === "classic";
		const bright = accent.r + accent.g + accent.b > LEGACY_REVERSE_BRIGHT_THRESHOLD;
		this.sprite.drawable.tint = fromFloor && bright ? 0x000000 : 0xffffff;
		this.main.addChild(this.sprite.view);
		this.view.addChild(this.main);
	}
}
