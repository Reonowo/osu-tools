// the spinner: one era-invariant drawable over two pieces.
//
// what stays in the drawable is rotation and progress -- a frontend-only
// integration of cursor angle deltas (spinnerrotationtracker.cs:63-111 without
// damping), with progress preferring the simulation's spinnerspin events. what
// swaps is the piece.
//
// the two eras are DELIBERATELY asymmetric here and the asymmetry is recorded
// rather than resolved (TODO.md). argon's spinner is a judgement-correct
// placeholder: finishing it is a stack of ticks, progress arcs and a rotation
// counter. the legacy spinner below is sprite composition and cheap, so it is
// implemented completely -- both of its layouts.

import { Container, Graphics } from "pixi.js";
import {
	SPINNER_APPROACH_END_SCALE,
	SPINNER_APPROACH_SCALE,
	SPINNER_BACKGROUND_DEFAULT,
	SPINNER_BOX_HEIGHT,
	SPINNER_BOX_WIDTH,
	SPINNER_BOX_Y_OFFSET,
	SPINNER_FINAL_METRE_HEIGHT,
	SPINNER_GLOW_COLOUR,
	SPINNER_METRE_BARS,
	SPINNER_SPRITE_SCALE,
	SPINNER_TOP_OFFSET,
	SPINNER_Y_CENTRE
} from "@/skin/legacy/constants";
import type { SpinnerPieces } from "@/skin/pieces";
import { SIXTY_FRAME_TIME } from "@/skin/texture-sources";
import { fromBytes, toNumber } from "../../engine/color";
import { out } from "../../engine/easing";
import { SkinSprite } from "../skin-sprite";
import { SPINNER_FADE_OUT_TIME } from "../../engine/game-constants";
import { isLeft, isRight } from "../../engine/buttons";
import { cursorStateAt } from "../../engine/interpolation";
import { jump, trackValueAt, tween, type Track } from "../../engine/transforms";
import type { FrameDto } from "../../lib/scene-types";
import type { ObjectDrawable, RenderContext } from "../GameplayRenderer";

export function spinnerRotationSamples(
	frames: FrameDto[],
	startTime: number,
	endTime: number
): { times: number[]; cumulative: number[] } {
	const times: number[] = [];
	const cumulative: number[] = [];
	let total = 0;
	let lastAngle: number | null = null;
	for (const frame of frames) {
		const angle = -(Math.atan2(frame.x - 256, frame.y - 192) * 180) / Math.PI;
		const inWindow = frame.time >= startTime && frame.time < endTime;
		const holding = isLeft(frame.buttons) || isRight(frame.buttons);
		if (lastAngle !== null && inWindow && holding) {
			let delta = angle - lastAngle;
			if (delta > 180) delta -= 360;
			if (delta < -180) delta += 360;
			total += delta;
		}
		lastAngle = angle;
		times.push(frame.time);
		cumulative.push(Math.abs(total));
	}
	return { times, cumulative };
}

function sampleAt(samples: { times: number[]; cumulative: number[] }, t: number): number {
	let lo = 0,
		hi = samples.times.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (samples.times[mid] <= t) lo = mid + 1;
		else hi = mid;
	}
	return lo === 0 ? 0 : samples.cumulative[lo - 1];
}

/** what the drawable hands its piece every frame. everything here is the
 * OBJECT's -- where the play is, not what it looks like */
export interface SpinnerState {
	t: number;
	/** clockwise degrees the tracker has integrated */
	rotation: number;
	/** 0-1, how much of the required spinning is done */
	progress: number;
	/** when the spinner was completed, or null if it never was */
	completedAt: number | null;
}

export interface SpinnerPiece {
	readonly view: Container;
	apply(state: SpinnerState): void;
}

/**
 * legacyspinner.cs's shared window-space frame.
 *
 * every constant in the two legacy layouts is measured in stable's 640x480
 * WINDOW space rather than the 512x384 playfield, and lazer reproduces that by
 * sizing the spinner 640x480 and positioning it at (0, -8) from the playfield's
 * centre (:52-55). this renderer draws in playfield osu!px, where window space
 * is 1:1, so the same frame is one fixed offset -- computed here once rather
 * than folded into every constant
 */
const SPINNER_ORIGIN = {
	x: 256 - SPINNER_BOX_WIDTH / 2,
	y: 192 - SPINNER_BOX_HEIGHT / 2 + SPINNER_BOX_Y_OFFSET
};
const SPINNER_CENTRE = { x: SPINNER_ORIGIN.x + SPINNER_BOX_WIDTH / 2, y: SPINNER_ORIGIN.y + SPINNER_Y_CENTRE };

function clamp01(value: number): number {
	return Math.min(1, Math.max(0, value));
}

interface SpinnerTiming {
	startTime: number;
	endTime: number;
	fadeIn: number;
}

/**
 * the parts both legacy layouts share (legacyspinner.cs:46-108): the "spin!"
 * prompt and the "clear!" flash.
 *
 * what is NOT here, deliberately: the bonus-score counter and the spins-per-
 * minute readout. both are `LegacySpriteText(LegacyFont.Score)` and want the
 * skin's score font, which is heads-up-display skinning and out of scope for
 * this work -- recorded in TODO.md rather than half-drawn
 */
class LegacySpinnerChrome {
	readonly view = new Container();
	private readonly spin: SkinSprite;
	private readonly clear: SkinSprite;

	constructor(
		ctx: RenderContext,
		pieces: SpinnerPieces,
		private readonly timing: SpinnerTiming
	) {
		this.spin = new SkinSprite(ctx.skinTexture, pieces.spin);
		this.spin.view.scale.set(SPINNER_SPRITE_SCALE);
		this.spin.view.position.set(SPINNER_CENTRE.x, SPINNER_ORIGIN.y + SPINNER_TOP_OFFSET + 335);
		this.clear = new SkinSprite(ctx.skinTexture, pieces.clear);
		this.clear.view.position.set(SPINNER_CENTRE.x, SPINNER_ORIGIN.y + SPINNER_TOP_OFFSET + 115);
		this.view.addChild(this.spin.view, this.clear.view);
	}

	apply(state: SpinnerState): void {
		// :194-203 -- the prompt fades in over half the fade-in before the start
		// and out over min(400, duration) before the end
		const { startTime, endTime, fadeIn } = this.timing;
		const rising = clamp01((state.t - (startTime - fadeIn / 2)) / Math.max(1, fadeIn / 2));
		const outLength = Math.max(1, Math.min(400, endTime - startTime));
		const falling = 1 - clamp01((state.t - (endTime - outLength)) / outLength);
		this.spin.view.alpha = Math.min(rising, falling);

		// :151-168 -- "clear!" fades in over 400 from the completion, and pops
		// down from twice the sprite scale as it does
		const shown = state.completedAt === null ? 0 : clamp01((state.t - state.completedAt) / 400);
		this.clear.view.alpha = shown;
		this.clear.view.scale.set(SPINNER_SPRITE_SCALE * (2 - shown));
	}
}

/** legacyspinner.cs:197-198 -- the approach circle shrinks to a tenth of its
 * size across the spinner's whole duration */
function spinnerApproachScale(k: number): number {
	return SPINNER_SPRITE_SCALE * (SPINNER_APPROACH_SCALE + (SPINNER_APPROACH_END_SCALE - SPINNER_APPROACH_SCALE) * k);
}

/**
 * legacynewstylespinner.cs -- two spinning discs, a fixed overlay and a final
 * spinning overlay, with no background layer.
 *
 * chosen by ASSET PRESENCE (a spinner top with no spinner background), never by
 * the `[General] Version` field. the two mechanisms coexist in this work and
 * conflating them would pick the wrong layout for every skin that declares one
 * era and ships the other's assets -- see `SkinPieces.layout`
 */
class LegacyNewStyleSpinner implements SpinnerPiece {
	readonly view = new Container();
	private readonly scaleContainer = new Container();
	private readonly glow: SkinSprite;
	private readonly discBottom: SkinSprite;
	private readonly discTop: SkinSprite;
	private readonly spinningMiddle: SkinSprite;
	private readonly fixedMiddle: SkinSprite;
	private readonly approach: SkinSprite | null;
	private readonly chrome: LegacySpinnerChrome;
	private readonly timing: SpinnerTiming;

	constructor(ctx: RenderContext, pieces: SpinnerPieces, timing: SpinnerTiming) {
		this.timing = timing;
		this.glow = new SkinSprite(ctx.skinTexture, pieces.glow);
		this.glow.drawable.blendMode = "add";
		this.glow.drawable.tint = toNumber(fromBytes(SPINNER_GLOW_COLOUR));
		this.discBottom = new SkinSprite(ctx.skinTexture, pieces.bottom);
		this.discTop = new SkinSprite(ctx.skinTexture, pieces.top);
		this.spinningMiddle = new SkinSprite(ctx.skinTexture, pieces.middle2);
		this.fixedMiddle = new SkinSprite(ctx.skinTexture, pieces.middle);
		this.scaleContainer.addChild(
			this.glow.view,
			this.discBottom.view,
			this.discTop.view,
			this.spinningMiddle.view,
			this.fixedMiddle.view
		);
		this.scaleContainer.position.set(SPINNER_CENTRE.x, SPINNER_CENTRE.y);
		this.view.addChild(this.scaleContainer);

		// :81-93 -- the approach circle is added only when the spinner top came
		// from a real skin rather than the default legacy set. that provider test
		// is ported as "the classic floor answered", which is the same statement
		// in this chain's own terms
		const fromFloor = pieces.top.kind === "textured" && pieces.top.texture.sourceId === "classic";
		this.approach = fromFloor ? null : new SkinSprite(ctx.skinTexture, pieces.approachCircle);
		if (this.approach !== null) {
			this.approach.view.position.set(SPINNER_CENTRE.x, SPINNER_CENTRE.y);
			this.view.addChild(this.approach.view);
		}

		this.chrome = new LegacySpinnerChrome(ctx, pieces, timing);
		this.view.addChild(this.chrome.view);
	}

	apply(state: SpinnerState): void {
		// :139-147
		const turnRatio = this.spinningMiddle.empty ? 1 : 0.5;
		this.discTop.view.angle = state.rotation * turnRatio;
		this.spinningMiddle.view.angle = state.rotation;
		this.discBottom.view.angle = this.discTop.view.angle / 3;
		this.glow.view.alpha = state.progress;
		this.scaleContainer.scale.set(SPINNER_SPRITE_SCALE * (0.8 + out(state.progress) * 0.2));

		// :113-116 -- the fixed middle runs white to red across the spinner
		const k = clamp01((state.t - this.timing.startTime) / Math.max(1, this.timing.endTime - this.timing.startTime));
		this.fixedMiddle.drawable.tint = toNumber({ r: 1, g: 1 - k, b: 1 - k, a: 1 });
		this.approach?.view.scale.set(spinnerApproachScale(k));
		this.chrome.apply(state);
	}
}

/**
 * legacyoldstylespinner.cs -- one spinning disc over a background, with the
 * metre filling from below.
 *
 * chosen when the skin ships a spinner background, whatever else it has
 */
class LegacyOldStyleSpinner implements SpinnerPiece {
	readonly view = new Container();
	private readonly disc: SkinSprite;
	private readonly metreWindow = new Container();
	private readonly metre: SkinSprite;
	private readonly approach: SkinSprite;
	private readonly chrome: LegacySpinnerChrome;
	private readonly blink: boolean;
	private readonly timing: SpinnerTiming;

	constructor(ctx: RenderContext, pieces: SpinnerPieces, timing: SpinnerTiming) {
		this.blink = pieces.blink;
		this.timing = timing;

		// :43-46 -- tinted by the skin's SpinnerBackground colour, else a flat grey
		const background = new SkinSprite(ctx.skinTexture, pieces.background);
		background.drawable.tint = toNumber(fromBytes(pieces.backgroundTint ?? SPINNER_BACKGROUND_DEFAULT));
		background.view.scale.set(SPINNER_SPRITE_SCALE);
		background.view.position.set(SPINNER_CENTRE.x, SPINNER_CENTRE.y);

		this.disc = new SkinSprite(ctx.skinTexture, pieces.circle);
		this.disc.view.scale.set(SPINNER_SPRITE_SCALE);
		this.disc.view.position.set(SPINNER_CENTRE.x, SPINNER_CENTRE.y);

		// :56-71 -- "this anchor makes no sense, but that's what stable uses":
		// the metre hangs from the window box's own top-left rather than from
		// anywhere the art suggests
		this.metre = new SkinSprite(ctx.skinTexture, pieces.metre, { anchor: 0 });
		this.metre.view.scale.set(SPINNER_SPRITE_SCALE);
		const mask = new Graphics().rect(0, 0, SPINNER_BOX_WIDTH, SPINNER_FINAL_METRE_HEIGHT).fill(0xffffff);
		this.metreWindow.addChild(mask, this.metre.view);
		this.metreWindow.mask = mask;
		this.metreWindow.x = SPINNER_ORIGIN.x;

		this.approach = new SkinSprite(ctx.skinTexture, pieces.approachCircle);
		this.approach.view.position.set(SPINNER_CENTRE.x, SPINNER_CENTRE.y);

		this.chrome = new LegacySpinnerChrome(ctx, pieces, timing);
		this.view.addChild(background.view, this.disc.view, this.metreWindow, this.approach.view, this.chrome.view);
	}

	apply(state: SpinnerState): void {
		this.disc.view.angle = state.rotation;
		// :106-112 -- the window slides down and the sprite back up by the same
		// amount, so the metre appears to blink up from below rather than down
		// from above
		const height = this.metreHeight(state);
		this.metreWindow.y = SPINNER_ORIGIN.y + SPINNER_TOP_OFFSET + (SPINNER_FINAL_METRE_HEIGHT - height);
		this.metre.view.y = -(SPINNER_FINAL_METRE_HEIGHT - height);
		const k = clamp01((state.t - this.timing.startTime) / Math.max(1, this.timing.endTime - this.timing.startTime));
		this.approach.view.scale.set(spinnerApproachScale(k));
		this.chrome.apply(state);
	}

	/**
	 * legacyoldstylespinner.cs:117-131.
	 *
	 * the metre gains a bar every 10% and BLINKS the next one in with a
	 * probability equal to how far through that tenth the spinner is. lazer
	 * draws that from a live RNG, which a replay viewer cannot: the same moment
	 * has to look the same twice. the draw is therefore replaced by a hash of
	 * the 60fps frame the moment falls in -- the same flicker rate, and stable
	 * under a seek. a documented divergence, and the only kind available here
	 */
	private metreHeight(state: SpinnerState): number {
		let progress = state.progress * 100;
		// :121-123 -- the spinner should still blink at 100%
		if (this.blink) progress = Math.min(99, progress);
		let bars = Math.floor(progress / 10);
		if (this.blink) {
			const within = (progress % 10) / 10;
			const frame = Math.floor(state.t / SIXTY_FRAME_TIME);
			const noise = ((Math.imul(frame ^ 0x9e3779b9, 0x85ebca6b) >>> 0) % 1024) / 1024;
			if (noise < within) bars += 1;
		}
		return (bars / SPINNER_METRE_BARS) * SPINNER_FINAL_METRE_HEIGHT;
	}
}

/** the one place a spinner's era fork is taken. null where the skin ships
 * neither layout's assets, which draws argon's own placeholder instead */
export function createSpinnerPiece(ctx: RenderContext, timing: SpinnerTiming): SpinnerPiece | null {
	const pieces = ctx.pieces.spinner;
	if (pieces.layout === "new") return new LegacyNewStyleSpinner(ctx, pieces, timing);
	if (pieces.layout === "old") return new LegacyOldStyleSpinner(ctx, pieces, timing);
	return null;
}

export class SpinnerDrawable implements ObjectDrawable {
	readonly view = new Container();
	/** argon's placeholder disc, or null where a legacy layout drew instead */
	private readonly disc: Graphics | null;
	private readonly fill: Graphics | null;
	/** the container argon's placeholder lives in, kept separate so the legacy
	 * layouts can position themselves in window space off an unmoved view */
	private readonly placeholder = new Container();
	private readonly piece: SpinnerPiece | null;
	private readonly alphaTrack: Track[];
	private readonly rotation: { times: number[]; cumulative: number[] };
	private readonly spinTimes: number[];
	private readonly spinsRequired: number;
	private readonly startTime: number;
	private readonly endTime: number;
	private readonly frames: FrameDto[];
	/** simulation.status === "authoritative" -- gates whether spinTimes (the
	 * simulator's spinnerSpin judgements) or the local rotation integration
	 * drives progress (decision 5) */
	private readonly simulated: boolean;

	constructor(ctx: RenderContext, objectIndex: number) {
		const obj = ctx.scene.renderPlan.objects[objectIndex];
		const kind = obj.kind;
		if (kind.type !== "spinner") throw new Error("not a spinner");
		this.startTime = obj.startTime;
		this.endTime = obj.endTime;
		this.spinsRequired = kind.spinsRequired;
		this.frames = ctx.scene.frames;
		this.simulated = ctx.scene.simulation.status === "authoritative";
		this.rotation = spinnerRotationSamples(ctx.scene.frames, obj.startTime, obj.endTime);
		this.spinTimes = ctx.derived.judgementsByObject[objectIndex]
			.filter((e) => e.kind.type === "spinnerSpin")
			.map((e) => e.time);

		this.piece = createSpinnerPiece(ctx, {
			startTime: obj.startTime,
			endTime: obj.endTime,
			fadeIn: obj.fadeIn
		});
		if (this.piece !== null) {
			// the legacy layouts position every sprite in window space themselves,
			// so this drawable's own view stays at the playfield origin
			this.disc = null;
			this.fill = null;
			this.view.addChild(this.piece.view);
		} else {
			this.disc = new Graphics().circle(0, 0, 192).stroke({ width: 3, color: 0xffffff });
			this.fill = new Graphics().circle(0, 0, 184).fill(0xffffff);
			const centre = new Graphics().circle(0, 0, 40).stroke({ width: 6, color: 0xffffff });
			this.placeholder.addChild(this.fill, this.disc, centre);
			this.placeholder.position.set(256, 192);
			this.view.addChild(this.placeholder);
		}
		this.alphaTrack = [jump(obj.startTime - obj.preempt, 1), tween(obj.endTime, SPINNER_FADE_OUT_TIME, 1, 0)];
		ctx.layers.objects.addChild(this.view);
	}

	/** when the required spins were all landed, or null if they never were --
	 * what the legacy "clear!" flash keys on */
	private completedAt(): number | null {
		if (this.spinsRequired === 0) return this.startTime;
		if (!this.simulated) return null;
		return this.spinTimes.length >= this.spinsRequired ? this.spinTimes[this.spinsRequired - 1] : null;
	}

	private progressAt(t: number): number {
		// drawablespinner.cs:236-239: spinsRequired == 0 is unconditionally
		// complete, checked before any rotation/event data is consulted
		if (this.spinsRequired === 0) return 1;
		if (this.simulated) {
			const done = this.spinTimes.filter((time) => time <= t).length;
			return Math.min(1, done / this.spinsRequired);
		}
		return Math.min(1, sampleAt(this.rotation, t) / 360 / this.spinsRequired);
	}

	update(t: number): void {
		this.view.alpha = trackValueAt(this.alphaTrack, t, 0);
		const rotation = sampleAt(this.rotation, t);
		const progress = this.progressAt(t);
		if (this.piece !== null) {
			this.piece.apply({ t, rotation, progress, completedAt: this.completedAt() });
			return;
		}
		const sample = cursorStateAt(this.frames, t);
		const holding = sample !== null && (isLeft(sample.buttons) || isRight(sample.buttons));
		const state = t >= this.startTime && t < this.endTime && holding;
		this.disc!.alpha = state ? 0.4 : 0.2;
		this.fill!.alpha = state ? 0.4 : 0.2;
		this.fill!.scale.set(0.1 + 0.88 * progress);
		this.placeholder.rotation = (rotation * Math.PI) / 180;
	}

	destroy(): void {
		// disc/fill/centre are raw Graphics with their own owned GraphicsContext;
		// {children: true} alone does not free it (Graphics.destroy() in
		// scene/graphics/shared/Graphics.js only calls context.destroy() when
		// options === true or options?.context === true), so context: true is
		// required here too -- the same leak class task 15 shipped
		this.view.destroy({ children: true, context: true });
	}
}
