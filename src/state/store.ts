// the app store: discrete state only (the clock owns continuous time).
// ipc goes through an injected deps object so bun tests script it

import { createStore, useStore, type StoreApi } from "zustand";
import {
  invokeGetSettings, invokeLoadReplay, invokeLoadReplayWithBeatmap,
  invokeSetOsuStablePath, isIpcError,
} from "../lib/ipc";
import type { IpcError, LoadedScene, Settings } from "../lib/scene-types";
import { deriveScene, type DerivedScene } from "../lib/derive";
import { describeIpcError } from "./errors";

export interface IpcDeps {
  loadReplay(osrPath: string): Promise<LoadedScene>;
  loadReplayWithBeatmap(osrPath: string, beatmapPath: string, allowMismatch: boolean): Promise<LoadedScene>;
  getSettings(): Promise<Settings>;
  setOsuStablePath(path: string | null): Promise<Settings>;
}

export interface OverlaySettings {
  cursorPath: boolean;
  clickMarkers: boolean;
  frameMarkers: boolean;
  hideCursor: boolean;
  keyOverlay: boolean;
  /** ms; lazer's ReplayAnalysisDisplayLength (200-2000 step 200, default 800) */
  displayLength: number;
}

export interface ViewerState {
  scene: LoadedScene | null;
  derived: DerivedScene | null;
  sceneId: number;
  loading: boolean;
  lastError: { error: IpcError; osrPath: string } | null;
  /** the osrPath of the load that most recently failed with a pickBeatmap-
   * recoverable error (beatmapNotFound / osuDbNotFound), so a dropped
   * beatmap can route to openWithBeatmap even after lastError itself is
   * cleared (App.tsx clears lastError synchronously once its toast is
   * raised -- this field has its own lifetime, independent of the toast).
   * cleared at the start of every load attempt and re-set by that
   * attempt's outcome (to null when it isn't pickBeatmap-recoverable),
   * so it always reflects only the most recent attempt */
  pendingRecovery: string | null;
  pendingMismatch: { expectedMd5: string; actualMd5: string; osrPath: string; beatmapPath: string } | null;
  /** ms; the attached audio's duration once its metadata loads (PlayerView
   * publishes it). the clock's playable range extends past the last object
   * when the audio outlives it, and the timeline must map against those same
   * effective bounds. null until metadata arrives; reset by every install */
  audioDurationMs: number | null;
  settings: Settings | null;
  overlays: OverlaySettings;
  playing: boolean;
  rate: number;

  openReplay(osrPath: string): Promise<void>;
  openWithBeatmap(osrPath: string, beatmapPath: string): Promise<void>;
  confirmMismatch(): Promise<void>;
  dismissMismatch(): void;
  clearError(): void;
  setAudioDuration(durationMs: number): void;
  setOverlay<K extends keyof OverlaySettings>(key: K, value: OverlaySettings[K]): void;
  setPlaying(playing: boolean): void;
  setRate(rate: number): void;
  loadSettings(): Promise<void>;
  saveStablePath(path: string | null): Promise<void>;
}

export function createViewerStore(deps: IpcDeps): StoreApi<ViewerState> {
  return createStore<ViewerState>((set, get) => {
    // bumped at the start of every load; a load whose seq is no longer
    // current was superseded by a newer user action (the drop handler
    // doesn't gate on `loading`) and must not touch the store. loads are
    // also chained through loadQueue: the tauri commands install the
    // backend session as a side effect (commands.rs install_scene), so
    // overlapping calls would let an older completion replace a newer
    // session backend-side and drop the displayed scene's .osz cache
    // lease. serializing keeps backend install order = user action order,
    // and a superseded load that hasn't started skips its ipc call entirely
    let loadSeq = 0;
    let loadQueue: Promise<void> = Promise.resolve();

    // a stale (superseded) success still swaps the displayed scene: its
    // command already installed the backend session (commands.rs
    // install_scene runs before the promise resolves) and dropped the
    // previous scene's cache lease, so the display must follow the backend
    // or a failing newest load would leave it pointing at deleted assets.
    // only the current load owns the loading flag and error/pending state
    function install(scene: LoadedScene, current: boolean) {
      set({
        scene,
        derived: deriveScene(scene),
        sceneId: get().sceneId + 1,
        audioDurationMs: null,
        playing: false,
        ...(current ? { loading: false, lastError: null, pendingRecovery: null, pendingMismatch: null } : {}),
      });
    }

    function run(osrPath: string, load: () => Promise<LoadedScene>, beatmapPath?: string): Promise<void> {
      const seq = ++loadSeq;
      // pendingRecovery clears here, not just on completion: a beatmap
      // dropped while this load is in flight must not route to the
      // previous replay's recovery (openers.ts reads the field live)
      set({ loading: true, lastError: null, pendingMismatch: null, pendingRecovery: null });
      const result = loadQueue.then(() => runCurrent(seq, osrPath, load, beatmapPath));
      // the chain must survive an unexpected rejection (runCurrent already
      // catches everything the load itself can throw)
      loadQueue = result.catch(() => {});
      return result;
    }

    async function runCurrent(seq: number, osrPath: string, load: () => Promise<LoadedScene>, beatmapPath?: string) {
      if (seq !== loadSeq) return;
      try {
        const scene = await load();
        install(scene, seq === loadSeq);
      } catch (e) {
        // a stale failure installed nothing backend-side -- ignore it
        if (seq !== loadSeq) return;
        if (isIpcError(e)) {
          if (e.kind === "beatmapMismatch" && beatmapPath !== undefined) {
            set({
              loading: false,
              pendingRecovery: null,
              pendingMismatch: { expectedMd5: e.expectedMd5, actualMd5: e.actualMd5, osrPath, beatmapPath },
            });
          } else {
            set({
              loading: false,
              lastError: { error: e, osrPath },
              pendingRecovery: describeIpcError(e).recovery === "pickBeatmap" ? osrPath : null,
            });
          }
        } else {
          set({
            loading: false,
            lastError: { error: { kind: "internal", message: String(e) }, osrPath },
            pendingRecovery: null,
          });
        }
      }
    }

    return {
      scene: null,
      derived: null,
      sceneId: 0,
      loading: false,
      lastError: null,
      pendingRecovery: null,
      pendingMismatch: null,
      audioDurationMs: null,
      settings: null,
      overlays: {
        cursorPath: false, clickMarkers: false, frameMarkers: false,
        hideCursor: false, keyOverlay: true, displayLength: 800,
      },
      playing: false,
      rate: 1,

      openReplay: (osrPath) => run(osrPath, () => deps.loadReplay(osrPath)),
      openWithBeatmap: (osrPath, beatmapPath) =>
        run(osrPath, () => deps.loadReplayWithBeatmap(osrPath, beatmapPath, false), beatmapPath),
      confirmMismatch: async () => {
        const pending = get().pendingMismatch;
        if (pending === null) return;
        await run(
          pending.osrPath,
          () => deps.loadReplayWithBeatmap(pending.osrPath, pending.beatmapPath, true),
          pending.beatmapPath,
        );
      },
      dismissMismatch: () => set({ pendingMismatch: null }),
      clearError: () => set({ lastError: null }),
      setAudioDuration: (durationMs) => set({ audioDurationMs: durationMs }),
      setOverlay: (key, value) => set({ overlays: { ...get().overlays, [key]: value } }),
      setPlaying: (playing) => set({ playing }),
      setRate: (rate) => set({ rate }),
      loadSettings: async () => set({ settings: await deps.getSettings() }),
      saveStablePath: async (path) => {
        try {
          set({ settings: await deps.setOsuStablePath(path) });
        } catch (e) {
          // callers void this promise (SettingsDialog buttons), so a failed
          // save must surface through the toast flow, not vanish as an
          // unhandled rejection
          const error: IpcError = isIpcError(e) ? e : { kind: "internal", message: String(e) };
          set({ lastError: { error, osrPath: "" } });
        }
      },
    };
  });
}

export const viewerStore = createViewerStore({
  loadReplay: invokeLoadReplay,
  loadReplayWithBeatmap: invokeLoadReplayWithBeatmap,
  getSettings: invokeGetSettings,
  setOsuStablePath: invokeSetOsuStablePath,
});

export function useViewerStore<T>(selector: (state: ViewerState) => T): T {
  return useStore(viewerStore, selector);
}
