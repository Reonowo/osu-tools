import { describe, expect, test } from "bun:test";
import { aliveWindow, countAtOrBefore } from "./analysis";

describe("aliveWindow (analysisframeentry.cs lifetime [t, t+len))", () => {
  const times = [0, 100, 200, 300, 400];

  test("selects entries with time <= t < time + displayLength", () => {
    expect(aliveWindow(times, 250, 800)).toEqual({ lo: 0, hi: 3 });
    expect(aliveWindow(times, 950, 800)).toEqual({ lo: 2, hi: 5 });
    // exactly at expiry: entry at 0 dies at t=800
    expect(aliveWindow(times, 800, 800)).toEqual({ lo: 1, hi: 5 });
    expect(aliveWindow(times, -1, 800)).toEqual({ lo: 0, hi: 0 });
  });

  test("empty times array is always an empty window", () => {
    expect(aliveWindow([], 500, 800)).toEqual({ lo: 0, hi: 0 });
  });

  // duplicate timestamps are a real replay-frame shape (interpolation.ts:43-46,
  // confirmed against framedreplayinputhandler.cs:141-146); a run of ties must
  // enter and leave the window together, never split by index
  describe("duplicate timestamps", () => {
    const dup = [100, 100, 200, 200, 200, 300];

    test("a run of ties at the trailing edge (time === t) is fully included", () => {
      // window (100, 200]: excludes both 100s, includes all three 200s
      expect(aliveWindow(dup, 200, 100)).toEqual({ lo: 2, hi: 5 });
    });

    test("a run of ties at the leading edge (time === t - displayLength) is fully excluded", () => {
      // window (0, 100]: both 100s satisfy time <= t and t < time + length, so
      // they are alive -- but a *different* tie exactly at t - displayLength
      // itself would be excluded (time <= t - length fails t < time + length)
      expect(aliveWindow(dup, 100, 100)).toEqual({ lo: 0, hi: 2 });
    });

    test("a lone entry past every tie", () => {
      // window (200, 300]: only the trailing 300 qualifies
      expect(aliveWindow(dup, 300, 100)).toEqual({ lo: 5, hi: 6 });
    });
  });
});

describe("countAtOrBefore", () => {
  test("binary search over press-edge times", () => {
    const times = [10, 20, 20, 30];
    expect(countAtOrBefore(times, 5)).toBe(0);
    expect(countAtOrBefore(times, 20)).toBe(3);
    expect(countAtOrBefore(times, 99)).toBe(4);
  });

  test("empty input is always zero", () => {
    expect(countAtOrBefore([], 0)).toBe(0);
  });

  test("boundary ties: t exactly at a duplicated value counts the whole run", () => {
    const times = [5, 5, 5];
    expect(countAtOrBefore(times, 4)).toBe(0);
    expect(countAtOrBefore(times, 5)).toBe(3);
  });
});
