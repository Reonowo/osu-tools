// argon cursor + trail. citations: argoncursor.cs:16-80 (visual; the dot's
// glow is additive per compositedrawable.drawnode.cs:142, EdgeEffectType.Glow),
// skinnablecursor.cs:9-30 (press-expand), osucursor.cs:25 (size),
// osuconfigmanager.cs:115-117 (cursor scale fixed at 1.0 by default). the
// trail's own geometry and fade live in trail-parts.ts -- this drawable only
// draws whatever that yields for the current time

import { Container, Sprite } from "pixi.js";
import { CURSOR_SIZE } from "../../engine/argon";
import { darken, fromHex, toNumber } from "../../engine/color";
import { outElasticHalf, outQuad } from "../../engine/easing";
import { cursorStateAt } from "../../engine/interpolation";
import { isLeft, isRight } from "../../engine/buttons";
import { jump, trackValueAt, tracksWithin, tween, type Track } from "../../engine/transforms";
import type { FrameDto } from "../../lib/scene-types";
import type { ObjectDrawable, RenderContext } from "../GameplayRenderer";
import { ARGON_TRAIL, buildTrailPath, trailPartsAt, type TrailPath } from "./trail-parts";

export function holdIntervals(frames: FrameDto[]): { start: number; end: number }[] {
	const intervals: { start: number; end: number }[] = [];
	let openStart: number | null = null;
	for (const frame of frames) {
		const held = isLeft(frame.buttons) || isRight(frame.buttons);
		if (held && openStart === null) openStart = frame.time;
		if (!held && openStart !== null) {
			intervals.push({ start: openStart, end: frame.time });
			openStart = null;
		}
	}
	if (openStart !== null) intervals.push({ start: openStart, end: Number.POSITIVE_INFINITY });
	return intervals;
}

/** skinnablecursor.cs:14-23 -- Expand() unconditionally jumps ExpandTarget to
 * 1 first (a duration-less ScaleTo is an instant set), *then* queues the
 * elastic tween to 1.2 over 400ms OutElasticHalf; Contract() tweens back to
 * 1 over 400ms OutQuad, starting from whatever the *current* value actually
 * is at that moment. every interval is independent (start/end come straight
 * from the hold span, never a fixed timestamp shared across intervals), so
 * there is no cross-interval track-resurrection risk: trackValueAt's
 * "greatest start <= t" selection always lands on the current interval's
 * own tracks.
 *
 * a same-instant press+release (`start === end`, the duplicate-time-run
 * shape interpolation.ts already treats as real input -- two frames sharing
 * one timestamp, one pressed and one not) is the one degenerate case within
 * a single interval: naively pushing all three tracks lets the release tween
 * tie the press tween's start and win (later-in-array wins ties), snapping
 * the value to 1.2 and easing it back down as if a real press-and-hold had
 * just ended, even though nothing was ever visibly expanded. tracing
 * Expand()/Contract() by hand: Expand()'s instant jump lands the value at 1
 * with zero elapsed time, then Contract() immediately starts its own tween
 * *from that already-1 value* (ScaleTo always samples the drawable's current
 * value as its start) -- so it eases 1 -> 1, i.e. nothing moves. the fix
 * below reproduces that by emitting only the jump for a zero-duration
 * interval, skipping both tweens entirely */
export function expandTracks(intervals: { start: number; end: number }[]): Track[] {
	const tracks: Track[] = [];
	for (const { start, end } of intervals) {
		tracks.push(jump(start, 1));
		if (start === end) continue;
		const press = tween(start, 400, 1, 1.2, outElasticHalf);
		tracks.push(press);
		if (Number.isFinite(end)) {
			// contract()'s scaleto samples the current value: a release mid-
			// expansion eases down from wherever the elastic actually got to,
			// never from an assumed-complete 1.2
			tracks.push(tween(end, 400, trackValueAt([press], end, 1), 1, outQuad));
		}
	}
	return tracks;
}

// argoncursor.cs:33,49 -- fixed pixel border thicknesses (unlike the default
// skin's cursor, argon's aren't relative to CURSOR_SIZE)
const RING_BORDER_OUTER = 6;
const RING_BORDER_INNER = 2;
/** argoncursor.cs:68 -- the centre dot's Scale, relative to the 28px cursor */
const DOT_RELATIVE_SCALE = 0.2;
/** argoncursor.cs:73 -- EdgeEffectParameters.Radius on the dot's glow */
const DOT_GLOW_RADIUS = 20;
/** argoncursor.cs:63-69 -- the centre dot's own diameter */
const DOT_SIZE = CURSOR_SIZE * DOT_RELATIVE_SCALE;
/** the dot plus the glow's radius on either side */
const DOT_GLOW_SIZE = DOT_SIZE + 2 * DOT_GLOW_RADIUS;

/** argoncursortrail.cs:22 -- Scale = 0.8/Texture.ScaleAdjust, folded with an
 * assumed 64 osu!px DisplayWidth stand-in for the real Cursor/cursortrail
 * texture (not present in the pinned checkout; see the task brief) */
const TRAIL_PART_SIZE = 64 * 0.8;

export class CursorDrawable implements ObjectDrawable {
	readonly view = new Container();
	/** the ring/dot piece, repositioned to the live cursor position every
	 * frame (see update()) */
	private readonly cursorSprite = new Container();
	private readonly expandTarget = new Container();
	/** trail parts are positioned in absolute playfield space, so this
	 * container is never itself moved -- unlike cursorSprite, it stays a
	 * direct child of the unmoved `view` */
	private readonly trailLayer = new Container();
	/** the dot's additive glow, kept as a field only so the cursorGlow effect
	 * can hide it -- the dot and ring underneath it never hide */
	private readonly glow: Sprite;
	private readonly expand: Track[];
	private readonly frames: FrameDto[];
	private readonly trail: TrailPath;
	/** one sprite per part slot, grown on demand and reused frame to frame.
	 * they carry no trail state of their own: every frame overwrites position,
	 * size and alpha from trailPartsAt's output, which is what makes a
	 * rebuilt drawable indistinguishable from one that has run all along */
	private readonly partSprites: Sprite[] = [];

	constructor(private readonly ctx: RenderContext) {
		this.frames = ctx.scene.frames;
		this.expand = expandTracks(holdIntervals(this.frames));
		this.trail = buildTrailPath(this.frames);

		// `view` itself is never repositioned and stays a real parent of both
		// pieces, so a single destroy() call releases everything -- attaching
		// trailLayer as a sibling straight to ctx.layers.cursor instead would
		// leave it outside this drawable's tracked view, relying on the
		// layer's own removeChildren() (a detach, not a destroy) for cleanup.
		// trailLayer is added first so the trail draws under the ring/dot
		this.view.addChild(this.trailLayer, this.cursorSprite);
		ctx.layers.cursor.addChild(this.view);

		// the cursor's own size and position are already in playfield osu!px;
		// unlike hit objects it does not apply renderPlan.scale -- CURSOR_SIZE
		// is a fixed UI constant (osucursor.cs:25), not CS-derived

		// ring stack: a CURSOR_SIZE osu!px box, canvas-drawn at whatever the
		// current density bucket supersamples that to
		const ring = new Sprite(
			ctx.textures.canvasTexture(CURSOR_SIZE, "argon-cursor", (c, size) => {
				const s = size / CURSOR_SIZE;
				const radius = CURSOR_SIZE / 2;
				// fill disc: fc618f darkened x0.625 at 0.4 alpha, spans the full ring (argoncursor.cs:37-42)
				const fill = darken(fromHex("FC618F"), 0.6);
				c.fillStyle = `rgba(${Math.round(fill.r * 255)}, ${Math.round(fill.g * 255)}, ${Math.round(fill.b * 255)}, 0.4)`;
				c.beginPath();
				c.arc(size / 2, size / 2, radius * s - 1, 0, Math.PI * 2);
				c.fill();
				// outer ring: 6px border, vertical gradient fc618f -> bb1a41 (argoncursor.cs:33-34)
				const gradient = c.createLinearGradient(0, 0, 0, size);
				gradient.addColorStop(0, "#FC618F");
				gradient.addColorStop(1, "#BB1A41");
				c.strokeStyle = gradient;
				c.lineWidth = RING_BORDER_OUTER * s;
				c.beginPath();
				c.arc(size / 2, size / 2, (radius - RING_BORDER_OUTER / 2) * s, 0, Math.PI * 2);
				c.stroke();
				// inner white ring: 2px at 0.8 alpha, immediately inside the outer border (argoncursor.cs:49-50)
				c.strokeStyle = "rgba(255, 255, 255, 0.8)";
				c.lineWidth = RING_BORDER_INNER * s;
				c.beginPath();
				c.arc(size / 2, size / 2, (radius - RING_BORDER_OUTER - RING_BORDER_INNER / 2) * s, 0, Math.PI * 2);
				c.stroke();
			})
		);
		ring.anchor.set(0.5);
		ring.width = ring.height = CURSOR_SIZE;
		this.expandTarget.addChild(ring);

		// centre dot: a fixed-size white core (argoncursor.cs:63-69) with an
		// additive cyan glow behind it (argoncursor.cs:70-75); the dot itself
		// is not a child of expandTarget, so it never scales on press
		this.glow = new Sprite(ctx.textures.glowTexture(DOT_GLOW_SIZE, DOT_SIZE / 2 / (DOT_GLOW_SIZE / 2)));
		this.glow.anchor.set(0.5);
		this.glow.width = this.glow.height = DOT_GLOW_SIZE;
		this.glow.tint = toNumber(fromHex("ABFFFF"));
		this.glow.alpha = 100 / 255; // argoncursor.cs:74 -- Color4(171, 255, 255, 100), a byte alpha
		this.glow.blendMode = "add"; // compositedrawable.drawnode.cs:142 -- EdgeEffectType.Glow blends additively
		const dot = new Sprite(ctx.textures.circleTexture(DOT_SIZE));
		dot.anchor.set(0.5);
		dot.width = dot.height = DOT_SIZE;

		this.cursorSprite.addChild(this.expandTarget, this.glow, dot);
	}

	private partSprite(index: number): Sprite {
		let sprite = this.partSprites[index];
		if (sprite === undefined) {
			sprite = new Sprite(this.ctx.textures.glowTexture(TRAIL_PART_SIZE, 0.1));
			sprite.anchor.set(0.5);
			sprite.blendMode = "add"; // argoncursortrail.cs:24 -- BlendingParameters.Additive
			this.trailLayer.addChild(sprite);
			this.partSprites[index] = sprite;
		}
		return sprite;
	}

	private hidePartsFrom(index: number): void {
		for (let i = index; i < this.partSprites.length; i += 1) this.partSprites[i].visible = false;
	}

	update(t: number): void {
		const state = cursorStateAt(this.frames, t);
		if (state === null) return;
		this.cursorSprite.position.set(state.x, state.y);
		this.expandTarget.scale.set(trackValueAt(this.expand, t, 1));

		// the ring, dot and press expansion above are the cursor itself and are
		// never gated; only the glow and the trail are effects
		const effects = this.ctx.getEffects();
		this.glow.visible = effects.cursorGlow;
		this.trailLayer.visible = effects.cursorTrail;
		if (!effects.cursorTrail) {
			// a disabled trail draws nothing rather than freezing the last set:
			// the parts are recomputed from scratch anyway, so re-enabling picks
			// up the trail behind wherever the cursor is now
			this.hidePartsFrom(0);
			return;
		}

		const parts = trailPartsAt(this.trail, t, ARGON_TRAIL);
		// a part keeps the press expansion the cursor had when it passed, so a
		// press leaves a visibly fatter streak behind it. narrowed to the fade
		// window first: trackValueAt scans the whole track set, and a replay's
		// hold intervals run to thousands while a window holds a handful
		const expandInWindow = tracksWithin(this.expand, parts[0]?.bornAt ?? t, t);
		for (let i = 0; i < parts.length; i += 1) {
			const part = parts[i];
			const sprite = this.partSprite(i);
			sprite.visible = true;
			sprite.position.set(part.x, part.y);
			sprite.alpha = part.alpha;
			sprite.width = sprite.height = TRAIL_PART_SIZE * trackValueAt(expandInWindow, part.bornAt, 1);
		}
		this.hidePartsFrom(parts.length);
	}

	destroy(): void {
		// trailLayer is a child of view, so this one call releases every pooled
		// sprite (live and recycled alike -- recycled ones stay attached, just
		// hidden) plus the ring/glow/dot. nothing here is a raw Graphics with
		// its own GraphicsContext, so {children: true} alone is sufficient --
		// every piece is a Sprite over a cached texture.ts texture, which this
		// does not (and must not) destroy
		this.view.destroy({ children: true });
	}
}
