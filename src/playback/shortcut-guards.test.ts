import { describe, expect, test } from "bun:test";
import {
	asksPageZoomReset,
	controlOwnsKeydown,
	wheelFrameStep,
	withinDialog,
	withinInteractiveControl,
	withinNativeWheelUi,
	withinViewportChrome,
	type GuardElement
} from "./shortcut-guards";

function el(tagName: string, attrs: Record<string, string> = {}, parent: GuardElement | null = null): GuardElement {
	return {
		tagName: tagName.toUpperCase(),
		getAttribute: (name: string) => attrs[name] ?? null,
		parentElement: parent
	};
}

describe("withinInteractiveControl", () => {
	test("blocks interactive tags themselves", () => {
		for (const tag of ["input", "textarea", "select", "button"]) {
			expect(withinInteractiveControl(el(tag))).toBe(true);
		}
	});

	test("blocks descendants of interactive controls", () => {
		const icon = el("svg", {}, el("button"));
		expect(withinInteractiveControl(icon)).toBe(true);
	});

	test("blocks slider thumbs and dialog content by role", () => {
		expect(withinInteractiveControl(el("div", { role: "slider" }))).toBe(true);
		expect(withinInteractiveControl(el("span", {}, el("div", { role: "dialog" })))).toBe(true);
	});

	test("allows an element that opts out, and its subtree", () => {
		// the frames panel's rows: buttons for clicking and tab-reachability
		// only, so `,` `.` space arrows home must keep firing while one of them
		// holds the focus a click just gave it
		const row = el("button", { "data-shortcut-passthrough": "" });
		expect(withinInteractiveControl(row)).toBe(false);
		expect(withinInteractiveControl(el("span", {}, row))).toBe(false);
	});

	test("still blocks a real control nested inside an opt-out", () => {
		// innermost declaration wins: the walk reaches the input first
		const input = el("input", {}, el("div", { "data-shortcut-passthrough": "" }));
		expect(withinInteractiveControl(input)).toBe(true);
	});

	test("allows plain page targets", () => {
		expect(withinInteractiveControl(el("span", {}, el("div", {}, el("body"))))).toBe(false);
		expect(withinInteractiveControl(el("canvas"))).toBe(false);
	});

	test("allows null and non-element targets like window", () => {
		expect(withinInteractiveControl(null)).toBe(false);
		expect(withinInteractiveControl({})).toBe(false);
	});
});

describe("controlOwnsKeydown", () => {
	// the second parameter is the focus-modality stamp (focus-modality.ts):
	// false is the residue focus of a click, true is keyboard-acquired focus
	const clickFocused = (target: unknown, key: string) => controlOwnsKeydown({ key, target }, false);
	const keyboardFocused = (target: unknown, key: string) => controlOwnsKeydown({ key, target }, true);

	test("a click-focused button hands every bound key back to the viewer", () => {
		// the reported bug: click the zoom reset, hold space to pan, and the
		// reset fires again instead. the residue focus of a click owns nothing
		const button = el("button");
		for (const key of [" ", ",", ".", "ArrowLeft", "ArrowRight", "Home", "0", "Delete", "Escape"]) {
			expect(clickFocused(button, key)).toBe(false);
		}
	});

	test("a keyboard-focused button keeps its native keys", () => {
		// tabbing to a control is a statement of intent a click is not: space
		// and enter must activate what the focus ring is on
		const button = el("button");
		expect(keyboardFocused(button, " ")).toBe(true);
		expect(keyboardFocused(button, "ArrowLeft")).toBe(true);
		expect(keyboardFocused(button, ",")).toBe(true);
	});

	test("a keyboard-focused button does not swallow an accelerator", () => {
		// the reported symptom: Ctrl+O opens the menu, Escape closes it and hands
		// focus back to its own trigger, and the same chord could not reopen it.
		// no control's native keys carry ctrl/alt/meta, so a chord is never the
		// focused button's to consume -- while space and enter still are
		const button = el("button");
		const chord = (key: string, mods: Record<string, boolean>) =>
			controlOwnsKeydown({ key, target: button, ...mods }, true);
		expect(chord("o", { ctrlKey: true })).toBe(false);
		expect(chord("o", { metaKey: true })).toBe(false);
		expect(chord("ArrowUp", { altKey: true })).toBe(false);
		// shift is not an accelerator: shift+space still activates a button
		expect(chord(" ", { shiftKey: true })).toBe(true);
		expect(keyboardFocused(button, " ")).toBe(true);
	});

	test("an accelerator still belongs to a text entry, a dialog, and a focused slider", () => {
		// the exemption is only for the modality arm: Ctrl+A in a field is the
		// field's selection, a modal keeps every key behind it, and a slider's
		// arrows stay its own however they are modified
		expect(controlOwnsKeydown({ key: "a", target: el("input"), ctrlKey: true }, true)).toBe(true);
		expect(
			controlOwnsKeydown(
				{ key: "o", target: el("button", {}, el("div", { role: "dialog" })), ctrlKey: true },
				true
			)
		).toBe(true);
		expect(controlOwnsKeydown({ key: "ArrowUp", target: el("div", { role: "slider" }), altKey: true }, true)).toBe(
			true
		);
	});

	test("text entries own every key under either modality", () => {
		for (const target of [el("input"), el("input", { type: "text" }), el("textarea"), el("select")]) {
			expect(clickFocused(target, " ")).toBe(true);
			expect(clickFocused(target, ",")).toBe(true);
			expect(clickFocused(target, "ArrowLeft")).toBe(true);
			expect(clickFocused(target, "Backspace")).toBe(true);
		}
		expect(clickFocused(el("div", { contenteditable: "" }), " ")).toBe(true);
		expect(clickFocused(el("div", { contenteditable: "false" }), " ")).toBe(false);
	});

	test("a click-focused slider keeps its nav keys but yields space", () => {
		// the slider's hidden range input holds focus after a drag; arrows and
		// home still nudge the thumb through its own handler, so seeking on the
		// same keydown would double-fire -- but space is not a slider key
		for (const thumb of [el("input", { type: "range" }), el("div", { role: "slider" })]) {
			expect(clickFocused(thumb, "ArrowLeft")).toBe(true);
			expect(clickFocused(thumb, "Home")).toBe(true);
			expect(clickFocused(thumb, " ")).toBe(false);
			expect(clickFocused(thumb, ".")).toBe(false);
		}
		expect(keyboardFocused(el("input", { type: "range" }), " ")).toBe(true);
	});

	test("click-focused composites keep the arrows their roving handlers act on", () => {
		// the tab rail (role=tab) and the toggle groups act on arrows at the
		// element itself, upstream of the document-level shortcuts: acting here
		// too would switch tab and seek on one keystroke
		const railTab = el("button", { role: "tab" });
		const paletteTool = el("button", {}, el("div", { "data-slot": "toggle-group" }));
		for (const member of [railTab, paletteTool]) {
			expect(clickFocused(member, "ArrowLeft")).toBe(true);
			expect(clickFocused(member, "ArrowUp")).toBe(true);
			expect(clickFocused(member, "Home")).toBe(true);
			expect(clickFocused(member, " ")).toBe(false);
			expect(clickFocused(member, ".")).toBe(false);
		}
	});

	test("a dialog owns everything, even over a click-focused button inside it", () => {
		// space on a settings-dialog button must never toggle playback behind
		// the modal; the walk continues past the undecided button to the dialog
		const dialogButton = el("button", {}, el("div", { role: "dialog" }));
		expect(clickFocused(dialogButton, " ")).toBe(true);
		expect(clickFocused(dialogButton, "Escape")).toBe(true);
	});

	test("the passthrough opt-out wins under either modality", () => {
		// the frames panel's rows: stepping with `,` `.` while walking the rows
		// is what the rows are for, tab-focused or clicked
		const row = el("button", { "data-shortcut-passthrough": "" });
		expect(clickFocused(row, " ")).toBe(false);
		expect(keyboardFocused(row, " ")).toBe(false);
		expect(keyboardFocused(row, "ArrowLeft")).toBe(false);
	});

	test("a real control nested inside an opt-out still owns its keys", () => {
		const input = el("input", {}, el("div", { "data-shortcut-passthrough": "" }));
		expect(clickFocused(input, " ")).toBe(true);
	});

	test("null and non-element targets own nothing", () => {
		expect(clickFocused(null, " ")).toBe(false);
		expect(clickFocused({}, " ")).toBe(false);
		expect(keyboardFocused(null, " ")).toBe(false);
	});
});

describe("withinDialog", () => {
	test("finds a dialog anywhere up the chain", () => {
		expect(withinDialog(el("div", { role: "dialog" }))).toBe(true);
		expect(withinDialog(el("button", {}, el("div", {}, el("div", { role: "dialog" }))))).toBe(true);
	});

	test("plain chrome and page targets are outside", () => {
		expect(withinDialog(el("button", {}, el("nav")))).toBe(false);
		expect(withinDialog(null)).toBe(false);
		expect(withinDialog({})).toBe(false);
	});
});

describe("withinViewportChrome", () => {
	test("blocks the marked chrome container itself and everything inside it", () => {
		const chrome = el("div", { "data-viewport-chrome": "" });
		expect(withinViewportChrome(chrome)).toBe(true);
		// padding and separators are plain divs/spans: the whole subtree is
		// the chrome's, whitespace included
		expect(withinViewportChrome(el("span", {}, el("div", {}, chrome)))).toBe(true);
	});

	test("allows the plain viewport surface", () => {
		expect(withinViewportChrome(el("div", {}, el("div")))).toBe(false);
		expect(withinViewportChrome(null)).toBe(false);
	});
});

describe("withinNativeWheelUi", () => {
	test("keeps native wheel inside dialogs", () => {
		expect(withinNativeWheelUi(el("label", {}, el("div", { role: "dialog" })))).toBe(true);
		expect(withinNativeWheelUi(el("div", { "data-slot": "dialog-overlay" }))).toBe(true);
	});

	test("keeps native wheel inside popovers and scroll areas", () => {
		expect(withinNativeWheelUi(el("p", {}, el("div", { "data-slot": "popover-content" })))).toBe(true);
		expect(withinNativeWheelUi(el("div", {}, el("div", { "data-slot": "scroll-area-viewport" })))).toBe(true);
	});

	test("keeps native wheel inside explicitly marked ui like the info panel", () => {
		const aside = el("aside", { "data-native-wheel": "" });
		expect(withinNativeWheelUi(el("dd", {}, el("dl", {}, aside)))).toBe(true);
	});

	test("steps frames everywhere else", () => {
		expect(withinNativeWheelUi(el("canvas"))).toBe(false);
		expect(withinNativeWheelUi(el("button", {}, el("footer")))).toBe(false);
		expect(withinNativeWheelUi(null)).toBe(false);
		expect(withinNativeWheelUi({})).toBe(false);
	});
});

describe("wheelFrameStep", () => {
	const canvas = el("canvas");
	// the two timeline tiers as the guard walk sees them: plain divs with no
	// native-wheel opt-out anywhere up the chain -- the detail lanes lost
	// theirs when their span zoom moved to ctrl+wheel, so one wheel gesture
	// means one thing over the whole dock
	const overviewStrip = el("div", {}, el("div", {}, el("div")));
	const detailLane = el("div", { "data-hold-lane": "k1" }, el("div", {}, el("div")));

	test("one frame per event, in the wheel's direction, whatever the magnitude", () => {
		expect(wheelFrameStep({ deltaY: -1, ctrlKey: false, target: canvas })).toBe(-1);
		expect(wheelFrameStep({ deltaY: -4000, ctrlKey: false, target: canvas })).toBe(-1);
		expect(wheelFrameStep({ deltaY: 0.5, ctrlKey: false, target: canvas })).toBe(1);
		expect(wheelFrameStep({ deltaY: 4000, ctrlKey: false, target: canvas })).toBe(1);
	});

	test("plain wheel frame-steps over both timeline tiers, same as over the viewport", () => {
		expect(wheelFrameStep({ deltaY: 100, ctrlKey: false, target: overviewStrip })).toBe(1);
		expect(wheelFrameStep({ deltaY: -100, ctrlKey: false, target: overviewStrip })).toBe(-1);
		expect(wheelFrameStep({ deltaY: 100, ctrlKey: false, target: detailLane })).toBe(1);
		expect(wheelFrameStep({ deltaY: -100, ctrlKey: false, target: detailLane })).toBe(-1);
	});

	test("a purely horizontal wheel steps nothing", () => {
		expect(wheelFrameStep({ deltaY: 0, ctrlKey: false, target: canvas })).toBeNull();
	});

	test("ctrl+wheel steps nothing anywhere -- it is zoom, wherever it lands", () => {
		// the viewport's pointer-anchored zoom and the timeline dock's span
		// zoom (detailSpanForWheel) both ride ctrl+wheel, and neither may have
		// the replay scrubbed out from under it by the same gesture
		expect(wheelFrameStep({ deltaY: -100, ctrlKey: true, target: canvas })).toBeNull();
		expect(wheelFrameStep({ deltaY: 100, ctrlKey: true, target: canvas })).toBeNull();
		expect(wheelFrameStep({ deltaY: 100, ctrlKey: true, target: overviewStrip })).toBeNull();
		expect(wheelFrameStep({ deltaY: 100, ctrlKey: true, target: detailLane })).toBeNull();
	});

	test("scrollable ui keeps its native scroll", () => {
		const inDialog = el("div", {}, el("div", { role: "dialog" }));
		expect(wheelFrameStep({ deltaY: 100, ctrlKey: false, target: inDialog })).toBeNull();
		// the side panels' scrollable bodies stay opted out too
		const inPanelBody = el("dd", {}, el("div", { "data-native-wheel": "" }));
		expect(wheelFrameStep({ deltaY: 100, ctrlKey: false, target: inPanelBody })).toBeNull();
	});
});

describe("asksPageZoomReset", () => {
	// what each layout actually delivers for a press of the physical top-row
	// zero, which is the key the webview resets page zoom from. these carry the
	// shift state the browser would report even though the predicate's own
	// parameter type does not name it: going by code is exactly what makes the
	// chord blind to shift, and these three are what that blindness buys
	const qwerty = { ctrlKey: true, altKey: false, shiftKey: false, code: "Digit0", key: "0" };
	// french/belgian azerty print `à` there and reach "0" only through shift,
	// so both of these are one user pressing "ctrl and the zero key"
	const azertyUnshifted = { ctrlKey: true, altKey: false, shiftKey: false, code: "Digit0", key: "à" };
	const azertyShifted = { ctrlKey: true, altKey: false, shiftKey: true, code: "Digit0", key: "0" };

	test("the physical top-row zero resets whatever character the layout prints", () => {
		expect(asksPageZoomReset(qwerty)).toBe(true);
		expect(asksPageZoomReset(azertyUnshifted)).toBe(true);
		expect(asksPageZoomReset(azertyShifted)).toBe(true);
	});

	test("the numpad zero resets only with numlock on", () => {
		expect(asksPageZoomReset({ ctrlKey: true, altKey: false, code: "Numpad0", key: "0" })).toBe(true);
		// numlock off makes that same code Insert, and ctrl+insert is copy
		expect(asksPageZoomReset({ ctrlKey: true, altKey: false, code: "Numpad0", key: "Insert" })).toBe(false);
	});

	test("altgr is left alone so the german-family layouts can still type `}`", () => {
		// chromium reports altgr as ctrl+alt
		expect(asksPageZoomReset({ ctrlKey: true, altKey: true, code: "Digit0", key: "}" })).toBe(false);
	});

	test("a plain zero and other ctrl chords ask for nothing", () => {
		expect(asksPageZoomReset({ ctrlKey: false, altKey: false, code: "Digit0", key: "0" })).toBe(false);
		expect(asksPageZoomReset({ ctrlKey: true, altKey: false, code: "Digit9", key: "9" })).toBe(false);
		expect(asksPageZoomReset({ ctrlKey: true, altKey: false, code: "KeyO", key: "o" })).toBe(false);
	});

	test("the suppression stays on ctrl+0 whatever the viewport reset is bound to", () => {
		// it is the webview's gesture, not the user's binding: rebinding the
		// reset must neither stop this swallowing ctrl+0 nor start it swallowing
		// something else. this predicate takes no binding at all, which is the
		// shape of that guarantee
		const rebound = { ctrlKey: true, altKey: false, code: "KeyR", key: "r" };
		expect(asksPageZoomReset(rebound)).toBe(false);
		expect(asksPageZoomReset(qwerty)).toBe(true);
	});
});
