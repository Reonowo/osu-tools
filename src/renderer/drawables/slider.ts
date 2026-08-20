// the slider drawable: body + head circle + ball/follow + arrows/ticks,
// all evaluated from pure tracks. argon draws no tail piece
// (drawableslidertail.cs -- circlepiece has no default drawable), so the
// tail is just the body's round cap

import { Container } from "pixi.js";
import { toNumber, type Rgba } from "../../engine/color";
import { curvePositionAt } from "../../engine/slider-path";
import { trackValueAt, type Track } from "../../engine/transforms";
import type { Grade, JudgementEventDto, RenderNested, RenderObject, RenderSlider } from "../../lib/scene-types";
import type { ObjectDrawable, RenderContext } from "../GameplayRenderer";
import { SliderBodyRenderer } from "../slider/body";
import {
	createApproachCircle,
	createCirclePiece,
	texturedPiece,
	type ApproachCirclePiece,
	type CirclePiece
} from "./circle";
import { circleTracks, resolveCircleResult, type CircleTracks } from "./circle-tracks";
import {
	ArgonFollowCircle,
	ArgonReverseArrow,
	ArgonSliderBall,
	createSliderTick,
	LegacyReverseArrow,
	LegacySliderBall,
	LegacySliderFollowCircle,
	type FollowCirclePiece,
	type ReverseArrowPiece,
	type SliderBallPiece
} from "./slider-parts";
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
	arrow: ReverseArrowPiece | null;
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
	private readonly head: CirclePiece;
	private readonly headTracks: CircleTracks;
	private readonly headHit: { time: number; miss: boolean };
	private readonly approach: ApproachCirclePiece;
	private readonly fades: { bodyAlpha: Track[]; containerAlpha: Track[] };
	private readonly ball: SliderBallPiece;
	private readonly ballT: ReturnType<typeof st.ballTracks>;
	private readonly follow: FollowCirclePiece;
	/** the legacy tail circle, or null in the lazer era -- argon draws no tail
	 * piece (drawableslidertail.cs supplies none), so the body's round cap is
	 * the whole of its end */
	private readonly tail: CirclePiece | null;
	private readonly legacy: boolean;
	private readonly followT: ReturnType<typeof st.followCircleTracks>;
	private readonly pieces: NestedPiece[] = [];
	/** legacyreversearrow.cs:56 -- a version 1 skin swings its arrows */
	private readonly reverseRotates: boolean;

	constructor(ctx: RenderContext, objectIndex: number) {
		const obj = ctx.scene.renderPlan.objects[objectIndex];
		const slider = obj.kind as RenderSlider;
		this.obj = obj;
		this.slider = slider;
		this.planScale = ctx.scene.renderPlan.scale;
		this.simulated = ctx.scene.simulation.status === "authoritative";
		this.hitAnimations = ctx.getEffects().hitAnimations;
		// the head's fork, taken off its own spec rather than off the skin's
		// era: a beatmap can answer a texture lookup over an argon skin, and
		// what draws a texture is the composited piece either way. it also
		// decides the REVERSE ARROWS, which is lazer's own gate -- the arrow is
		// keyed on `hasHitCircle` (osulegacyskintransformer.cs:197-201), not on
		// its own asset, so circles from a beatmap bring a legacy arrow with
		// them even when nothing in the chain has arrow art to draw
		this.legacy = texturedPiece(ctx.pieces.slider.head.circle);
		this.reverseRotates = ctx.pieces.slider.reverseRotates;
		const accent = ctx.accents[objectIndex];
		const events = ctx.derived.judgementsByObject[objectIndex];

		this.view.position.set(obj.position[0], obj.position[1]);
		ctx.layers.objects.addChild(this.view);

		// body (head-relative coordinates; radius carries the cs scale)
		this.body = new SliderBodyRenderer(ctx.renderer, slider, accent, this.planScale, ctx.pieces.body);
		this.view.addChild(this.body.view);

		// nested piece layers, in lazer's own child order (drawableslider.cs:
		// 100-122): ticks under repeats, the head above both -- added below,
		// after these -- and the ball on top of everything. one container per
		// piece kind rather than per-piece adds, or a repeat arrow would draw
		// under a later tick instead of over every tick. argon draws no tail
		// piece, so source's proxied-under-everything tail has no analogue
		const tickLayer = new Container();
		const repeatLayer = new Container();
		this.view.addChild(tickLayer, repeatLayer);

		// head: a full argon circle without the outer fill (osuargonskintransformer.cs:
		// SliderHeadHitCircle -> ArgonMainCirclePiece(false)), judged by the
		// sliderHead event (falls back to hit-on-time, decision 5). added after
		// the nested layers: source's headContainer sits above the shake
		// container holding body/ticks/repeats, so arrows never cover the head
		const headResult = resolveCircleResult(events, obj.startTime);
		this.headHit = { time: headResult.time, miss: headResult.grade === "miss" };
		this.headTracks = circleTracks(obj, headResult, true, this.hitAnimations);

		// the tail circle, which exists only where a skin supplies one: argon
		// draws none at all (drawableslidertail.cs:67 falls back to Empty()), so
		// its slider ends at the body's round cap exactly as it did before.
		//
		// built after the head's tracks because it shares the object's own dim
		// with them, and inserted directly ABOVE the body, under the tick and
		// repeat layers already added: lazer proxies the tail exactly there
		// ("so that the tail is drawn under repeats/ticks - legacy skins rely
		// on this", drawableslider.cs:110-111), so an opaque tail circle must
		// never cover a tick, a repeat arrow or the head
		this.tail = this.tailPiece(ctx, accent, obj, slider, events);
		if (this.tail !== null) this.view.addChildAt(this.tail.view, 1);

		this.head = createCirclePiece(ctx, {
			family: ctx.pieces.slider.head,
			accent,
			indexInCombo: obj.indexInCombo,
			withOuterFill: false,
			obj,
			result: headResult,
			hitAnimations: this.hitAnimations,
			shared: this.headTracks
		});
		this.head.view.scale.set(this.planScale);
		this.view.addChild(this.head.view);

		// logical child of `view` (inherits position/scale and is released by
		// view.destroy()'s cascade); merely attached to the approach RenderLayer
		// so it draws above every object regardless of draw order -- addChild()
		// throws on a RenderLayer (task 13's circle.ts established this pattern)
		this.approach = createApproachCircle(ctx, accent);
		this.view.addChild(this.approach.view);
		ctx.layers.approach.attach(this.approach.view);

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
			(nested.kind === "tick" ? tickLayer : repeatLayer).addChild(view);
			if (nested.kind === "tick") {
				const tick = createSliderTick(ctx, accent);
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
				const arrow = this.legacy ? new LegacyReverseArrow(ctx, accent) : new ArgonReverseArrow(ctx, accent);
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

		// ball + follow circle ride the folded progress. each follows its OWN
		// spec rather than the head's flag: lazer gates these two on their own
		// assets (osulegacyskintransformer.cs:166-177), unlike the arrow and the
		// tail, so a beatmap shipping only circles over argon keeps argon's ball
		// -- and one shipping only a `sliderb` draws it over argon circles
		const legacyBall = texturedPiece(ctx.pieces.slider.ball);
		this.ball = legacyBall
			? // legacysliderball.cs:118-120 -- the frame delay is the SLIDER's,
				// derived from its velocity in osu!px per ms
				new LegacySliderBall(ctx, accent, slider.distance / Math.max(1e-9, slider.spanDuration))
			: new ArgonSliderBall(ctx, accent);
		this.ball.view.scale.set(this.planScale);
		const legacyFollow = texturedPiece(ctx.pieces.slider.followCircle);
		this.follow = legacyFollow ? new LegacySliderFollowCircle(ctx) : new ArgonFollowCircle(ctx, accent);
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
		this.followT = st.followCircleTracks(
			changes,
			obj.endTime,
			endedTracking,
			legacyFollow ? st.LEGACY_FOLLOW_CIRCLE : st.ARGON_FOLLOW_CIRCLE
		);
	}

	/**
	 * the tail circle, or null where the era draws none.
	 *
	 * osulegacyskintransformer.cs:185-189 -- `LegacyMainCirclePiece
	 * ("sliderendcircle", false)`: the dedicated end assets when the skin ships
	 * them, its own hit circle when it does not, and NO combo number either way.
	 *
	 * the fade-in is delayed by a third of the preempt
	 * (drawableosuhitobject.cs:163-172's `ApplyRepeatFadeIn`, on the snaking-in
	 * branch this renderer is always on), which is expressed here by handing the
	 * piece a shortened preempt rather than a separate track: the piece's own
	 * appear time IS `startTime - preempt`
	 */
	private tailPiece(
		ctx: RenderContext,
		accent: Rgba,
		obj: RenderObject,
		slider: RenderSlider,
		events: JudgementEventDto[]
	): CirclePiece | null {
		if (!texturedPiece(ctx.pieces.slider.tail.circle)) return null;
		const tail = slider.nested.find((nested) => nested.kind === "tail");
		if (tail === undefined) return null;
		const hit = events.find((event) => event.kind.type === "sliderTail");
		const kind = hit?.kind;
		const result = {
			time: hit?.time ?? tail.time,
			grade: (kind?.type === "sliderTail" && !kind.hit ? "miss" : "great") as Grade
		};
		const piece = createCirclePiece(ctx, {
			family: ctx.pieces.slider.tail,
			accent,
			indexInCombo: obj.indexInCombo,
			withOuterFill: false,
			// the tail's own appear window: `- preempt/3` on the fade-in delay
			obj: { startTime: obj.startTime, preempt: (obj.preempt * 2) / 3, fadeIn: tail.fadeIn },
			result,
			hitAnimations: this.hitAnimations,
			shared: this.headTracks
		});
		// head-relative, and unrotated: the end circle sits flat on the curve's
		// last point whichever way the path arrived there
		piece.view.position.set(slider.endPosition[0] - obj.position[0], slider.endPosition[1] - obj.position[1]);
		piece.view.scale.set(this.planScale);
		return piece;
	}

	update(t: number): void {
		this.view.alpha = trackValueAt(this.fades.containerAlpha, t, 0);
		this.tail?.apply(t);

		const completion = st.completionProgress(this.obj, this.slider.duration, t);
		const headHit = this.simulated ? !this.headHit.miss && t >= this.headHit.time : t >= this.obj.startTime;
		const [p0, p1] = st.snakeRange(this.slider, this.obj, t, completion, headHit);
		this.body.setRange(p0, p1);
		this.body.view.alpha = trackValueAt(this.fades.bodyAlpha, t, 0);
		const dim = trackValueAt(this.headTracks.dim, t, 1);
		this.body.view.tint = toNumber({ r: dim, g: dim, b: dim, a: 1 });

		this.head.apply(t);
		// this drawable's own view carries no scale (only a position), so the cs
		// scale is folded in here rather than inherited
		this.approach.apply(
			trackValueAt(this.headTracks.approachAlpha, t, 0),
			this.planScale * trackValueAt(this.headTracks.approachScale, t, 4)
		);

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
		// an animated ball's frame is a pure function of how far into the slider
		// the moment is, so a seek shows the frame that moment genuinely had
		this.ball.setElapsed(t - this.obj.startTime);
		this.follow.view.alpha = trackValueAt(this.followT.alpha, t, 0);
		this.follow.view.scale.set(this.planScale * trackValueAt(this.followT.scale, t, 1));
		this.follow.setElapsed(t - this.obj.startTime);

		// nested pieces
		const curve = this.body.currentCurve;
		for (const piece of this.pieces) {
			piece.view.alpha = trackValueAt(piece.alpha, t, 0);
			if (piece.scale !== null) piece.view.scale.set(this.planScale * trackValueAt(piece.scale, t, 0.5));
			if (piece.arrow !== null) {
				const hitScale = (this.legacy ? st.legacyRepeatHitScale : st.repeatHitScale)(
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
					// legacyreversearrow.cs:87-91 -- the hit branch stops touching the
					// idle pulse, freezing the arrow wherever it had swung to. computed
					// at the HIT TIME rather than latched from the last frame drawn,
					// so a drawable rebuilt mid-fade (which a density move does) lands
					// on the same angle one that had run all along would show
					piece.arrow.main.rotation = this.legacy
						? (st.legacyRepeatPulse(piece.nested.time, piece.appear, this.reverseRotates).rotation *
								Math.PI) /
							180
						: 0;
				} else if (this.legacy) {
					// legacyreversearrow.cs:100-108 -- the whole arrow pulses (and,
					// on a version 1 skin, swings); there is no separate `main` piece
					// to pulse independently the way argon has
					const pulse = st.legacyRepeatPulse(t, piece.appear, this.reverseRotates);
					piece.arrow.view.scale.set(1);
					piece.arrow.main.scale.set(pulse.scale);
					piece.arrow.main.rotation = (pulse.rotation * Math.PI) / 180;
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
		// the approach circle and every other piece here live under `view` --
		// directly or via the tick/repeat layers -- and attach() only affects
		// draw order, never scene-graph ownership, so this single recursive
		// cascade releases all of them. `context:
		// true` is required too: Graphics.destroy() (scene/graphics/shared/
		// Graphics.js) only frees its owned GraphicsContext when `options ===
		// true` or `options?.context === true` -- passing `{children: true}`
		// alone recurses into every ArgonTick/ArgonReverseArrow-capsule
		// Graphics and destroys the renderable but leaks its GraphicsContext
		this.view.destroy({ children: true, context: true });
	}
}
