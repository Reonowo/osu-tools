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
 * purely horizontal wheel carries no direction, ctrl+wheel is the viewport's
 * pointer-anchored zoom (which must not also scrub the replay out from under
 * it), and scrollable ui keeps its native scroll. one frame per event
 * whatever the delta magnitude -- no accumulation */
export function wheelFrameStep(e: { deltaY: number; ctrlKey: boolean; target: unknown }): 1 | -1 | null {
	if (e.deltaY === 0) return null;
	if (e.ctrlKey) return null;
	if (withinNativeWheelUi(e.target)) return null;
	return e.deltaY < 0 ? -1 : 1;
}
