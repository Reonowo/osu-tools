// keyboard shortcuts and wheel frame-stepping for the viewer, extracted from
// Controls.tsx (spec 2026-08-06, item 4). keyboard goes through
// @tanstack/react-hotkeys; wheel stays a manual listener because the library
// is keyboard-only. Controls stays mounted with no scene (App renders it
// unconditionally and it returns null early), so every handler re-checks the
// scene itself rather than relying on mount state

import { useEffect } from "react";
import { useHotkeys } from "@tanstack/react-hotkeys";
import { adjacentFrameTime } from "@/lib/timeline";
import { playbackClock } from "@/playback/instance";
import { viewerStore } from "@/state/store";
import { withinInteractiveControl, withinNativeWheelUi } from "./shortcut-guards";

/** seek to the neighbouring replay frame; does not pause playback, matching
 * the `,` / `.` behaviour the wheel shares */
export function stepFrame(direction: 1 | -1) {
	const { scene } = viewerStore.getState();
	if (scene === null) return;
	const next = adjacentFrameTime(scene.frames, playbackClock.currentTime(), direction);
	if (next !== undefined) playbackClock.seekTo(next);
}

function guarded(e: KeyboardEvent, action: () => void) {
	// text-like inputs never reach here at all -- @tanstack/hotkeys' default
	// ignoreInputs (true for these single-key bindings) skips input/textarea/
	// select/contenteditable before this runs. this predicate is the second
	// gate, for targets that default doesn't cover: a focused button must keep
	// its native space activation instead of toggling playback out from under
	// it, and a focused slider thumb must keep its own arrow-key handling
	// instead of seeking
	if (viewerStore.getState().scene === null) return;
	if (withinInteractiveControl(e.target)) return;
	action();
}

export function usePlaybackShortcuts() {
	useHotkeys(
		[
			{
				hotkey: "Space",
				// holding space must not rapid-toggle, while the arrows below keep
				// key repeat for held-key seeking. e.repeat is filtered here instead
				// of using the library's requireReset: its hasFired flag only resets
				// on a keyup this document receives, so releasing space while
				// alt-tabbed away would swallow the first press after refocus
				callback: (e) => {
					if (e.repeat) return;
					guarded(e, () => {
						// preventDefault only after the guard passes: the library-level
						// preventDefault option would also swallow space on a focused
						// button before the guard could decline
						e.preventDefault();
						const { playing, setPlaying } = viewerStore.getState();
						setPlaying(!playing);
					});
				}
			},
			{
				hotkey: "ArrowLeft",
				callback: (e) => guarded(e, () => playbackClock.seekTo(playbackClock.currentTime() - 1000))
			},
			{
				hotkey: "ArrowRight",
				callback: (e) => guarded(e, () => playbackClock.seekTo(playbackClock.currentTime() + 1000))
			},
			{ hotkey: ",", callback: (e) => guarded(e, () => stepFrame(-1)) },
			{ hotkey: ".", callback: (e) => guarded(e, () => stepFrame(1)) },
			{ hotkey: "Home", callback: (e) => guarded(e, () => playbackClock.seekTo(playbackClock.minTime)) }
		],
		// @tanstack/hotkeys defaults both preventDefault and stopPropagation to
		// true for every matched registration, applied unconditionally on match
		// -- before requireReset's gate and before our callback ever runs (see
		// hotkey-manager.ts). left at those defaults, a focused play button's
		// native space-activation would be suppressed regardless of what
		// guarded() decides, and the event would stop at this document listener
		// before reaching any future window-level handler. both are disabled
		// here so the explicit e.preventDefault() above is the only event-flow
		// mutation this hook makes
		{ preventDefault: false, stopPropagation: false }
	);

	useEffect(() => {
		function onWheel(e: WheelEvent) {
			// one frame per event regardless of delta magnitude (no accumulation);
			// deltaY 0 means a purely horizontal wheel, which is not a step
			if (e.deltaY === 0) return;
			if (viewerStore.getState().scene === null) return;
			if (withinNativeWheelUi(e.target)) return;
			stepFrame(e.deltaY < 0 ? -1 : 1);
		}
		// passive: the viewer layout never scrolls, so default is never prevented
		window.addEventListener("wheel", onWheel, { passive: true });
		return () => window.removeEventListener("wheel", onWheel);
	}, []);
}
