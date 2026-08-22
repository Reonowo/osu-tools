// pure state for the slider drawable. citations at each function:
// snakingsliderbody.cs, drawableslider.cs, argonsliderball.cs,
// argonfollowcircle.cs, drawableslidertick.cs, drawablesliderrepeat.cs,
// argonreversearrow.cs, drawableosuhitobject.cs

import { FOLLOW_AREA, OBJECT_RADIUS, SLIDER_FADE_OUT_TIME } from "../../engine/game-constants";
import { isLeft, isRight } from "../../engine/buttons";
import { cursorStateAt } from "../../engine/interpolation";
import {
	LEGACY_REVERSE_HIT_MAX_DURATION,
	LEGACY_REVERSE_HIT_SCALE,
	LEGACY_REVERSE_PULSE_DURATION,
	LEGACY_REVERSE_PULSE_ROTATION
} from "@/skin/legacy/constants";
import { outQuad, outQuint, outElasticHalf, out } from "../../engine/easing";
import { trackValueAt, tween, jump, type Track } from "../../engine/transforms";
import { curvePositionAt, positionAt, progressAt, spanAt, type SliderGeometry } from "../../engine/slider-path";
import type { FrameDto } from "../../lib/scene-types";

/** drawableslider.cs:263 */
export function completionProgress(obj: { startTime: number }, duration: number, t: number): number {
	return Math.min(Math.max((t - obj.startTime) / duration, 0), 1);
}

/** skinning/snakingsliderbody.cs:73-100 (updateprogress). `snakingIn` gates
 * the preempt/3 grow-in (:84 -- off means the body answers fully drawn from
 * its appear time); `snakingOut` gates the final-span retract behind the ball
 * (:91,95) */
export function snakeRange(
	slider: { spanCount: number; snakeInDuration: number },
	obj: { startTime: number; preempt: number },
	t: number,
	completion: number,
	headHit: boolean,
	snakingIn: boolean,
	snakingOut: boolean
): [number, number] {
	const effective = headHit ? completion : 0;
	const span = spanAt(slider.spanCount, effective);
	const spanProgress = progressAt(slider.spanCount, effective);

	let start = 0;
	let end = snakingIn ? Math.min(Math.max((t - (obj.startTime - obj.preempt)) / slider.snakeInDuration, 0), 1) : 1;

	if (span >= slider.spanCount - 1) {
		if (Math.min(span, slider.spanCount - 1) % 2 === 1) {
			start = 0;
			end = snakingOut ? spanProgress : 1;
		} else {
			start = snakingOut ? spanProgress : 0;
		}
	}
	return start <= end ? [start, end] : [end, start];
}

export function sliderFadeTracks(
	obj: { startTime: number; preempt: number; fadeIn: number },
	result: { endTime: number; aggregateMiss: boolean; headHitTime: number | null },
	snakingOut: boolean
): { bodyAlpha: Track[]; containerAlpha: Track[] } {
	const appear = obj.startTime - obj.preempt;
	const bodyAlpha: Track[] = [tween(appear, obj.fadeIn, 0, 1)];
	const containerAlpha: Track[] = [jump(appear, 1), tween(result.endTime, SLIDER_FADE_OUT_TIME, 1, 0)];
	// drawableslider.cs:360 -- updatehitstatetransforms: short body fade only
	// when the head was hit AND snaking out is on, since its whole job is to
	// smooth that retract away
	if (result.headHitTime !== null && snakingOut) bodyAlpha.push(tween(result.endTime, 40, 1, 0));
	return { bodyAlpha, containerAlpha };
}

export function ballTracks(obj: { startTime: number }, endTime: number): { alpha: Track[]; iconScale: Track[] } {
	return {
		// drawableslider.cs (updatestarttimestatetransforms: ball.fadein()) +
		// argonsliderball.cs:90-103 (the actual alpha/scale timings)
		alpha: [jump(obj.startTime, 0), tween(obj.startTime, 200, 0, 1, outQuint), tween(endTime, 50, 1, 0, outQuint)],
		iconScale: [tween(obj.startTime, 200, 0, 1, outElasticHalf), tween(endTime, 200, 1, 0.9, outQuint)]
	};
}

/**
 * how one era's follow circle answers each of the four tracking events.
 *
 * every value here differs between argon (argonfollowcircle.cs:62-95) and
 * legacy (legacyfollowcircle.cs:23-58), and the shape is a parameter rather
 * than a fork so that the sequencing below -- which samples the value each
 * tween actually reached, exactly as `ScaleTo` does -- is written once
 */
export interface FollowCircleShape {
	/** where tracking takes it, and how long the scale and the fade each run */
	pressScale: number;
	pressDuration: number;
	pressFadeDuration: number;
	/** where losing tracking takes it before it vanishes */
	releaseScale: number;
	releaseDuration: number;
	/** where the slider ending while still tracked leaves it */
	endScale: number;
	endDuration: number;
	endFadeDuration: number;
}

/** argonfollowcircle.cs:62-95 -- the tracking area is the ruleset's own
 * FOLLOW_AREA, and the release overshoots it by a fifth */
export const ARGON_FOLLOW_CIRCLE: FollowCircleShape = {
	pressScale: FOLLOW_AREA,
	pressDuration: 300,
	pressFadeDuration: 300,
	releaseScale: FOLLOW_AREA * 1.2,
	releaseDuration: 150,
	endScale: 1,
	endDuration: 300,
	endFadeDuration: 150
};

/**
 * legacyfollowcircle.cs:23-58.
 *
 * note the 2 rather than FOLLOW_AREA: legacy's sprite is deliberately smaller
 * than the area gameplay actually tracks over (:29-30 says so), and skins are
 * drawn expecting that.
 *
 * one documented divergence. lazer's legacy `OnSliderRelease` does NOTHING --
 * the circle only vanishes when a nested object is actually MISSED
 * (`OnSliderBreak`, followcircle.cs:100-112). this drawable's input is the
 * tracking timeline rather than the nested judgements, so a tracking stop plays
 * the break here. the two agree on every slider whose drop costs a nested
 * object, which is every slider a player would notice; they differ only in the
 * gap between letting go and the next tick, where lazer leaves the circle
 * hanging and this hides it early
 */
export const LEGACY_FOLLOW_CIRCLE: FollowCircleShape = {
	pressScale: 2,
	// :31-32 -- both are capped at the time the slider has left to run, which
	// this does not model; the caps only bite on a slider shorter than 180ms
	pressDuration: 180,
	pressFadeDuration: 60,
	// :56-57 -- OnSliderBreak
	releaseScale: 4,
	releaseDuration: 100,
	// :41-42 -- OnSliderEnd
	endScale: 1.6,
	endDuration: 200,
	endFadeDuration: 200
};

export function followCircleTracks(
	changes: { time: number; tracking: boolean }[],
	endTime: number,
	endedWhileTracking: boolean,
	shape: FollowCircleShape = ARGON_FOLLOW_CIRCLE
): { scale: Track[]; alpha: Track[] } {
	const scale: Track[] = [];
	const alpha: Track[] = [];
	// every scaleto/fadeto in argonfollowcircle.cs starts from the value the
	// drawable actually reached at the change, so each new tween's `from` is
	// sampled from the tracks built so far; the scale resets to 1 only when
	// the circle is fully faded out (the alpha ~= 0 branch)
	for (const change of changes.filter((c) => c.time < endTime)) {
		const scaleNow = trackValueAt(scale, change.time, 1);
		const alphaNow = trackValueAt(alpha, change.time, 0);
		if (change.tracking) {
			scale.push(
				tween(change.time, shape.pressDuration, alphaNow === 0 ? 1 : scaleNow, shape.pressScale, outQuint)
			);
			alpha.push(tween(change.time, shape.pressFadeDuration, alphaNow, 1, outQuint));
		} else {
			scale.push(tween(change.time, shape.releaseDuration, scaleNow, shape.releaseScale, outQuint));
			alpha.push(tween(change.time, shape.releaseDuration, alphaNow, 0, outQuint));
		}
	}
	if (endedWhileTracking) {
		scale.push(tween(endTime, shape.endDuration, trackValueAt(scale, endTime, 1), shape.endScale, outQuint));
		alpha.push(tween(endTime, shape.endFadeDuration, trackValueAt(alpha, endTime, 0), 0, outQuint));
	}
	return { scale, alpha };
}

/** `hitAnimations` is the effect toggle: it drops the tick's pop on being hit,
 * leaving the appear tween and the plain alpha fade the tick has either way */
export function tickTracks(
	nested: { time: number; preempt: number },
	result: "hit" | "miss" | null,
	hitAnimations: boolean
): { alpha: Track[]; scale: Track[] } {
	const appear = nested.time - nested.preempt;
	const resolved = result ?? "hit";
	const resultTime = nested.time;
	const alpha: Track[] = [tween(appear, 150, 0, 1), tween(resultTime, 150, 1, 0, outQuint)];
	const scale: Track[] = [tween(appear, 600, 0.5, 1, outElasticHalf)];
	if (resolved === "hit" && hitAnimations) scale.push(tween(resultTime, 150, 1, 1.5, out));
	return { alpha, scale };
}

export function repeatTracks(
	nested: { time: number; preempt: number; fadeIn: number; spanIndex: number },
	spanDuration: number,
	snakeInDuration: number,
	result: "hit" | "miss" | null,
	snakingIn: boolean
): { alpha: Track[] } {
	const appear = nested.time - nested.preempt;
	// drawableosuhitobject.cs:155-172 (applyrepeatfadein) -- arrows fade over
	// 150 (capped to spanduration past the first), and first-span pieces wait
	// for the snake-in (:163 -- the delay exists only to wait for it, so it
	// applies only while snaking in is on)
	const fadeDuration = nested.spanIndex > 0 ? Math.min(spanDuration, 150) : 150;
	const delay = snakingIn && nested.spanIndex === 0 ? snakeInDuration : 0;
	const animDuration = Math.min(300, spanDuration);
	const resolved = result ?? "hit";
	const alpha: Track[] = [tween(appear + delay, fadeDuration, 0, 1)];
	alpha.push(
		resolved === "hit" ? tween(nested.time, animDuration, 1, 0, out) : tween(nested.time, animDuration, 1, 0)
	);
	return { alpha };
}

/** argonreversearrow.cs:92-113 -- per-frame pulse, deliberately unclamped
 * past the 285ms mark (interpolation.valueat has no clamp) */
export function repeatPulse(t: number, animationStart: number): { mainScale: number; sideX: number } {
	const loop = (((t - animationStart) % 300) + 300) % 300;
	if (loop < 35) {
		const k = outQuad(loop / 35);
		return { mainScale: 1 + 0.3 * k, sideX: -12 * k };
	}
	const k = outQuad((loop - 35) / 250);
	return { mainScale: 1.3 - 0.3 * k, sideX: -12 + 12 * k };
}

/** argonreversearrow.cs:80-89 -- once hit, the idle loop above stops
 * altogether (frozen at its last value) and the *whole* arrow -- not just
 * `main` -- scales 1 -> 1.5 over min(300, spanDuration) with Out easing,
 * starting at the piece's own judgement time. returns null while the piece
 * should keep running the idle `repeatPulse` loop instead (not yet hit, a
 * miss never gates the idle loop per source, or before its own judgement
 * time). `result === null` (notSimulated) is decision 5's stand-in: play
 * the hit animation on time, same convention as tickTracks/repeatTracks.
 * `hitAnimations` is the effect toggle: with it off the hit still stops the
 * idle loop (a flat 1 rather than null), it just no longer grows -- the arrow
 * is left to the plain alpha fade repeatTracks already gives it */
export function repeatHitScale(
	t: number,
	nested: { time: number },
	spanDuration: number,
	result: "hit" | "miss" | null,
	hitAnimations: boolean
): number | null {
	if ((result ?? "hit") !== "hit" || t < nested.time) return null;
	if (!hitAnimations) return 1;
	const duration = Math.min(300, spanDuration);
	if (duration <= 0) return 1.5;
	// interpolation.valueat has no clamp past the window either; harmless
	// since the piece's own alpha fade (the same duration) is already
	// clamped to 0 by then
	const k = out((t - nested.time) / duration);
	return 1 + 0.5 * k;
}

/** framework Precision.cs's FLOAT_EPSILON, the per-component tolerance its
 * AlmostEquals(Vector2, Vector2) compares against */
const AIM_VERTEX_EPSILON = 1e-3;

/** drawablesliderrepeat.cs:118-161's UpdateSnakingPosition: aims a repeat
 * at the currently-snaked curve end it sits on, unless it is hit and has
 * already been aimed once. `aimed` is the caller's own per-piece bookkeeping
 * (mirrors source's `hasRotation` field) -- it exists because this
 * drawable can be constructed lazily (a seek) at a t already past the
 * repeat's own hit time, unlike lazer's continuous simulation where
 * UpdateSnakingPosition always runs many frames before any repeat can be
 * hit, so source's own `if (IsHit) return;` guard never has to cover a
 * "hit but never aimed" case the way this port does. the aim vector comes
 * from source's own search (:137-149): walk inboard from the curve's end
 * until a vertex differs from the arrow's position -- a fixed neighbouring
 * vertex degenerates once a fully snaked path duplicates its endpoint
 * vertices (pathToProgress always duplicates the p0 endpoint, and the p1
 * endpoint whenever the snake lands exactly on a vertex), leaving atan2 of
 * a zero vector. returns null when nothing should change this frame (the
 * 50ms rotation smoothing and its ±180° unwrap remain omitted -- TODO.md) */
export function repeatAim(
	hit: boolean,
	aimed: boolean,
	nested: { spanIndex: number },
	curve: ArrayLike<number>,
	p0: number,
	p1: number,
	geo: SliderGeometry
): { position: [number, number]; rotation: number } | null {
	if (hit && aimed) return null;
	if (curve.length < 4) return null;
	const atEnd = nested.spanIndex % 2 === 0;
	const [px, py] = positionAt(geo, atEnd ? p1 : p0);
	// source seeds aimRotationVector at Vector2.Zero, so a curve of nothing
	// but the arrow's own position aims at the origin exactly as lazer does
	let aimX = 0;
	let aimY = 0;
	const count = curve.length / 2;
	const direction = atEnd ? -1 : 1;
	for (let i = atEnd ? count - 1 : 0; i >= 0 && i < count; i += direction) {
		const x = curve[i * 2];
		const y = curve[i * 2 + 1];
		// Precision.AlmostEquals is per-component, not a distance
		if (Math.abs(x - px) <= AIM_VERTEX_EPSILON && Math.abs(y - py) <= AIM_VERTEX_EPSILON) continue;
		aimX = x;
		aimY = y;
		break;
	}
	return { position: [px, py], rotation: Math.atan2(aimY - py, aimX - px) };
}

/** frontend-only visual tracking (decision 5): button held and cursor
 * within follow_area x radius of the ball. judgement-irrelevant */
export function trackingStateChanges(
	frames: FrameDto[],
	slider: { startTime: number; endTime: number; x: number; y: number; scale: number; duration: number },
	geo: SliderGeometry,
	spanCount: number
): { time: number; tracking: boolean }[] {
	const changes: { time: number; tracking: boolean }[] = [];
	let last = false;
	const followRadius = FOLLOW_AREA * OBJECT_RADIUS * slider.scale;
	for (const frame of frames) {
		if (frame.time < slider.startTime || frame.time > slider.endTime) continue;
		const state = cursorStateAt(frames, frame.time);
		if (state === null) continue;
		const progress = Math.min(Math.max((frame.time - slider.startTime) / slider.duration, 0), 1);
		const [bx, by] = curvePositionAt(geo, spanCount, progress);
		const dx = state.x - (slider.x + bx);
		const dy = state.y - (slider.y + by);
		const tracking =
			(isLeft(state.buttons) || isRight(state.buttons)) && dx * dx + dy * dy <= followRadius * followRadius;
		if (tracking !== last) {
			changes.push({ time: frame.time, tracking });
			last = tracking;
		}
	}
	return changes;
}

/**
 * legacyreversearrow.cs:94-108 -- the idle pulse, which is a plain loop rather
 * than argon's two-stage one: the arrow shrinks 1.3 -> 1 over 300ms and starts
 * again.
 *
 * `rotates` is the version fork (:56): a version 1 skin also swings the arrow
 * +-5.625 degrees across the same loop and runs the scale LINEARLY, while a
 * later skin eases the scale out and does not swing at all
 */
export function legacyRepeatPulse(
	t: number,
	animationStart: number,
	rotates: boolean
): { scale: number; rotation: number } {
	const duration = LEGACY_REVERSE_PULSE_DURATION;
	const loop = (((t - animationStart) % duration) + duration) % duration;
	const k = loop / duration;
	if (!rotates) return { scale: 1.3 - 0.3 * out(k), rotation: 0 };
	return {
		scale: 1.3 - 0.3 * k,
		rotation: LEGACY_REVERSE_PULSE_ROTATION - 2 * LEGACY_REVERSE_PULSE_ROTATION * k
	};
}

/** legacyreversearrow.cs:87-91 -- once hit, the idle loop stops and the arrow
 * grows 1 -> 1.4 over min(300, spanDuration) with Out easing. the same shape
 * argon's `repeatHitScale` has and a different destination, which is why the
 * two are separate functions rather than one with a magic number */
export function legacyRepeatHitScale(
	t: number,
	nested: { time: number },
	spanDuration: number,
	result: "hit" | "miss" | null,
	hitAnimations: boolean
): number | null {
	if ((result ?? "hit") !== "hit" || t < nested.time) return null;
	if (!hitAnimations) return 1;
	const duration = Math.min(LEGACY_REVERSE_HIT_MAX_DURATION, spanDuration);
	if (duration <= 0) return LEGACY_REVERSE_HIT_SCALE;
	return 1 + (LEGACY_REVERSE_HIT_SCALE - 1) * out((t - nested.time) / duration);
}
