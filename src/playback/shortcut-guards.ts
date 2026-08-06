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

function asGuardElement(target: unknown): GuardElement | null {
	if (typeof target !== "object" || target === null) return null;
	const candidate = target as Partial<GuardElement>;
	if (typeof candidate.tagName !== "string" || typeof candidate.getAttribute !== "function") return null;
	return candidate as GuardElement;
}

/** true when the event target sits inside an interactive control: a focused
 * button must keep space activation, a slider thumb its arrow keys, a dialog
 * its own keyboard handling */
export function withinInteractiveControl(target: unknown): boolean {
	for (let element = asGuardElement(target); element !== null; element = element.parentElement) {
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
