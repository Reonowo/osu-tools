// pure state tracks for the argon hit circle. citations:
// drawablehitcircle.cs:190-235 (approach, miss, lifetime),
// argonmaincirclepiece.cs:158-231 (the hit explosion, hit-lighting on),
// drawableosuhitobject.cs:115-124 (dim, lifetime offset)

import { BORDER_THICKNESS, DIM_TINT, HIT_FADE_OUT_TIME, MISS_WINDOW, OBJECT_RADIUS } from "../../engine/argon";
import { none, outElasticHalf, outQuad, outQuint } from "../../engine/easing";
import { jump, tween, type Track } from "../../engine/transforms";
import type { Grade, JudgementEventDto } from "../../lib/scene-types";

export interface CircleResult {
  time: number;
  grade: Grade;
}

export function resolveCircleResult(events: JudgementEventDto[], startTime: number): CircleResult {
  for (const event of events) {
    if (event.kind.type === "circle") return { time: event.time, grade: event.kind.grade };
    if (event.kind.type === "sliderHead") {
      return { time: event.time, grade: event.kind.hit ? "great" : "miss" };
    }
  }
  // not simulated: the stand-in is a clean hit exactly on time (decision 5)
  return { time: startTime, grade: "great" };
}

export interface CircleTracks {
  containerAlpha: Track[];
  pieceAlpha: Track[];
  dim: Track[];
  approachAlpha: Track[];
  approachScale: Track[];
  numberAlpha: Track[];
  fillAlpha: Track[];
  innerGradientAlpha: Track[];
  borderScale: Track[];
  borderAccentMix: Track[];
  borderAlpha: Track[];
  outerGradientScale: Track[];
  outerGradientWhite: Track[];
  outerGradientAlpha: Track[];
  flashAlpha: Track[];
}

/** osuhitobject.cs:27 -- OBJECT_DIMENSIONS, the circle's full osu!px size */
const CIRCLE_SIZE = OBJECT_RADIUS * 2;

const FLASH_IN = 150;
const RESIZE = 400;
const SHRINK = 0.8;

export function circleTracks(
  obj: { startTime: number; preempt: number; fadeIn: number },
  result: CircleResult,
  withApproach: boolean,
): CircleTracks {
  const appear = obj.startTime - obj.preempt;
  const hit = result.time;
  const missed = result.grade === "miss";

  const tracks: CircleTracks = {
    containerAlpha: [jump(appear, 1)],
    pieceAlpha: [tween(appear, obj.fadeIn, 0, 1)],
    dim: [jump(appear, DIM_TINT), tween(obj.startTime - MISS_WINDOW, 100, DIM_TINT, 1)],
    approachAlpha: [],
    approachScale: [],
    numberAlpha: [jump(appear, 1)],
    fillAlpha: [jump(appear, 1)],
    innerGradientAlpha: [jump(appear, 1)],
    borderScale: [jump(appear, 1)],
    borderAccentMix: [jump(appear, 0)],
    borderAlpha: [jump(appear, 1)],
    outerGradientScale: [jump(appear, 1)],
    outerGradientWhite: [jump(appear, 0)],
    outerGradientAlpha: [jump(appear, 1)],
    flashAlpha: [jump(appear, 0)],
  };

  if (withApproach) {
    tracks.approachAlpha.push(
      tween(appear, Math.min(obj.fadeIn * 2, obj.preempt), 0, 0.9),
      tween(obj.startTime, 50, 0.9, 0),
    );
    tracks.approachScale.push(tween(appear, obj.preempt, 4, 1));
  }

  if (missed) {
    tracks.containerAlpha.push(tween(hit, 100, 1, 0));
    return tracks;
  }

  // hit explosion (argonmaincirclepiece.cs:163-231, hit lighting on)
  tracks.approachAlpha.push(jump(hit, 0));
  // an early hit (hit < startTime, the common negative-offset case) must stay
  // cut past startTime too, or the greatest-start-wins evaluator hands the
  // value back to the startTime-anchored fadeout tween above and the ring
  // flashes back to 0.9 for up to 50ms. real transform sequences avoid this
  // because inserting a later transform deletes any already-queued transform
  // for the same member that starts after it
  // (targetgroupingtransformtracker.cs:239-253); this is the local
  // equivalent for the one property here that has a fixed-time track queued
  // independently of the hit
  if (withApproach && hit < obj.startTime) tracks.approachAlpha.push(jump(obj.startTime, 0));
  tracks.numberAlpha.push(tween(hit, FLASH_IN / 2, 1, 0));
  tracks.fillAlpha.push(tween(hit, FLASH_IN, 1, 0, outQuint));
  tracks.innerGradientAlpha.push(tween(hit, FLASH_IN, 1, 0, outQuint));

  // bordercolour: white -> accent gradient(0.5a -> 0a) over 800 linear;
  // approximated as an accent-mix ramp plus an alpha ramp to the gradient's
  // 0.25 average; the piece is fully faded by then anyway
  tracks.borderAccentMix.push(tween(hit, HIT_FADE_OUT_TIME, 0, 1));
  tracks.borderAlpha.push(tween(hit, HIT_FADE_OUT_TIME, 1, 0.25));
  tracks.borderScale.push(
    tween(hit, RESIZE, 1, (CIRCLE_SIZE * SHRINK + BORDER_THICKNESS) / CIRCLE_SIZE, outElasticHalf),
  );

  const gradientDelay = hit + FLASH_IN / 12;
  tracks.outerGradientScale.push(tween(gradientDelay, RESIZE, 1, SHRINK, outElasticHalf));
  tracks.outerGradientWhite.push(tween(gradientDelay, 80, 0, 1, none));
  tracks.outerGradientAlpha.push(tween(gradientDelay + 80, FLASH_IN, 1, 0, none));

  tracks.flashAlpha.push(tween(hit, FLASH_IN, 0, 1, outQuint));
  tracks.pieceAlpha.push(tween(hit, HIT_FADE_OUT_TIME, 1, 0, outQuad));
  tracks.containerAlpha.push(jump(hit + HIT_FADE_OUT_TIME, 0));
  return tracks;
}
