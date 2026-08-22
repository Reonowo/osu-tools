import { describe, expect, test } from "bun:test";
import { FOLLOW_AREA } from "../../engine/game-constants";
import { pathToProgress, positionAt } from "../../engine/slider-path";
import { trackValueAt } from "../../engine/transforms";
import type { FrameDto, RenderPlan } from "../../lib/scene-types";
import { loadFixture } from "../../test/fixtures";
import {
	ballTracks,
	completionProgress,
	followCircleTracks,
	repeatAim,
	repeatHitScale,
	repeatPulse,
	repeatTracks,
	sliderFadeTracks,
	snakeRange,
	tickTracks,
	trackingStateChanges
} from "./slider-tracks";

const obj = { startTime: 1000, preempt: 600, fadeIn: 400, endTime: 2000 };

describe("snakeRange (snakingsliderbody.cs:73-100)", () => {
	const oneSpan = { spanCount: 1, snakeInDuration: 200 };
	// both settings on -- lazer's defaults, and every other case below varies
	// one flag at a time against this baseline
	const on = [true, true] as const;

	test("snakes in over preempt/3 from appear", () => {
		expect(snakeRange(oneSpan, obj, 400, 0, false, ...on)).toEqual([0, 0]);
		expect(snakeRange(oneSpan, obj, 500, 0, false, ...on)).toEqual([0, 0.5]);
		expect(snakeRange(oneSpan, obj, 600, 0, false, ...on)).toEqual([0, 1]);
		expect(snakeRange(oneSpan, obj, 1500, 0, false, ...on)).toEqual([0, 1]);
	});

	test("single span snakes out from the start once the head is hit", () => {
		expect(snakeRange(oneSpan, obj, 1500, 0.5, true, ...on)).toEqual([0.5, 1]);
		// head not hit: completion forced to 0 upstream, so no snake-out
		expect(snakeRange(oneSpan, obj, 1500, 0.5, false, ...on)).toEqual([0, 1]);
	});

	test("even span count snakes out from the end on the final (odd-index) span", () => {
		const twoSpans = { spanCount: 2, snakeInDuration: 200 };
		// completion 0.75 -> span 1 (final), spanProgress folds to 0.5
		expect(snakeRange(twoSpans, obj, 1750, 0.75, true, ...on)).toEqual([0, 0.5]);
	});

	test("3-span slider: only the final span (even index) snakes out, middle spans stay untrimmed", () => {
		const threeSpans = { spanCount: 3, snakeInDuration: 200 };
		// completion 0.5 -> span 1 (middle, index 1 < spanCount-1=2): no trim,
		// even though 1 is odd -- the span>=spanCount-1 gate must fire first
		expect(snakeRange(threeSpans, obj, 1750, 0.5, true, ...on)).toEqual([0, 1]);
		// completion 5/6 -> span 2 (final, even index): trims start from spanProgress
		expect(snakeRange(threeSpans, obj, 1750, 5 / 6, true, ...on)).toEqual([0.5, 1]);
	});

	test("snaking in off answers the whole body from its appear time (:84)", () => {
		expect(snakeRange(oneSpan, obj, 400, 0, false, false, true)).toEqual([0, 1]);
		expect(snakeRange(oneSpan, obj, 500, 0, false, false, true)).toEqual([0, 1]);
	});

	test("snaking out off keeps the final span untrimmed (:91,95), either direction", () => {
		const oneSpanOn = { spanCount: 1, snakeInDuration: 200 };
		expect(snakeRange(oneSpanOn, obj, 1500, 0.5, true, true, false)).toEqual([0, 1]);
		const twoSpans = { spanCount: 2, snakeInDuration: 200 };
		expect(snakeRange(twoSpans, obj, 1750, 0.75, true, true, false)).toEqual([0, 1]);
	});
});

describe("fades", () => {
	test("body fades in over fadeIn from appear and out over 240 at the end", () => {
		const tracks = sliderFadeTracks(obj, { endTime: 2000, aggregateMiss: false, headHitTime: 1000 }, true);
		expect(trackValueAt(tracks.bodyAlpha, 400, 0)).toBe(0);
		expect(trackValueAt(tracks.bodyAlpha, 600, 0)).toBeCloseTo(0.5, 9);
		// head hit + snaking out: the 40ms body fade wins at the end
		expect(trackValueAt(tracks.bodyAlpha, 2040, 0)).toBe(0);
		expect(trackValueAt(tracks.containerAlpha, 2120, 1)).toBeCloseTo(0.5, 9);
		expect(trackValueAt(tracks.containerAlpha, 2240, 1)).toBe(0);
	});

	test("no head hit: the body has no short end-fade of its own, only the container's 240ms fade", () => {
		const tracks = sliderFadeTracks(obj, { endTime: 2000, aggregateMiss: false, headHitTime: null }, true);
		// bodyAlpha never anchors anything at endTime, so it holds at its
		// fade-in's "to" (1) indefinitely -- proves the 40ms push is gated on
		// headHitTime, not unconditional
		expect(trackValueAt(tracks.bodyAlpha, 2040, 0)).toBe(1);
		expect(trackValueAt(tracks.bodyAlpha, 5000, 0)).toBe(1);
	});

	test("snaking out off drops the short end-fade too (drawableslider.cs:360)", () => {
		const tracks = sliderFadeTracks(obj, { endTime: 2000, aggregateMiss: false, headHitTime: 1000 }, false);
		expect(trackValueAt(tracks.bodyAlpha, 2040, 0)).toBe(1);
	});
});

describe("completionProgress", () => {
	test("clamps into the slider window", () => {
		expect(completionProgress(obj, 1000, 900)).toBe(0);
		expect(completionProgress(obj, 1000, 1500)).toBe(0.5);
		expect(completionProgress(obj, 1000, 2400)).toBe(1);
	});
});

describe("ticks (drawableslidertick.cs)", () => {
	test("fade in over 150 starting preempt before the tick; hit pops 1.5x", () => {
		const tracks = tickTracks({ time: 1500, preempt: 500 }, "hit", true);
		expect(trackValueAt(tracks.alpha, 1000, 0)).toBe(0);
		expect(trackValueAt(tracks.alpha, 1075, 0)).toBeCloseTo(0.5, 9);
		expect(trackValueAt(tracks.alpha, 1650, 0)).toBe(0);
		expect(trackValueAt(tracks.scale, 1500 + 150, 0.5)).toBeCloseTo(1.5, 6);
	});

	test("miss fades the same as hit but never pops the scale", () => {
		const nested = { time: 1500, preempt: 500 };
		const miss = tickTracks(nested, "miss", true);
		const hit = tickTracks(nested, "hit", true);
		expect(miss.alpha).toEqual(hit.alpha); // same 150ms OutQuint fade either way
		expect(trackValueAt(miss.scale, 1500 + 150, 0.5)).toBeCloseTo(1, 6); // no x1.5 pop
	});

	test("result === null (notSimulated) behaves exactly like a hit -- decision 5's time-only stand-in", () => {
		const nested = { time: 1500, preempt: 500 };
		expect(tickTracks(nested, null, true)).toEqual(tickTracks(nested, "hit", true));
	});

	test("hitAnimations off drops the pop but keeps the appear tween and the fade", () => {
		const nested = { time: 1500, preempt: 500 };
		const off = tickTracks(nested, "hit", false);
		expect(off.alpha).toEqual(tickTracks(nested, "hit", true).alpha); // the plain fade is untouched
		expect(trackValueAt(off.scale, 1000, 0.5)).toBeCloseTo(0.5, 6); // still grows in on appear
		expect(trackValueAt(off.scale, 1600, 0.5)).toBeCloseTo(1, 6); // the appear elastic settles at 1
		expect(trackValueAt(off.scale, 1500 + 150, 0.5)).toBeCloseTo(1, 6); // no x1.5 pop
	});
});

describe("repeat pulse (argonreversearrow.cs:92-113)", () => {
	test("peaks 1.3 at 35ms and returns by 285ms, looping at 300", () => {
		const start = 400;
		expect(repeatPulse(start, start).mainScale).toBeCloseTo(1, 9);
		expect(repeatPulse(start + 35, start).mainScale).toBeCloseTo(1.3, 9);
		expect(repeatPulse(start + 285, start).mainScale).toBeCloseTo(1, 6);
		expect(repeatPulse(start + 300, start).mainScale).toBeCloseTo(1, 9);
		expect(repeatPulse(start + 35, start).sideX).toBeCloseTo(-12, 9);
	});
});

describe("repeat hit scale (argonreversearrow.cs:80-89)", () => {
	test("null (idle) before the piece's own judgement time, then ramps the whole arrow 1 -> 1.5", () => {
		const nested = { time: 1500 };
		expect(repeatHitScale(1499, nested, 300, "hit", true)).toBeNull();
		expect(repeatHitScale(1500, nested, 300, "hit", true)).toBeCloseTo(1, 9);
		expect(repeatHitScale(1650, nested, 300, "hit", true)).toBeCloseTo(1.375, 9); // outQuad(0.5) = 0.75
		expect(repeatHitScale(1800, nested, 300, "hit", true)).toBeCloseTo(1.5, 9);
	});

	test("caps the ramp duration to spanDuration when it is under 300ms", () => {
		const nested = { time: 1500 };
		expect(repeatHitScale(1700, nested, 200, "hit", true)).toBeCloseTo(1.5, 9); // fully ramped by 1500+200
	});

	test("miss never gates -- stays null so the idle pulse keeps running", () => {
		const nested = { time: 1500 };
		expect(repeatHitScale(1600, nested, 300, "miss", true)).toBeNull();
	});

	test("result === null (notSimulated) behaves like a hit", () => {
		const nested = { time: 1500 };
		expect(repeatHitScale(1650, nested, 300, null, true)).toEqual(repeatHitScale(1650, nested, 300, "hit", true));
	});

	test("hitAnimations off still freezes the idle pulse at the hit, it just never grows", () => {
		// a flat 1 rather than null: null would hand the arrow back to the idle
		// loop, which source stops for good once the piece is hit
		const nested = { time: 1500 };
		expect(repeatHitScale(1499, nested, 300, "hit", false)).toBeNull();
		expect(repeatHitScale(1500, nested, 300, "hit", false)).toBe(1);
		expect(repeatHitScale(1650, nested, 300, "hit", false)).toBe(1);
		expect(repeatHitScale(1800, nested, 300, "hit", false)).toBe(1);
	});
});

describe("repeatAim (drawablesliderrepeat.cs:118-161 UpdateSnakingPosition)", () => {
	// a straight 1-span slider curve, already snaked from x=0 to x=100 --
	// vertices=[0,0, 50,0, 100,0] flattened
	const geo = { vertices: [0, 0, 100, 0], cumulativeLengths: [0, 100], distance: 100 };
	const curve = [0, 0, 50, 0, 100, 0];

	test("even spanIndex aims from p1 back along the curve toward the previous vertex", () => {
		const aim = repeatAim(false, false, { spanIndex: 0 }, curve, 0, 1, geo);
		expect(aim).not.toBeNull();
		expect(aim!.position).toEqual([100, 0]); // positionAt(p1=1)
		// aiming from (100,0) back to (50,0): atan2(0-0, 50-100) = PI
		expect(aim!.rotation).toBeCloseTo(Math.PI, 9);
	});

	test("odd spanIndex aims from p0 toward the next vertex", () => {
		const aim = repeatAim(false, false, { spanIndex: 1 }, curve, 0, 1, geo);
		expect(aim).not.toBeNull();
		expect(aim!.position).toEqual([0, 0]); // positionAt(p0=0)
		// aiming from (0,0) toward (50,0): atan2(0-0, 50-0) = 0
		expect(aim!.rotation).toBeCloseTo(0, 9);
	});

	test("frozen (null) once hit and already aimed", () => {
		expect(repeatAim(true, true, { spanIndex: 0 }, curve, 0, 1, geo)).toBeNull();
	});

	test(
		"still aims once even while already hit, if it was never aimed before -- the round-2 fix: a " +
			"drawable constructed lazily (a seek) at a t already inside a repeat's post-hit fade window " +
			"must not leave Arrow.Rotation at pixi's unset default of 0",
		() => {
			const aim = repeatAim(true, false, { spanIndex: 0 }, curve, 0, 1, geo);
			expect(aim).not.toBeNull();
			expect(aim!.position).toEqual([100, 0]);
			expect(aim!.rotation).toBeCloseTo(Math.PI, 9); // matches the pre-hit aim exactly, not 0
		}
	);

	test("null for a curve too short to aim from (fewer than 2 vertices)", () => {
		expect(repeatAim(false, false, { spanIndex: 0 }, [0, 0], 0, 1, geo)).toBeNull();
	});
});

describe("repeatAim duplicate-vertex walk (drawablesliderrepeat.cs:137-149)", () => {
	// a diagonal path so a degenerate atan2(0,0) = 0 cannot pass by luck --
	// this curve is the shape pathToProgress emits for a fully snaked path:
	// both endpoint vertices duplicated (the p0 endpoint always is; the p1
	// endpoint is once the snake reaches a vertex exactly)
	const geo = { vertices: [0, 0, 60, 80], cumulativeLengths: [0, 100], distance: 100 };
	const snakedCurve = [0, 0, 0, 0, 60, 80, 60, 80];

	test("end-side arrow walks inboard past the duplicated end vertex", () => {
		const aim = repeatAim(false, false, { spanIndex: 0 }, snakedCurve, 0, 1, geo);
		expect(aim).not.toBeNull();
		expect(aim!.position).toEqual([60, 80]);
		// back along the path, toward (0,0): atan2(0-80, 0-60)
		expect(aim!.rotation).toBeCloseTo(Math.atan2(-80, -60), 9);
	});

	test("start-side arrow walks forward past the duplicated start vertex", () => {
		const aim = repeatAim(false, false, { spanIndex: 1 }, snakedCurve, 0, 1, geo);
		expect(aim).not.toBeNull();
		expect(aim!.position).toEqual([0, 0]);
		// forward along the path, toward (60,80): atan2(80, 60)
		expect(aim!.rotation).toBeCloseTo(Math.atan2(80, 60), 9);
	});
});

// the smallest signed angle from b to a
function angleDiff(a: number, b: number): number {
	return Math.atan2(Math.sin(a - b), Math.cos(a - b));
}

describe("repeatAim over fixture geometry (slider-zoo repeat sliders)", () => {
	test("arrows point along the path's own tangent, and full snake-in never snaps the direction", async () => {
		const plan = await loadFixture<RenderPlan>("render_plan", "slider-zoo-v14.json");
		let endSide = 0;
		let startSide = 0;
		for (const obj of plan.objects) {
			if (obj.kind.type !== "slider" || obj.kind.repeatCount === 0) continue;
			const geo = obj.kind;
			const fullySnaked = pathToProgress(geo, 0, 1);
			const nearlySnaked = pathToProgress(geo, 0, 0.999);
			const n = fullySnaked.length;
			// precondition, so the case never silently weakens: the fully
			// snaked curve really does duplicate both endpoint vertices
			expect([fullySnaked[0], fullySnaked[1]]).toEqual([fullySnaked[2], fullySnaked[3]]);
			expect([fullySnaked[n - 2], fullySnaked[n - 1]]).toEqual([fullySnaked[n - 4], fullySnaked[n - 3]]);
			for (const nested of geo.nested) {
				if (nested.kind !== "repeat") continue;
				const atEnd = nested.spanIndex % 2 === 0;
				if (atEnd) endSide++;
				else startSide++;
				const aim = repeatAim(false, false, nested, fullySnaked, 0, 1, geo);
				expect(aim).not.toBeNull();
				// the fixture-backed expectation: the arrow points along the
				// path's tangent at its own end -- back along it from the tail,
				// forward along it from the head. delta = half an osu!px of
				// progress, small enough to stay in the endmost segments
				const delta = 0.5 / geo.distance;
				const [px, py] = positionAt(geo, atEnd ? 1 : 0);
				const [tx, ty] = positionAt(geo, atEnd ? 1 - delta : delta);
				const tangent = Math.atan2(ty - py, tx - px);
				expect(Math.abs(angleDiff(aim!.rotation, tangent)), `span ${nested.spanIndex}`).toBeLessThan(0.2);
				// and finishing the snake-in must not snap it: the aim over the
				// nearly snaked curve agrees with the fully snaked one
				const before = repeatAim(false, false, nested, nearlySnaked, 0, 0.999, geo);
				expect(before).not.toBeNull();
				expect(
					Math.abs(angleDiff(aim!.rotation, before!.rotation)),
					`span ${nested.spanIndex} continuity`
				).toBeLessThan(0.2);
			}
		}
		// both parities must actually have been exercised
		expect(endSide).toBeGreaterThanOrEqual(2);
		expect(startSide).toBeGreaterThanOrEqual(1);
	});
});

describe("ballTracks (argonsliderball.cs:90-103)", () => {
	test("alpha fades in instantly then out over 50ms OutQuint at the end; icon scale grows in then shrinks to 0.9x", () => {
		const tracks = ballTracks({ startTime: 1000 }, 1400);
		expect(trackValueAt(tracks.alpha, 999, -1)).toBe(-1); // nothing active before startTime
		expect(trackValueAt(tracks.alpha, 1000, 0)).toBe(0);
		expect(trackValueAt(tracks.alpha, 1200, 0)).toBe(1); // clamped past the 200ms OutQuint fade-in
		expect(trackValueAt(tracks.alpha, 1425, 0)).toBeCloseTo(0.03125, 9); // halfway through the 50ms OutQuint fade-out
		expect(trackValueAt(tracks.alpha, 1450, 0)).toBe(0); // clamped past the 50ms fade-out

		expect(trackValueAt(tracks.iconScale, 1000, -1)).toBe(0);
		expect(trackValueAt(tracks.iconScale, 1200, 0)).toBe(1); // clamped past the 200ms elastic grow
		expect(trackValueAt(tracks.iconScale, 1600, 0)).toBe(0.9); // clamped past the 200ms OutQuint shrink at endTime
	});
});

describe("followCircleTracks (argonfollowcircle.cs:62-95)", () => {
	test("press grows to FOLLOW_AREA over 300ms OutQuint and fades in; a later release grows further and fades out", () => {
		// release is far enough after the press that the press's own 300ms
		// window fully resolves first -- otherwise the release tween (a later,
		// and therefore winning, start) pre-empts it before it ever clamps,
		// which is a real but separate behaviour (covered below)
		const tracks = followCircleTracks(
			[
				{ time: 1000, tracking: true },
				{ time: 2000, tracking: false }
			],
			2500,
			false
		);
		expect(trackValueAt(tracks.scale, 1000, 0)).toBe(1);
		expect(trackValueAt(tracks.scale, 1300, 0)).toBeCloseTo(FOLLOW_AREA, 9); // clamped past the 300ms press
		expect(trackValueAt(tracks.alpha, 1000, 0)).toBe(0);
		expect(trackValueAt(tracks.alpha, 1300, 0)).toBe(1);
		// release at 2000
		expect(trackValueAt(tracks.scale, 2150, 0)).toBeCloseTo(FOLLOW_AREA * 1.2, 6); // clamped past the 150ms release
		expect(trackValueAt(tracks.alpha, 2150, 0)).toBe(0); // clamped past the 150ms release fade
	});

	test("a release that pre-empts the press's 300ms window starts from the sampled value, not FOLLOW_AREA", () => {
		// argonfollowcircle.cs's scaleto/fadeto sample the drawable's current
		// value, so a release 200ms into the 300ms press tween contracts from
		// wherever the press actually got to -- no pop to the completed value
		const tracks = followCircleTracks(
			[
				{ time: 1000, tracking: true },
				{ time: 1200, tracking: false }
			],
			1500,
			false
		);
		const pressOnly = followCircleTracks([{ time: 1000, tracking: true }], 1500, false);
		const scaleAtRelease = trackValueAt(pressOnly.scale, 1200, 0);
		const alphaAtRelease = trackValueAt(pressOnly.alpha, 1200, 0);
		expect(scaleAtRelease).toBeGreaterThan(1);
		expect(scaleAtRelease).toBeLessThan(FOLLOW_AREA);
		expect(trackValueAt(tracks.scale, 1200, 0)).toBeCloseTo(scaleAtRelease, 9);
		expect(trackValueAt(tracks.alpha, 1200, 0)).toBeCloseTo(alphaAtRelease, 9);
		expect(trackValueAt(tracks.scale, 1350, 0)).toBeCloseTo(FOLLOW_AREA * 1.2, 6); // clamped past the 150ms release
		expect(trackValueAt(tracks.alpha, 1350, 0)).toBe(0);
	});

	test("re-acquiring tracking before the fade-out completes resumes from the sampled scale, not from 1", () => {
		// the alpha ~= 0 reset branch must not fire mid-fade: lazer only snaps
		// the scale back to 1 when the circle is fully invisible
		const tracks = followCircleTracks(
			[
				{ time: 1000, tracking: true },
				{ time: 2000, tracking: false },
				{ time: 2075, tracking: true }
			],
			3000,
			false
		);
		expect(trackValueAt(tracks.scale, 2075, 0)).toBeGreaterThan(FOLLOW_AREA); // mid-release, still above FOLLOW_AREA
		expect(trackValueAt(tracks.alpha, 2075, 0)).toBeGreaterThan(0);
		expect(trackValueAt(tracks.scale, 2500, 0)).toBeCloseTo(FOLLOW_AREA, 9); // settles back
		expect(trackValueAt(tracks.alpha, 2500, 0)).toBe(1);
	});

	test("ending while tracking grows once more to FOLLOW_AREA*1.2's opposite -- back down to 1 -- while fading out", () => {
		const tracks = followCircleTracks([{ time: 1000, tracking: true }], 1500, true);
		expect(trackValueAt(tracks.scale, 1500, 0)).toBeCloseTo(FOLLOW_AREA, 9); // still at the press value right at endTime
		expect(trackValueAt(tracks.scale, 1800, 0)).toBeCloseTo(1, 9); // clamped past the 300ms end-scale
		expect(trackValueAt(tracks.alpha, 1650, 0)).toBe(0); // clamped past the 150ms end-fade
	});

	test("a change at or after endTime is excluded entirely, not just its end-of-slider handling", () => {
		const filtered = followCircleTracks(
			[
				{ time: 1000, tracking: true },
				{ time: 1600, tracking: false }
			],
			1500,
			false
		);
		const withoutLateChange = followCircleTracks([{ time: 1000, tracking: true }], 1500, false);
		expect(filtered.scale).toEqual(withoutLateChange.scale);
		expect(filtered.alpha).toEqual(withoutLateChange.alpha);
	});
});

describe("repeatTracks (drawableosuhitobject.cs:155-172 applyrepeatfadein + drawablesliderrepeat.cs)", () => {
	test("first-span arrow waits for the snake-in delay and fades in over 150ms linear", () => {
		const nested = { time: 1500, preempt: 500, fadeIn: 400, spanIndex: 0 };
		const tracks = repeatTracks(nested, 500, 200, "hit", true);
		const appear = 1000; // 1500 - 500
		expect(trackValueAt(tracks.alpha, appear, 0)).toBe(0);
		expect(trackValueAt(tracks.alpha, appear + 200, 0)).toBe(0); // fade only starts after the delay
		expect(trackValueAt(tracks.alpha, appear + 200 + 75, 0)).toBeCloseTo(0.5, 9); // halfway, linear
		// hit: fades out over min(300, spanDuration)=300 with Out easing from nested.time
		expect(trackValueAt(tracks.alpha, 1500, 0)).toBe(1);
		expect(trackValueAt(tracks.alpha, 1800, 0)).toBe(0);
	});

	test("snaking in off lifts the first-span delay too (:163 gates it on the snake)", () => {
		const nested = { time: 1500, preempt: 500, fadeIn: 400, spanIndex: 0 };
		const tracks = repeatTracks(nested, 500, 200, "hit", false);
		const appear = 1000;
		expect(trackValueAt(tracks.alpha, appear + 75, 0)).toBeCloseTo(0.5, 9); // fading immediately
		expect(trackValueAt(tracks.alpha, appear + 150, 0)).toBe(1);
	});

	test("a later-span arrow is not delayed, caps its fade-in to spanDuration, and misses fade out linearly", () => {
		const nested = { time: 3000, preempt: 500, fadeIn: 400, spanIndex: 1 };
		const tracks = repeatTracks(nested, 100, 200, "miss", true);
		const appear = 2500; // 3000 - 500
		expect(trackValueAt(tracks.alpha, appear, 0)).toBe(0);
		expect(trackValueAt(tracks.alpha, appear + 100, 0)).toBe(1); // capped fade-in duration is min(100,150)=100
		expect(trackValueAt(tracks.alpha, 3050, 0)).toBeCloseTo(0.5, 9); // halfway through the 100ms linear miss fade
		expect(trackValueAt(tracks.alpha, 3100, 0)).toBe(0);
	});

	test("result === null (notSimulated) behaves like a hit", () => {
		const nested = { time: 1500, preempt: 500, fadeIn: 400, spanIndex: 0 };
		expect(repeatTracks(nested, 500, 200, null, true)).toEqual(repeatTracks(nested, 500, 200, "hit", true));
	});
});

describe("trackingStateChanges (decision 5: frontend-only, judgement-irrelevant)", () => {
	// a straight 1-span slider from (0,0) to (100,0), so curvePositionAt is
	// just a straight lerp -- ball at progress p sits at (100p, 0)
	const geo = { vertices: [0, 0, 100, 0], cumulativeLengths: [0, 100], distance: 100 };
	const slider = { startTime: 1000, endTime: 1100, x: 0, y: 0, scale: 1, duration: 100 };
	// FOLLOW_AREA(2.4) * OBJECT_RADIUS(64) * scale(1) = 153.6

	test("records only the rising/falling edges of (button held AND within follow radius)", () => {
		const frames: FrameDto[] = [
			{ time: 1000, x: 0, y: 0, buttons: 1 }, // M1 held, on the ball (progress 0 -> x=0): tracking
			{ time: 1020, x: 0, y: 0, buttons: 0 }, // released: not tracking
			{ time: 1040, x: 1000, y: 0, buttons: 1 }, // held again but far from the ball (x=40 at progress 0.4): still not tracking
			{ time: 1080, x: 80, y: 0, buttons: 4 } // K1 held, on the ball (progress 0.8 -> x=80): tracking
		];
		expect(trackingStateChanges(frames, slider, geo, 1)).toEqual([
			{ time: 1000, tracking: true },
			{ time: 1020, tracking: false },
			{ time: 1080, tracking: true }
		]);
	});

	test("frames outside the slider's [startTime, endTime] window are ignored entirely", () => {
		const frames: FrameDto[] = [
			{ time: 900, x: 0, y: 0, buttons: 1 }, // before startTime
			{ time: 1000, x: 0, y: 0, buttons: 1 },
			{ time: 1200, x: 100, y: 0, buttons: 1 } // after endTime
		];
		expect(trackingStateChanges(frames, slider, geo, 1)).toEqual([{ time: 1000, tracking: true }]);
	});
});
