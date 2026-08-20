// the cursor: one era-invariant drawable over two pieces.
//
// what stays here is timing and input -- where the cursor is at t, when it was
// pressed, and what the trail looks like for that -- because none of that is a
// skin's to decide. what swaps is the PIECE: argon's procedural ring and dot
// (argoncursor.cs:16-80; the dot's glow is additive per
// compositedrawable.drawnode.cs:142, EdgeEffectType.Glow) or a legacy skin's
// `cursor` and `cursormiddle` sprites (legacycursor.cs). the two press
// expansions are different curves and both live below, next to the piece they
// belong to.
//
// citations for the shared half: osucursor.cs:25 (size),
// osuconfigmanager.cs:115-117 (cursor scale fixed at 1.0 by default). the
// trail's own geometry and fade live in trail-parts.ts -- this drawable only
// draws whatever that yields for the current time

import { Container, Sprite, type Texture } from "pixi.js";
import { CURSOR_SIZE } from "@/engine/game-constants";
import {
	LEGACY_CURSOR_EXPAND_DURATION,
	LEGACY_CURSOR_PRESSED_SCALE,
	LEGACY_CURSOR_RELEASED_SCALE,
	LEGACY_CURSOR_REVOLUTION_DURATION,
	NON_PLAYFIELD_SCALE_ADJUST
} from "@/skin/legacy/constants";
import type { CursorPieces } from "@/skin/pieces";
import { darken, fromHex, toNumber } from "../../engine/color";
import { out, outElasticHalf, outQuad } from "../../engine/easing";
import { cursorStateAt } from "../../engine/interpolation";
import { isLeft, isRight } from "../../engine/buttons";
import { jump, trackValueAt, tracksWithin, tween, type Track } from "../../engine/transforms";
import type { FrameDto } from "../../lib/scene-types";
import type { ObjectDrawable, RenderContext } from "../GameplayRenderer";
import { texturedPiece } from "./circle";
import { SkinSprite } from "../skin-sprite";
import {
	ARGON_TRAIL,
	buildTrailPath,
	legacyTrailShape,
	trailPartsAt,
	type TrailPath,
	type TrailShape
} from "./trail-parts";

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

/**
 * legacycursor.cs:60-69 -- the same shape as argon's and none of the same
 * numbers: `ScaleTo(1)` then `ScaleTo(1.3, 100, Easing.Out)` on press, and
 * `ScaleTo(1, 100, Easing.Out)` from wherever it got to on release.
 *
 * the degenerate same-instant press-and-release is handled exactly as argon's
 * is, and for the identical reason: `Expand()`'s instant set leaves the value
 * at 1, so `Contract()` eases 1 -> 1 and nothing moves
 */
export function legacyExpandTracks(intervals: { start: number; end: number }[]): Track[] {
	const tracks: Track[] = [];
	for (const { start, end } of intervals) {
		tracks.push(jump(start, LEGACY_CURSOR_RELEASED_SCALE));
		if (start === end) continue;
		const press = tween(
			start,
			LEGACY_CURSOR_EXPAND_DURATION,
			LEGACY_CURSOR_RELEASED_SCALE,
			LEGACY_CURSOR_PRESSED_SCALE,
			out
		);
		tracks.push(press);
		if (Number.isFinite(end)) {
			tracks.push(
				tween(
					end,
					LEGACY_CURSOR_EXPAND_DURATION,
					trackValueAt([press], end, LEGACY_CURSOR_RELEASED_SCALE),
					LEGACY_CURSOR_RELEASED_SCALE,
					out
				)
			);
		}
	}
	return tracks;
}

/**
 * legacycursor.cs:14,56-57 -- `ExpandTarget.Spin(REVOLUTION_DURATION,
 * Clockwise)`, one turn every ten seconds.
 *
 * anchored at replay time zero rather than at the drawable's own creation,
 * which lazer's `Spin` uses. that is a deliberate divergence and the only one
 * available: a replay viewer seeks, and an angle measured from when the
 * drawable happened to be built would differ between watching a moment and
 * seeking to it
 */
export function cursorSpinAngle(t: number): number {
	return ((t % LEGACY_CURSOR_REVOLUTION_DURATION) / LEGACY_CURSOR_REVOLUTION_DURATION) * Math.PI * 2;
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

/**
 * what the drawable needs from whichever piece is installed.
 *
 * three verbs and no more: the piece owns its own art and nothing about when
 * the cursor moved, was pressed, or was seeked to
 */
interface CursorPiece {
	readonly view: Container;
	/** the press expansion, applied to whatever part of the piece expands */
	setExpand(scale: number): void;
	/** the slow revolution, in radians. ignored by a piece that does not spin */
	setSpin(radians: number): void;
	/** the cursorGlow effect's one target */
	setGlowVisible(visible: boolean): void;
	/** how the press expansion is derived from the hold intervals */
	readonly expandTracks: (intervals: { start: number; end: number }[]) => Track[];
	/** one trail part sprite, or null when the piece draws no trail */
	createTrailPart(): Sprite | null;
	/** the trail this piece's era draws, given the part it just created */
	trailShape(part: Sprite | null): TrailShape;
}

class ArgonCursorPiece implements CursorPiece {
	readonly view = new Container();
	readonly expandTracks = expandTracks;
	private readonly expandTarget = new Container();
	/** the dot's additive glow, kept as a field only so the cursorGlow effect
	 * can hide it -- the dot and ring underneath it never hide */
	private readonly glow: Sprite;

	constructor(private readonly ctx: RenderContext) {
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

		this.view.addChild(this.expandTarget, this.glow, dot);
	}

	setExpand(scale: number): void {
		this.expandTarget.scale.set(scale);
	}

	setSpin(): void {
		// argon's cursor does not revolve
	}

	setGlowVisible(visible: boolean): void {
		this.glow.visible = visible;
	}

	createTrailPart(): Sprite {
		const sprite = new Sprite(this.ctx.textures.glowTexture(TRAIL_PART_SIZE, 0.1));
		sprite.anchor.set(0.5);
		sprite.blendMode = "add"; // argoncursortrail.cs:24 -- BlendingParameters.Additive
		sprite.width = sprite.height = TRAIL_PART_SIZE;
		return sprite;
	}

	trailShape(): TrailShape {
		return ARGON_TRAIL;
	}
}

/**
 * legacycursor.cs -- `cursor` under `cursormiddle`, with the middle never
 * spinning and never expanding.
 *
 * the two sprites are drawn at their texture's own size divided by the stable
 * magic ratio (nonplayfieldsprite.cs:23), which is what puts a classic cursor
 * at the size it is in game rather than at argon's 28 osu!px
 */
class LegacyCursorPiece implements CursorPiece {
	readonly view = new Container();
	readonly expandTracks = legacyExpandTracks;
	private readonly expandTarget = new Container();
	private readonly cursor: SkinSprite;
	private readonly middle: SkinSprite;
	private readonly pieces: CursorPieces;
	/** the trail's own texture and its osu!px size, read once. held as three
	 * values rather than as a `SkinSprite` because the trail is drawn by many
	 * pooled sprites and none of them is this one -- keeping the source sprite
	 * alive would leave a container outside this piece's tracked view for
	 * `destroy()` to miss */
	private readonly trailTexture: { texture: Texture; width: number; height: number } | null;

	constructor(ctx: RenderContext, pieces: CursorPieces) {
		this.pieces = pieces;
		// legacycursor.cs:43,49 -- CursorCentre: 0 origins BOTH sprites at their
		// top-left rather than their centre, which is how some skins align art
		// that is deliberately off-centre
		const anchor = pieces.centre ? 0.5 : 0;
		this.cursor = new SkinSprite(ctx.skinTexture, pieces.cursor, {
			anchor,
			scaleAdjust: NON_PLAYFIELD_SCALE_ADJUST
		});
		this.middle = new SkinSprite(ctx.skinTexture, pieces.middle, {
			anchor,
			scaleAdjust: NON_PLAYFIELD_SCALE_ADJUST
		});
		this.expandTarget.addChild(this.cursor.view);
		this.view.addChild(this.expandTarget, this.middle.view);
		// read once rather than per part: every part shares one texture, and the
		// trail's interval is derived from that texture's own width
		const source = new SkinSprite(ctx.skinTexture, pieces.trail, { scaleAdjust: NON_PLAYFIELD_SCALE_ADJUST });
		this.trailTexture = source.empty
			? null
			: { texture: source.drawable.texture, width: source.width, height: source.height };
		// the sprite itself was only a measuring stick; the TEXTURE belongs to the
		// skin texture store and outlives it
		source.destroy();
	}

	setExpand(scale: number): void {
		// osucursor.cs:120-125 -- Expand() returns early when the skin switched
		// CursorExpand off, so the press does nothing at all rather than being
		// applied and immediately undone
		this.expandTarget.scale.set(this.pieces.expand ? scale : LEGACY_CURSOR_RELEASED_SCALE);
	}

	setSpin(radians: number): void {
		// legacycursor.cs:56-57 -- only ExpandTarget spins, so the cursor middle
		// stays upright over a revolving cursor
		this.expandTarget.rotation = this.pieces.rotate ? radians : 0;
	}

	setGlowVisible(): void {
		// a legacy skin has no glow element: the halo is argon's own, and there
		// is nothing here for the toggle to hide
	}

	createTrailPart(): Sprite | null {
		if (this.trailTexture === null) return null;
		const sprite = new Sprite(this.trailTexture.texture);
		// legacycursortrail.cs:49-56 -- a disjoint trail origins by CursorCentre
		// and blends normally; a connected one is always centred and additive
		sprite.anchor.set(this.pieces.disjointTrail && !this.pieces.centre ? 0 : 0.5);
		if (!this.pieces.disjointTrail) sprite.blendMode = "add";
		sprite.width = this.trailTexture.width;
		sprite.height = this.trailTexture.height;
		return sprite;
	}

	trailShape(): TrailShape {
		return legacyTrailShape(this.trailTexture?.width ?? 0, this.pieces.disjointTrail);
	}
}

export class CursorDrawable implements ObjectDrawable {
	readonly view = new Container();
	/** the piece, repositioned to the live cursor position every frame */
	private readonly cursorSprite = new Container();
	/** trail parts are positioned in absolute playfield space, so this
	 * container is never itself moved -- unlike cursorSprite, it stays a
	 * direct child of the unmoved `view` */
	private readonly trailLayer = new Container();
	private readonly piece: CursorPiece;
	private readonly expand: Track[];
	private readonly frames: FrameDto[];
	private readonly trail: TrailPath;
	private readonly trailShape: TrailShape;
	/** whether a trail part turns with the cursor's own revolution
	 * (osucursorcontainer.cs:94 -- PartRotation is the cursor's CURRENT angle,
	 * not the angle the part was born at -- so a cursor that does not rotate
	 * leaves its trail unrotated too, whatever CursorTrailRotate says) */
	private readonly trailRotates: boolean;
	/** whether the trail parts take the press expansion the cursor had when it
	 * passed. every part takes the cursor's ACTUAL expanded scale at birth
	 * (osucursorcontainer.cs:93), so the gate is whether the cursor expands */
	private readonly trailExpands: boolean;
	/** one sprite per part slot, grown on demand and reused frame to frame.
	 * they carry no trail state of their own: every frame overwrites position,
	 * size and alpha from trailPartsAt's output, which is what makes a
	 * rebuilt drawable indistinguishable from one that has run all along */
	private readonly partSprites: Sprite[] = [];
	/** the prototype's two dimensions, kept apart: a legacy `cursortrail` need
	 * not be square, and writing one cached width into both would stretch every
	 * part into a square each frame */
	private readonly partWidth: number;
	private readonly partHeight: number;

	constructor(private readonly ctx: RenderContext) {
		this.frames = ctx.scene.frames;
		this.trail = buildTrailPath(this.frames);

		// off the cursor's own spec, not the skin's era: lazer gates the cursor
		// component on the source's own `cursor` texture
		// (osulegacyskintransformer.cs:209-213), so a beatmap shipping cursor art
		// over argon draws it. the trail rides the same fork because the piece
		// owns the trail part -- a beatmap shipping ONLY `cursortrail` keeps
		// argon whole rather than mixing one legacy part in
		const legacy = texturedPiece(ctx.pieces.cursor.cursor);
		this.piece = legacy ? new LegacyCursorPiece(ctx, ctx.pieces.cursor) : new ArgonCursorPiece(ctx);
		this.expand = this.piece.expandTracks(holdIntervals(this.frames));
		this.trailRotates = legacy && ctx.pieces.cursor.trailRotate && ctx.pieces.cursor.rotate;
		this.trailExpands = ctx.pieces.cursor.expand;

		// one prototype part decides the trail's own spacing, because the legacy
		// interval is derived from the trail texture's width (cursortrail.cs:201)
		const prototype = this.piece.createTrailPart();
		this.trailShape = this.piece.trailShape(prototype);
		this.partWidth = prototype?.width ?? 0;
		this.partHeight = prototype?.height ?? 0;
		prototype?.destroy();

		// `view` itself is never repositioned and stays a real parent of both
		// pieces, so a single destroy() call releases everything -- attaching
		// trailLayer as a sibling straight to ctx.layers.cursor instead would
		// leave it outside this drawable's tracked view, relying on the
		// layer's own removeChildren() (a detach, not a destroy) for cleanup.
		// trailLayer is added first so the trail draws under the piece
		this.cursorSprite.addChild(this.piece.view);
		this.view.addChild(this.trailLayer, this.cursorSprite);
		ctx.layers.cursor.addChild(this.view);
	}

	private partSprite(index: number): Sprite | null {
		let sprite = this.partSprites[index];
		if (sprite === undefined) {
			const created = this.piece.createTrailPart();
			if (created === null) return null;
			sprite = created;
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
		this.piece.setExpand(trackValueAt(this.expand, t, 1));
		this.piece.setSpin(cursorSpinAngle(t));

		// the piece itself is the cursor and is never gated; only the glow and
		// the trail are effects
		const effects = this.ctx.getEffects();
		this.piece.setGlowVisible(effects.cursorGlow);
		this.trailLayer.visible = effects.cursorTrail;
		if (!effects.cursorTrail) {
			// a disabled trail draws nothing rather than freezing the last set:
			// the parts are recomputed from scratch anyway, so re-enabling picks
			// up the trail behind wherever the cursor is now
			this.hidePartsFrom(0);
			return;
		}

		const parts = trailPartsAt(this.trail, t, this.trailShape);
		// a part keeps the press expansion the cursor had when it passed, so a
		// press leaves a visibly fatter streak behind it. narrowed to the fade
		// window first: trackValueAt scans the whole track set, and a replay's
		// hold intervals run to thousands while a window holds a handful
		const expandInWindow = this.trailExpands ? tracksWithin(this.expand, parts[0]?.bornAt ?? t, t) : [];
		const rotation = this.trailRotates ? cursorSpinAngle(t) : 0;
		for (let i = 0; i < parts.length; i += 1) {
			const part = parts[i];
			const sprite = this.partSprite(i);
			if (sprite === null) break;
			sprite.visible = true;
			sprite.position.set(part.x, part.y);
			sprite.alpha = part.alpha;
			sprite.rotation = rotation;
			const scale = this.trailExpands ? trackValueAt(expandInWindow, part.bornAt, 1) : 1;
			sprite.width = this.partWidth * scale;
			sprite.height = this.partHeight * scale;
		}
		this.hidePartsFrom(parts.length);
	}

	destroy(): void {
		// trailLayer is a child of view, so this one call releases every pooled
		// sprite (live and recycled alike -- recycled ones stay attached, just
		// hidden) plus whichever piece is installed. nothing here is a raw
		// Graphics with its own GraphicsContext, so {children: true} alone is
		// sufficient -- every piece is a Sprite over a texture this does not
		// (and must not) destroy, whether it was baked by textures.ts or loaded
		// into the skin texture store
		this.view.destroy({ children: true });
	}
}
