// the slider drawable: body + head circle + ball/follow + arrows/ticks,
// all evaluated from pure tracks. argon draws no tail piece
// (drawableslidertail.cs -- circlepiece has no default drawable), so the
// tail is just the body's round cap

import { Container, Sprite } from "pixi.js";
import { toNumber } from "../../engine/color";
import { curvePositionAt } from "../../engine/slider-path";
import { trackValueAt, type Track } from "../../engine/transforms";
import type { JudgementEventDto, RenderNested, RenderSlider } from "../../lib/scene-types";
import type { ObjectDrawable, RenderContext } from "../GameplayRenderer";
import { SliderBodyRenderer } from "../slider/body";
import { APPROACH_CIRCLE_SIZE } from "../textures";
import { ArgonCirclePiece } from "./circle";
import { circleTracks, resolveCircleResult, type CircleTracks } from "./circle-tracks";
import { ArgonFollowCircle, ArgonReverseArrow, ArgonSliderBall, ArgonTick } from "./slider-parts";
import * as st from "./slider-tracks";

const NESTED_EVENT_KIND = {
	tick: "sliderTick",
	repeat: "sliderRepeat",
	tail: "sliderTail"
} as const;

function nestedResult(events: JudgementEventDto[], nested: RenderNested, simulated: boolean): "hit" | "miss" | null {
	if (!simulated) return null;
	const wanted = NESTED_EVENT_KIND[nested.kind as "tick" | "repeat" | "tail"];
	for (const event of events) {
		if (event.kind.type === wanted && Math.abs(event.time - nested.time) <= 1 && "hit" in event.kind) {
			return event.kind.hit ? "hit" : "miss";
		}
	}
	return "hit";
}

interface NestedPiece {
	nested: RenderNested;
	view: Container;
	alpha: Track[];
	scale: Track[] | null;
	arrow: ArgonReverseArrow | null;
	appear: number;
	/** only consulted for repeats (arrow !== null): gates repeatHitScale */
	result: "hit" | "miss" | null;
	/** mirrors drawablesliderrepeat.cs's `hasRotation`: true once
	 * position/rotation have been aimed from the curve at least once.
	 * mutable, unlike every other NestedPiece field -- needed because
	 * this drawable can be constructed lazily (a seek) at a t already past
	 * the repeat's own hit time, unlike lazer's continuous simulation where
	 * UpdateSnakingPosition always runs many frames before any repeat can
	 * be hit, so `Arrow.Rotation` is never left at its unset default there */
	aimed: boolean;
}

export class SliderDrawable implements ObjectDrawable {
	readonly view = new Container();
	private readonly obj;
	private readonly slider: RenderSlider;
	private readonly planScale: number;
	private readonly simulated: boolean;
	/** read once at construction, like the tracks it feeds: setEffects rebuilds
	 * the object drawables when this flips */
	private readonly hitAnimations: boolean;
	private readonly body: SliderBodyRenderer;
	private readonly head: ArgonCirclePiece;
	private readonly headTracks: CircleTracks;
	private readonly headHit: { time: number; miss: boolean };
	private readonly approach: Sprite;
	private readonly baseApproachScale: number;
	private readonly fades: { bodyAlpha: Track[]; containerAlpha: Track[] };
	private readonly ball: ArgonSliderBall;
	private readonly ballT: ReturnType<typeof st.ballTracks>;
	private readonly follow: ArgonFollowCircle;
	private readonly followT: ReturnType<typeof st.followCircleTracks>;
	private readonly pieces: NestedPiece[] = [];

	constructor(ctx: RenderContext, objectIndex: number) {
		const obj = ctx.scene.renderPlan.objects[objectIndex];
		const slider = obj.kind as RenderSlider;
		this.obj = obj;
		this.slider = slider;
		this.planScale = ctx.scene.renderPlan.scale;
		this.simulated = ctx.scene.simulation.status === "authoritative";
		this.hitAnimations = ctx.getEffects().hitAnimations;
		const accent = ctx.accents[objectIndex];
		const events = ctx.derived.judgementsByObject[objectIndex];

		this.view.position.set(obj.position[0], obj.position[1]);
		ctx.layers.objects.addChild(this.view);

		// body (head-relative coordinates; radius carries the cs scale)
		this.body = new SliderBodyRenderer(ctx.renderer, slider, accent, this.planScale);
		this.view.addChild(this.body.view);

		// head: a full argon circle without the outer fill (osuargonskintransformer.cs:
		// SliderHeadHitCircle -> ArgonMainCirclePiece(false)), judged by the
		// sliderHead event (falls back to hit-on-time, decision 5)
		const headResult = resolveCircleResult(events, obj.startTime);
		this.headHit = { time: headResult.time, miss: headResult.grade === "miss" };
		this.headTracks = circleTracks(obj, headResult, true, this.hitAnimations);
		this.head = new ArgonCirclePiece(ctx, accent, obj.indexInCombo, false);
		this.head.view.scale.set(this.planScale);
		this.view.addChild(this.head.view);

		// logical child of `view` (inherits position/scale and is released by
		// view.destroy()'s cascade); merely attached to the approach RenderLayer
		// so it draws above every object regardless of draw order -- addChild()
		// throws on a RenderLayer (task 13's circle.ts established this pattern)
		this.approach = new Sprite(ctx.textures.approachCircleTexture());
		this.approach.anchor.set(0.5);
		this.approach.tint = toNumber(accent);
		this.view.addChild(this.approach);
		ctx.layers.approach.attach(this.approach);
		// against the texture's *logical* size, not its canvas size: the bake
		// grows with the density bucket while the sprite must not
		this.baseApproachScale = this.planScale * (128 / APPROACH_CIRCLE_SIZE) * (128 / 118);

		// container + body fades; the aggregate event carries the end result
		const aggregate = events.find((e) => e.kind.type === "sliderAggregate");
		const aggregateKind = aggregate?.kind;
		this.fades = st.sliderFadeTracks(obj, {
			endTime: obj.endTime,
			aggregateMiss: aggregateKind?.type === "sliderAggregate" && aggregateKind.grade === "miss",
			headHitTime: this.headHit.miss ? null : this.headHit.time
		});

		// nested pieces (positions arrive stacked; store head-relative)
		for (const nested of slider.nested) {
			if (nested.kind === "head" || nested.kind === "tail") continue;
			const result = nestedResult(events, nested, this.simulated);
			const view = new Container();
			view.position.set(nested.position[0] - obj.position[0], nested.position[1] - obj.position[1]);
			view.scale.set(this.planScale);
			this.view.addChild(view);
			if (nested.kind === "tick") {
				const tick = new ArgonTick(accent);
				view.addChild(tick.view);
				const tracks = st.tickTracks(nested, result, this.hitAnimations);
				this.pieces.push({
					nested,
					view,
					alpha: tracks.alpha,
					scale: tracks.scale,
					arrow: null,
					appear: nested.time - nested.preempt,
					result,
					aimed: false
				});
			} else {
				const arrow = new ArgonReverseArrow(ctx, accent);
				view.addChild(arrow.view);
				const tracks = st.repeatTracks(nested, slider.spanDuration, slider.snakeInDuration, result);
				this.pieces.push({
					nested,
					view,
					alpha: tracks.alpha,
					scale: null,
					arrow,
					appear: nested.time - nested.preempt,
					result,
					aimed: false
				});
			}
		}

		// ball + follow circle ride the folded progress
		this.ball = new ArgonSliderBall(ctx, accent);
		this.ball.view.scale.set(this.planScale);
		this.follow = new ArgonFollowCircle(ctx, accent);
		this.view.addChild(this.follow.view, this.ball.view);
		this.ballT = st.ballTracks(obj, obj.endTime);

		const changes = st.trackingStateChanges(
			ctx.scene.frames,
			{
				startTime: obj.startTime,
				endTime: obj.endTime,
				x: obj.position[0],
				y: obj.position[1],
				scale: this.planScale,
				duration: slider.duration
			},
			slider,
			slider.spanCount
		);
		const endedTracking = changes.length > 0 && changes[changes.length - 1].tracking;
		this.followT = st.followCircleTracks(changes, obj.endTime, endedTracking);
	}

	update(t: number): void {
		this.view.alpha = trackValueAt(this.fades.containerAlpha, t, 0);

		const completion = st.completionProgress(this.obj, this.slider.duration, t);
		const headHit = this.simulated ? !this.headHit.miss && t >= this.headHit.time : t >= this.obj.startTime;
		const [p0, p1] = st.snakeRange(this.slider, this.obj, t, completion, headHit);
		this.body.setRange(p0, p1);
		this.body.view.alpha = trackValueAt(this.fades.bodyAlpha, t, 0);
		const dim = trackValueAt(this.headTracks.dim, t, 1);
		this.body.view.tint = toNumber({ r: dim, g: dim, b: dim, a: 1 });

		this.head.apply(this.headTracks, t);
		this.approach.alpha = trackValueAt(this.headTracks.approachAlpha, t, 0);
		this.approach.scale.set(this.baseApproachScale * trackValueAt(this.headTracks.approachScale, t, 4));

		// ball: folded position + travel direction (drawablesliderball.cs:64-77)
		const [bx, by] = curvePositionAt(this.slider, this.slider.spanCount, completion);
		this.ball.view.position.set(bx, by);
		this.follow.view.position.set(bx, by);
		const checkDistance = 0.1 / this.slider.distance;
		const [ax, ay] = curvePositionAt(this.slider, this.slider.spanCount, Math.min(1 - checkDistance, completion));
		const [cx, cy] = curvePositionAt(this.slider, this.slider.spanCount, Math.min(1, completion + checkDistance));
		const dx = ax - cx,
			dy = ay - cy;
		if (Math.hypot(dx, dy) >= 0.01) {
			this.ball.setRotation(-Math.PI / 2 - Math.atan2(dx, dy));
		}
		this.ball.view.alpha = trackValueAt(this.ballT.alpha, t, 0);
		this.ball.setIconScale(trackValueAt(this.ballT.iconScale, t, 0));
		this.follow.view.alpha = trackValueAt(this.followT.alpha, t, 0);
		this.follow.view.scale.set(this.planScale * trackValueAt(this.followT.scale, t, 1));

		// nested pieces
		const curve = this.body.currentCurve;
		for (const piece of this.pieces) {
			piece.view.alpha = trackValueAt(piece.alpha, t, 0);
			if (piece.scale !== null) piece.view.scale.set(this.planScale * trackValueAt(piece.scale, t, 0.5));
			if (piece.arrow !== null) {
				const hitScale = st.repeatHitScale(
					t,
					piece.nested,
					this.slider.spanDuration,
					piece.result,
					this.hitAnimations
				);
				// drawablesliderrepeat.cs:118-161's UpdateSnakingPosition: position/
				// rotation freeze once hit ("the arrow should fade out on spot
				// rather than following the slider"). repeatAim's `aimed`
				// bookkeeping guarantees rotation is set at least once even for a
				// drawable born (via a seek) inside the post-hit fade window --
				// source never needs that fallback since UpdateSnakingPosition
				// always runs many frames before any repeat can be hit, but here
				// this is the only thing that ever writes Arrow.Rotation, so
				// skipping it entirely would leave it at pixi's unset default of 0
				if (curve !== null) {
					const aim = st.repeatAim(hitScale !== null, piece.aimed, piece.nested, curve, p0, p1, this.slider);
					if (aim !== null) {
						piece.view.position.set(aim.position[0], aim.position[1]);
						piece.arrow.view.rotation = aim.rotation;
						piece.aimed = true;
					}
				}
				// argonreversearrow.cs:80-89 -- hit freezes the idle main/side pulse
				// too (by simply no longer touching it) and scales the *whole*
				// arrow 1 -> 1.5 instead of just `main`; the non-hit path's
				// `Scale = Vector2.One;` runs unconditionally every idle frame in
				// source, so it is reset here too rather than left as a latch from
				// whatever the last hitScale happened to be
				if (hitScale !== null) {
					piece.arrow.view.scale.set(hitScale);
				} else {
					piece.arrow.view.scale.set(1);
					const pulse = st.repeatPulse(t, piece.appear);
					piece.arrow.main.scale.set(pulse.mainScale);
					// pulse.sideX drives argonreversearrow.cs's separate "side" edge
					// sprite (texture gameplay/osu/repeat-edge-piece); there is no
					// canvas stand-in for that asset, so it is left unconsumed here,
					// same documented-simplification spirit as the follow circle's
					// omitted tick pulse
				}
			}
		}
	}

	destroy(): void {
		this.body.destroy();
		// the approach circle and every other piece here are real children of
		// `view` (attach() only affects draw order, never scene-graph
		// ownership), so this single cascade releases all of them. `context:
		// true` is required too: Graphics.destroy() (scene/graphics/shared/
		// Graphics.js) only frees its owned GraphicsContext when `options ===
		// true` or `options?.context === true` -- passing `{children: true}`
		// alone recurses into every ArgonTick/ArgonReverseArrow-capsule
		// Graphics and destroys the renderable but leaks its GraphicsContext
		this.view.destroy({ children: true, context: true });
	}
}
