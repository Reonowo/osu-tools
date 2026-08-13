// keyboard shortcuts and wheel frame-stepping for the viewer, extracted from
// Controls.tsx (spec 2026-08-06, item 4). keyboard goes through
// @tanstack/react-hotkeys, except ctrl+0, which matches on the physical key
// the library cannot address; wheel stays a manual listener because the
// library is keyboard-only. Controls stays mounted with no scene (App renders
// it unconditionally and it returns null early), so every handler re-checks
// the scene itself rather than relying on mount state

import { useEffect } from "react";
import { useHotkeys } from "@tanstack/react-hotkeys";
import { frameCursor } from "@/playback/frame-cursor";
import { playbackClock } from "@/playback/instance";
import { spacePan } from "@/playback/space-pan";
import { viewerStore } from "@/state/store";
import { asksViewportReset, wheelFrameStep, withinInteractiveControl } from "./shortcut-guards";

/** exact-select the neighbouring replay frame, one index at a time so a run
 * of duplicate-time frames is fully steppable; does not pause playback,
 * matching the `,` / `.` behaviour the wheel shares */
export function stepFrame(direction: 1 | -1) {
	frameCursor.step(direction);
}

function guarded(e: KeyboardEvent, action: () => void) {
	// for the hotkey registrations, text-like inputs never reach here at all --
	// @tanstack/hotkeys' default ignoreInputs (true for these single-key
	// bindings) skips input/textarea/select/contenteditable before this runs,
	// and this predicate is the second gate, for targets that default doesn't
	// cover: a focused button must keep its native space activation instead of
	// toggling playback out from under it, and a focused slider thumb must keep
	// its own arrow-key handling instead of seeking. ctrl+0 arrives from a
	// manual listener with no such default ahead of it, so for that one this is
	// the only gate -- the interactive-tag walk covers the text-like inputs too
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
				// alt-tabbed away would swallow the first press after refocus.
				// filtering it is also what lets a hold be a drag: re-arming
				// mid-hold would forget a drag already under way
				callback: (e) => {
					if (e.repeat) return;
					guarded(e, () => {
						// preventDefault only after the guard passes: the library-level
						// preventDefault option would also swallow space on a focused
						// button before the guard could decline
						e.preventDefault();
						// keydown only arms the viewport's pan drag now; the play/pause
						// toggle moved to keyup so a space-drag can suppress it. a tap
						// still toggles, one keystroke later than it used to
						spacePan.press();
					});
				}
			},
			{
				hotkey: "Space",
				// conflictBehavior: the manager matches conflicts on the hotkey
				// string and target alone, so the keydown registration above would
				// warn about this one even though the two never fire on the same
				// event
				options: { eventType: "keyup", conflictBehavior: "allow" },
				callback: () => {
					// no guard needed: press() ran only if the keydown passed one, so
					// a release with nothing armed -- a focused button's own space
					// activation, a text field, no loaded scene -- toggles nothing
					if (!spacePan.release()) return;
					const { playing, setPlaying } = viewerStore.getState();
					setPlaying(!playing);
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
			const step = wheelFrameStep(e);
			if (step === null) return;
			if (viewerStore.getState().scene === null) return;
			stepFrame(step);
		}
		// the zoom readout's click, reachable from the keyboard. a manual
		// listener rather than a hotkey registration because the reset is the
		// *physical* zero and the library matches on the character the layout
		// prints there -- see asksViewportReset for why `Control+0` cannot
		// express it. guarded() is the whole gate here, with no library
		// ignoreInputs ahead of it: its interactive-tag walk covers the
		// input/textarea/select the library would have skipped, plus the
		// buttons, sliders and dialogs it would not have. preventDefault stays
		// App.tsx's, app-wide, so page zoom cannot drift even when this declines
		function onKeyDown(e: KeyboardEvent) {
			if (!asksViewportReset(e)) return;
			guarded(e, () => viewerStore.getState().resetViewport());
		}
		// passive: the viewer layout never scrolls, so default is never prevented
		// here. ctrl+wheel is the one wheel gesture that does need a
		// preventDefault (the webview's own page zoom), and wheelFrameStep bails
		// on it -- App.tsx suppresses it app-wide with a non-passive listener
		window.addEventListener("wheel", onWheel, { passive: true });
		window.addEventListener("keydown", onKeyDown);
		return () => {
			window.removeEventListener("wheel", onWheel);
			window.removeEventListener("keydown", onKeyDown);
		};
	}, []);
}
