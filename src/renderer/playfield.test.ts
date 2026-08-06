import { describe, expect, test } from "bun:test";
import { ActiveSetTracker, objectLifetime, playfieldTransform, reconcileActiveDrawables } from "./playfield";

describe("playfield fit (osuplayfieldadjustmentcontainer.cs)", () => {
  test("the reference 1024x768 target yields the stable magic 1.6 scale", () => {
    const t = playfieldTransform(1024, 768);
    expect(t.scale).toBeCloseTo(1.6, 9);
    expect(t.offsetX).toBeCloseTo((1024 - 512 * 1.6) / 2, 9);
    expect(t.offsetY).toBeCloseTo((768 - 384 * 1.6) / 2, 9);
  });

  test("width-constrained hosts fit by width", () => {
    const t = playfieldTransform(800, 3000);
    // fitW = min(800, 3000 * 4/3) = 800; scale = 800 * 0.8 / 512
    expect(t.scale).toBeCloseTo((800 * 0.8) / 512, 9);
  });

  test("height-constrained hosts fit by height", () => {
    const t = playfieldTransform(3000, 600);
    // fitW = 600 * 4/3 = 800
    expect(t.scale).toBeCloseTo((800 * 0.8) / 512, 9);
  });
});

describe("objectLifetime", () => {
  test("vanish follows a late judgement, not just endTime", () => {
    const circle = { startTime: 1000, preempt: 450, endTime: 1000 };
    expect(objectLifetime(circle, [], 800)).toEqual({ appear: 550, vanish: 1800 });
    // a circle hit 180ms late animates until 1180 + fadeOut
    expect(objectLifetime(circle, [{ time: 1180 }], 800)).toEqual({ appear: 550, vanish: 1980 });
  });

  test("events before endTime never pull vanish earlier", () => {
    const slider = { startTime: 1000, preempt: 450, endTime: 2000 };
    expect(objectLifetime(slider, [{ time: 1500 }, { time: 2000 }], 800))
      .toEqual({ appear: 550, vanish: 2800 });
  });
});

describe("active set tracking", () => {
  const entries = [
    { appear: 0, vanish: 100 },
    { appear: 50, vanish: 150 },
    { appear: 200, vanish: 300 },
  ];

  test("forward playback adds and removes incrementally", () => {
    const tracker = new ActiveSetTracker(entries);
    expect(tracker.update(0)).toEqual({ added: [0], removed: [] });
    expect(tracker.update(60)).toEqual({ added: [1], removed: [] });
    expect(tracker.update(120)).toEqual({ added: [], removed: [0] });
    expect(tracker.update(250)).toEqual({ added: [2], removed: [1] });
    expect(tracker.update(400)).toEqual({ added: [], removed: [2] });
  });

  test("backward seeks rebuild", () => {
    const tracker = new ActiveSetTracker(entries);
    tracker.update(250);
    const result = tracker.update(60);
    expect(new Set(result.added)).toEqual(new Set([0, 1]));
    expect(result.removed).toEqual([2]);
  });

  test("unsorted entries are handled (sorted internally by appear)", () => {
    const tracker = new ActiveSetTracker([{ appear: 100, vanish: 200 }, { appear: 0, vanish: 50 }]);
    expect(tracker.update(10)).toEqual({ added: [1], removed: [] });
    expect(tracker.update(150)).toEqual({ added: [0], removed: [1] });
  });

  test("zero objects never adds or removes anything, at any t", () => {
    const tracker = new ActiveSetTracker([]);
    expect(tracker.update(-1000)).toEqual({ added: [], removed: [] });
    expect(tracker.update(0)).toEqual({ added: [], removed: [] });
    expect(tracker.update(1e9)).toEqual({ added: [], removed: [] });
    // seeking backward on an empty tracker must not throw (rebuild path with an empty active set)
    expect(tracker.update(-500)).toEqual({ added: [], removed: [] });
  });

  test("a forward query landing after everything has already died reports nothing (never seen alive)", () => {
    // starting a fresh tracker's first query past every entry's vanish time means
    // those entries were never observed alive, so nothing is created to destroy later
    const tracker = new ActiveSetTracker(entries);
    expect(tracker.update(10_000)).toEqual({ added: [], removed: [] });
  });

  test("querying the same t twice is idempotent (no duplicate add/remove)", () => {
    const tracker = new ActiveSetTracker(entries);
    tracker.update(60);
    expect(tracker.update(60)).toEqual({ added: [], removed: [] });
  });

  test("entries sharing identical appear and vanish times are all tracked independently", () => {
    const tied = [
      { appear: 10, vanish: 20 },
      { appear: 10, vanish: 20 },
      { appear: 10, vanish: 20 },
    ];
    const tracker = new ActiveSetTracker(tied);
    const onAppear = tracker.update(10);
    expect(new Set(onAppear.added)).toEqual(new Set([0, 1, 2]));
    expect(onAppear.removed).toEqual([]);
    const onVanish = tracker.update(20);
    expect(new Set(onVanish.removed)).toEqual(new Set([0, 1, 2]));
    expect(onVanish.added).toEqual([]);
  });

  test("a zero-length lifetime (appear === vanish) never becomes active", () => {
    const tracker = new ActiveSetTracker([{ appear: 5, vanish: 5 }, { appear: 0, vanish: 100 }]);
    // at t=5 the instant entry (index 0) is consumed by the appear scan but its
    // vanish <= t so it must not appear in `added`; index 1 is still alive
    const result = tracker.update(5);
    expect(result.added).toEqual([1]);
    expect(result.removed).toEqual([]);
    // it also never shows up later as a removal, since it was never added
    expect(tracker.update(200)).toEqual({ added: [], removed: [1] });
  });

  test("an entry alive both before and after a backward seek is reported only in `added`, never `removed`", () => {
    // this is the contract GameplayRenderer.render's bookkeeping must respect (see
    // reconcileActiveDrawables below): a wide-lived entry survives the rebuild without
    // ever leaving `active`, so callers must not treat every `added` index as brand new
    const wide = [
      { appear: 0, vanish: 1000 }, // index 0: alive across the whole window below
      { appear: 100, vanish: 200 }, // index 1: dead by t=450, alive again at t=150
      { appear: 400, vanish: 500 }, // index 2: alive at t=450, dead by t=150
    ];
    const tracker = new ActiveSetTracker(wide);
    expect(tracker.update(450)).toEqual({ added: [0, 2], removed: [] });
    const result = tracker.update(150); // backward seek
    expect(new Set(result.added)).toEqual(new Set([0, 1]));
    expect(result.removed).toEqual([2]);
    // index 0 never appears in `removed` despite the full active-set rebuild
    expect(result.removed).not.toContain(0);
  });
});

describe("reconcileActiveDrawables (GameplayRenderer.render's map bookkeeping)", () => {
  interface StubDrawable {
    index: number;
    destroyed: boolean;
  }

  function stub(created: number[], destroyed: number[]) {
    return {
      create: (index: number): StubDrawable => {
        created.push(index);
        return { index, destroyed: false };
      },
      destroy: (drawable: StubDrawable): void => {
        drawable.destroyed = true;
        destroyed.push(drawable.index);
      },
    };
  }

  test("added creates, removed destroys, untouched indices are left alone", () => {
    const map = new Map<number, StubDrawable>();
    const created: number[] = [];
    const destroyed: number[] = [];
    const { create, destroy } = stub(created, destroyed);

    reconcileActiveDrawables(map, { added: [0, 1], removed: [] }, create, destroy);
    expect(created).toEqual([0, 1]);
    expect(map.size).toBe(2);

    reconcileActiveDrawables(map, { added: [], removed: [0] }, create, destroy);
    expect(destroyed).toEqual([0]);
    expect(map.has(0)).toBe(false);
    expect(map.has(1)).toBe(true);
  });

  test("a factory returning null (unrenderable kind) never enters the map", () => {
    const map = new Map<number, StubDrawable>();
    reconcileActiveDrawables(map, { added: [0], removed: [] }, () => null, () => {
      throw new Error("must not be called");
    });
    expect(map.size).toBe(0);
  });

  test("regression: a backward-seek rebuild reporting an already-alive index in `added` does not leak the old drawable", () => {
    // reproduces the GameplayRenderer.render bug: ActiveSetTracker's backward-seek rebuild
    // reports an index in `added` without a matching `removed` when it was alive both before
    // and after the seek. the old render() blindly created a fresh drawable for every `added`
    // index and overwrote the map entry, leaking the previous drawable's view/GPU resources.
    const map = new Map<number, StubDrawable>();
    const created: number[] = [];
    const destroyed: number[] = [];
    const { create, destroy } = stub(created, destroyed);

    // forward playback reaches t=450: objects 0 and 2 are alive (mirrors the
    // ActiveSetTracker "wide" fixture above)
    reconcileActiveDrawables(map, { added: [0, 2], removed: [] }, create, destroy);
    const originalZero = map.get(0);
    expect(originalZero).toBeDefined();

    // backward seek to t=150: the tracker rebuilds and reports 0 as re-added (still alive,
    // never actually removed) and 1 as newly alive; 2 is genuinely removed
    reconcileActiveDrawables(map, { added: [0, 1], removed: [2] }, create, destroy);

    // index 0 must not have been recreated...
    expect(created).toEqual([0, 2, 1]);
    // ...its original drawable instance must still be the one in the map...
    expect(map.get(0)).toBe(originalZero);
    // ...and it must never have been destroyed
    expect(originalZero?.destroyed).toBe(false);
    expect(destroyed).not.toContain(0);
    // 1 was freshly created, 2 was destroyed and dropped
    expect(map.has(1)).toBe(true);
    expect(destroyed).toEqual([2]);
    expect(map.has(2)).toBe(false);
  });
});

describe("playfield fit edge cases", () => {
  test("a zero-size host collapses to a zero scale without NaN or throwing", () => {
    const t = playfieldTransform(0, 0);
    expect(t.scale).toBe(0);
    expect(t.offsetX).toBe(0);
    expect(t.offsetY).toBe(0);
  });

  test("an extremely wide host stays height-constrained and finite", () => {
    const t = playfieldTransform(1_000_000, 1);
    // fitW = min(1e6, 1 * 4/3) * 0.8 = (4/3) * 0.8
    const expectedScale = ((4 / 3) * 0.8) / 512;
    expect(t.scale).toBeCloseTo(expectedScale, 12);
    expect(Number.isFinite(t.offsetX)).toBe(true);
    expect(Number.isFinite(t.offsetY)).toBe(true);
  });

  test("an extremely tall square host at large magnitude stays finite and centred", () => {
    const t = playfieldTransform(10_000_000, 10_000_000);
    const expectedScale = (10_000_000 * 0.8) / 512;
    expect(t.scale).toBeCloseTo(expectedScale, 3);
    expect(t.offsetX).toBeCloseTo((10_000_000 - 512 * expectedScale) / 2, 3);
    expect(t.offsetY).toBeCloseTo((10_000_000 - 384 * expectedScale) / 2, 3);
  });
});
