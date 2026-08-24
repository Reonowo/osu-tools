// pure target predicates for the playback shortcut and wheel handlers. they
// walk parentElement chains against a structural element shape instead of
// Element.closest so bun tests can exercise them headlessly with plain
// object trees (no dom registration in the test runner)

/** the structural subset of Element the guards need; real dom elements
 * satisfy it and tests build plain-object trees */
export interface GuardElement {
	tagName: string;
	getAttribute(name: string): string | null;
	parentElement: GuardElement | null;
}

const INTERACTIVE_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT", "BUTTON"]);
const INTERACTIVE_ROLES = new Set(["slider", "dialog"]);
const NATIVE_WHEEL_SLOTS = new Set(["popover-content", "scroll-area-viewport", "dialog-overlay"]);

/** the opt-out an element carries when it is an interactive tag only so it can
 * be clicked and tab-reached, and none of its own keys collide with the
 * playback shortcuts: the frames panel's rows (FramesPanel.tsx), where a
 * click focuses the row and suppressing the shortcuts for as long as it holds
 * focus would be exactly backwards. the keyboard guard honours it under
 * either focus modality -- stepping with `,` `.` while walking the rows is
 * the point of the rows, tab-focused or clicked */
const SHORTCUT_PASSTHROUGH_ATTR = "data-shortcut-passthrough";

function asGuardElement(target: unknown): GuardElement | null {
	if (typeof target !== "object" || target === null) return null;
	const candidate = target as Partial<GuardElement>;
	if (typeof candidate.tagName !== "string" || typeof candidate.getAttribute !== "function") return null;
	return candidate as GuardElement;
}

/** true when the event target sits inside an interactive control. this is
 * the pointer-path guard (use-edit-tools' gestures): a press on a button is
 * that button's click whatever holds focus, so it stays structural with no
 * modality in it. keydown guarding lives in controlOwnsKeydown. an element
 * marked `data-shortcut-passthrough` declines the guard for itself and its
 * subtree; the innermost declaration wins either way, so a real control
 * nested inside a passthrough element is still guarded */
export function withinInteractiveControl(target: unknown): boolean {
	for (let element = asGuardElement(target); element !== null; element = element.parentElement) {
		if (element.getAttribute(SHORTCUT_PASSTHROUGH_ATTR) !== null) return false;
		if (INTERACTIVE_TAGS.has(element.tagName)) return true;
		const role = element.getAttribute("role");
		if (role !== null && INTERACTIVE_ROLES.has(role)) return true;
	}
	return false;
}

/** the keys a roving-focus composite or a slider consumes for its own
 * navigation, whatever put focus on it. exported because these are also the
 * keys (with Tab) that move focus, which is what focus-modality.ts watches */
export const NAV_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"]);
const NAV_OWNING_ROLES = new Set(["tab", "tablist", "slider"]);
const NAV_OWNING_SLOTS = new Set(["toggle-group"]);

/** text entry and modal surfaces own every key under any focus modality: a
 * click into a text field is still typing, and a dialog's keys never leak to
 * the viewer behind it. inputs are text-like except the sliders' hidden
 * range input, which owns only its nav keys (below). an open menu popup is a
 * modal surface too: the arrows walk it, enter and space confirm, characters
 * typeahead -- letting any of those also seek, toggle playback or arm a tool
 * would give the menu a side effect per keystroke */
function ownsEveryKey(element: GuardElement): boolean {
	if (element.tagName === "TEXTAREA" || element.tagName === "SELECT") return true;
	if (element.tagName === "INPUT" && element.getAttribute("type") !== "range") return true;
	const editable = element.getAttribute("contenteditable");
	if (editable !== null && editable !== "false") return true;
	const role = element.getAttribute("role");
	return role === "dialog" || role === "menu";
}

function ownsNavKeys(element: GuardElement, role: string | null): boolean {
	// only the range input reaches here; text-likes returned in ownsEveryKey
	if (element.tagName === "INPUT") return true;
	if (role !== null && NAV_OWNING_ROLES.has(role)) return true;
	const slot = element.getAttribute("data-slot");
	return slot !== null && NAV_OWNING_SLOTS.has(slot);
}

/** true when a keydown is an accelerator rather than a key a control natively
 * answers to. no control's own keys carry ctrl, alt or meta -- a button
 * activates on space and enter, a slider moves on the arrows -- so a chord can
 * never be the focused control's to consume, however it acquired focus. shift
 * is deliberately not one of these: shift+space still activates a button */
function isAccelerator(e: { ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean }): boolean {
	return e.ctrlKey === true || e.altKey === true || e.metaKey === true;
}

/** true when a keydown belongs to the control holding focus rather than to
 * the viewer's shortcuts. focus modality is the pivot: keyboard-acquired
 * focus (tabbing, composite arrow roving) keeps every native key so a
 * keyboard user can still space-activate the button they tabbed to, while
 * the residue focus a mouse click leaves behind hands the keys back --
 * otherwise space after clicking the zoom reset re-fires the reset instead
 * of panning, and the same for every control in the chrome.
 *
 * keyboardFocus is a parameter, recorded at focus-acquisition time by
 * focus-modality.ts, because the obvious signal is a trap: chromium promotes
 * the focused element to :focus-visible on any keydown -- including the very
 * space press being reclaimed -- so reading the pseudo-class from inside a
 * key handler always answers "keyboard" for the click-focused button this
 * predicate exists to expose. there is exactly one focus per document, so a
 * single boolean covers the walk; it only ever decides for the target
 * itself, since ancestors of the focused element were not focused.
 *
 * an accelerator is exempt from that arm whatever the modality: a focused
 * button answers to space and enter, never to a ctrl/alt/meta chord, so
 * handing it one would take an app-wide key away for as long as some button
 * happened to hold focus. Ctrl+O is where that bites in practice -- closing
 * the open menu returns focus to its own trigger, and without this the same
 * chord that opened it could not reopen it.
 *
 * two things modality never unlocks: text entry and dialogs (ownsEveryKey),
 * and the nav keys of a click-focused composite or slider (ownsNavKeys) --
 * the tab rail and the toggle groups act on arrows through their own
 * element-level roving handlers, upstream of this document-level guard, so
 * seeking on those same keydowns would switch tab and scrub on one keystroke.
 * both still hold for accelerators: a text field keeps its Ctrl+A, and a
 * focused slider keeps Alt+Arrow */
export function controlOwnsKeydown(
	e: { key: string; target: unknown; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean },
	keyboardFocus: boolean
): boolean {
	const navKey = NAV_KEYS.has(e.key);
	const accelerator = isAccelerator(e);
	for (let element = asGuardElement(e.target); element !== null; element = element.parentElement) {
		if (element.getAttribute(SHORTCUT_PASSTHROUGH_ATTR) !== null) return false;
		if (ownsEveryKey(element)) return true;
		const role = element.getAttribute("role");
		if (
			keyboardFocus &&
			!accelerator &&
			(element.tagName === "BUTTON" || element.tagName === "INPUT" || role === "slider")
		) {
			return true;
		}
		if (navKey && ownsNavKeys(element, role)) return true;
	}
	return false;
}

/** true when the target sits inside a dialog (base-ui gives its popovers the
 * same role, which is right here too). the click-residue blur consults this:
 * inside a modal, focus falling to the body would put the keydown target
 * outside the dialog subtree and controlOwnsKeydown's dialog arm with it,
 * letting space toggle playback behind an open modal */
export function withinDialog(target: unknown): boolean {
	for (let element = asGuardElement(target); element !== null; element = element.parentElement) {
		if (element.getAttribute("role") === "dialog") return true;
	}
	return false;
}

/** the marker the viewport's floating chrome containers carry (tool palette,
 * zoom cluster, coordinate readout) so pointer gestures ignore presses
 * anywhere on them: their padding, separators, and readouts are divs and
 * spans no interactive-control walk would catch, and a gesture started there
 * would edit whatever frame the chrome happens to obscure */
export const VIEWPORT_CHROME_ATTR = "data-viewport-chrome";

/** true when the event target sits inside floating viewport chrome; the
 * whole container is the chrome's, controls and whitespace alike */
export function withinViewportChrome(target: unknown): boolean {
	for (let element = asGuardElement(target); element !== null; element = element.parentElement) {
		if (element.getAttribute(VIEWPORT_CHROME_ATTR) !== null) return true;
	}
	return false;
}

/** true when the event target sits inside scrollable ui (settings dialog,
 * info panel, popovers) where the wheel keeps its native scroll behaviour
 * instead of frame-stepping. a menu popup joins the dialogs: the context
 * menu sits at the pointer, so a wheel straight after right-click would
 * otherwise scrub the replay from the menu's own surface */
export function withinNativeWheelUi(target: unknown): boolean {
	for (let element = asGuardElement(target); element !== null; element = element.parentElement) {
		const role = element.getAttribute("role");
		if (role === "dialog" || role === "menu") return true;
		if (element.getAttribute("data-native-wheel") !== null) return true;
		const slot = element.getAttribute("data-slot");
		if (slot !== null && NATIVE_WHEEL_SLOTS.has(slot)) return true;
	}
	return false;
}

/** the frame step a wheel event asks for, or null when it asks for none: a
 * purely horizontal wheel carries no direction, ctrl+wheel is zoom wherever
 * it lands (the viewport's pointer-anchored zoom, the timeline dock's span
 * zoom -- neither may have the replay scrubbed out from under it by the
 * same gesture), and scrollable ui keeps its native scroll. one frame per
 * event whatever the delta magnitude -- no accumulation */
export function wheelFrameStep(e: { deltaY: number; ctrlKey: boolean; target: unknown }): 1 | -1 | null {
	if (e.deltaY === 0) return null;
	if (e.ctrlKey) return null;
	if (withinNativeWheelUi(e.target)) return null;
	return e.deltaY < 0 ? -1 : 1;
}

/** true when a keydown is the chord the webview would reset its page zoom on.
 * App.tsx swallows it app-wide, unconditionally, because nothing in this app
 * is ever meant to resize that way.
 *
 * deliberately pinned to the physical ctrl+0 rather than to whatever the
 * viewport reset is bound to: the gesture belongs to the webview, not to the
 * user's binding, so rebinding the reset must neither stop this suppressing
 * ctrl+0 nor start it suppressing some other chord. one predicate served both
 * sides while the reset was hardcoded here; matchesCodeKeybind (keybinds.ts)
 * is what the viewer's own reset reads now.
 *
 * the top row goes by code, not key -- the physical zero is ctrl+0 whatever
 * character the layout prints there. an azerty zero is `à` unshifted and "0"
 * only with shift, so a key test misses it either way, and @tanstack/hotkeys
 * cannot express this: its `Control+0` demands shift be up, and for the
 * unshifted azerty press it trusts `à` as a letter and never reaches its own
 * Digit-code fallback. alt is excluded even so -- chromium reports altgr as
 * ctrl+alt, and altgr+0 is `}` on the german-family layouts, which this would
 * otherwise stop those users typing anywhere in the app. the numpad arm does
 * ask for the key, since with numlock off that same code is Insert:
 * ctrl+insert is copy, and the webview never zoomed on it */
export function asksPageZoomReset(e: { ctrlKey: boolean; altKey: boolean; code: string; key: string }): boolean {
	if (!e.ctrlKey || e.altKey) return false;
	return e.code === "Digit0" || (e.code === "Numpad0" && e.key === "0");
}
