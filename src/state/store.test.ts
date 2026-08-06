import { describe, expect, test } from "bun:test";
import type { IpcError, LoadedScene } from "../lib/scene-types";
import { testScene } from "../test/scene";
import { createViewerStore, type IpcDeps } from "./store";

function deps(overrides: Partial<IpcDeps> = {}): IpcDeps {
  return {
    loadReplay: async () => testScene(),
    loadReplayWithBeatmap: async () => testScene(),
    getSettings: async () => ({ osuStablePath: null }),
    setOsuStablePath: async (path) => ({ osuStablePath: path }),
    ...overrides,
  };
}

const reject = (e: IpcError) => async (): Promise<LoadedScene> => { throw e; };

describe("load flow", () => {
  test("openReplay success installs scene + derived and bumps sceneId", async () => {
    const store = createViewerStore(deps());
    await store.getState().openReplay("C:\\r.osr");
    const s = store.getState();
    expect(s.scene).not.toBeNull();
    expect(s.derived?.bounds.minTime).toBe(-1500);
    expect(s.sceneId).toBe(1);
    expect(s.loading).toBe(false);
    expect(s.lastError).toBeNull();
  });

  test("beatmapNotFound surfaces with the pickBeatmap recovery", async () => {
    const store = createViewerStore(deps({
      loadReplay: reject({ kind: "beatmapNotFound", md5: "abc" }),
    }));
    await store.getState().openReplay("C:\\r.osr");
    const s = store.getState();
    expect(s.scene).toBeNull();
    expect(s.lastError?.error.kind).toBe("beatmapNotFound");
    expect(s.lastError?.osrPath).toBe("C:\\r.osr");
  });

  test("mismatch goes to pendingMismatch and confirm re-invokes with allowMismatch", async () => {
    // strengthened: records the full argument tuple (not just the allow
    // flag) so the test also catches a retry that drops or swaps the
    // remembered osrPath/beatmapPath, not only a retry that forgets to flip
    // allowMismatch
    const calls: { osrPath: string; beatmapPath: string; allow: boolean }[] = [];
    const store = createViewerStore(deps({
      loadReplayWithBeatmap: async (osrPath, beatmapPath, allow) => {
        calls.push({ osrPath, beatmapPath, allow });
        if (!allow) throw { kind: "beatmapMismatch", expectedMd5: "a", actualMd5: "b" } satisfies IpcError;
        return testScene();
      },
    }));
    await store.getState().openWithBeatmap("C:\\r.osr", "C:\\m.osu");
    const pending = store.getState().pendingMismatch;
    expect(pending?.expectedMd5).toBe("a");
    expect(pending?.actualMd5).toBe("b");
    expect(pending?.osrPath).toBe("C:\\r.osr");
    expect(pending?.beatmapPath).toBe("C:\\m.osu");
    expect(store.getState().scene).toBeNull();

    await store.getState().confirmMismatch();
    expect(calls).toEqual([
      { osrPath: "C:\\r.osr", beatmapPath: "C:\\m.osu", allow: false },
      { osrPath: "C:\\r.osr", beatmapPath: "C:\\m.osu", allow: true },
    ]);
    expect(store.getState().scene).not.toBeNull();
    expect(store.getState().pendingMismatch).toBeNull();
  });

  test("a new load replaces the previous error and scene state", async () => {
    // strengthened: the original version only compared two independent
    // fresh store instances, which can't fail for the reason the test name
    // states (a load replacing *the same store's* prior error/scene). this
    // now also retries on the SAME store instance to prove that path.
    let shouldFail = true;
    const store = createViewerStore(deps({
      loadReplay: async () => {
        if (shouldFail) throw { kind: "replayParse", message: "bad" } satisfies IpcError;
        return testScene();
      },
    }));
    await store.getState().openReplay("C:\\r.osr");
    expect(store.getState().lastError?.error.kind).toBe("replayParse");
    expect(store.getState().scene).toBeNull();

    const ok = createViewerStore(deps());
    await ok.getState().openReplay("C:\\r.osr");
    expect(ok.getState().lastError).toBeNull();

    shouldFail = false;
    await store.getState().openReplay("C:\\r.osr");
    expect(store.getState().lastError).toBeNull();
    expect(store.getState().scene).not.toBeNull();
    expect(store.getState().derived?.bounds.minTime).toBe(-1500);
  });

  test("overlapping loads serialize their ipc calls and install in action order", async () => {
    // the drop handler doesn't gate on `loading` (src/lib/openers.ts), so a
    // second drop can start while the first ipc call is pending. the tauri
    // commands install the backend session as a side effect, so the calls
    // must never overlap (backend install order = user action order), and
    // every successful completion installs frontend-side to stay in
    // lockstep with the backend session
    const calls: string[] = [];
    let resolveFirst!: (scene: LoadedScene) => void;
    const store = createViewerStore(deps({
      loadReplay: (osrPath) => {
        calls.push(osrPath);
        if (calls.length === 1) return new Promise<LoadedScene>((resolve) => { resolveFirst = resolve; });
        return Promise.resolve(testScene());
      },
    }));
    const staleLoad = store.getState().openReplay("C:\\old.osr");
    await Promise.resolve(); // let the first ipc call actually start
    const newLoad = store.getState().openReplay("C:\\new.osr");
    expect(calls).toEqual(["C:\\old.osr"]); // the second call queues behind the first

    resolveFirst(testScene());
    await Promise.all([staleLoad, newLoad]);
    expect(calls).toEqual(["C:\\old.osr", "C:\\new.osr"]);
    expect(store.getState().sceneId).toBe(2); // both successes installed, newest last
    expect(store.getState().scene).not.toBeNull();
    expect(store.getState().loading).toBe(false);
  });

  test("a stale success followed by a failing newest load leaves the stale scene displayed (backend parity)", async () => {
    // the stale command already installed its session backend-side and
    // dropped the previous scene's cache lease; when the newest load then
    // fails, the frontend must show that stale scene rather than keep one
    // whose assets the backend has deleted
    const calls: string[] = [];
    let resolveFirst!: (scene: LoadedScene) => void;
    const store = createViewerStore(deps({
      loadReplay: (osrPath) => {
        calls.push(osrPath);
        if (calls.length === 1) return new Promise<LoadedScene>((resolve) => { resolveFirst = resolve; });
        return Promise.reject({ kind: "replayParse", message: "bad" } satisfies IpcError);
      },
    }));
    const staleLoad = store.getState().openReplay("C:\\a.osr");
    await Promise.resolve();
    const newLoad = store.getState().openReplay("C:\\b.osr");

    resolveFirst(testScene());
    await Promise.all([staleLoad, newLoad]);
    expect(store.getState().scene).not.toBeNull(); // the stale success is displayed
    expect(store.getState().sceneId).toBe(1);
    expect(store.getState().lastError?.error.kind).toBe("replayParse"); // the newest failure still surfaces
    expect(store.getState().lastError?.osrPath).toBe("C:\\b.osr");
    expect(store.getState().loading).toBe(false);
  });

  test("a stale failure cannot clobber a newer load's clean state", async () => {
    const calls: string[] = [];
    let rejectFirst!: (e: IpcError) => void;
    const store = createViewerStore(deps({
      loadReplay: (osrPath) => {
        calls.push(osrPath);
        if (calls.length === 1) return new Promise<LoadedScene>((_, reject2) => { rejectFirst = reject2; });
        return Promise.resolve(testScene());
      },
    }));
    const staleLoad = store.getState().openReplay("C:\\old.osr");
    await Promise.resolve();
    const newLoad = store.getState().openReplay("C:\\new.osr");

    rejectFirst({ kind: "replayParse", message: "bad" });
    await Promise.all([staleLoad, newLoad]);
    expect(store.getState().lastError).toBeNull();
    expect(store.getState().scene).not.toBeNull();
    expect(store.getState().loading).toBe(false);
  });

  test("a load superseded while still queued never issues its ipc call", async () => {
    const calls: string[] = [];
    let resolveFirst!: (scene: LoadedScene) => void;
    const store = createViewerStore(deps({
      loadReplay: (osrPath) => {
        calls.push(osrPath);
        if (calls.length === 1) return new Promise<LoadedScene>((resolve) => { resolveFirst = resolve; });
        return Promise.resolve(testScene());
      },
    }));
    const first = store.getState().openReplay("C:\\a.osr");
    await Promise.resolve();
    const second = store.getState().openReplay("C:\\b.osr");
    const third = store.getState().openReplay("C:\\c.osr");

    resolveFirst(testScene());
    await Promise.all([first, second, third]);
    // b was superseded by c before it ever started: its ipc call is skipped
    // outright, so the backend never installs a doomed session
    expect(calls).toEqual(["C:\\a.osr", "C:\\c.osr"]);
    expect(store.getState().sceneId).toBe(2); // a (stale success) then c
    expect(store.getState().loading).toBe(false);
  });

  test("audio duration publishes and resets on the next install", async () => {
    const store = createViewerStore(deps());
    await store.getState().openReplay("C:\\r.osr");
    store.getState().setAudioDuration(123_456);
    expect(store.getState().audioDurationMs).toBe(123_456);

    await store.getState().openReplay("C:\\r.osr");
    expect(store.getState().audioDurationMs).toBeNull();
  });

  test("settings round-trip through the injected ipc", async () => {
    const store = createViewerStore(deps());
    await store.getState().loadSettings();
    expect(store.getState().settings).toEqual({ osuStablePath: null });
    await store.getState().saveStablePath("D:\\osu!");
    expect(store.getState().settings).toEqual({ osuStablePath: "D:\\osu!" });
  });

  test("a failing settings save surfaces through lastError instead of rejecting", async () => {
    // the dialog buttons void this promise, so a rejection would otherwise
    // be unhandled and the user would never learn the save failed
    const store = createViewerStore(deps({
      setOsuStablePath: async () => { throw { kind: "io", message: "unwritable" } satisfies IpcError; },
    }));
    await store.getState().saveStablePath("D:\\osu!");
    expect(store.getState().lastError?.error.kind).toBe("io");
    expect(store.getState().settings).toBeNull();
  });
});

describe("pendingRecovery (openers.ts routes a dropped beatmap through this, not lastError)", () => {
  test("a pickBeatmap-recoverable error records the osrPath, and it survives clearError", async () => {
    // App.tsx's toast effect calls clearError() synchronously in the same
    // effect that raises the toast (src/App.tsx:35), so lastError is gone by
    // the time a user actually drags a beatmap onto the window. pendingRecovery
    // must have its own lifetime, independent of that toast-driven clear
    const store = createViewerStore(deps({
      loadReplay: reject({ kind: "beatmapNotFound", md5: "abc" }),
    }));
    await store.getState().openReplay("C:\\r.osr");
    expect(store.getState().pendingRecovery).toBe("C:\\r.osr");

    store.getState().clearError();
    expect(store.getState().lastError).toBeNull();
    expect(store.getState().pendingRecovery).toBe("C:\\r.osr");
  });

  test("osuDbNotFound is pickBeatmap-recoverable too", async () => {
    const store = createViewerStore(deps({
      loadReplay: reject({ kind: "osuDbNotFound", searched: [] }),
    }));
    await store.getState().openReplay("C:\\r.osr");
    expect(store.getState().pendingRecovery).toBe("C:\\r.osr");
  });

  test("a dropped beatmap after beatmapNotFound reaches openWithBeatmap with the recorded osrPath", async () => {
    // mirrors installDropHandler's routing (src/lib/openers.ts): reads
    // pendingRecovery, not lastError, to decide where a dropped beatmap goes
    const calls: { osrPath: string; beatmapPath: string }[] = [];
    const store = createViewerStore(deps({
      loadReplay: reject({ kind: "beatmapNotFound", md5: "abc" }),
      loadReplayWithBeatmap: async (osrPath, beatmapPath) => {
        calls.push({ osrPath, beatmapPath });
        return testScene();
      },
    }));
    await store.getState().openReplay("C:\\r.osr");
    store.getState().clearError();

    const { pendingRecovery } = store.getState();
    expect(pendingRecovery).not.toBeNull();
    await store.getState().openWithBeatmap(pendingRecovery!, "C:\\m.osu");

    expect(calls).toEqual([{ osrPath: "C:\\r.osr", beatmapPath: "C:\\m.osu" }]);
    expect(store.getState().scene).not.toBeNull();
  });

  test("a successful load clears pendingRecovery", async () => {
    let shouldFail = true;
    const store = createViewerStore(deps({
      loadReplay: async () => {
        if (shouldFail) throw { kind: "beatmapNotFound", md5: "abc" } satisfies IpcError;
        return testScene();
      },
    }));
    await store.getState().openReplay("C:\\r.osr");
    expect(store.getState().pendingRecovery).toBe("C:\\r.osr");

    shouldFail = false;
    await store.getState().openReplay("C:\\r.osr");
    expect(store.getState().pendingRecovery).toBeNull();
  });

  test("a later load attempt that fails without pickBeatmap recovery clears the stale pendingRecovery", async () => {
    // judgement call: pendingRecovery always reflects only the most recent
    // load attempt's outcome, so a second, unrelated failure (here a corrupt
    // replay, which has no recovery at all) invalidates the earlier
    // beatmapNotFound's recovery rather than leaving it dangling and
    // silently routing a later beatmap drop at the wrong replay
    let errorKind: "beatmapNotFound" | "replayParse" = "beatmapNotFound";
    const store = createViewerStore(deps({
      loadReplay: async () => {
        if (errorKind === "beatmapNotFound") throw { kind: "beatmapNotFound", md5: "abc" } satisfies IpcError;
        throw { kind: "replayParse", message: "corrupt" } satisfies IpcError;
      },
    }));
    await store.getState().openReplay("C:\\r.osr");
    expect(store.getState().pendingRecovery).toBe("C:\\r.osr");

    errorKind = "replayParse";
    await store.getState().openReplay("C:\\other.osr");
    expect(store.getState().lastError?.error.kind).toBe("replayParse");
    expect(store.getState().pendingRecovery).toBeNull();
  });

  test("starting a new load clears the stale pendingRecovery immediately", async () => {
    // a beatmap dropped while the new load is in flight must not route to
    // the previous replay's recovery (src/lib/openers.ts reads this field
    // live, and the drop handler is not gated by `loading`)
    let resolveNext!: (scene: LoadedScene) => void;
    let call = 0;
    const store = createViewerStore(deps({
      loadReplay: () => {
        call += 1;
        if (call === 1) return Promise.reject({ kind: "beatmapNotFound", md5: "abc" } satisfies IpcError);
        return new Promise<LoadedScene>((resolve) => { resolveNext = resolve; });
      },
    }));
    await store.getState().openReplay("C:\\a.osr");
    expect(store.getState().pendingRecovery).toBe("C:\\a.osr");

    const second = store.getState().openReplay("C:\\b.osr");
    expect(store.getState().pendingRecovery).toBeNull();
    await Promise.resolve(); // let the queued ipc call start so resolveNext exists
    resolveNext(testScene());
    await second;
    expect(store.getState().pendingRecovery).toBeNull();
  });

  test("a beatmapMismatch outcome does not set pendingRecovery (its own recovery is offerMismatch, not pickBeatmap)", async () => {
    const store = createViewerStore(deps({
      loadReplayWithBeatmap: reject({ kind: "beatmapMismatch", expectedMd5: "a", actualMd5: "b" }),
    }));
    await store.getState().openWithBeatmap("C:\\r.osr", "C:\\m.osu");
    expect(store.getState().pendingMismatch).not.toBeNull();
    expect(store.getState().pendingRecovery).toBeNull();
  });
});
