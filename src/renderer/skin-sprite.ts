// one skin element, drawn: the sprite (or frame set) a `PieceSpec` names,
// sized in playfield osu!px.
//
// every legacy piece is built from this, which is what keeps the era's own
// drawing code down to composition and tinting. three things it owns and no
// caller should repeat:
//
// - **the resolution factor.** a lookup carries one out per frame
//   (`ResolvedTexture.resolutionFactors`), so an `@2x` asset is drawn at half
//   its pixel size and lands the same osu!px as its 1x sibling would have. this
//   is the whole of the `@2x` handling: nothing rebakes, nothing re-decodes.
// - **the frame selection.** an animation's frame is a pure function of the
//   time asked for, so a seek shows the frame that moment actually had rather
//   than resuming wherever playback left off.
// - **the missing texture.** a spec can name a url that failed to load, which
//   draws as nothing rather than as an error -- the same posture a stale skin
//   locator gets.

import { Container, Sprite, Texture } from "pixi.js";
import type { PieceSpec } from "@/skin/pieces";
import type { SkinTextureLookup } from "./skin-textures";

export interface SkinSpriteOptions {
	/**
	 * divides the texture's own display size.
	 *
	 * nonplayfieldsprite.cs:23's stable "magic ratio" and nothing else: the
	 * cursor and its trail are drawn inside the playfield but were historically
	 * not part of it, so their art is 1.6x smaller in playfield space than a hit
	 * object's. everything else leaves this at 1
	 */
	scaleAdjust?: number;
	/** 0.5 centres the sprite on its position, 0 origins it at the top-left --
	 * which is what `CursorCentre: 0` asks for */
	anchor?: number;
	/** whether an animation restarts after its last frame or holds it */
	loop?: boolean;
	/**
	 * overrides the spec's own frame length.
	 *
	 * exactly one element needs this and it is worth saying which: the slider
	 * ball's frame delay is derived from the SLIDER's velocity rather than from
	 * the skin (legacysliderball.cs:118-120), so a fast slider's ball spins
	 * faster. every other element takes the length the lookup resolved
	 */
	frameLength?: number;
}

/** one frame, already sized: the resolution factor is per FRAME, because lazer
 * writes `ScaleAdjust` per texture (legacyskin.cs:560-580). a set that is `@2x`
 * in some frames and not others plays in full, each frame at its own scale */
interface SkinFrame {
	texture: Texture;
	width: number;
	height: number;
}

/**
 * the drawn form of one piece spec.
 *
 * always constructible, including from a `hidden` spec: a drawable that has to
 * branch on whether a piece exists before it can lay itself out is a drawable
 * that has to know about eras, and the whole point of the piece seam is that it
 * does not. an empty one simply draws nothing and measures zero
 */
export class SkinSprite {
	readonly view = new Container();
	private readonly sprite = new Sprite();
	private readonly frames: SkinFrame[] = [];
	private readonly frameLength: number;
	private readonly loop: boolean;

	constructor(lookup: SkinTextureLookup, spec: PieceSpec, options: SkinSpriteOptions = {}) {
		const scaleAdjust = options.scaleAdjust ?? 1;
		this.loop = options.loop ?? (spec.kind === "textured" && spec.loop);
		this.frameLength = options.frameLength ?? (spec.kind === "textured" ? spec.frameLength : 0);

		if (spec.kind === "textured") {
			for (let index = 0; index < spec.texture.frames.length; index += 1) {
				const texture = lookup(spec.texture.frames[index]);
				// a frame that failed to load drops the whole set rather than
				// leaving a hole mid-animation: a one-frame gap reads as a flicker
				// the skin did not ask for
				if (texture === null) {
					this.frames.length = 0;
					break;
				}
				const factor = (spec.texture.resolutionFactors[index] ?? 1) * scaleAdjust;
				this.frames.push({ texture, width: texture.width / factor, height: texture.height / factor });
			}
		}

		this.sprite.anchor.set(options.anchor ?? 0.5);
		if (this.frames.length > 0) {
			this.show(this.frames[0]);
			this.view.addChild(this.sprite);
		}
	}

	private show(frame: SkinFrame): void {
		this.sprite.texture = frame.texture;
		this.sprite.width = frame.width;
		this.sprite.height = frame.height;
	}

	/** the osu!px size of frame zero, which is what a caller lays out against.
	 * zero when nothing loaded */
	get width(): number {
		return this.frames[0]?.width ?? 0;
	}

	get height(): number {
		return this.frames[0]?.height ?? 0;
	}

	/** whether this piece draws anything at all */
	get empty(): boolean {
		return this.frames.length === 0;
	}

	/** whether the answer was an actual frame set rather than a lone sprite */
	get animated(): boolean {
		return this.frames.length > 1;
	}

	/**
	 * shows the frame `elapsed` ms into the animation.
	 *
	 * a pure function of the time asked for, with no per-call state: a seek
	 * lands on the frame that moment genuinely had, and a drawable rebuilt
	 * mid-playback (which a density move does to every scene-lifetime one) is
	 * indistinguishable from one that has run all along
	 */
	setElapsed(elapsed: number): void {
		if (this.frames.length < 2 || !(this.frameLength > 0)) return;
		const step = Math.floor(Math.max(0, elapsed) / this.frameLength);
		const index = this.loop ? step % this.frames.length : Math.min(step, this.frames.length - 1);
		const frame = this.frames[index];
		if (this.sprite.texture !== frame.texture) this.show(frame);
	}

	/** the sprite itself, for the tint and blend a caller owns */
	get drawable(): Sprite {
		return this.sprite;
	}

	destroy(): void {
		// the textures belong to the skin texture store and outlive this sprite;
		// destroying them here would blank every other drawable holding one
		this.view.destroy({ children: true });
	}
}
