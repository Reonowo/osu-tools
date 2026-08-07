// the app store: discrete state only (the clock owns continuous time).
// ipc goes through an injected deps object so bun tests script it

import { createStore, useStore, type StoreApi } from "zustand";
import {
	invokeClearRecents,
	invokeGetSettings,
	invokeLoadRecentReplay,
	invokeLoadReplay,
	invokeLoadReplayWithBeatmap,
	invokeSetOsuStablePath,
	invokeSetViewerPrefs,
	isIpcError
} from "../lib/ipc";
import type {
	EditingSettings,
	EffectSettings,
	IpcError,
	LoadedScene,
	OverlaySettings,
	RecentReplay,
	Settings
} from "../lib/scene-types";
import { deriveScene, type DerivedScene } from "../lib/derive";
import { clampViewportZoom, DEFAULT_VIEWPORT_ZOOM, NO_VIEWPORT_PAN, type ViewportPan } from "../renderer/playfield";
import {
	clampDetailSpan,
	clampDisplayLength,
	clampVolume,
	DEFAULT_DETAIL_SPAN,
	DEFAULT_EDITING,
	DEFAULT_EFFECTS,
	DEFAULT_OVERLAYS,
	DEFAULT_VOLUME
} from "./defaults";
import { describeIpcError } from "./errors";

// OverlaySettings moved to the wire contract (scene-types.ts) when the
// overlays became a persisted setting; re-exported so the renderer and the
// settings dialog keep importing it from here
export type { EditingSettings, EffectSettings, OverlaySettings };

// watch shows a replay; edit is the (future) mutation surface
export type ViewerMode = "watch" | "edit";
export type PanelTab = "replay" | "analysis" | "frames" | "keys" | "meta" | "history";
export type ToolId = "select" | "lasso" | "move" | "smooth" | "erase";

export interface IpcDeps {
	loadReplay(osrPath: string): Promise<LoadedScene>;
	loadReplayWithBeatmap(osrPath: string, beatmapPath: string, allowMismatch: boolean): Promise<LoadedScene>;
	loadRecentReplay(osrPath: string): Promise<LoadedScene>;
	getSettings(): Promise<Settings>;
	setOsuStablePath(path: string | null): Promise<Settings>;
	setViewerPrefs(
		volume: number,
		overlays: OverlaySettings,
		editing: EditingSettings,
		effects: EffectSettings
	): Promise<Settings>;
	clearRecents(): Promise<Settings>;
}

export interface ViewerState {
	scene: LoadedScene | null;
	/** the .osr path behind the displayed scene. LoadedScene itself carries no
	 * filesystem path (it's an ipc argument, not part of the wire contract),
	 * and HistoryPanel's baseline node needs one to label "as loaded from...".
	 * mirrors scene's own lifecycle exactly, not just its gating: both are set
	 * together inside install() (current or stale, same as each other) and
	 * neither is touched by a failed load -- a failed reload leaves the
	 * previous scene on screen (install() never ran), so osrPath must keep
	 * naming that same scene rather than going null out from under it */
	osrPath: string | null;
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
	editing: EditingSettings;
	/** the raw per-effect toggles, master included -- consumers gate on
	 * effectiveEffects(effects), never on the granular flags alone */
	effects: EffectSettings;
	playing: boolean;
	rate: number;
	/** linear amplitude percent 0-100; persisted (unlike rate, which belongs
	 * to the replay being watched rather than to the app) */
	volume: number;
	mode: ViewerMode;
	panelOpen: boolean;
	panelTab: PanelTab;
	tool: ToolId;
	/** ms; the detail tier's visible timeline span */
	detailSpanMs: number;
	/** the viewport's framing, session-only: it belongs to the replay being
	 * looked at rather than to the app, so it is never persisted and every
	 * scene install puts it back to 100% centred */
	viewportZoom: number;
	viewportPan: ViewportPan;

	openReplay(osrPath: string): Promise<void>;
	/** reopens a recents entry. the whole entry is the argument to keep this
	 * action honest about what it is for -- the backend resolves the beatmap
	 * from the association it holds for that exact path, so an arbitrary path
	 * belongs in openReplay instead */
	openRecent(entry: RecentReplay): Promise<void>;
	openWithBeatmap(osrPath: string, beatmapPath: string): Promise<void>;
	confirmMismatch(): Promise<void>;
	dismissMismatch(): void;
	clearError(): void;
	setAudioDuration(durationMs: number): void;
	setOverlay<K extends keyof OverlaySettings>(key: K, value: OverlaySettings[K]): void;
	setEditing<K extends keyof EditingSettings>(key: K, value: EditingSettings[K]): void;
	setEffect<K extends keyof EffectSettings>(key: K, value: EffectSettings[K]): void;
	setPlaying(playing: boolean): void;
	setRate(rate: number): void;
	setVolume(volume: number): void;
	setMode(mode: ViewerMode): void;
	togglePanel(): void;
	setPanelTab(tab: PanelTab): void;
	setTool(tool: ToolId): void;
	setDetailSpan(spanMs: number): void;
	/** zoom and pan move together or not at all: a pointer-anchored zoom shifts
	 * the pan by construction, and writing them separately would paint a frame
	 * at the new zoom with the old pan. the pan arrives already clamped --
	 * clampViewportPan needs the host box, which only the viewport itself
	 * measures (renderer/playfield.ts) */
	setViewportZoom(zoom: number, pan: ViewportPan): void;
	/** the absolute pan a drag has reached, clamped by the caller for the same
	 * reason. absolute rather than a delta so a drag held against the clamp
	 * and brought back tracks the pointer instead of sticking */
	panViewport(pan: ViewportPan): void;
	resetViewport(): void;
	/** startup only: pulls the persisted settings and applies volume + overlays
	 * into the store. distinct from loadSettings, which the settings dialog
	 * calls on every open and which must NOT touch volume/overlays -- doing so
	 * would revert changes still sitting in the persistence debounce */
	hydrateSettings(): Promise<void>;
	loadSettings(): Promise<void>;
	saveStablePath(path: string | null): Promise<void>;
	clearRecents(): Promise<void>;
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

		// orders every settings publication: reads (install()'s post-load
		// refresh, hydrateSettings, loadSettings) claim a slot by bumping at
		// initiation and publish only while still the newest claim, writes
		// (publishSettings) bump at publication and always win. concurrent
		// getSettings() calls have no ordering relationship to each other or
		// to a racing write, so a stale resolution must recognize itself and
		// no-op instead of overwriting -- or cancelling -- a newer publication
		let settingsRefreshSeq = 0;

		// volume is a primitive, so hydration cannot use a value compare to
		// detect an in-flight edit -- a drag away and back lands on the starting
		// value again. every setVolume bumps this instead (overlays don't need
		// one: setOverlay always builds a new object, so identity shows the edit)
		let volumeEdits = 0;

		// a direct settings write carries newer backend state than any refresh
		// still in flight from install(), so it invalidates those refreshes too
		// -- without the bump a getSettings() issued before the write could
		// resolve after it and publish its stale snapshot over this one
		function publishSettings(settings: Settings) {
			settingsRefreshSeq += 1;
			set({ settings });
		}

		// a stale (superseded) success still swaps the displayed scene: its
		// command already installed the backend session (commands.rs
		// install_scene runs before the promise resolves) and dropped the
		// previous scene's cache lease, so the display must follow the backend
		// or a failing newest load would leave it pointing at deleted assets.
		// only the current load owns the loading flag and error/pending state
		function install(scene: LoadedScene, current: boolean, osrPath: string) {
			set({
				scene,
				derived: deriveScene(scene),
				sceneId: get().sceneId + 1,
				osrPath,
				audioDurationMs: null,
				playing: false,
				// a new replay gets the default framing: a zoom held over from
				// the last one would be pointing at nothing in particular
				viewportZoom: DEFAULT_VIEWPORT_ZOOM,
				viewportPan: NO_VIEWPORT_PAN,
				...(current ? { loading: false, lastError: null, pendingRecovery: null, pendingMismatch: null } : {})
			});
			// the load command records the recent backend-side, so the
			// published settings are one write behind until this refresh.
			// a failed read is not worth surfacing -- the scene loaded
			const refreshSeq = ++settingsRefreshSeq;
			void deps
				.getSettings()
				.then((settings) => {
					// a refresh from an earlier load must not overwrite a later one
					if (refreshSeq === settingsRefreshSeq) set({ settings });
				})
				.catch(() => {});
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
				install(scene, seq === loadSeq, osrPath);
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
			osrPath: null,
			derived: null,
			sceneId: 0,
			loading: false,
			lastError: null,
			pendingRecovery: null,
			pendingMismatch: null,
			audioDurationMs: null,
			settings: null,
			overlays: DEFAULT_OVERLAYS,
			editing: DEFAULT_EDITING,
			effects: DEFAULT_EFFECTS,
			playing: false,
			rate: 1,
			volume: DEFAULT_VOLUME,
			mode: "watch",
			panelOpen: false,
			panelTab: "replay",
			tool: "select",
			detailSpanMs: DEFAULT_DETAIL_SPAN,
			viewportZoom: DEFAULT_VIEWPORT_ZOOM,
			viewportPan: NO_VIEWPORT_PAN,

			openReplay: (osrPath) => run(osrPath, () => deps.loadReplay(osrPath)),
			openRecent: (entry) => run(entry.osrPath, () => deps.loadRecentReplay(entry.osrPath)),
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
			setEditing: (key, value) => set({ editing: { ...get().editing, [key]: value } }),
			// the master and the granular flags are stored side by side and
			// written the same way: turning `enabled` off must not touch the five
			// below it, so the user gets their own selection back when it returns
			setEffect: (key, value) => set({ effects: { ...get().effects, [key]: value } }),
			setPlaying: (playing) => set({ playing }),
			setRate: (rate) => set({ rate }),
			setVolume: (volume) => {
				if (!Number.isFinite(volume)) return;
				volumeEdits += 1;
				set({ volume: clampVolume(volume) });
			},
			// watch hands the playfield the window; edit brings the panel
			// back. the rail toggle still overrides either way
			setMode: (mode) => set({ mode, panelOpen: mode === "edit" }),
			togglePanel: () => set({ panelOpen: !get().panelOpen }),
			// a rail click is also a request to see the panel
			setPanelTab: (panelTab) => set({ panelTab, panelOpen: true }),
			setTool: (tool) => set({ tool }),
			setDetailSpan: (spanMs) => set({ detailSpanMs: clampDetailSpan(spanMs) }),
			setViewportZoom: (zoom, pan) => set({ viewportZoom: clampViewportZoom(zoom), viewportPan: pan }),
			panViewport: (pan) => set({ viewportPan: pan }),
			resetViewport: () => set({ viewportZoom: DEFAULT_VIEWPORT_ZOOM, viewportPan: NO_VIEWPORT_PAN }),
			hydrateSettings: async () => {
				// the volume slider and overlay toggles are usable before the read
				// resolves, so capture what could be edited in flight: applying the
				// loaded value over a fresher edit would visibly revert the control
				// the user just touched (and the edit predates persistence install,
				// so nothing would re-save it)
				const overlaysBefore = get().overlays;
				const editingBefore = get().editing;
				const effectsBefore = get().effects;
				const volumeEditsBefore = volumeEdits;
				// claimed at initiation, like install()'s refresh: bumping only at
				// publication would let this read -- when it resolves late --
				// both publish its older snapshot and cancel a refresh that
				// started after it
				const refreshSeq = ++settingsRefreshSeq;
				let settings: Settings;
				try {
					settings = await deps.getSettings();
				} catch {
					// startup must not break on an unreadable settings file; the
					// defaults already in the store stand in, and the settings dialog
					// retries through loadSettings on its next open
					return;
				}
				const volumeEdited = volumeEdits !== volumeEditsBefore;
				// reference equality: setOverlay/setEditing/setEffect always build a
				// new object
				const overlaysEdited = get().overlays !== overlaysBefore;
				const editingEdited = get().editing !== editingBefore;
				const effectsEdited = get().effects !== effectsBefore;
				// volume/overlays/editing/effects are frontend-owned -- nothing
				// backend-side ever changes them on its own -- so they apply even when
				// a newer read has claimed the slot; the settings object itself
				// (recents move under a concurrent load) publishes only while this
				// read is still the newest claim
				set({
					...(refreshSeq === settingsRefreshSeq ? { settings } : {}),
					...(volumeEdited ? {} : { volume: clampVolume(settings.volume) }),
					...(overlaysEdited ? {} : { overlays: { ...DEFAULT_OVERLAYS, ...settings.overlays } }),
					...(editingEdited ? {} : { editing: { ...DEFAULT_EDITING, ...settings.editing } }),
					...(effectsEdited ? {} : { effects: { ...DEFAULT_EFFECTS, ...settings.effects } })
				});
				// an edit made while the read was in flight predates the persistence
				// subscription (App installs it only once this resolves), and the
				// guards above re-emit nothing for it afterwards, so no debounced
				// save would ever pick it up -- write the surviving values through
				// now or they revert on restart. the write-through's own await is
				// the same gap one layer down, so repeat until nothing changed
				// while the save was in flight; edits after the stable save cannot
				// slip past install, because App's subscription lands in the same
				// microtask drain as this resolution, ahead of any queued input
				if (volumeEdited || overlaysEdited || editingEdited || effectsEdited) {
					for (;;) {
						const { volume, overlays, editing, effects } = get();
						const volumeEditsAtSave = volumeEdits;
						try {
							const saved = await deps.setViewerPrefs(volume, overlays, editing, effects);
							const stable =
								volumeEdits === volumeEditsAtSave &&
								get().overlays === overlays &&
								get().editing === editing &&
								get().effects === effects;
							if (stable) {
								publishSettings(saved);
								break;
							}
						} catch (e) {
							// same contract as saveStablePath: App voids this promise, so a
							// failed save must surface through the toast flow. no retry --
							// a failing backend would loop forever
							const error: IpcError = isIpcError(e) ? e : { kind: "internal", message: String(e) };
							set({ lastError: { error, osrPath: "" } });
							break;
						}
					}
				}
			},
			// claimed at initiation for the same reason as hydrateSettings: a
			// slow dialog read must neither publish over nor cancel anything newer
			loadSettings: async () => {
				const refreshSeq = ++settingsRefreshSeq;
				const settings = await deps.getSettings();
				if (refreshSeq === settingsRefreshSeq) set({ settings });
			},
			saveStablePath: async (path) => {
				try {
					publishSettings(await deps.setOsuStablePath(path));
				} catch (e) {
					// callers void this promise (SettingsDialog buttons), so a failed
					// save must surface through the toast flow, not vanish as an
					// unhandled rejection
					const error: IpcError = isIpcError(e) ? e : { kind: "internal", message: String(e) };
					set({ lastError: { error, osrPath: "" } });
				}
			},
			clearRecents: async () => {
				try {
					publishSettings(await deps.clearRecents());
				} catch (e) {
					// callers void this promise (StartScreen's clear-recents button),
					// so a failed clear must surface through the toast flow, not
					// vanish as an unhandled rejection -- same reasoning as saveStablePath
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
	loadRecentReplay: invokeLoadRecentReplay,
	getSettings: invokeGetSettings,
	setOsuStablePath: invokeSetOsuStablePath,
	setViewerPrefs: invokeSetViewerPrefs,
	clearRecents: invokeClearRecents
});

export function useViewerStore<T>(selector: (state: ViewerState) => T): T {
	return useStore(viewerStore, selector);
}
