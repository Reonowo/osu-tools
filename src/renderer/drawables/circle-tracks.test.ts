import { describe, expect, test } from "bun:test";
import { outElasticHalf } from "../../engine/easing";
import { trackValueAt } from "../../engine/transforms";
import { circleTracks, resolveCircleResult } from "./circle-tracks";

const obj = { startTime: 1000, preempt: 600, fadeIn: 400 };

describe("resolveCircleResult", () => {
  test("uses the circle judgement when present, else hit-on-time", () => {
    expect(resolveCircleResult(
      [{ time: 1030, objectIndex: 0, kind: { type: "circle", grade: "ok" }, comboAfter: 1, accuracyAfter: 1 }],
      1000,
    )).toEqual({ time: 1030, grade: "ok" });
    expect(resolveCircleResult([], 1000)).toEqual({ time: 1000, grade: "great" });
  });

  test("slider heads resolve through sliderHead events", () => {
    expect(resolveCircleResult(
      [{ time: 990, objectIndex: 0, kind: { type: "sliderHead", hit: false }, comboAfter: 0, accuracyAfter: 1 }],
      1000,
    )).toEqual({ time: 990, grade: "miss" });
  });
});

describe("circle tracks (argonmaincirclepiece.cs / drawablehitcircle.cs)", () => {
  test("pre-hit: piece fades in over fadeIn, approach shrinks 4->1 and caps at 0.9 alpha", () => {
    // hit is picked comfortably after preempt ends (not == obj.startTime) so the
    // hard-cut jump a non-miss result pushes onto approachAlpha doesn't land on the
    // exact same instant as the startTime fade-out track sampled below at t=1000 --
    // per transforms.ts's documented tie rule (later-in-array wins ties), that
    // coincidence would make the hard-cut win and read 0 instead of the natural
    // ramp's 0.9, which isn't what this test is exercising
    const tracks = circleTracks(obj, { time: 1050, grade: "great" }, true);
    expect(trackValueAt(tracks.pieceAlpha, 400, 0)).toBe(0);       // appear
    expect(trackValueAt(tracks.pieceAlpha, 600, 0)).toBeCloseTo(0.5, 9);
    expect(trackValueAt(tracks.approachScale, 400, 4)).toBe(4);
    expect(trackValueAt(tracks.approachScale, 700, 4)).toBeCloseTo(2.5, 9);
    expect(trackValueAt(tracks.approachScale, 1000, 4)).toBe(1);
    // fadeIn*2 > preempt, so the approach alpha ramp spans the whole preempt
    expect(trackValueAt(tracks.approachAlpha, 700, 0)).toBeCloseTo(0.45, 9);
    expect(trackValueAt(tracks.approachAlpha, 1000, 0)).toBeCloseTo(0.9, 9);
  });

  test("the dim releases over 100ms ending at startTime - 300", () => {
    const tracks = circleTracks(obj, { time: 1000, grade: "great" }, true);
    expect(trackValueAt(tracks.dim, 500, 1)).toBeCloseTo(195 / 255, 9);
    expect(trackValueAt(tracks.dim, 650, 1)).toBeCloseTo((195 / 255 + 1) / 2, 9);
    expect(trackValueAt(tracks.dim, 700, 1)).toBe(1);
  });

  test("miss: container fades over 100ms, no flash", () => {
    const tracks = circleTracks(obj, { time: 1180, grade: "miss" }, true);
    expect(trackValueAt(tracks.containerAlpha, 1230, 1)).toBeCloseTo(0.5, 9);
    expect(trackValueAt(tracks.containerAlpha, 1280, 1)).toBe(0);
    expect(trackValueAt(tracks.flashAlpha, 2000, 0)).toBe(0);
  });

  test("hit: the argon explosion timeline", () => {
    const hit = 1010;
    const tracks = circleTracks(obj, { time: hit, grade: "great" }, true);
    expect(trackValueAt(tracks.numberAlpha, hit + 75, 1)).toBe(0);
    expect(trackValueAt(tracks.fillAlpha, hit + 150, 1)).toBe(0);
    // border lands at (128*0.8 + border_thickness)/128 with the elastic ease
    const target = (128 * 0.8 + 128 * (2 / 58)) / 128;
    expect(trackValueAt(tracks.borderScale, hit + 400, 1)).toBeCloseTo(target, 6);
    expect(trackValueAt(tracks.borderScale, hit + 200, 1)).toBeCloseTo(
      1 + (target - 1) * outElasticHalf(0.5), 6);
    // outer gradient: delayed 12.5ms, whitens by +92.5, gone by +242.5
    expect(trackValueAt(tracks.outerGradientWhite, hit + 92.5, 0)).toBe(1);
    expect(trackValueAt(tracks.outerGradientAlpha, hit + 92.5 + 150, 1)).toBe(0);
    // piece fade (outquad 800) and the hard container cutoff
    expect(trackValueAt(tracks.pieceAlpha, hit + 800, 1)).toBe(0);
    expect(trackValueAt(tracks.containerAlpha, hit + 799, 1)).toBe(1);
    expect(trackValueAt(tracks.containerAlpha, hit + 800, 1)).toBe(0);
    // approach hard-cut at the hit
    expect(trackValueAt(tracks.approachAlpha, hit + 1, 0)).toBe(0);
  });

  test("hit: an early hit permanently silences the approach circle, no resurrection at startTime", () => {
    // a negative-offset hit (hit < startTime) is the common case in real
    // replays. the startTime-anchored FadeOut(50) tween is still queued
    // unconditionally above (it's needed for misses and for hits that land
    // after startTime), so without the startTime jump the greatest-start
    // evaluator would hand the value back to that tween's 0.9 for up to 50ms
    // after startTime -- real transform sequences avoid this by deleting the
    // superseded queued transform outright
    // (targetgroupingtransformtracker.cs:239-253)
    const hit = 985;
    const tracks = circleTracks(obj, { time: hit, grade: "great" }, true);
    expect(trackValueAt(tracks.approachAlpha, 984, 0)).toBeCloseTo(0.876, 9); // still ramping, pre-hit
    expect(trackValueAt(tracks.approachAlpha, hit, 0)).toBe(0);               // hard cut
    expect(trackValueAt(tracks.approachAlpha, 999, 0)).toBe(0);
    expect(trackValueAt(tracks.approachAlpha, 1000, 0)).toBe(0);              // must not resurrect to 0.9
    expect(trackValueAt(tracks.approachAlpha, 1010, 0)).toBe(0);              // must not resurrect to 0.72
    expect(trackValueAt(tracks.approachAlpha, 1050, 0)).toBe(0);
  });

  test("notSimulated stand-in composes cleanly through resolveCircleResult (hit == startTime)", () => {
    // decision 5's notSimulated path resolves every object to hit == startTime;
    // exercise the actual composed pathway (not a hand-built CircleResult) so a
    // regression in either function individually, or in how they compose, is caught
    const result = resolveCircleResult([], obj.startTime);
    const tracks = circleTracks(obj, result, true);
    expect(trackValueAt(tracks.approachAlpha, obj.startTime, 0)).toBe(0);
    expect(trackValueAt(tracks.approachAlpha, obj.startTime + 40, 0)).toBe(0);
    expect(trackValueAt(tracks.pieceAlpha, obj.startTime + 800, 1)).toBe(0);
  });
});
