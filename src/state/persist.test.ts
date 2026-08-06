import { describe, expect, test } from "bun:test";
import type { IpcError, OverlaySettings, Settings } from "../lib/scene-types";
import { testScene } from "../test/scene";
import { DEFAULT_OVERLAYS } from "./defaults";
import { installPrefsPersistence, type Scheduler } from "./persist";
import { createViewerStore, type IpcDeps } from "./store";

const baseSettings: Settings = { osuStablePath: null, volume: 100, overlays: DEFAULT_OVERLAYS };

function deps(): IpcDeps {
  return {
    loadReplay: async () => testScene(),
    loadReplayWithBeatmap: async () => testScene(),
    getSettings: async () => baseSettings,
    setOsuStablePath: async (path) => ({ ...baseSettings, osuStablePath: path }),
    setViewerPrefs: async (volume, overlays) => ({ ...baseSettings, volume, overlays }),
  };
}

/** a manual scheduler: bun:test has no fake timers, so the debounce is driven
 * by hand. only the most recently scheduled callback is pending, matching
 * setTimeout/clearTimeout semantics under the trailing debounce */
function manualScheduler() {
  let pending: (() => void) | null = null;
  let nextHandle = 1;
  let scheduled = 0;
  let cancelled = 0;
  const scheduler: Scheduler = {
    schedule(fn) {
      scheduled += 1;
      pending = fn;
      return nextHandle++;
    },
    cancel() {
      cancelled += 1;
      pending = null;
    },
  };
  return {
    scheduler,
    get scheduled() { return scheduled; },
    get cancelled() { return cancelled; },
    get isPending() { return pending !== null; },
    fire() {
      const fn = pending;
      pending = null;
      fn?.();
    },
  };
}

function saveRecorder() {
  const calls: { volume: number; overlays: OverlaySettings }[] = [];
  return {
    calls,
    save: async (volume: number, overlays: OverlaySettings) => {
      calls.push({ volume, overlays });
      return baseSettings;
    },
  };
}

describe("installPrefsPersistence", () => {
  test("a burst of changes collapses into one save carrying the latest values", () => {
    const store = createViewerStore(deps());
    const timer = manualScheduler();
    const rec = saveRecorder();
    installPrefsPersistence(store, rec.save, 500, timer.scheduler);

    store.getState().setVolume(10);
    store.getState().setVolume(20);
    store.getState().setVolume(30);
    expect(rec.calls).toHaveLength(0); // nothing before the timer fires
    expect(timer.cancelled).toBe(2); // each new change replaced the pending save

    timer.fire();
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0].volume).toBe(30);
  });

  test("the save reads the values current at fire time, not at schedule time", () => {
    const store = createViewerStore(deps());
    const timer = manualScheduler();
    const rec = saveRecorder();
    installPrefsPersistence(store, rec.save, 500, timer.scheduler);

    store.getState().setVolume(55);
    // a change that lands after the timer was armed but before it fires still
    // has to be included -- the callback reads the store, not a captured value
    store.getState().setOverlay("cursorPath", true);
    timer.fire();

    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0].volume).toBe(55);
    expect(rec.calls[0].overlays.cursorPath).toBe(true);
  });

  test("overlay changes schedule a save; rate, playing and scene loads do not", async () => {
    const store = createViewerStore(deps());
    const timer = manualScheduler();
    const rec = saveRecorder();
    installPrefsPersistence(store, rec.save, 500, timer.scheduler);

    store.getState().setRate(1.5);
    store.getState().setPlaying(true);
    store.getState().setAudioDuration(1234);
    await store.getState().openReplay("C:\\r.osr");
    expect(timer.scheduled).toBe(0);

    store.getState().setOverlay("keyOverlay", false);
    expect(timer.scheduled).toBe(1);
    timer.fire();
    expect(rec.calls[0].overlays.keyOverlay).toBe(false);
  });

  test("dispose flushes the pending save and stops listening", () => {
    const store = createViewerStore(deps());
    const timer = manualScheduler();
    const rec = saveRecorder();
    const dispose = installPrefsPersistence(store, rec.save, 500, timer.scheduler);

    store.getState().setVolume(40);
    expect(timer.isPending).toBe(true);
    dispose();
    expect(timer.isPending).toBe(false);
    // a pending save is committed user intent -- teardown writes it now
    // instead of dropping it
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0].volume).toBe(40);

    store.getState().setVolume(60);
    expect(timer.scheduled).toBe(1); // no new schedule after dispose
    expect(rec.calls).toHaveLength(1);
  });

  test("dispose with nothing pending saves nothing", () => {
    const store = createViewerStore(deps());
    const timer = manualScheduler();
    const rec = saveRecorder();
    const dispose = installPrefsPersistence(store, rec.save, 500, timer.scheduler);
    dispose();
    expect(rec.calls).toHaveLength(0);
  });

  test("a failed save surfaces through lastError instead of vanishing", async () => {
    const store = createViewerStore(deps());
    const timer = manualScheduler();
    installPrefsPersistence(
      store,
      async () => { throw { kind: "io", message: "read-only config dir" } satisfies IpcError; },
      500,
      timer.scheduler,
    );

    store.getState().setVolume(25);
    timer.fire();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(store.getState().lastError?.error.kind).toBe("io");
    // the store keeps the user's value; only the write to disk failed
    expect(store.getState().volume).toBe(25);
  });

  test("a non-ipc save failure is wrapped as an internal error", async () => {
    const store = createViewerStore(deps());
    const timer = manualScheduler();
    installPrefsPersistence(store, async () => { throw new Error("boom"); }, 500, timer.scheduler);

    store.getState().setVolume(25);
    timer.fire();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(store.getState().lastError?.error.kind).toBe("internal");
  });

  test("a re-set of the same value still writes only what the store holds", () => {
    // zustand notifies on every set, even one that changes nothing; the
    // debounce must not turn that into a divergent write
    const store = createViewerStore(deps());
    const timer = manualScheduler();
    const rec = saveRecorder();
    installPrefsPersistence(store, rec.save, 500, timer.scheduler);

    store.getState().setVolume(100); // identical to the initial value
    if (timer.isPending) timer.fire();
    for (const call of rec.calls) {
      expect(call.volume).toBe(store.getState().volume);
      expect(call.overlays).toBe(store.getState().overlays);
    }
  });
});
