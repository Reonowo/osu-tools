// follow point connections (followpointconnection.cs:55-123,
// followpointlifetimeentry.cs:82-96), one era-invariant drawable over two
// pieces: the argon chevron (argonfollowpoint.cs: additive, #fc618f->#bb1a41
// gradient, 8px double chevron; drawn here as canvas glyphs -- decision 8) or
// the skin's own `followpoint`, animated.
//
// the CONNECTION is not skinnable and never was: the spacing, the preempt and
// the per-point fade come from the ruleset constants that were split out of the
// skin (engine/game-constants.ts), so a skin decides what a chevron looks like
// and nothing about where they go.
//
// the preference decides WHETHER: with follow points off the chain is never
// asked, so the spec here is already `hidden` and there is no lookup to make

import { Container, Sprite } from "pixi.js";
import { FOLLOW_POINT_PREEMPT, FOLLOW_POINT_SPACING, PREEMPT_MIN } from "../../engine/game-constants";
import { SkinSprite } from "../skin-sprite";
import { fromHex, toNumber } from "../../engine/color";
import { out } from "../../engine/easing";
import { trackValueAt, tween, type Track } from "../../engine/transforms";
import type { RenderObject } from "../../lib/scene-types";
import { ActiveSetTracker, reconcileActiveDrawables } from "../playfield";
import type { ObjectDrawable, RenderContext } from "../GameplayRenderer";

export interface FollowPointSpec {
	fromX: number;
	fromY: number;
	toX: number;
	toY: number;
	rotation: number;
	fadeInTime: number;
	fadeOutTime: number;
	fadeDuration: number;
}

function endPositionOf(obj: RenderObject): [number, number] {
	return obj.kind.type === "slider" ? obj.kind.endPosition : obj.position;
}

export function generateFollowPoints(objects: RenderObject[], globalScale: number): FollowPointSpec[] {
	void globalScale; // scale is applied by the drawable; specs stay in osu!px
	const specs: FollowPointSpec[] = [];
	for (let i = 0; i < objects.length - 1; i++) {
		const start = objects[i];
		const end = objects[i + 1];
		if (start.kind.type === "spinner" || end.kind.type === "spinner") continue;
		if (end.comboIndex !== start.comboIndex) continue; // new combo breaks the chain

		const [sx, sy] = endPositionOf(start);
		const [ex, ey] = end.position;
		const dx = ex - sx,
			dy = ey - sy;
		const distance = Math.trunc(Math.fround(Math.hypot(dx, dy)));
		const rotation = Math.atan2(dy, dx);
		const startTime = start.endTime;
		const duration = end.startTime - startTime;
		const preempt = FOLLOW_POINT_PREEMPT * Math.min(1, start.preempt / PREEMPT_MIN);

		for (
			let d = Math.trunc(FOLLOW_POINT_SPACING * 1.5);
			d < distance - FOLLOW_POINT_SPACING;
			d += FOLLOW_POINT_SPACING
		) {
			const fraction = d / distance;
			const fadeOutTime = startTime + fraction * duration;
			specs.push({
				fromX: sx + (fraction - 0.1) * dx,
				fromY: sy + (fraction - 0.1) * dy,
				toX: sx + fraction * dx,
				toY: sy + fraction * dy,
				rotation,
				fadeInTime: fadeOutTime - preempt,
				fadeOutTime,
				fadeDuration: end.fadeIn
			});
		}
	}
	return specs;
}

const CHEVRON_TOP = fromHex("FC618F");
/** the square the double chevron is drawn on, in osu!px: the glyph itself
 * spans ~45% of it, which lands argonfollowpoint.cs's 8px chevron with room
 * for its round caps */
const CHEVRON_SIZE = 12;

/** the per-point fade, move and pop, which are the connection's and not any
 * skin's -- both eras animate the identical envelope */
function followPointTracks(spec: FollowPointSpec): { alpha: Track[]; move: Track[]; scale: Track[] } {
	return {
		alpha: [tween(spec.fadeInTime, spec.fadeDuration, 0, 1), tween(spec.fadeOutTime, spec.fadeDuration, 1, 0)],
		move: [tween(spec.fadeInTime, spec.fadeDuration, 0, 1, out)],
		scale: [tween(spec.fadeInTime, spec.fadeDuration, 1.5, 1, out)]
	};
}

export class FollowPointsDrawable implements ObjectDrawable {
	readonly view = new Container();
	private readonly specs: FollowPointSpec[];
	private readonly tracker: ActiveSetTracker;
	private readonly sprites = new Map<
		number,
		{ view: Container; frames: SkinSprite | null; alpha: Track[]; move: Track[]; scale: Track[] }
	>();
	private readonly scale: number;

	constructor(private readonly ctx: RenderContext) {
		this.scale = ctx.scene.renderPlan.scale;
		this.specs = generateFollowPoints(ctx.scene.renderPlan.objects, this.scale);
		this.tracker = new ActiveSetTracker(
			this.specs.map((s) => ({
				appear: s.fadeInTime,
				vanish: s.fadeOutTime + s.fadeDuration
			}))
		);
		ctx.layers.followPoints.addChild(this.view);
	}

	update(t: number): void {
		// a pure visibility flip, like JudgementsDrawable's: the chevrons keep
		// being pooled and positioned while hidden, so re-enabling shows the
		// right frame immediately rather than a stale one
		this.view.visible = this.ctx.getEffects().followPoints;
		// reconcileActiveDrawables guards against re-creating an index the map
		// already holds -- load-bearing on a backward seek, where the tracker's
		// rebuild reports a chevron in `added` with no matching `removed` if it
		// was alive both before and after the seek (see playfield.ts). without
		// that guard the old chevron sprite stays orphaned as an untracked,
		// additively-blended child at its last position/alpha
		reconcileActiveDrawables(
			this.sprites,
			this.tracker.update(t),
			(index) => {
				const spec = this.specs[index];
				const piece = this.ctx.pieces.followPoint;
				if (piece.kind === "hidden") {
					// a skin's blank `followpoint` removed the element; falling
					// through to the chevron would resurrect exactly what that
					// blank asset removed. the empty entry keeps the tracker's
					// bookkeeping identical either way
					const view = new Container();
					this.view.addChild(view);
					return { view, frames: null, ...followPointTracks(spec) };
				}
				if (piece.kind === "textured") {
					// legacy follow points are NOT additive: the additive blend is
					// DefaultFollowPoint's own, not the element's
					const frames = new SkinSprite(this.ctx.skinTexture, piece);
					frames.view.rotation = spec.rotation;
					this.view.addChild(frames.view);
					return {
						view: frames.view,
						frames,
						...followPointTracks(spec)
					};
				}
				const sprite = new Sprite(
					this.ctx.textures.canvasTexture(CHEVRON_SIZE, "followpoint", (c, size) => {
						// the glyph is written as fractions of the canvas, which is
						// CHEVRON_SIZE osu!px at whatever the density bucket bakes
						const arm = size / 8;
						c.strokeStyle = "#fff";
						c.lineWidth = size / 8;
						c.lineCap = "round";
						const draw = (x: number) => {
							c.beginPath();
							c.moveTo(x - arm, size / 4);
							c.lineTo(x + arm, size / 2);
							c.lineTo(x - arm, (3 * size) / 4);
							c.stroke();
						};
						draw(size * 0.4);
						draw(size * 0.6);
					})
				);
				sprite.anchor.set(0.5);
				sprite.rotation = spec.rotation;
				sprite.tint = toNumber(CHEVRON_TOP);
				sprite.blendMode = "add";
				this.view.addChild(sprite);
				return { view: sprite, frames: null, ...followPointTracks(spec) };
			},
			(entry) => entry.view.destroy({ children: true })
		);
		for (const [index, entry] of this.sprites) {
			const spec = this.specs[index];
			const k = trackValueAt(entry.move, t, 0);
			entry.view.position.set(spec.fromX + (spec.toX - spec.fromX) * k, spec.fromY + (spec.toY - spec.fromY) * k);
			entry.view.alpha = trackValueAt(entry.alpha, t, 0);
			const s = trackValueAt(entry.scale, t, 1.5) * this.scale;
			// the argon texture measures CHEVRON_SIZE osu!px whatever bucket baked
			// it, and a skin sprite is already sized in osu!px, so the tracked
			// scale is the entire factor either way
			entry.view.scale.set(s);
			// osulegacyskintransformer.cs:160 -- startAtCurrentTime is FALSE, so
			// the animation runs from this connection's own appearance rather than
			// from wherever the clock happens to be
			entry.frames?.setElapsed(t - spec.fadeInTime);
		}
	}

	destroy(): void {
		this.view.destroy({ children: true });
	}
}
