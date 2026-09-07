// trailing-debounced persistence for the viewer preferences. dragging a
// volume slider emits a store write per pointer move; without the debounce
// each one would be a settings.json rewrite, so a save fires only once the
// user has settled.
//
// the scheduler is injectable because bun:test has no fake timers -- the
// tests drive a manual queue instead of waiting on real wall time

import type { StoreApi } from "zustand";
import { isIpcError } from "../lib/ipc";
import type {
	AudioSettings,
	EditingSettings,
	EffectSettings,
	GameplaySettings,
	InterfaceSettings,
	IpcError,
	KeybindOverrides,
	OverlaySettings,
	TimelineSettings
} from "../lib/scene-types";
import type { ViewerState } from "./store";

export type PrefsSaver = (
	volume: number,
	audio: AudioSettings,
	gameplay: GameplaySettings,
	overlays: OverlaySettings,
	editing: EditingSettings,
	effects: EffectSettings,
	timeline: TimelineSettings,
	interfacePrefs: InterfaceSettings,
	keybinds: KeybindOverrides
) => Promise<unknown>;

export interface Scheduler {
	schedule(fn: () => void, ms: number): unknown;
	cancel(handle: unknown): void;
}

const timerScheduler: Scheduler = {
	schedule: (fn, ms) => setTimeout(fn, ms),
	cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
};

/**
 * subscribes to volume/overlay changes and persists them after `waitMs` of
 * quiet. install this only AFTER hydrateSettings() has resolved: installing
 * first would see hydration's own write and save the loaded values straight
 * back. returns a dispose that flushes any pending save and unsubscribes.
 */
export function installPrefsPersistence(
	store: StoreApi<ViewerState>,
	save: PrefsSaver,
	waitMs = 500,
	scheduler: Scheduler = timerScheduler
): () => void {
	let handle: unknown = null;

	// reads at call time, so a burst collapses to one save carrying the
	// latest values rather than the ones that scheduled it
	const flush = () => {
		// one read, then `interface` pulled off it by hand: it is a reserved
		// word in module code, so the destructuring shorthand every sibling
		// uses is not available to it
		const state = store.getState();
		const { volume, audio, gameplay, overlays, editing, effects, timeline, keybinds } = state;
		const interfacePrefs = state.interface;
		save(volume, audio, gameplay, overlays, editing, effects, timeline, interfacePrefs, keybinds).catch(
			(e: unknown) => {
				// a silently dropped rejection would let the ui imply the prefs
				// were saved while they revert on restart; route it through the
				// same toast flow as saveStablePath
				const error: IpcError = isIpcError(e) ? e : { kind: "internal", message: String(e) };
				store.setState({ lastError: { error, osrPath: "" } });
			}
		);
	};

	const unsubscribe = store.subscribe((state, prev) => {
		// reference equality on audio/overlays/editing/effects/timeline/interface/
		// keybinds: setAudio/setOverlay/setEditing/setEffect/setTimeline/
		// setInterface/setKeybinds always build a new object, and every other
		// store write (scene installs, playback, rate, and the OS reduce-motion
		// observation beside the interface group) leaves all eight fields
		// untouched, so those never schedule a save
		if (
			state.volume === prev.volume &&
			state.audio === prev.audio &&
			state.gameplay === prev.gameplay &&
			state.overlays === prev.overlays &&
			state.editing === prev.editing &&
			state.effects === prev.effects &&
			state.timeline === prev.timeline &&
			state.interface === prev.interface &&
			state.keybinds === prev.keybinds
		) {
			return;
		}
		if (handle !== null) scheduler.cancel(handle);
		handle = scheduler.schedule(() => {
			handle = null;
			flush();
		}, waitMs);
	});

	return () => {
		// a pending save is committed user intent -- teardown writes it now
		// instead of dropping it
		if (handle !== null) {
			scheduler.cancel(handle);
			handle = null;
			flush();
		}
		unsubscribe();
	};
}
