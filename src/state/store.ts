// the app store: discrete state only (the clock owns continuous time).
// ipc goes through an injected deps object so bun tests script it

import { createStore, useStore, type StoreApi } from "zustand";
import {
	invokeGetSettings,
	invokeLoadReplay,
	invokeLoadReplayWithBeatmap,
	invokeSetOsuStablePath,
	invokeSetViewerPrefs,
	isIpcError
} from "../lib/ipc";
import type { IpcError, LoadedScene, OverlaySettings, Settings } from "../lib/scene-types";
import { deriveScene, type DerivedScene } from "../lib/derive";
import { clampDisplayLength, clampVolume, DEFAULT_OVERLAYS, DEFAULT_VOLUME } from "./defaults";
import { describeIpcError } from "./errors";

// OverlaySettings moved to the wire contract (scene-types.ts) when the
// overlays became a persisted setting; re-exported so the renderer and the
// settings dialog keep importing it from here
export type { OverlaySettings };

export interface IpcDeps {
	loadReplay(osrPath: string): Promise<LoadedScene>;
	loadReplayWithBeatmap(osrPath: string, beatmapPath: string, allowMismatch: boolean): Promise<LoadedScene>;
	getSettings(): Promise<Settings>;
	setOsuStablePath(path: string | null): Promise<Settings>;
	setViewerPrefs(volume: number, overlays: OverlaySettings): Promise<Settings>;
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
	/** linear amplitude percent 0-100; persisted (unlike rate, which belongs
	 * to the replay being watched rather than to the app) */
	volume: number;

	openReplay(osrPath: string): Promise<void>;
	openWithBeatmap(osrPath: string, beatmapPath: string): Promise<void>;
	confirmMismatch(): Promise<void>;
	dismissMismatch(): void;
	clearError(): void;
	setAudioDuration(durationMs: number): void;
	setOverlay<K extends keyof OverlaySettings>(key: K, value: OverlaySettings[K]): void;
	setPlaying(playing: boolean): void;
	setRate(rate: number): void;
	setVolume(volume: number): void;
	/** startup only: pulls the persisted settings and applies volume + overlays
	 * into the store. distinct from loadSettings, which the settings dialog
	 * calls on every open and which must NOT touch volume/overlays -- doing so
	 * would revert changes still sitting in the persistence debounce */
	hydrateSettings(): Promise<void>;
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

		// volume is a primitive, so hydration cannot use a value compare to
		// detect an in-flight edit -- a drag away and back lands on the starting
		// value again. every setVolume bumps this instead (overlays don't need
		// one: setOverlay always builds a new object, so identity shows the edit)
		let volumeEdits = 0;

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
				...(current ? { loading: false, lastError: null, pendingRecovery: null, pendingMismatch: null } : {})
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

		async function runCurrent(
			seq: number,
			osrPath: string,
			load: () => Promise<LoadedScene>,
			beatmapPath?: string
		) {
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
							pendingMismatch: {
								expectedMd5: e.expectedMd5,
								actualMd5: e.actualMd5,
								osrPath,
								beatmapPath
							}
						});
					} else {
						set({
							loading: false,
							lastError: { error: e, osrPath },
							pendingRecovery: describeIpcError(e).recovery === "pickBeatmap" ? osrPath : null
						});
					}
				} else {
					set({
						loading: false,
						lastError: { error: { kind: "internal", message: String(e) }, osrPath },
						pendingRecovery: null
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
			overlays: DEFAULT_OVERLAYS,
			playing: false,
			rate: 1,
			volume: DEFAULT_VOLUME,

			openReplay: (osrPath) => run(osrPath, () => deps.loadReplay(osrPath)),
			openWithBeatmap: (osrPath, beatmapPath) =>
				run(osrPath, () => deps.loadReplayWithBeatmap(osrPath, beatmapPath, false), beatmapPath),
			confirmMismatch: async () => {
				const pending = get().pendingMismatch;
				if (pending === null) return;
				await run(
					pending.osrPath,
					() => deps.loadReplayWithBeatmap(pending.osrPath, pending.beatmapPath, true),
					pending.beatmapPath
				);
			},
			dismissMismatch: () => set({ pendingMismatch: null }),
			clearError: () => set({ lastError: null }),
			setAudioDuration: (durationMs) => set({ audioDurationMs: durationMs }),
			setOverlay: (key, value) => {
				let next = value;
				if (key === "displayLength") {
					// the numeric field commits raw user input, so validate here rather
					// than at every call site; a blank field arrives as NaN and must
					// leave the last good value alone
					const ms = value as number;
					if (!Number.isFinite(ms)) return;
					next = clampDisplayLength(ms) as OverlaySettings[typeof key];
				}
				set({ overlays: { ...get().overlays, [key]: next } });
			},
			setPlaying: (playing) => set({ playing }),
			setRate: (rate) => set({ rate }),
			setVolume: (volume) => {
				if (!Number.isFinite(volume)) return;
				volumeEdits += 1;
				set({ volume: clampVolume(volume) });
			},
			hydrateSettings: async () => {
				// the volume slider and overlay toggles are usable before the read
				// resolves, so capture what could be edited in flight: applying the
				// loaded value over a fresher edit would visibly revert the control
				// the user just touched (and the edit predates persistence install,
				// so nothing would re-save it)
				const overlaysBefore = get().overlays;
				const volumeEditsBefore = volumeEdits;
				let settings: Settings;
				try {
					settings = await deps.getSettings();
				} catch {
					// startup must not break on an unreadable settings file; the
					// defaults already in the store stand in, and the settings dialog
					// retries through loadSettings on its next open
					return;
				}
				set({
					settings,
					...(volumeEdits === volumeEditsBefore ? { volume: clampVolume(settings.volume) } : {}),
					// reference equality: setOverlay always builds a new object
					...(get().overlays === overlaysBefore
						? { overlays: { ...DEFAULT_OVERLAYS, ...settings.overlays } }
						: {})
				});
			},
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
			}
		};
	});
}

export const viewerStore = createViewerStore({
	loadReplay: invokeLoadReplay,
	loadReplayWithBeatmap: invokeLoadReplayWithBeatmap,
	getSettings: invokeGetSettings,
	setOsuStablePath: invokeSetOsuStablePath,
	setViewerPrefs: invokeSetViewerPrefs
});

export function useViewerStore<T>(selector: (state: ViewerState) => T): T {
	return useStore(viewerStore, selector);
}
