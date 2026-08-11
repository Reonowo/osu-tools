import { describe, expect, test } from "bun:test";
import {
	wheelFrameStep,
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
