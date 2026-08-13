// which input modality gave the currently focused element its focus. the
// keyboard guard (shortcut-guards.ts's controlOwnsKeydown) pivots on this,
// and it cannot read :focus-visible for it: chromium promotes the focused
// element to :focus-visible on any keydown -- including the very space press
// the shortcuts are reclaiming from a click-focused button -- so the
// pseudo-class always answers "keyboard" by the time a key handler asks.
// modality has to be recorded when focus is *acquired* instead, which is
// what this scrap of state does: pointer presses and focus-moving keys each
// stamp the last input, and every focus arrival snapshots that stamp. the
// same scheme covers programmatic refocus for free -- a dialog closed by
// mouse click restores its trigger under the pointer stamp that click left,
// so the trigger's keys go back to the viewer instead of reopening it

import { withinDialog, withinInteractiveControl, NAV_KEYS } from "./shortcut-guards";

export class FocusModality {
	private lastInputWasPointer = false;
	private focusFromPointer = false;

	/** true when the currently focused element acquired focus from the
	 * keyboard. the initial state reads keyboard so that focus placed before
	 * any input at all (an autofocus) conservatively keeps its native keys */
	get keyboardFocus(): boolean {
		return !this.focusFromPointer;
	}

	pointerDown(): void {
		this.lastInputWasPointer = true;
	}

	/** only focus-moving keys re-stamp the modality: tab, the nav keys a
	 * roving composite moves focus with, and escape, whose dialog dismissal
	 * restores focus to the trigger -- that restore was keyboard-driven, so
	 * space must activate the visibly focused trigger rather than fall to
	 * the viewer under the stale stamp of the click that opened the dialog.
	 * a printable key or space held over a click-focused control moved
	 * nothing and must not launder that click into keyboard focus -- that
	 * would recreate the chromium promotion this module exists to avoid */
	keyDown(key: string): void {
		if (key === "Tab" || key === "Escape" || NAV_KEYS.has(key)) this.lastInputWasPointer = false;
	}

	/** call on focusin. the stamp is read here and nowhere else, so a nav
	 * keydown that moved no focus changes nothing until focus actually moves */
	focusChanged(): void {
		this.focusFromPointer = this.lastInputWasPointer;
	}
}

/** app-wide, alongside spacePan and playbackClock */
export const focusModality = new FocusModality();

/** the thin dom shell: capture-phase listeners so the stamps land before any
 * element-level handler (a composite's roving) moves focus in response to
 * the same event. installed once from App.tsx.
 *
 * the click listener is the modality's enforcement arm, and it exists
 * because the document-level guard cannot reach everything: base-ui's
 * composite items (the rail's tabs, every toggle-group item) dispatch their
 * click synchronously on space *keydown*, at the element itself
 * (useButton.mjs), upstream of any document-level handler -- so a rail tab
 * left click-focused re-toggles its panel the moment space goes down,
 * whatever controlOwnsKeydown would have said. the fix is for pointer
 * clicks to leave no residue focus at all: after a click lands on a
 * button-tag control under pointer modality, the control is blurred, so
 * there is nothing for any element-level key handler to fire on. keyboard
 * activations (synthesized clicks under keyboard modality) keep their
 * focus, as do passthrough elements (the frames panel's rows re-focus
 * themselves on activation by contract -- withinInteractiveControl declines
 * them) and anything inside a dialog (blurring inside a modal would drop
 * focus to the body, outside the dialog subtree the keyboard guard's
 * dialog arm walks, letting space reach the viewer behind the modal) */
export function installFocusModality(target: Window): () => void {
	const onPointerDown = (e: PointerEvent) => {
		focusModality.pointerDown();
		// a press on the element that already holds focus moves nothing, so no
		// focusin will re-snapshot the stamp: re-stamp here, or tabbing to a
		// control and then clicking it would leave it counted as keyboard focus
		const active = target.document.activeElement;
		if (
			active instanceof HTMLElement &&
			active !== target.document.body &&
			e.target instanceof Node &&
			active.contains(e.target)
		) {
			focusModality.focusChanged();
		}
	};
	const onKeyDown = (e: KeyboardEvent) => focusModality.keyDown(e.key);
	const onFocusIn = () => focusModality.focusChanged();
	// bubble-phase and window-level: runs after react's own handlers at the
	// root, so the click's work (a rail tab's togglePanel, a tool selection)
	// is done before the control loses focus
	const onClick = (e: MouseEvent) => {
		if (focusModality.keyboardFocus) return;
		const active = target.document.activeElement;
		if (!(active instanceof HTMLElement) || active.tagName !== "BUTTON") return;
		if (!(e.target instanceof Node) || !active.contains(e.target)) return;
		if (!withinInteractiveControl(active) || withinDialog(active)) return;
		active.blur();
	};
	// the click listener never sees a press that fails to complete: a
	// pointerup off the control retargets the click to the common ancestor,
	// a pointercancel dispatches no click at all, and a secondary-button
	// release produces contextmenu/auxclick instead -- any of these would
	// leave the button pointer-focused, and the next space both fires
	// base-ui's element-level composite click and arms playback. same
	// eligibility as the click arm; only an in-bounds primary-button
	// pointerup (touch and pen tips report button 0 too) is a click in
	// flight and stays the click listener's to resolve
	const onPointerRelease = (e: PointerEvent) => {
		if (focusModality.keyboardFocus) return;
		const active = target.document.activeElement;
		if (!(active instanceof HTMLElement) || active.tagName !== "BUTTON") return;
		if (e.type === "pointerup" && e.button === 0 && e.target instanceof Node && active.contains(e.target)) {
			return;
		}
		if (!withinInteractiveControl(active) || withinDialog(active)) return;
		active.blur();
	};
	target.addEventListener("pointerdown", onPointerDown, true);
	target.addEventListener("keydown", onKeyDown, true);
	target.addEventListener("focusin", onFocusIn, true);
	target.addEventListener("click", onClick);
	target.addEventListener("pointerup", onPointerRelease);
	target.addEventListener("pointercancel", onPointerRelease);
	return () => {
		target.removeEventListener("pointerdown", onPointerDown, true);
		target.removeEventListener("keydown", onKeyDown, true);
		target.removeEventListener("focusin", onFocusIn, true);
		target.removeEventListener("click", onClick);
		target.removeEventListener("pointerup", onPointerRelease);
		target.removeEventListener("pointercancel", onPointerRelease);
	};
}
