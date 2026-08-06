import { describe, expect, test } from "bun:test";
import { withinInteractiveControl, withinNativeWheelUi, type GuardElement } from "./shortcut-guards";

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

	test("allows plain page targets", () => {
		expect(withinInteractiveControl(el("span", {}, el("div", {}, el("body"))))).toBe(false);
		expect(withinInteractiveControl(el("canvas"))).toBe(false);
	});

	test("allows null and non-element targets like window", () => {
		expect(withinInteractiveControl(null)).toBe(false);
		expect(withinInteractiveControl({})).toBe(false);
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
