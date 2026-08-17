// keyboard shortcuts and wheel frame-stepping for the viewer, extracted from
// Controls.tsx (spec 2026-08-06, item 4). keyboard goes through
// @tanstack/react-hotkeys, except the code-matched viewport reset, which
// matches on the physical key the library cannot address; wheel stays a manual
// listener because the library is keyboard-only. Controls stays mounted with
// no scene (App renders it unconditionally and it returns null early), so
// every handler re-checks the scene itself rather than relying on mount state.
//
// this is the `global` registration point of keybinds.ts's table: every key
// below is read from the store's *effective* table, so what the app binds and
// what the settings rows list cannot drift -- and a capture takes effect
// without closing the dialog, because the registrations re-derive from it.
// the `gesture` half registers in use-edit-tools

import { useEffect, useMemo } from "react";
import { useHotkeys, type Hotkey, type UseHotkeyDefinition } from "@tanstack/react-hotkeys";
import { frameEditGate } from "@/editor/gate";
import { gestureLive } from "@/editor/gesture-live";
import { captureArm } from "@/playback/capture-arm";
import { frameCursor } from "@/playback/frame-cursor";
import { playbackClock } from "@/playback/instance";
import { spacePan } from "@/playback/space-pan";
import { useViewerStore, viewerStore } from "@/state/store";
import { focusModality } from "./focus-modality";
import {
	EDIT_ACTIONS,
	keybindRow,
	keybindMainKey,
	matchesCodeKeybind,
	releasedMainKey,
	resolveEditKeybind,
	type EditKeybindResolution,
	type EffectiveKeybind,
	type KeybindAction
} from "./keybinds";
import { controlOwnsKeydown, wheelFrameStep, withinInteractiveControl } from "./shortcut-guards";

/** one press of the volume keys, in percent. lazer moves its master in
 * hundredths of unity per press (AudioManager's VolumeIncreaseAmount), which
 * is one percentage point here; five makes the pair usable in a hurry without
 * overshooting a level anyone tuned by hand */
const VOLUME_STEP = 5;

function nudgeMasterVolume(delta: number) {
	const { volume, setVolume } = viewerStore.getState();
	setVolume(volume + delta);
}

/** exact-select the neighbouring replay frame, one index at a time so a run
 * of duplicate-time frames is fully steppable; does not pause playback,
 * matching the `,` / `.` behaviour the wheel shares */
export function stepFrame(direction: 1 | -1) {
	frameCursor.step(direction);
}

/** the one gate for every binding, hotkey-registered and the manual
 * code-matched reset alike (the library's own ignoreInputs is disabled below
 * so nothing is swallowed before this reads it). the modality split lives in
 * controlOwnsKeydown: keyboard-acquired focus keeps a control's native keys,
 * the residue focus a mouse click leaves behind hands them back -- clicking
 * the zoom reset and then holding space must pan, not re-fire the reset. text
 * entries, dialogs, and composites' nav keys stay owned under either modality.
 *
 * an armed capture declines everything: the settings modal's own dialog arm
 * already covers the hotkey registrations, but the keys being captured also
 * reach window listeners the hotkey manager does not mediate (use-edit-tools',
 * the reset below), and those must not act on a keystroke meant for a slot */
function viewerClaims(e: KeyboardEvent): boolean {
	if (captureArm.armed) return false;
	if (viewerStore.getState().scene === null) return false;
	return !controlOwnsKeydown(e, focusModality.keyboardFocus);
}

/** the click-residue focus the guard just overruled has no further claim on
 * the keyboard: drop it before acting, or chromium's promote-on-keydown paints
 * the control with a focus ring mid-shortcut and a later enter re-fires it.
 * the structural walk keeps this off plain page targets and off the frames
 * panel's passthrough rows, which keep focus by contract */
function dropClickResidue(e: KeyboardEvent) {
	if (withinInteractiveControl(e.target) && e.target instanceof HTMLElement) e.target.blur();
}

function guarded(e: KeyboardEvent, action: () => void) {
	if (!viewerClaims(e)) return;
	dropClickResidue(e);
	// the app has just claimed this press, so nothing else may also act on it.
	// it matters far more now that any of these can be rebound to a chord: the
	// library-level preventDefault stays off (it fires before this guard could
	// decline, which would swallow a focused button's own space activation),
	// so suppressing it here -- after the claim, never before -- is what keeps
	// a rebound Ctrl+F from seeking *and* opening the webview's find bar
	e.preventDefault();
	action();
}

/** what an edit-mode key asks the store for, or null when it asks for
 * nothing. every gate that is not focus, dialog or scene-loaded
 * (viewerClaims') lives in the resolver, so this is the whole impure half of
 * the read: gather the plain facts and ask */
function editKeybindResolution(hotkey: string): EditKeybindResolution | null {
	const state = viewerStore.getState();
	if (state.scene === null) return null;
	return resolveEditKeybind(
		hotkey,
		{ mode: state.mode, editable: frameEditGate(state.scene).editable, gestureLive: gestureLive.active },
		state.effectiveKeybinds
	);
}

function applyEditKeybind(resolution: EditKeybindResolution) {
	const state = viewerStore.getState();
	if (resolution.kind === "tool") {
		state.setTool(resolution.tool);
		return;
	}
	// the tile's own action, so what a keyboard toggle persists and what a
	// click persists cannot diverge
	state.setEditing("snapToLattice", !state.editing.snapToLattice);
}

/** a stored binding as the library's registration type. its Hotkey union
 * enumerates the key names of the layouts it knows, which a rebinding is not
 * bound by: a cyrillic `М` is a perfectly good hotkey string at runtime, and
 * the whole point of this feature is that the app does not choose the alphabet */
const asHotkey = (hotkey: string) => hotkey as Hotkey;

/** the registrations one action's bindings produce. every branch reads the
 * hotkey it was handed rather than a literal, so a rebinding needs nothing
 * here -- only an action added to the table does */
function registrationsFor(row: EffectiveKeybind, key: string): UseHotkeyDefinition[] {
	const hotkey = asHotkey(key);
	switch (row.action) {
		case "playPause":
			return [
				{
					// holding space must not rapid-toggle, while the arrows below keep
					// key repeat for held-key seeking. e.repeat is filtered here instead
					// of using the library's requireReset: its hasFired flag only resets
					// on a keyup this document receives, so releasing space while
					// alt-tabbed away would swallow the first press after refocus.
					// filtering it is also what lets a hold be a drag: re-arming
					// mid-hold would forget a drag already under way
					hotkey,
					callback: (e) =>
						guarded(e, () => {
							// the repeat filter sits inside the guard, not ahead of it, so
							// a held key stays suppressed for as long as the app owns it:
							// a rebound accelerator would otherwise reach the webview on
							// every repeat after the first
							if (e.repeat) return;
							// keydown arms the viewport's pan drag AND pauses. only the
							// play half of the toggle waits for the keyup, where a
							// space-drag can still suppress it -- pausing cannot wait,
							// because a held key would keep a replay playing and
							// hitsounding for the whole press (see space-pan.ts). the
							// release is not registered here at all: see the keyup
							// listener in the effect below for why the library cannot
							// see it end
							const { playing, setPlaying } = viewerStore.getState();
							spacePan.press(keybindMainKey(key), playing);
							if (playing) setPlaying(false);
						})
				}
			];
		case "seekBack":
			return [
				{ hotkey, callback: (e) => guarded(e, () => playbackClock.seekTo(playbackClock.currentTime() - 1000)) }
			];
		case "seekForward":
			return [
				{ hotkey, callback: (e) => guarded(e, () => playbackClock.seekTo(playbackClock.currentTime() + 1000)) }
			];
		case "frameStepBack":
			return [{ hotkey, callback: (e) => guarded(e, () => stepFrame(-1)) }];
		case "frameStepForward":
			return [{ hotkey, callback: (e) => guarded(e, () => stepFrame(1)) }];
		case "restart":
			return [{ hotkey, callback: (e) => guarded(e, () => playbackClock.seekTo(playbackClock.minTime)) }];
		case "volumeUp":
			return [{ hotkey, callback: (e) => guarded(e, () => nudgeMasterVolume(VOLUME_STEP)) }];
		case "volumeDown":
			return [{ hotkey, callback: (e) => guarded(e, () => nudgeMasterVolume(-VOLUME_STEP)) }];
		default:
			// the tool keys and the snap toggle. registered here rather than in
			// use-edit-tools so they inherit the focus modality rules, the
			// click-residue blur and the scene check the wrapper already applies;
			// what is left of the decision is the resolver's.
			//
			// anything else global reaching this point has no behaviour yet: a
			// new action must add its own case rather than being quietly filed
			// as a sixth edit key
			if (!EDIT_ACTIONS.includes(row.action)) return [];
			return [
				{
					hotkey,
					callback: (e) => {
						// not guarded(): these are the only bindings that routinely
						// decline (watch mode, a non-editable replay), and a key the
						// app ignores must not drop the focus a click left behind --
						// that would make `E` in watch mode reset the user's tab
						// position. resolve first, blur only once something is claimed
						if (!viewerClaims(e)) return;
						const resolution = editKeybindResolution(hotkey);
						if (resolution === null) return;
						dropClickResidue(e);
						// claimed, so nothing else may also act on it -- the rule
						// guarded() applies, held back here until the resolver says
						// the press really was ours. ahead of the repeat filter, so a
						// held rebinding stays suppressed rather than reaching the
						// webview on every repeat after the first
						e.preventDefault();
						// same reason space filters repeats: the tool setter and the
						// snap toggle write unconditionally, so a resting finger would
						// churn the palette (and flip snap back and forth) every repeat
						if (e.repeat) return;
						applyEditKeybind(resolution);
					}
				}
			];
	}
}

/** the global actions this hook must match by hand, because their matcher is
 * the physical key */
const CODE_MATCHED: readonly KeybindAction[] = ["viewportReset"];

/** the global actions registered somewhere else. this hook mounts with
 * AppShell, which exists only once a scene is loaded; the help binding and the
 * open accelerator both have to work on the start screen too, so App registers
 * them (use-help-shortcut.ts, use-open-shortcut.ts) */
const APP_LEVEL: readonly KeybindAction[] = ["showHelp", "openMenu"];

/** the actions this hook registers through the library: every global one
 * matched on its printed character. the code-matched rows cannot be registered
 * at all (the library's registerable hotkey carries no physical code), so they
 * are matched by hand below */
function hotkeyDefinitions(table: readonly EffectiveKeybind[]): UseHotkeyDefinition[] {
	return table
		.filter((row) => row.owner === "global" && row.by === "key" && !APP_LEVEL.includes(row.action))
		.flatMap((row) => row.bindings.flatMap((binding) => registrationsFor(row, binding.hotkey)));
}

export function usePlaybackShortcuts() {
	const table = useViewerStore((s) => s.effectiveKeybinds);
	// the library diffs the array it is handed, so a re-registration on a
	// rebinding needs no manual teardown
	const definitions = useMemo(() => hotkeyDefinitions(table), [table]);

	useHotkeys(
		definitions,
		// @tanstack/hotkeys defaults both preventDefault and stopPropagation to
		// true for every matched registration, applied unconditionally on match
		// -- before requireReset's gate and before our callback ever runs (see
		// hotkey-manager.ts). left at those defaults, a keyboard-focused play
		// button's native space-activation would be suppressed regardless of
		// what guarded() decides, and the event would stop at this document
		// listener before reaching any future window-level handler. both are
		// disabled here so the explicit e.preventDefault() above is the only
		// event-flow mutation this hook makes. ignoreInputs goes too: the
		// library's version drops every input but the button-likes before the
		// callback, which would keep space dead while a slider drag leaves its
		// hidden range input focused, and would swallow the space keyup that
		// disarms the pan -- controlOwnsKeydown covers the text entries that
		// default was protecting
		{ preventDefault: false, stopPropagation: false, ignoreInputs: false }
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
		// prints there -- see KEYBINDS.viewportReset for why `Control+0` cannot
		// express it. the table is read at event time rather than closed over,
		// so a rebinding reaches this listener without re-attaching it.
		// guarded() is the whole gate here, same as for the hotkey
		// registrations now that their ignoreInputs is off. the page-zoom
		// preventDefault stays App.tsx's, app-wide and pinned to the physical
		// ctrl+0 whatever this is bound to
		function onKeyDown(e: KeyboardEvent) {
			const rows = viewerStore.getState().effectiveKeybinds;
			for (const action of CODE_MATCHED) {
				const row = keybindRow(rows, action);
				if (!row.bindings.some((binding) => matchesCodeKeybind(e, binding))) continue;
				guarded(e, () => viewerStore.getState().resetViewport());
				return;
			}
		}
		// the release half of play/pause. a manual listener rather than a keyup
		// registration because the library matches a keyup against the whole
		// chord: `Control+K` let go of ctrl-first delivers the K keyup with
		// ctrlKey already false, so it never matches, and the hold the keydown
		// latched is never seen to end -- the viewport keeps its grab cursor and
		// plain left-drags pan until the window loses focus. the same trap
		// catches the shipped Space when a modifier is touched mid-hold.
		// releasesKeybind asks only whether the main key came up
		function onKeyUp(e: KeyboardEvent) {
			// the key that armed the hold is the only one that can end it: an
			// alternate binding on the same action is a different press, and its
			// release must not drop a pan it never started
			if (!spacePan.heldBy(releasedMainKey(e))) return;
			// the keydown's guard covers most of this: press() ran only if it
			// passed, so a release with nothing armed -- a keyboard-focused
			// button's own space activation, a text field, no loaded scene --
			// has nothing to answer
			const shouldPlay = spacePan.release();
			if (shouldPlay === null) return;
			// but the release can land somewhere the press did not: space armed
			// over the viewer, then a click into a number field before letting go
			// targets this keyup at the field. the latch is already cleared above;
			// the release is discarded so playback does not start behind the field
			// the user just entered. a replay the press paused stays paused, which
			// is the half that already happened and the half nobody minds
			if (controlOwnsKeydown(e, focusModality.keyboardFocus)) return;
			// an absolute state, not a toggle: the press already moved playback,
			// so toggling again here would undo the pause it just performed
			const { playing, setPlaying } = viewerStore.getState();
			if (playing !== shouldPlay) setPlaying(shouldPlay);
		}
		// passive: the viewer layout never scrolls, so default is never prevented
		// here. ctrl+wheel is the one wheel gesture that does need a
		// preventDefault (the webview's own page zoom), and wheelFrameStep bails
		// on it -- App.tsx suppresses it app-wide with a non-passive listener
		window.addEventListener("wheel", onWheel, { passive: true });
		window.addEventListener("keydown", onKeyDown);
		window.addEventListener("keyup", onKeyUp);
		return () => {
			window.removeEventListener("wheel", onWheel);
			window.removeEventListener("keydown", onKeyDown);
			window.removeEventListener("keyup", onKeyUp);
		};
	}, []);
}
