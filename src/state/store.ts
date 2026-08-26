// the app store: discrete state only (the clock owns continuous time).
// ipc goes through an injected deps object so bun tests script it

import { createStore, useStore, type StoreApi } from "zustand";
import type { PhysicalKey } from "../engine/buttons";
import { gesturePreview } from "../editor/preview";
import { pressRunAt, pressRunFromIndex, type PressSelection } from "../editor/press-runs";
import { applyFrameChanges, isFullFrames, remapQueuedOps, remapSelection } from "../editor/splice";
import {
	invokeApplyEdit,
	invokeCancelVideoExport,
	invokeClearRecents,
	invokeGetSkin,
	invokeGetVideoRendererStatus,
	invokeImportSkin,
	invokeInstallVideoRenderer,
	invokeListSkins,
	invokeRedetectVideoEncoder,
	invokeSetSkin,
	invokeSetVideoPrefs,
	invokeExportReplay,
	invokeExportVideo,
	invokeGetSettings,
	invokeLoadReplay,
	invokeLoadReplayWithBeatmap,
	invokeRedo,
	invokeResync,
	invokeRevertAll,
	invokeSetOsuStablePath,
	invokeSetViewerPrefs,
	invokeUndo,
	isIpcError
} from "../lib/ipc";
import { inferLattice, summarizeOffLattice, type Lattice, type OffLatticeSummary } from "../lib/lattice";
import type {
	AudioSettings,
	EditDelta,
	EditingSettings,
	EditOp,
	EffectSettings,
	ExportResult,
	FrameChanges,
	FrameDto,
	IpcError,
	GameplaySettings,
	KeybindOverrides,
	LoadedScene,
	OverlaySettings,
	RendererOptionsMap,
	Settings,
	SkinEntry,
	SkinLocator,
	SkinManifest,
	TimelineSettings,
	VideoExportResult,
	VideoRendererStatus,
	VideoSettings
} from "../lib/scene-types";
import { deriveScene, type DerivedScene } from "../lib/derive";
import { widenBounds, type TimeBounds } from "../lib/timeline";
import { foldKeybinds, NO_KEYBIND_OVERRIDES, type EffectiveKeybind } from "../playback/keybinds";
import { clampViewportZoom, DEFAULT_VIEWPORT_ZOOM, NO_VIEWPORT_PAN, type ViewportPan } from "../renderer/playfield";
import {
	clampAudioOffset,
	clampBackgroundDim,
	clampDetailSpan,
	clampDisplayLength,
	clampFeather,
	clampPlayfieldGridSpacing,
	clampStrength,
	clampVolume,
	clampPositionalLevel,
	DEFAULT_AUDIO,
	DEFAULT_DETAIL_SPAN,
	DEFAULT_EDITING,
	DEFAULT_EFFECTS,
	DEFAULT_FEATHER_MS,
	DEFAULT_GAMEPLAY,
	DEFAULT_OVERLAYS,
	DEFAULT_SMOOTH_STRENGTH,
	DEFAULT_TIMELINE,
	DEFAULT_VOLUME
} from "./defaults";
import { describeIpcError } from "./errors";
import { toggleMute } from "@/playback/audio-levels";

// OverlaySettings moved to the wire contract (scene-types.ts) when the
// overlays became a persisted setting; re-exported so the renderer and the
// settings dialog keep importing it from here
export type { AudioSettings, EditingSettings, EffectSettings, GameplaySettings, OverlaySettings, TimelineSettings };

// watch shows a replay; edit is the (future) mutation surface
export type ViewerMode = "watch" | "edit";
export type PanelTab = "replay" | "analysis" | "frames" | "keys" | "meta" | "history";
/** the cursor-path tools, as data: the keybind table's test enumerates them
 * to assert every tool is reachable from the keyboard, which a type alone
 * cannot answer at runtime */
export const TOOL_IDS = ["select", "lasso", "move", "smooth", "erase"] as const;
export type ToolId = (typeof TOOL_IDS)[number];

export interface IpcDeps {
	loadReplay(osrPath: string): Promise<LoadedScene>;
	loadReplayWithBeatmap(osrPath: string, beatmapPath: string, allowMismatch: boolean): Promise<LoadedScene>;
	getSettings(): Promise<Settings>;
	setOsuStablePath(path: string | null): Promise<Settings>;
	setViewerPrefs(
		volume: number,
		audio: AudioSettings,
		gameplay: GameplaySettings,
		overlays: OverlaySettings,
		editing: EditingSettings,
		effects: EffectSettings,
		timeline: TimelineSettings,
		keybinds: KeybindOverrides
	): Promise<Settings>;
	clearRecents(): Promise<Settings>;
	listSkins(): Promise<SkinEntry[]>;
	getSkin(): Promise<SkinManifest>;
	setSkin(locator: SkinLocator): Promise<SkinManifest>;
	importSkin(path: string): Promise<SkinManifest>;
	applyEdit(epoch: number, baseRevision: number, ops: EditOp[], label: string): Promise<EditDelta>;
	undo(epoch: number): Promise<EditDelta>;
	redo(epoch: number): Promise<EditDelta>;
	revertAll(epoch: number): Promise<EditDelta>;
	resync(epoch: number): Promise<EditDelta>;
	exportReplay(epoch: number, destPath: string, overwrite: boolean): Promise<ExportResult>;
	exportVideo(epoch: number, destPath: string): Promise<VideoExportResult>;
	cancelVideoExport(jobId: string): Promise<void>;
	getVideoRendererStatus(): Promise<VideoRendererStatus>;
	installVideoRenderer(): Promise<VideoRendererStatus>;
	setVideoPrefs(video: VideoSettings, rendererOptions: RendererOptionsMap): Promise<Settings>;
	redetectVideoEncoder(): Promise<Settings>;
}

export interface EditorState {
	epoch: number;
	revision: number;
	/** the union of the two split flags, kept for the dirty chip */
	dirty: boolean;
	/** the document's dirty split: the export dialog keys its path
	 * expectation off which kind of dirty the session is */
	framesDirty: boolean;
	metadataDirty: boolean;
	canUndo: boolean;
	canRedo: boolean;
	history: { labels: string[]; cursor: number };
	/** inferred once at install and frozen for the session's life */
	lattice: Lattice | null;
	/** the loaded file's off-lattice run summary, computed once at install
	 * beside the frozen lattice and never recomputed per edit -- like the
	 * integrity report, it always describes the loaded file. null when no
	 * lattice was inferred (unanalysable, not clean) */
	offLattice: OffLatticeSummary | null;
	/** the frame selection: sorted frame indices the cursor-path tools operate
	 * on. independent of the frame cursor -- selecting never seeks */
	frameSelection: number[];
	/** the press selection: the single press keypress editing operates on.
	 * independent of the frame selection -- keypress work and cursor-path
	 * work never fight over each other's state -- and selecting never seeks */
	pressSelection: PressSelection | null;
}

export type CommitOutcome = "landed" | "skipped" | "cancelled" | "failed";

export interface EditCommit {
	/** the history label; a function is resolved at dispatch against the ops
	 * actually sent, which is what lets labels carry counts ("move 12
	 * frames") that survive a queued payload shrinking through a remap */
	label: string | ((ops: EditOp[]) => string);
	payload:
		| { kind: "ops"; ops: EditOp[] }
		| {
				kind: "intent";
				expand: (frames: readonly FrameDto[], editor: EditorState) => EditOp[] | null;
				/** carries the intent's frame identities through a landed splice,
				 * mirroring the remap computed payloads get -- without it a queued
				 * intent expands against indices the splice shifted. false means
				 * nothing the intent named survives; the commit cancels */
				remap?: (changes: FrameChanges) => boolean;
		  };
	/** called exactly once when the commit reaches a terminal state: its delta
	 * installed ("landed"), its expansion reduced to identity ("skipped"), it
	 * was dropped by a cancellation path ("cancelled"), or its dispatch threw
	 * ("failed"). the gesture preview ties its pending entries to this */
	onSettled?: (outcome: CommitOutcome) => void;
	/** a press operation's computed outcome: called when this commit's delta
	 * lands with frame changes, against the post-splice frames; what it
	 * returns replaces the press selection, null clearing it. commits
	 * without one leave re-resolution to the generic key + time containment
	 * rule (installDelta) */
	pressOutcome?: (frames: readonly FrameDto[]) => PressSelection | null;
}

/** injected side-channels for state the store does not own: the gesture
 * preview module keeps its pending entries in the authoritative index space
 * by observing every landed splice. injected (with a no-op default) so store
 * tests can run without the singleton and assert against spies */
export interface StoreHooks {
	onSplice?(changes: FrameChanges): void;
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
	/** the timeline's mapping bounds: the dock's fixed frame of reference,
	 * shared by both tiers and the status bar's zoom readout. frozen from the
	 * pristine document at install and only ever widened when a landed
	 * delta's live bounds outgrow it (lib/timeline.ts's widenBounds) --
	 * derived.bounds keep breathing with the simulation because the clock
	 * needs the full fade covered, and mapping the timeline against those
	 * directly made every mark shift on screen when an edit re-judged the
	 * last object. null exactly when derived is null */
	timelineBounds: TimeBounds | null;
	sceneId: number;
	loading: boolean;
	lastError: { error: IpcError; osrPath: string } | null;
	/** why the skin the user just asked for was not made active, or null.
	 *
	 * deliberately NOT an `IpcError`: a skin refused at load -- a cap breach, an
	 * unreadable folder -- is a fact about that skin rather than a fault in the
	 * app, and routing it through `lastError` renders it as a toast titled
	 * "internal error", which tells the user something broke when nothing did.
	 * the picker shows this in the same strip the fallback notice uses */
	skinNotice: string | null;
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
	/** the open the discard prompt is standing in front of, or null. set only
	 * by openReplay, and only when the loaded document has unsaved edits.
	 *
	 * the request is held as DATA rather than as a closure, mirroring
	 * pendingMismatch: a closure in the store is unreachable from `bun test
	 * src`, and replaying the request through the same IpcDeps seam every other
	 * load goes through is the whole reason that seam exists */
	pendingOpen: { osrPath: string } | null;
	/** ms; the attached audio's duration once its metadata loads (PlayerView
	 * publishes it). the clock's playable range extends past the last object
	 * when the audio outlives it, and the timeline must map against those same
	 * effective bounds. null until metadata arrives; reset by every install */
	audioDurationMs: number | null;
	settings: Settings | null;
	/**
	 * the active skin, held BESIDE the scene rather than on it.
	 *
	 * a skin is app-wide and changes without a scene reload -- which is exactly
	 * why the beatmap's sample file map, which rides the scene, is not the model
	 * to copy. null until the startup hydrate resolves; every consumer treats
	 * null as the bundled default rather than as "no skin", because there is no
	 * such state
	 */
	skin: SkinManifest | null;
	/** what the picker lists. refreshed on demand rather than held live: a
	 * stable install with 138 skins is a directory walk, not a subscription */
	skins: SkinEntry[];
	overlays: OverlaySettings;
	editing: EditingSettings;
	/** the raw per-effect toggles, master included -- consumers gate on
	 * effectiveEffects(effects), never on the granular flags alone */
	effects: EffectSettings;
	/** the timeline dock's per-layer visibility toggles */
	timeline: TimelineSettings;
	/** the user's sparse keybind overrides, exactly as they persist */
	keybinds: KeybindOverrides;
	/** the overrides folded onto the defaults: what is actually bound. it
	 * lives in the store rather than in a module-level singleton because three
	 * consumers read it -- the playback shortcuts hook, the edit-tools hook and
	 * the tool palette's tooltips -- and a singleton would not re-render the
	 * tooltips, so the palette would go on advertising a key the user had
	 * already changed */
	effectiveKeybinds: EffectiveKeybind[];
	playing: boolean;
	rate: number;
	/** the MASTER volume, linear amplitude percent 0-100; persisted (unlike
	 * rate, which belongs to the replay being watched rather than to the app) */
	volume: number;
	/** the channels under the master. effective gain is master x channel, so
	 * zero anywhere is the mute -- music to 0 leaves hitsounds, and the other
	 * way round */
	audio: AudioSettings;
	/** the gameplay preferences that are not render effects: how far hit
	 * samples are panned and whether the play's first combo break sounds */
	gameplay: GameplaySettings;
	mode: ViewerMode;
	panelOpen: boolean;
	panelTab: PanelTab;
	/** the keybind help overlay. session-only chrome, never persisted, and
	 * deliberately not gated on a loaded scene -- the list is most useful to
	 * someone who has not opened a replay yet */
	helpOpen: boolean;
	/** the top bar's open menu. in the store rather than in the component
	 * because its keybind registers at the App root (the start screen has to
	 * reach it too), which is above the popover's own lifetime. session-only
	 * chrome, never persisted */
	openMenuOpen: boolean;
	tool: ToolId;
	/** the armed key tile: filters the press table and names the key
	 * add-press writes. session-only, never persisted; reset by every scene
	 * install; uncoupled from the press selection */
	armedKey: PhysicalKey | null;
	/** ms; the move tool's feather window. session-only, never persisted */
	featherMs: number;
	/** percent 0-100; the smooth tool's original->smoothed blend. session-only */
	smoothStrength: number;
	/** ms; the detail tier's visible timeline span */
	detailSpanMs: number;
	/** the viewport's framing, session-only: it belongs to the replay being
	 * looked at rather than to the app, so it is never persisted and every
	 * scene install puts it back to 100% centred */
	viewportZoom: number;
	viewportPan: ViewportPan;
	/** per-scene editing state; null exactly when scene is null */
	editor: EditorState | null;
	/** bumped when a delta changes the frame stream -- NOT sceneId, so
	 * viewport, playback position, and audio never reset on an edit */
	editRevision: number;
	/** the frame changes of the last landed delta, for PlayerView's
	 * frame-cursor remap; fullFrames means "no splice to remap through" */
	lastSplice: FrameChanges | null;

	/** the whole open surface: a picked file, a drop, a recents card in either
	 * list. the backend resolves the beatmap through the association it holds
	 * for that exact path, so nothing but the path is ever needed here.
	 *
	 * the ONLY guarded entry point: this is where a user asks for a different
	 * replay, so this is where an edited document gets its one prompt. every
	 * continuation of a request that already prompted -- openWithBeatmap and
	 * confirmMismatch -- loads without asking again */
	openReplay(osrPath: string): Promise<void>;
	openWithBeatmap(osrPath: string, beatmapPath: string): Promise<void>;
	confirmMismatch(): Promise<void>;
	dismissMismatch(): void;
	/** runs the open the prompt is holding. the consent is spent here, not
	 * re-asked for by whatever the load needs next */
	confirmDiscard(): Promise<void>;
	/** declines it, leaving the scene, the document and its undo stack exactly
	 * as they were and attempting no load */
	dismissDiscard(): void;
	clearError(): void;
	setAudioDuration(durationMs: number): void;
	setOverlay<K extends keyof OverlaySettings>(key: K, value: OverlaySettings[K]): void;
	setEditing<K extends keyof EditingSettings>(key: K, value: EditingSettings[K]): void;
	setEffect<K extends keyof EffectSettings>(key: K, value: EffectSettings[K]): void;
	setTimeline<K extends keyof TimelineSettings>(key: K, value: TimelineSettings[K]): void;
	/** replaces the whole override map -- the keybind module's pure editors
	 * (applyCapture, clearBinding, revertKeybind) are what produce the next
	 * one, so every rule about what an override may be lives in one place */
	setKeybinds(overrides: KeybindOverrides): void;
	setPlaying(playing: boolean): void;
	setRate(rate: number): void;
	setVolume(volume: number): void;
	/** the speaker's click: silence the master, or put back the level the
	 * silencing replaced. the level it remembers is transient on purpose --
	 * only `volume` persists, so a relaunch that was left muted comes back
	 * muted and unmutes to the fallback rather than to a level from a session
	 * the user no longer remembers */
	toggleMute(): void;
	setAudio<K extends keyof AudioSettings>(key: K, value: AudioSettings[K]): void;
	setGameplay<K extends keyof GameplaySettings>(key: K, value: GameplaySettings[K]): void;
	setMode(mode: ViewerMode): void;
	togglePanel(): void;
	setPanelTab(tab: PanelTab): void;
	setHelpOpen(open: boolean): void;
	setOpenMenuOpen(open: boolean): void;
	setTool(tool: ToolId): void;
	setFeatherMs(ms: number): void;
	setSmoothStrength(value: number): void;
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
	/** re-walks the skin locations and republishes the picker's rows */
	refreshSkins(): Promise<void>;
	/** picks a skin. the swap is ATOMIC by construction: the whole manifest
	 * resolves before anything is published, so no frame can show a
	 * half-swapped playfield. a refused skin surfaces through the toast flow
	 * and leaves the previous selection in place */
	selectSkin(locator: SkinLocator): Promise<void>;
	/** imports an .osk and selects it */
	importSkin(path: string): Promise<void>;

	commitEdit(commit: EditCommit): Promise<void>;
	undoEdit(): Promise<void>;
	redoEdit(): Promise<void>;
	revertAll(): Promise<void>;
	setFrameSelection(indices: number[]): void;
	setPressSelection(selection: PressSelection | null): void;
	setArmedKey(key: PhysicalKey | null): void;
	/** writes the current document to destPath through the backend's atomic
	 * write protocol. throws the typed IpcError on failure rather than
	 * routing through lastError -- export failures render inside the dialog,
	 * never as vanishing toasts */
	exportReplay(destPath: string, overwrite: boolean): Promise<ExportResult>;
	/** renders the current document to destPath through the video seam --
	 * the same drain-then-pin choreography as exportReplay, and the same
	 * throw-typed posture: the dialog renders failures in place */
	exportVideo(destPath: string): Promise<VideoExportResult>;
	cancelVideoExport(jobId: string): Promise<void>;
	/** install state + consent metadata, passed through untouched: the dialog
	 * renders whatever backend the seam holds */
	getVideoRendererStatus(): Promise<VideoRendererStatus>;
	installVideoRenderer(): Promise<VideoRendererStatus>;
	/** persists the video prefs + blobs and republishes settings; failures
	 * surface through the toast flow (control writes are fire-and-forget) */
	saveVideoPrefs(video: VideoSettings, rendererOptions: RendererOptionsMap): Promise<void>;
	/** re-runs the encoder probe and republishes the settings carrying its
	 * winner */
	redetectVideoEncoder(): Promise<void>;
}

export function createViewerStore(deps: IpcDeps, hooks: StoreHooks = {}): StoreApi<ViewerState> {
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

		// the edit queue: one editor command in flight, later commits queued
		// behind it. queued commits are never skipped by newer ones -- edits
		// compose -- but a fullFrames delta cancels everything queued (the
		// state they were computed against is gone) and a scene install
		// clears the queue outright. responses are tagged with the epoch they
		// were issued under; a tag that no longer matches is dropped
		type PendingEdit =
			| { kind: "commit"; commit: EditCommit }
			| { kind: "undo" }
			| { kind: "redo" }
			| { kind: "revertAll" };
		let editQueue: PendingEdit[] = [];
		/** the in-flight drain, exposed so a caller that must observe the
		 * settled document -- export -- can wait the queue out rather than
		 * racing it */
		let activePump: Promise<void> | null = null;

		/** settles every queued commit as cancelled and empties the queue --
		 * the shape of every "this state is gone" path */
		function cancelQueued(): void {
			for (const pending of editQueue) {
				if (pending.kind === "commit") pending.commit.onSettled?.("cancelled");
			}
			editQueue = [];
		}

		function installDelta(
			delta: EditDelta,
			epochTag: number,
			pressOutcome?: (frames: readonly FrameDto[]) => PressSelection | null
		): void {
			const { scene, editor } = get();
			if (scene === null || editor === null || editor.epoch !== epochTag) return;
			// serialized commands cannot reorder, so an older revision can only
			// be a duplicate or a bug -- drop it; equal revisions are identity
			// deltas and carry no frame changes
			if (delta.revision < editor.revision) return;

			let frames = scene.frames;
			let editRevision = get().editRevision;
			let lastSplice = get().lastSplice;
			let frameSelection = editor.frameSelection;
			let pressSelection = editor.pressSelection;
			if (delta.frames !== null) {
				frames = applyFrameChanges(scene.frames, delta.frames);
				editRevision += 1;
				lastSplice = delta.frames;
				if (isFullFrames(delta.frames)) {
					// the queued ops' base state no longer exists in any mappable
					// sense; selections' referents likewise
					cancelQueued();
					frameSelection = [];
					pressSelection = null;
				} else {
					frameSelection = remapSelection(frameSelection, delta.frames);
					if (pressOutcome !== undefined) {
						// the landing commit named a press: its computed outcome --
						// the nudged edge's new identity, the merged run's start --
						// resolved against the post-splice frames
						pressSelection = pressOutcome(frames);
					} else if (pressSelection !== null) {
						// engine-driven deltas (undo/redo) and commits that never
						// named a press re-resolve index-first: the start frame
						// remapped through the splice, while it still holds a run
						// of the key, names the same press exactly -- two runs of
						// one key can share a start millisecond, where time
						// containment alone would jump to the later one. key +
						// time containment is the fallback when that frame is
						// gone or released, clearing honestly when no run of the
						// key contains the prior start. pure move-frames splices
						// resolve back to the identical run, leaving the
						// selection untouched
						const [remapped] = remapSelection([pressSelection.startIndex], delta.frames);
						const exact =
							remapped === undefined ? null : pressRunFromIndex(frames, pressSelection.key, remapped);
						if (exact !== null) {
							pressSelection = { key: pressSelection.key, startIndex: exact.startIndex };
						} else {
							const priorTime = scene.frames[pressSelection.startIndex]?.time;
							const run =
								priorTime === undefined ? null : pressRunAt(frames, pressSelection.key, priorTime);
							pressSelection =
								run === null ? null : { key: pressSelection.key, startIndex: run.startIndex };
						}
					}
					remapQueuedPayloads(delta.frames);
				}
			}
			const nextScene: LoadedScene = {
				...scene,
				frames,
				simulation: delta.simulation ?? scene.simulation,
				replay: { ...scene.replay, playerName: delta.playerName, timestampTicks: delta.timestampTicks }
			};
			const rederived = delta.frames !== null || delta.simulation !== null ? deriveScene(nextScene) : null;
			set({
				scene: nextScene,
				...(rederived !== null
					? {
							derived: rederived,
							timelineBounds: widenBounds(get().timelineBounds, rederived.timelineBounds)
						}
					: {}),
				editRevision,
				lastSplice,
				editor: {
					...editor,
					revision: delta.revision,
					dirty: delta.dirty,
					framesDirty: delta.framesDirty,
					metadataDirty: delta.metadataDirty,
					canUndo: delta.canUndo,
					canRedo: delta.canRedo,
					history: delta.history,
					frameSelection,
					pressSelection
				}
			});
			// after the state write: a hook that reads the store back must see
			// the post-splice truth it is being told about
			if (delta.frames !== null) hooks.onSplice?.(delta.frames);
		}

		function remapQueuedPayloads(changes: FrameChanges): void {
			editQueue = editQueue.flatMap((pending): PendingEdit[] => {
				if (pending.kind !== "commit") return [pending];
				const payload = pending.commit.payload;
				if (payload.kind === "intent") {
					if (payload.remap === undefined || payload.remap(changes)) return [pending];
					pending.commit.onSettled?.("cancelled");
					return [];
				}
				const ops = remapQueuedOps(payload.ops, changes);
				if (ops === null) {
					pending.commit.onSettled?.("cancelled");
					return [];
				}
				return [
					{ kind: "commit" as const, commit: { ...pending.commit, payload: { kind: "ops" as const, ops } } }
				];
			});
		}

		async function resyncNow(epochTag: number): Promise<void> {
			try {
				installDelta(await deps.resync(epochTag), epochTag);
			} catch {
				// a resync that itself fails leaves the next command to retry;
				// the store keeps showing the last authoritative state
			}
		}

		/** a second caller joins the active run rather than returning while its
		 * own item is still queued. joining is not by itself a guarantee that
		 * the item landed -- see the restart below -- so a caller that must
		 * observe a drained queue loops on `queueIsQuiet` instead */
		function pumpEdits(): Promise<void> {
			if (activePump === null) {
				activePump = drainEdits().finally(() => {
					activePump = null;
					// `activePump` is cleared in a reaction, so it stays non-null
					// for a microtask after the drain emptied the queue. an item
					// enqueued in that window joins a pump that has already
					// settled and would sit here unattended until the next
					// mutation happened along; restarting is what closes that
					if (editQueue.length > 0) void pumpEdits();
				});
			}
			return activePump;
		}

		/** true once nothing is queued and no drain is in flight */
		function queueIsQuiet(): boolean {
			return editQueue.length === 0 && activePump === null;
		}

		async function drainEdits(): Promise<void> {
			for (;;) {
				const pending = editQueue.shift();
				if (pending === undefined) return;
				const { scene, editor } = get();
				if (scene === null || editor === null) {
					if (pending.kind === "commit") pending.commit.onSettled?.("cancelled");
					cancelQueued();
					return;
				}
				const epochTag = editor.epoch;
				// re-check history steps against the authoritative state at
				// dispatch: the enqueue-time gate can pass while the step that
				// will consume the last entry is still in flight
				if (pending.kind === "undo" && !editor.canUndo) continue;
				if (pending.kind === "redo" && !editor.canRedo) continue;
				try {
					let delta: EditDelta;
					if (pending.kind === "undo") delta = await deps.undo(epochTag);
					else if (pending.kind === "redo") delta = await deps.redo(epochTag);
					else if (pending.kind === "revertAll") delta = await deps.revertAll(epochTag);
					else {
						// dispatch-time expansion: intents read the then-current
						// frames, and base_revision is assigned here -- after any
						// remap or expansion -- which is what makes a same-epoch
						// mismatch unreachable short of a bug
						const payload = pending.commit.payload;
						const ops = payload.kind === "ops" ? payload.ops : payload.expand(scene.frames, editor);
						if (ops === null || ops.length === 0) {
							pending.commit.onSettled?.("skipped");
							continue;
						}
						// resolved against the dispatched ops, after any remap or
						// expansion, so a counted label names what actually happened
						const label =
							typeof pending.commit.label === "function"
								? pending.commit.label(ops)
								: pending.commit.label;
						delta = await deps.applyEdit(epochTag, editor.revision, ops, label);
					}
					// landed before installDelta: the splice hook must be able to
					// tell this commit's own entry apart from the still-pending
					// ones it remaps
					if (pending.kind === "commit") pending.commit.onSettled?.("landed");
					installDelta(delta, epochTag, pending.kind === "commit" ? pending.commit.pressOutcome : undefined);
				} catch (e) {
					if (pending.kind === "commit") pending.commit.onSettled?.("failed");
					// a response for a replaced session is dropped outright: the
					// install already reset the slice and cleared the queue
					if (get().editor?.epoch !== epochTag) continue;
					const error: IpcError = isIpcError(e) ? e : { kind: "internal", message: String(e) };
					set({ lastError: { error, osrPath: "" } });
					if (error.kind === "staleSession") await resyncNow(epochTag);
				}
			}
		}

		// orders every settings publication: reads (install()'s post-load
		// refresh, hydrateSettings, loadSettings) claim a slot by bumping at
		// initiation and publish only while still the newest claim, writes
		// (publishSettings) bump at publication and always win. concurrent
		// getSettings() calls have no ordering relationship to each other or
		// to a racing write, so a stale resolution must recognize itself and
		// no-op instead of overwriting -- or cancelling -- a newer publication
		let settingsRefreshSeq = 0;
		// the video prefs get their own sequence for the same reason the skin
		// does: they are written by dragged controls that issue many overlapping
		// writes, and ordering those against each other is a separate question
		// from invalidating a refresh. two counters, because "which write is
		// newest" and "which write's answer is on screen" diverge the moment
		// one of them fails
		let videoPrefsSeq = 0;
		let videoPrefsPublishedSeq = 0;
		// the skin gets its OWN sequence: resolving a locator touches the disk
		// and finishes on its own schedule, so borrowing the settings counter
		// would let any unrelated settings publication -- a dialog open, a load's
		// refresh, a debounced pref write -- discard a resolved manifest that
		// nothing ever re-reads
		let skinRefreshSeq = 0;
		// the ROW LIST has its own order, separate from the selection's: it is
		// published from four places (a refresh, a success, and both superseded
		// and gated import branches), the walk behind it is off-thread and
		// unordered, and one of those callers has already proven itself stale --
		// so the list it fetched is the one guaranteed NOT to hold what the
		// newer operation is about to add. without a sequence that stale list can
		// land last and leave the picker with no row for the active skin
		let skinListSeq = 0;
		const publishSkins = async () => {
			const seq = ++skinListSeq;
			const rows = await deps.listSkins();
			if (seq === skinListSeq) set({ skins: rows });
		};

		// every preference the user has touched, counted under `group.key`.
		// hydration cannot detect an in-flight edit by comparing values -- a drag
		// away and back lands on the starting value again -- and cannot do it by
		// comparing whole groups either: a group's setter builds a new object, so
		// identity shows that SOMETHING moved but not what, and holding the whole
		// group back reverts every sibling of the edit to its default and then
		// writes those defaults over the file. so each setter records the one key
		// it moved and hydration decides key by key.
		//
		// counts rather than a set of names, because the write-through loop asks
		// the narrower question "did anything move while my save was in flight",
		// and a second touch of an already-recorded key must answer yes
		const prefEdits = new Map<string, number>();
		function recordPrefEdit(key: string) {
			prefEdits.set(key, (prefEdits.get(key) ?? 0) + 1);
		}
		/** whether anything at all has been touched since `before` was taken.
		 * the ledger only ever grows, so a differing size or count is the whole
		 * question */
		function prefsEditedSince(before: ReadonlyMap<string, number>): boolean {
			if (prefEdits.size !== before.size) return true;
			for (const [key, count] of prefEdits) if (before.get(key) !== count) return true;
			return false;
		}

		// the master level a mute replaced, so the next unmute can put it back.
		// beside prefEdits and for the same reason: it is session scratch the
		// ui never reads directly, and putting it in the state would publish a
		// field every consumer would have to be told to ignore
		let mutedFrom: number | null = null;

		// a direct settings write carries newer backend state than any refresh
		// still in flight from install(), so it invalidates those refreshes too
		// -- without the bump a getSettings() issued before the write could
		// resolve after it and publish its stale snapshot over this one
		function publishSettings(settings: Settings) {
			settingsRefreshSeq += 1;
			set({ settings });
		}

		/** the session both exports dispatch against, pinned before the wait:
		 * the destination the user picked and the expectation they were shown
		 * belong to it, so a scene installed while we drain makes the request
		 * stale rather than silently retargeting a different replay. an export
		 * has to describe the document the user is looking at, so it waits the
		 * edit queue out first -- dispatching straight past it would hand the
		 * backend a document those edits had not reached yet, and the backend
		 * would answer consistently for that older state, silently omitting
		 * the pending edit while still reporting success. looping rather than
		 * awaiting once: a join can resolve early against a pump that was
		 * already settling. shared by exportReplay and exportVideo so the two
		 * cannot drift on the stale-session rules */
		async function drainedExportEpoch(): Promise<number> {
			const requested = get().editor;
			if (requested === null) {
				throw { kind: "staleSession" } satisfies IpcError;
			}
			const epochTag = requested.epoch;
			while (!queueIsQuiet()) {
				await pumpEdits();
			}
			if (get().editor?.epoch !== epochTag) {
				throw { kind: "staleSession" } satisfies IpcError;
			}
			return epochTag;
		}

		/** the overrides and the table they fold to, written together: the two
		 * fields are one fact, and a set that moved only one of them would let
		 * a consumer read a table the persisted map does not describe */
		function installKeybinds(keybinds: KeybindOverrides) {
			return { keybinds, effectiveKeybinds: foldKeybinds(keybinds) };
		}

		// a stale (superseded) success still swaps the displayed scene: its
		// command already installed the backend session (commands.rs
		// install_scene runs before the promise resolves) and dropped the
		// previous scene's cache lease, so the display must follow the backend
		// or a failing newest load would leave it pointing at deleted assets.
		// only the current load owns the loading flag and error/pending state
		function install(scene: LoadedScene, current: boolean, osrPath: string) {
			// a fresh session invalidates every command queued against the
			// previous one -- the epoch check in installDelta would drop their
			// responses anyway, but there is no reason to let them dispatch
			cancelQueued();
			// inferred once here and frozen: the lattice comes from the
			// source's own untouched frames, and edits must never shift it.
			// the off-lattice summary rides beside it under the same rule --
			// it describes the loaded file, not the edited document
			const lattice = inferLattice(scene.frames);
			const offLattice = summarizeOffLattice(scene.frames, lattice);
			const derived = deriveScene(scene);
			set({
				scene,
				derived,
				// the pristine document's own mapping bounds: the frame of
				// reference every edit this session maps inside (widened only by
				// genuine frame extension, never re-derived)
				timelineBounds: derived.timelineBounds,
				sceneId: get().sceneId + 1,
				osrPath,
				audioDurationMs: null,
				playing: false,
				// a new replay gets the default framing: a zoom held over from
				// the last one would be pointing at nothing in particular
				viewportZoom: DEFAULT_VIEWPORT_ZOOM,
				viewportPan: NO_VIEWPORT_PAN,
				// a key armed for the previous replay would aim add-press at a
				// tile whose counts no longer mean anything
				armedKey: null,
				editor: {
					epoch: scene.epoch,
					revision: 0,
					dirty: false,
					framesDirty: false,
					metadataDirty: false,
					canUndo: false,
					canRedo: false,
					history: { labels: [], cursor: 0 },
					lattice,
					offLattice,
					frameSelection: [],
					pressSelection: null
				},
				editRevision: 0,
				lastSplice: null,
				// unconditional, unlike the request state below: a prompt asks
				// whether to throw away THIS document, and every install replaces
				// it -- a stale one installs a fresh, un-dirty editor slice just
				// as a current one does. gating it on `current` would leave the
				// dialog up over a document whose edits no longer exist
				pendingOpen: null,
				// the error/loading state belongs to the load that owns it, which
				// a superseded one does not
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
			timelineBounds: null,
			sceneId: 0,
			loading: false,
			lastError: null,
			pendingRecovery: null,
			pendingMismatch: null,
			pendingOpen: null,
			audioDurationMs: null,
			settings: null,
			skin: null,
			skins: [],
			skinNotice: null,
			overlays: DEFAULT_OVERLAYS,
			editing: DEFAULT_EDITING,
			effects: DEFAULT_EFFECTS,
			timeline: DEFAULT_TIMELINE,
			keybinds: NO_KEYBIND_OVERRIDES,
			effectiveKeybinds: foldKeybinds(NO_KEYBIND_OVERRIDES),
			playing: false,
			rate: 1,
			volume: DEFAULT_VOLUME,
			audio: DEFAULT_AUDIO,
			gameplay: DEFAULT_GAMEPLAY,
			mode: "watch",
			panelOpen: false,
			panelTab: "replay",
			helpOpen: false,
			openMenuOpen: false,
			tool: "select",
			armedKey: null,
			featherMs: DEFAULT_FEATHER_MS,
			smoothStrength: DEFAULT_SMOOTH_STRENGTH,
			detailSpanMs: DEFAULT_DETAIL_SPAN,
			viewportZoom: DEFAULT_VIEWPORT_ZOOM,
			viewportPan: NO_VIEWPORT_PAN,
			editor: null,
			editRevision: 0,
			lastSplice: null,

			openReplay: async (osrPath) => {
				// drained before the guard reads it, for the reason exportReplay
				// drains: `dirty` mirrors the last LANDED delta, so a commit still
				// queued or awaiting its response is not in it yet. the first edit
				// of a session is the reachable case -- nothing has dirtied the
				// document before it -- and the guard would pass, install() would
				// cancel the queue and drop the in-flight response by epoch, and
				// the edit would be gone without the question ever being asked.
				// looping rather than awaiting once, as export does: a join can
				// resolve early against a pump that was already settling.
				// the wait claims no place in the load sequence, so a
				// continuation installing during it leaves this older request
				// to load over the newer one -- open-intent ordering is the
				// fix for that and for install()'s unconditional clear below,
				// deferred together in TODO. it is a recoverable wrong replay
				// against a silent lost edit, which is why this landed first
				while (!queueIsQuiet()) {
					await pumpEdits();
				}
				// guard once, here, at the moment the user asks for a different
				// replay. no same-path exemption: opening the replay already on
				// screen discards the document just as thoroughly, and exempting
				// it would silently destroy an edit exactly once
				if (get().editor?.dirty === true) {
					// a new request supersedes the last one's outstanding offer,
					// which is what run() would have done had this not stopped
					// short of it: a mismatch dialog left standing would render
					// alongside the prompt, two modals deep, each asking about a
					// different replay. declining the discard leaves the earlier
					// beatmap to be picked again, which is the cheaper of the two
					set({ pendingOpen: { osrPath }, pendingMismatch: null });
					return;
				}
				await run(osrPath, () => deps.loadReplay(osrPath));
			},
			// unguarded on purpose: both of these continue a request that already
			// prompted -- the error toast's "pick beatmap", the beatmap-recovery
			// drop, and the mismatch override all follow an openReplay that
			// guarded and then failed. one decision, one dialog
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
			confirmDiscard: async () => {
				const pending = get().pendingOpen;
				if (pending === null) return;
				// straight to run(), never back through openReplay: this IS the
				// guarded request, and re-entering the guard would re-raise the
				// prompt the user just answered. nothing is discarded here either
				// -- install() runs only on success, so a load that then fails
				// leaves the edited document exactly where it was
				set({ pendingOpen: null });
				await run(pending.osrPath, () => deps.loadReplay(pending.osrPath));
			},
			dismissDiscard: () => set({ pendingOpen: null }),
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
				} else if (key === "playfieldGrid") {
					// an enum on the wire, so anything outside the allowed set means
					// off rather than a value the renderer would have to interpret
					next = clampPlayfieldGridSpacing(value as number) as OverlaySettings[typeof key];
				}
				recordPrefEdit(`overlays.${key}`);
				set({ overlays: { ...get().overlays, [key]: next } });
			},
			setEditing: (key, value) => {
				recordPrefEdit(`editing.${key}`);
				set({ editing: { ...get().editing, [key]: value } });
			},
			// the master and the granular flags are stored side by side and
			// written the same way: turning `enabled` off must not touch the five
			// below it, so the user gets their own selection back when it returns
			setEffect: (key, value) => {
				let next = value;
				if (key === "backgroundDim") {
					// the one numeric member of this group, validated here for the
					// same reason displayLength is above
					const percent = value as number;
					if (!Number.isFinite(percent)) return;
					next = clampBackgroundDim(percent) as EffectSettings[typeof key];
				}
				recordPrefEdit(`effects.${key}`);
				set({ effects: { ...get().effects, [key]: next } });
			},
			setGameplay: (key, value) => {
				// the level is the group's one number and gets the same
				// validation every other numeric pref gets
				const next =
					key === "positionalHitsoundLevel"
						? (clampPositionalLevel(value as number) as GameplaySettings[typeof key])
						: value;
				recordPrefEdit(`gameplay.${key}`);
				set({ gameplay: { ...get().gameplay, [key]: next } });
			},
			setTimeline: (key, value) => {
				recordPrefEdit(`timeline.${key}`);
				set({ timeline: { ...get().timeline, [key]: value } });
			},
			setKeybinds: (overrides) => {
				// one key for the whole map, matching how it hydrates: the map
				// replaces wholesale rather than merging, so there is no
				// per-action question to ask
				recordPrefEdit("keybinds");
				set(installKeybinds(overrides));
			},
			setPlaying: (playing) => set({ playing }),
			setRate: (rate) => set({ rate }),
			setVolume: (volume) => {
				if (!Number.isFinite(volume)) return;
				recordPrefEdit("volume");
				set({ volume: clampVolume(volume) });
			},
			toggleMute: () => {
				// recorded like any other master edit: a mute is a level the user
				// chose, and a hydration landing on top of one would put the
				// sound back
				recordPrefEdit("volume");
				const next = toggleMute(get().volume, mutedFrom);
				mutedFrom = next.mutedFrom;
				set({ volume: clampVolume(next.volume) });
			},
			setAudio: (key, value) => {
				// only the key that moved is recorded -- not the master, which
				// persists under its own top-level key, and not this group's
				// other three members. hydration reverts what it is told nobody
				// touched, so a wider record here is a wider reset there
				let next = value;
				if (typeof value !== "boolean") {
					const raw = value as number;
					if (!Number.isFinite(raw)) return;
					// the offset has its own range and its own zero; the two channels
					// are percents on the master's terms
					next = (key === "offsetMs" ? clampAudioOffset(raw) : clampVolume(raw)) as AudioSettings[typeof key];
				}
				recordPrefEdit(`audio.${key}`);
				set({ audio: { ...get().audio, [key]: next } });
			},
			// watch hands the playfield the window; edit brings the panel
			// back. the rail toggle still overrides either way
			setMode: (mode) => set({ mode, panelOpen: mode === "edit" }),
			togglePanel: () => set({ panelOpen: !get().panelOpen }),
			// a rail click is also a request to see the panel
			setPanelTab: (panelTab) => set({ panelTab, panelOpen: true }),
			setHelpOpen: (helpOpen) => set({ helpOpen }),
			setOpenMenuOpen: (openMenuOpen) => set({ openMenuOpen }),
			setTool: (tool) => set({ tool }),
			// a blank number field arrives as NaN and must leave the last good
			// value alone, matching setOverlay's displayLength rule
			setFeatherMs: (ms) => {
				if (!Number.isFinite(ms)) return;
				set({ featherMs: clampFeather(ms) });
			},
			setSmoothStrength: (value) => {
				if (!Number.isFinite(value)) return;
				set({ smoothStrength: clampStrength(value) });
			},
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
				const editsBefore = new Map(prefEdits);
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
				const editedInFlight = (key: string) => prefEdits.get(key) !== editsBefore.get(key);
				/** the loaded group with the members the user moved mid-read left at
				 * what they chose. per member, never per group: holding a whole group
				 * back would keep every sibling of the edit at its default and then
				 * write those defaults over the file */
				const hydrateGroup = <T extends object>(group: string, loaded: T, current: T): T => {
					const next = { ...loaded };
					for (const key of Object.keys(next) as (keyof T & string)[]) {
						if (editedInFlight(`${group}.${key}`)) next[key] = current[key];
					}
					return next;
				};
				const live = get();
				// volume/audio/gameplay/overlays/editing/effects/timeline/keybinds are
				// frontend-owned -- nothing backend-side ever changes them on its own
				// -- so they apply even when a newer read has claimed the slot; the
				// settings object itself (recents move under a concurrent load)
				// publishes only while this read is still the newest claim
				set({
					...(refreshSeq === settingsRefreshSeq ? { settings } : {}),
					// the master persists under its own top-level key and hydrates on
					// its own terms, so it is guarded on its own rather than with the
					// channels it multiplies
					...(editedInFlight("volume") ? {} : { volume: clampVolume(settings.volume) }),
					audio: hydrateGroup("audio", { ...DEFAULT_AUDIO, ...settings.audio }, live.audio),
					gameplay: hydrateGroup("gameplay", { ...DEFAULT_GAMEPLAY, ...settings.gameplay }, live.gameplay),
					overlays: hydrateGroup("overlays", { ...DEFAULT_OVERLAYS, ...settings.overlays }, live.overlays),
					editing: hydrateGroup("editing", { ...DEFAULT_EDITING, ...settings.editing }, live.editing),
					effects: hydrateGroup("effects", { ...DEFAULT_EFFECTS, ...settings.effects }, live.effects),
					timeline: hydrateGroup("timeline", { ...DEFAULT_TIMELINE, ...settings.timeline }, live.timeline),
					// the whole map replaces, never merges: a merge would resurrect an
					// override the user reverted in another window, and the sparse map
					// is already only what they changed. a settings file written
					// before this feature hydrates it empty
					...(editedInFlight("keybinds") ? {} : installKeybinds(settings.keybinds ?? NO_KEYBIND_OVERRIDES))
				});
				// the skin is resolved separately from the settings read, because the
				// persisted locator is a POINTER and resolving it touches the disk:
				// a folder that moved between sessions comes back as the bundled
				// default with a fallback notice rather than as a failed startup,
				// which is the same posture a stale beatmap association gets
				// declared OUTSIDE the try: the catch publishes too, and a failure
				// that has been superseded must no more overwrite a newer pick than
				// a success would
				let skinSeq = 0;
				try {
					skinSeq = ++skinRefreshSeq;
					const skin = await deps.getSkin();
					// guarded on the SKIN sequence, not the settings one: only a
					// newer skin resolution may cancel this, and an explicit pick
					// that landed while this was in flight is exactly that
					//
					// and the gate applies HERE too: a persisted locator is the third
					// route to an active skin, beside select and import. a dev build
					// and a shipped one share one settings file (the identifier in
					if (skinSeq === skinRefreshSeq) set({ skin });
				} catch (e) {
					// a skin that will not load must never stop the app opening: the
					// null the store started with reads as the bundled default
					// everywhere, so there is nothing to substitute. but it is SAID,
					// for the reason the gated branch above says it -- a null skin
					// leaves every picker row unticked, and an unreadable folder or a
					// cap breach is exactly the case a user needs told about, since
					// unlike a stale locator it does not come back as a fallback
					const error: IpcError = isIpcError(e) ? e : { kind: "internal", message: String(e) };
					if (skinSeq === skinRefreshSeq) {
						set({ skinNotice: `your skin could not be loaded: ${describeIpcError(error).title}` });
					}
				}
				// an edit made while the read was in flight predates the persistence
				// subscription (App installs it only once this resolves), and the
				// guards above re-emit nothing for it afterwards, so no debounced
				// save would ever pick it up -- write the surviving values through
				// now or they revert on restart. the write-through's own await is
				// the same gap one layer down, so repeat until nothing changed
				// while the save was in flight; edits after the stable save cannot
				// slip past install, because App's subscription lands in the same
				// microtask drain as this resolution, ahead of any queued input
				if (prefsEditedSince(editsBefore)) {
					for (;;) {
						const { volume, audio, gameplay, overlays, editing, effects, timeline, keybinds } = get();
						const editsAtSave = new Map(prefEdits);
						try {
							const saved = await deps.setViewerPrefs(
								volume,
								audio,
								gameplay,
								overlays,
								editing,
								effects,
								timeline,
								keybinds
							);
							if (!prefsEditedSince(editsAtSave)) {
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
			refreshSkins: async () => {
				try {
					await publishSkins();
				} catch (e) {
					const error: IpcError = isIpcError(e) ? e : { kind: "internal", message: String(e) };
					set({ lastError: { error, osrPath: "" } });
				}
			},
			selectSkin: async (locator) => {
				try {
					// resolve first, publish once: the manifest is complete before
					// anything downstream sees the change, which is what makes the
					// swap atomic. a per-element progressive swap would momentarily
					// produce exactly the mixed-era look the floor rule exists to
					// prevent
					const skinSeq = ++skinRefreshSeq;
					const skin = await deps.setSkin(locator);
					// a superseded pick stops HERE, before it notifies or writes
					// anything.
					if (skinSeq !== skinRefreshSeq) return;
					// ONE publication, deliberately: the manifest and the settings
					// snapshot the dialog reads are one fact, and two sets would let a
					// subscriber observe the new skin beside the old selection.
					//
					// the REQUESTED locator is what lands in settings, not the
					// manifest's, and the two differ in exactly one case: a folder that
					// does not resolve falls back to the bundled default while the
					// selection keeps naming the folder. that is deliberate and is what
					// the backend persisted -- the user asked for that skin, so
					// restoring the folder restores the skin without them re-picking it
					// the sequence bump is what publishSettings does and for the same
					// reason: a getSettings() issued before this write could resolve
					// after it and publish its pre-write snapshot over the selection
					settingsRefreshSeq += 1;
					set((state) => ({
						skin,
						skinNotice: null,
						settings: state.settings === null ? null : { ...state.settings, skin: locator }
					}));
					// the row list is a separate fact and it MOVED: a folder skin is
					// not enumerable, so the backend lists whichever one is selected.
					// without refetching, browsing to a skin leaves the picker with no
					// row matching the active locator -- nothing ticked at all
					await publishSkins();
				} catch (e) {
					// a cap breach refuses the skin WHOLE and the previous selection
					// stands -- which is why nothing is published before the setSkin
					// await. past that point the re-list can also land here, with the
					// selection already committed, and it must not undo it: the row
					// list is a separate fact, exactly as importSkin says of its own
					const error: IpcError = isIpcError(e) ? e : { kind: "internal", message: String(e) };
					set({ lastError: { error, osrPath: "" } });
				}
			},
			importSkin: async (path) => {
				try {
					const skinSeq = ++skinRefreshSeq;
					const skin = await deps.importSkin(path);
					// superseded imports stop before notifying or writing, as in
					// selectSkin -- but the archive DID land, so the row list is still
					// re-published. it is a separate fact from the selection (the
					// success path publishes it separately for the same reason), and
					// skipping it would leave the imported skin with no row anywhere
					// until the dialog is reopened
					if (skinSeq !== skinRefreshSeq) {
						await publishSkins();
						return;
					}
					if (skinSeq !== skinRefreshSeq) return;
					// the manifest's own locator here, not a requested one: only the
					// import knows where the archive landed
					settingsRefreshSeq += 1;
					set((state) => ({
						skin,
						skinNotice: null,
						settings: state.settings === null ? null : { ...state.settings, skin: skin.locator }
					}));
					// the row list is a separate publication because it is a separate
					// fact: the import already succeeded and the skin is already
					// selected, so a failed re-list must not undo either
					await publishSkins();
				} catch (e) {
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
			},
			commitEdit: async (commit) => {
				if (get().editor === null) return;
				editQueue.push({ kind: "commit", commit });
				await pumpEdits();
			},
			undoEdit: async () => {
				if (get().editor?.canUndo !== true) return;
				editQueue.push({ kind: "undo" });
				await pumpEdits();
			},
			redoEdit: async () => {
				if (get().editor?.canRedo !== true) return;
				editQueue.push({ kind: "redo" });
				await pumpEdits();
			},
			revertAll: async () => {
				if (get().editor === null) return;
				editQueue.push({ kind: "revertAll" });
				await pumpEdits();
			},
			setFrameSelection: (indices) => {
				const editor = get().editor;
				if (editor === null) return;
				set({ editor: { ...editor, frameSelection: indices } });
			},
			setPressSelection: (selection) => {
				const editor = get().editor;
				if (editor === null) return;
				set({ editor: { ...editor, pressSelection: selection } });
			},
			setArmedKey: (key) => set({ armedKey: key }),
			exportReplay: async (destPath, overwrite) =>
				deps.exportReplay(await drainedExportEpoch(), destPath, overwrite),
			exportVideo: async (destPath) => deps.exportVideo(await drainedExportEpoch(), destPath),
			cancelVideoExport: (jobId) => deps.cancelVideoExport(jobId),
			getVideoRendererStatus: () => deps.getVideoRendererStatus(),
			installVideoRenderer: async () => {
				const status = await deps.installVideoRenderer();
				// the install cached the encoder probe's winner backend-side, so
				// the published settings are one write behind until this refresh
				const refreshSeq = ++settingsRefreshSeq;
				try {
					const settings = await deps.getSettings();
					if (refreshSeq === settingsRefreshSeq) set({ settings });
				} catch {
					// the install itself succeeded; a failed refresh only delays
					// the probe cache reaching the dialog
				}
				return status;
			},
			saveVideoPrefs: async (video, rendererOptions) => {
				// every control sends a whole snapshot, and a slider drag sends
				// one per step, so these responses race each other -- an older
				// one publishing over a newer would rewind the control under the
				// cursor. the guard is "highest seq PUBLISHED wins" rather than
				// "must be the newest issued": the newest write can fail, and
				// gating on it would then suppress an older write that did
				// land, leaving the store behind the backend for the session
				const writeSeq = ++videoPrefsSeq;
				// the snapshot every control branches from is this store's, so it
				// has to move NOW rather than when the answer lands. two different
				// controls changed inside one round-trip would otherwise both read
				// the pre-write state, and the later write would carry the earlier
				// one's field at its old value -- silently reverting a setting the
				// user just chose. the seq guard below orders the ANSWERS; only
				// this keeps the next write's snapshot current
				const beforeWrite = get().settings;
				set((state) => ({
					settings: state.settings === null ? null : { ...state.settings, video, rendererOptions }
				}));
				try {
					const settings = await deps.setVideoPrefs(video, rendererOptions);
					if (writeSeq > videoPrefsPublishedSeq) {
						videoPrefsPublishedSeq = writeSeq;
						publishSettings(settings);
					}
				} catch (e) {
					// the optimistic move above has to come back, or a write that
					// never landed would leave the control showing a value the
					// backend does not hold for the rest of the session. only when
					// this is still the newest write issued: a newer one has
					// already branched from the optimistic state and rolling back
					// underneath it would revert ITS field instead
					if (writeSeq === videoPrefsSeq && beforeWrite !== null) {
						// only the two fields this write owns, and only while each is
						// still the exact value this request installed. a skin swap
						// publishes a whole fresh Settings and an encoder re-detect
						// republishes rendererOptions with a new probedEncoder --
						// either landing while this request was pending means the
						// field is no longer ours to restore, and putting the old
						// one back would not just hide the newer value but feed it
						// to the NEXT whole-snapshot write, persisting the stale map
						// over what the backend already stored
						set((state) => {
							if (state.settings === null) return {};
							return {
								settings: {
									...state.settings,
									video: state.settings.video === video ? beforeWrite.video : state.settings.video,
									rendererOptions:
										state.settings.rendererOptions === rendererOptions
											? beforeWrite.rendererOptions
											: state.settings.rendererOptions
								}
							};
						});
					}
					// fire-and-forget control writes surface through the toast
					// flow, the saveStablePath posture
					const error: IpcError = isIpcError(e) ? e : { kind: "internal", message: String(e) };
					set({ lastError: { error, osrPath: "" } });
				}
			},
			redetectVideoEncoder: async () => {
				try {
					publishSettings(await deps.redetectVideoEncoder());
				} catch (e) {
					const error: IpcError = isIpcError(e) ? e : { kind: "internal", message: String(e) };
					set({ lastError: { error, osrPath: "" } });
				}
			}
		};
	});
}

export const viewerStore = createViewerStore(
	{
		loadReplay: invokeLoadReplay,
		loadReplayWithBeatmap: invokeLoadReplayWithBeatmap,
		getSettings: invokeGetSettings,
		setOsuStablePath: invokeSetOsuStablePath,
		setViewerPrefs: invokeSetViewerPrefs,
		clearRecents: invokeClearRecents,
		listSkins: invokeListSkins,
		getSkin: invokeGetSkin,
		setSkin: invokeSetSkin,
		importSkin: invokeImportSkin,
		applyEdit: invokeApplyEdit,
		undo: invokeUndo,
		redo: invokeRedo,
		revertAll: invokeRevertAll,
		resync: invokeResync,
		exportReplay: invokeExportReplay,
		exportVideo: invokeExportVideo,
		cancelVideoExport: invokeCancelVideoExport,
		getVideoRendererStatus: invokeGetVideoRendererStatus,
		installVideoRenderer: invokeInstallVideoRenderer,
		setVideoPrefs: invokeSetVideoPrefs,
		redetectVideoEncoder: invokeRedetectVideoEncoder
	},
	{
		// every landed splice keeps the gesture preview's pending entries in the
		// authoritative index space (editor/preview.ts)
		onSplice: (changes) => gesturePreview.applySplice(changes)
	}
);

export function useViewerStore<T>(selector: (state: ViewerState) => T): T {
	return useStore(viewerStore, selector);
}
