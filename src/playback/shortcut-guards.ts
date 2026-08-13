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
 * focus would be exactly backwards */
const SHORTCUT_PASSTHROUGH_ATTR = "data-shortcut-passthrough";

function asGuardElement(target: unknown): GuardElement | null {
	if (typeof target !== "object" || target === null) return null;
	const candidate = target as Partial<GuardElement>;
	if (typeof candidate.tagName !== "string" || typeof candidate.getAttribute !== "function") return null;
	return candidate as GuardElement;
}

/** true when the event target sits inside an interactive control: a focused
 * button must keep space activation, a slider thumb its arrow keys, a dialog
 * its own keyboard handling. an element marked `data-shortcut-passthrough`
 * declines the guard for itself and its subtree; the innermost declaration
 * wins either way, so a real control nested inside a passthrough element is
 * still guarded */
export function withinInteractiveControl(target: unknown): boolean {
	for (let element = asGuardElement(target); element !== null; element = element.parentElement) {
		if (element.getAttribute(SHORTCUT_PASSTHROUGH_ATTR) !== null) return false;
		if (INTERACTIVE_TAGS.has(element.tagName)) return true;
		const role = element.getAttribute("role");
		if (role !== null && INTERACTIVE_ROLES.has(role)) return true;
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
 * instead of frame-stepping */
export function withinNativeWheelUi(target: unknown): boolean {
	for (let element = asGuardElement(target); element !== null; element = element.parentElement) {
		if (element.getAttribute("role") === "dialog") return true;
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

/** true when a keydown is the viewport reset chord. the one predicate both
 * sides read: App.tsx suppresses the webview's page-zoom reset with it and
 * the shortcut hook acts on it, so what the app swallows and what it acts on
 * cannot drift apart.
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
export function asksViewportReset(e: { ctrlKey: boolean; altKey: boolean; code: string; key: string }): boolean {
	if (!e.ctrlKey || e.altKey) return false;
	return e.code === "Digit0" || (e.code === "Numpad0" && e.key === "0");
}
