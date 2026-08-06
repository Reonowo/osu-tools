import { describe, expect, test } from "bun:test";
import { fractionFor, statsAt, timeFor } from "./timeline";

const bounds = { minTime: -1500, maxTime: 8500 };

describe("timeline mapping", () => {
  test("fraction spans the signed range", () => {
    expect(fractionFor(bounds, -1500)).toBe(0);
    expect(fractionFor(bounds, 8500)).toBe(1);
    expect(fractionFor(bounds, 0)).toBeCloseTo(0.15, 9);
    expect(fractionFor(bounds, 99999)).toBe(1);
  });

  test("fraction clamps below the minimum too", () => {
    expect(fractionFor(bounds, -99999)).toBe(0);
    expect(fractionFor(bounds, -1500.0001)).toBe(0);
  });

  test("fraction on a zero-span (or inverted) bounds never divides by zero", () => {
    expect(fractionFor({ minTime: 0, maxTime: 0 }, 0)).toBe(0);
    expect(fractionFor({ minTime: 0, maxTime: 0 }, 500)).toBe(0);
    expect(fractionFor({ minTime: 100, maxTime: 0 }, 50)).toBe(0);
  });

  test("timeFor inverts and clamps", () => {
    expect(timeFor(bounds, 0.15)).toBeCloseTo(0, 9);
    expect(timeFor(bounds, -0.5)).toBe(-1500);
    expect(timeFor(bounds, 2)).toBe(8500);
    expect(timeFor({ minTime: 0, maxTime: 0 }, 0.5)).toBe(0);
  });

  test("timeFor at the exact fraction boundaries", () => {
    expect(timeFor(bounds, 0)).toBe(-1500);
    expect(timeFor(bounds, 1)).toBe(8500);
  });

  test("fractionFor and timeFor round-trip within the span", () => {
    for (const t of [-1500, -750, 0, 1, 4000, 8499, 8500]) {
      expect(timeFor(bounds, fractionFor(bounds, t))).toBeCloseTo(t, 6);
    }
  });
});

describe("statsAt", () => {
  const events = [
    { time: 100, objectIndex: 0, kind: { type: "circle", grade: "great" }, comboAfter: 1, accuracyAfter: 1 },
    { time: 200, objectIndex: 1, kind: { type: "circle", grade: "miss" }, comboAfter: 0, accuracyAfter: 0.5 },
  ] satisfies import("./scene-types").JudgementEventDto[];

  test("null before the first judgement, latest state after", () => {
    expect(statsAt(events, 50)).toBeNull();
    expect(statsAt(events, 100)).toEqual({ combo: 1, accuracy: 1 });
    expect(statsAt(events, 150)).toEqual({ combo: 1, accuracy: 1 });
    expect(statsAt(events, 999)).toEqual({ combo: 0, accuracy: 0.5 });
  });

  test("empty events are always null, at any t including 0 and negative", () => {
    expect(statsAt([], 0)).toBeNull();
    expect(statsAt([], -1000)).toBeNull();
    expect(statsAt([], 999999)).toBeNull();
  });

  test("several events at the same instant: the last one in sequence wins", () => {
    const tied = [
      { time: 100, objectIndex: 0, kind: { type: "circle", grade: "great" }, comboAfter: 1, accuracyAfter: 1 },
      { time: 500, objectIndex: 1, kind: { type: "sliderTick", hit: true }, comboAfter: 2, accuracyAfter: 0.95 },
      { time: 500, objectIndex: 1, kind: { type: "sliderTick", hit: true }, comboAfter: 3, accuracyAfter: 0.96 },
      { time: 500, objectIndex: 1, kind: { type: "sliderAggregate", grade: "ok" }, comboAfter: 4, accuracyAfter: 0.9 },
    ] satisfies import("./scene-types").JudgementEventDto[];

    // exactly at the tied instant: the last event at that time (index 3) wins
    expect(statsAt(tied, 500)).toEqual({ combo: 4, accuracy: 0.9 });
    // just after the tie, same result
    expect(statsAt(tied, 500.5)).toEqual({ combo: 4, accuracy: 0.9 });
    // just before the tie, the pre-tie event still holds
    expect(statsAt(tied, 499)).toEqual({ combo: 1, accuracy: 1 });
  });

  test("a single event exactly at t", () => {
    const single = [
      { time: 42, objectIndex: 0, kind: { type: "circle", grade: "meh" }, comboAfter: 1, accuracyAfter: 0.8 },
    ] satisfies import("./scene-types").JudgementEventDto[];
    expect(statsAt(single, 42)).toEqual({ combo: 1, accuracy: 0.8 });
    expect(statsAt(single, 41.999)).toBeNull();
  });

  test("negative t (lead-in) before any judgement is null", () => {
    expect(statsAt(events, -1500)).toBeNull();
    expect(statsAt(events, -0.001)).toBeNull();
  });
});
