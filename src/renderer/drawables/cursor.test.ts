import { describe, expect, test } from "bun:test";
import { trackValueAt } from "../../engine/transforms";
import { advanceTrail, expandTracks, holdIntervals, isTrailReset, trailAlpha } from "./cursor";

const frame = (time: number, buttons: number) => ({ time, x: 0, y: 0, buttons });

describe("hold intervals", () => {
  test("merges left/right holds into gameplay-press spans", () => {
    const intervals = holdIntervals([
      frame(0, 0), frame(10, 1), frame(20, 1 | 2), frame(30, 2), frame(40, 0), frame(50, 4), frame(60, 0),
    ]);
    expect(intervals).toEqual([{ start: 10, end: 40 }, { start: 50, end: 60 }]);
  });

  test("a hold running to the last frame stays open-ended", () => {
    const intervals = holdIntervals([frame(0, 0), frame(10, 1)]);
    expect(intervals).toEqual([{ start: 10, end: Number.POSITIVE_INFINITY }]);
  });
});

describe("expand tracks (skinnablecursor.cs:9-30)", () => {
  test("press snaps to 1 then eases to 1.2; release eases back", () => {
    const tracks = expandTracks([{ start: 100, end: 600 }]);
    expect(trackValueAt(tracks, 99, 1)).toBe(1);
    expect(trackValueAt(tracks, 100, 1)).toBe(1);
    expect(trackValueAt(tracks, 500, 1)).toBeCloseTo(1.2, 3); // settled
    expect(trackValueAt(tracks, 1000, 1)).toBeCloseTo(1, 3);  // released
  });

  test("a genuinely brief but non-zero hold still runs both the press and release tweens", () => {
    // 1ms hold: short, but start !== end, so this is the ordinary path, not
    // the degenerate same-instant case below. the press tween barely gets
    // going before the release tween (started at 101) takes over, so this
    // never reaches 1.2 -- it only needs to show real (if brief) motion,
    // unlike the zero-duration case, which stays pinned at exactly 1
    const tracks = expandTracks([{ start: 100, end: 101 }]);
    expect(trackValueAt(tracks, 99, 1)).toBe(1);
    expect(trackValueAt(tracks, 100, 1)).toBe(1);
    // mid-ramp, still driven by the press tween since the release tween's
    // start (101) hasn't been reached yet
    expect(trackValueAt(tracks, 100.5, 1)).toBeGreaterThan(1);
    // well after the release tween (101 + 400 = 501) has finished
    expect(trackValueAt(tracks, 600, 1)).toBeCloseTo(1, 6);
  });

  test("a release mid-expansion contracts from the sampled value, not from 1.2", () => {
    // contract()'s scaleto starts from the drawable's current value
    // (skinnablecursor.cs:21), so a 200ms hold releases from wherever the
    // 400ms elastic actually got to -- no pop to the completed 1.2
    const tracks = expandTracks([{ start: 100, end: 300 }]);
    const pressOnly = expandTracks([{ start: 100, end: Number.POSITIVE_INFINITY }]);
    const atRelease = trackValueAt(pressOnly, 300, 1);
    expect(trackValueAt(tracks, 300, 1)).toBeCloseTo(atRelease, 9);
    expect(trackValueAt(tracks, 800, 1)).toBeCloseTo(1, 9); // settled back after the 400ms contraction
  });

  test("a same-instant press and release (start === end) never visibly expands", () => {
    // holdIntervals produces exactly this shape from a duplicate-time frame
    // run: frame(10,1) pressed then frame(10,0) released, both at time 10
    // (interpolation.ts already treats this pairing as real input --
    // interpolation.test.ts:68). Expand()'s instant jump-to-1 is immediately
    // superseded by Contract()'s ScaleTo(1, ...) starting from that same
    // already-1 value (skinnablecursor.cs:14-23), so nothing ever ramps to
    // 1.2 -- unlike the naive 3-track push, which let the release tween
    // (tied at the same start) win and snap the value to 1.2
    const intervals = holdIntervals([frame(0, 0), frame(10, 1), frame(10, 0), frame(20, 0)]);
    expect(intervals).toEqual([{ start: 10, end: 10 }]);

    const tracks = expandTracks(intervals);
    expect(trackValueAt(tracks, 9, 1)).toBe(1);
    expect(trackValueAt(tracks, 10, 1)).toBe(1);
    expect(trackValueAt(tracks, 50, 1)).toBe(1);
    expect(trackValueAt(tracks, 500, 1)).toBe(1);
  });

  test("a same-instant blip cuts off an in-flight release tween from an earlier press, pinning to 1", () => {
    // interval1 releases at t=500 (mid-ramp back down at t=520); interval2
    // is a same-instant blip that reopens and immediately recloses at 520,
    // the same duplicate-time-run shape as above. Expand()'s unconditional
    // jump must win over interval1's still-in-flight release tween
    const tracks = expandTracks([{ start: 100, end: 500 }, { start: 520, end: 520 }]);
    expect(trackValueAt(tracks, 519, 1)).toBeGreaterThan(1); // interval1's release tween, still easing down
    expect(trackValueAt(tracks, 520, 1)).toBe(1);
    expect(trackValueAt(tracks, 521, 1)).toBe(1);
  });
});

describe("trail reset detection (cursortrail.cs's AddTrail assumes continuous mouse motion)", () => {
  test("the very first update is always a reset", () => {
    expect(isTrailReset(null, 0, 200)).toBe(true);
  });

  test("a backward seek resets, regardless of magnitude", () => {
    expect(isTrailReset(500, 499, 200)).toBe(true);
    expect(isTrailReset(500, 100, 200)).toBe(true);
  });

  test("a forward jump within the threshold is ordinary playback", () => {
    expect(isTrailReset(500, 500, 200)).toBe(false);
    expect(isTrailReset(500, 700, 200)).toBe(false);
  });

  test("a forward jump past the threshold resets", () => {
    expect(isTrailReset(500, 701, 200)).toBe(true);
  });
});

describe("trail spawn spacing (cursortrail.cs:179-226)", () => {
  test("spawns at each interval strictly before the segment end, carrying the remainder forward", () => {
    // 3-4-5 triangle scaled by the interval: distance is exactly 5x interval
    const { spawns, next } = advanceTrail([0, 0], [30.72, 40.96], 10.24);
    expect(spawns.length).toBe(4); // strict '<' excludes the exact 5th multiple
    expect(spawns[0][0]).toBeCloseTo(6.144, 6); // 0.6 * 10.24
    expect(spawns[0][1]).toBeCloseTo(8.192, 6); // 0.8 * 10.24
    expect(spawns[3][0]).toBeCloseTo(24.576, 6); // 0.6 * 40.96
    expect(spawns[3][1]).toBeCloseTo(32.768, 6); // 0.8 * 40.96
    expect(next[0]).toBeCloseTo(spawns[3][0], 10);
    expect(next[1]).toBeCloseTo(spawns[3][1], 10);
  });

  test("movement under one interval spawns nothing and leaves the reference point unchanged", () => {
    const { spawns, next } = advanceTrail([0, 0], [5, 0], 10.24);
    expect(spawns).toEqual([]);
    expect(next).toEqual([0, 0]);
  });

  test("movement exactly one interval spawns nothing (strict '<' excludes the boundary too)", () => {
    const { spawns, next } = advanceTrail([0, 0], [10.24, 0], 10.24);
    expect(spawns).toEqual([]);
    expect(next).toEqual([0, 0]);
  });

  test("standing still spawns nothing (no direction to divide by)", () => {
    const { spawns, next } = advanceTrail([12, 34], [12, 34], 10.24);
    expect(spawns).toEqual([]);
    expect(next).toEqual([12, 34]);
  });
});

describe("trail fade alpha (argoncursortrail.cs:16,26 -- 0.8 * clamp(1-age,0,1)^4)", () => {
  test("a fresh part renders at the base alpha", () => {
    expect(trailAlpha(0)).toBe(0.8);
  });

  test("a part halfway through its fade is dimmed by the fourth power, not linearly", () => {
    expect(trailAlpha(0.5)).toBeCloseTo(0.8 * 0.5 ** 4, 10);
    expect(trailAlpha(0.5)).not.toBeCloseTo(0.8 * 0.5, 3);
  });

  test("a fully aged part is invisible, and age past 1 clamps rather than going negative", () => {
    expect(trailAlpha(1)).toBe(0);
    expect(trailAlpha(1.5)).toBe(0);
  });
});
