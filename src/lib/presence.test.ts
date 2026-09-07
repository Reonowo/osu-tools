// every transition of the exit-holding machine, driven the way the hook
// drives it: an inputs signal whenever the open flag or the row's motion flag
// changes, an exitEnded when the driving property's transition finishes on
// the element itself. prior art: lib/combo.test.ts and the space-pan tests --
// a pure state module exercised through its own signals, with no dom

import { describe, expect, test } from "bun:test";
import {
	initialPresence,
	isDrivingTransitionEnd,
	presenceInert,
	presenceMounted,
	presenceStep,
	type PresenceSignal,
	type PresenceState
} from "./presence";

/** the sequence a region actually lives through, folded in order, so a test
 * reads as the user's gestures rather than as a list of single steps */
const run = (start: PresenceState, ...signals: PresenceSignal[]): PresenceState => signals.reduce(presenceStep, start);

const inputs = (open: boolean, motion = true): PresenceSignal => ({ kind: "inputs", open, motion });
const exitEnded: PresenceSignal = { kind: "exitEnded" };

describe("where a region starts", () => {
	test("open at first paint is entered, so nothing about it is a change", () => {
		expect(initialPresence(true)).toBe("entered");
	});

	test("closed at first paint is unmounted", () => {
		expect(initialPresence(false)).toBe("unmounted");
	});
});

describe("opening", () => {
	test("mounts entered", () => {
		expect(presenceStep("unmounted", inputs(true))).toBe("entered");
	});

	test("an open region staying open stays put", () => {
		expect(presenceStep("entered", inputs(true))).toBe("entered");
	});

	test("opening with motion off still mounts -- the row decides the motion, never the presence", () => {
		expect(presenceStep("unmounted", inputs(true, false))).toBe("entered");
	});
});

describe("closing with motion on", () => {
	test("holds in exiting until the end event", () => {
		expect(presenceStep("entered", inputs(false))).toBe("exiting");
		expect(run("entered", inputs(false), inputs(false))).toBe("exiting");
	});

	test("the end event unmounts it", () => {
		expect(run("entered", inputs(false), exitEnded)).toBe("unmounted");
	});

	test("a closed region already unmounted stays unmounted", () => {
		expect(presenceStep("unmounted", inputs(false))).toBe("unmounted");
	});
});

describe("closing with motion off", () => {
	test("unmounts at once and never waits, because a 0ms transition fires no end event", () => {
		expect(presenceStep("entered", inputs(false, false))).toBe("unmounted");
	});

	test("the master flipping off mid-exit lands the region instantly", () => {
		expect(run("entered", inputs(false), inputs(false, false))).toBe("unmounted");
	});
});

describe("interruptions", () => {
	test("a reopen mid-exit re-enters without ever unmounting", () => {
		expect(run("entered", inputs(false), inputs(true))).toBe("entered");
	});

	test("a reopen mid-exit followed by the old exit's end event does not unmount the live region", () => {
		// the transitionend of the exit that was interrupted can still arrive:
		// the reversed transition finishes and reports the same property
		expect(run("entered", inputs(false), inputs(true), exitEnded)).toBe("entered");
	});

	test("a rapid close-open-close ends up exiting again, not unmounted", () => {
		expect(run("entered", inputs(false), inputs(true), inputs(false))).toBe("exiting");
	});
});

describe("stray end events", () => {
	test("an end event in entered changes nothing", () => {
		expect(presenceStep("entered", exitEnded)).toBe("entered");
	});

	test("an end event in unmounted changes nothing", () => {
		expect(presenceStep("unmounted", exitEnded)).toBe("unmounted");
	});

	test("a second end event after an exit finished changes nothing", () => {
		expect(run("entered", inputs(false), exitEnded, exitEnded)).toBe("unmounted");
	});
});

describe("which transitionend ends an exit", () => {
	// plain objects stand in for elements, as shortcut-guards.test.ts builds
	// its own: the filter reads identity and a property name and nothing else
	const region = {};
	const child = {};
	const ended = (target: object, propertyName: string) => ({ target, currentTarget: region, propertyName });

	test("the region's own driving property does", () => {
		expect(isDrivingTransitionEnd(ended(region, "width"), "width")).toBe(true);
	});

	test("a bubbling child's is ignored, even for the same property", () => {
		// a tooltip fading inside a sliding panel, or the key tile's press
		// inside the HUD's fade, would otherwise speak for its parent
		expect(isDrivingTransitionEnd(ended(child, "width"), "width")).toBe(false);
	});

	test("another property ending on the region itself is ignored", () => {
		// the panel's body fade ends half a slide before its width does
		expect(isDrivingTransitionEnd(ended(region, "opacity"), "width")).toBe(false);
	});
});

describe("what a state reports", () => {
	test("exiting is mounted and inert; entered is mounted and not; unmounted is neither", () => {
		expect([presenceMounted("unmounted"), presenceInert("unmounted")]).toEqual([false, false]);
		expect([presenceMounted("entered"), presenceInert("entered")]).toEqual([true, false]);
		expect([presenceMounted("exiting"), presenceInert("exiting")]).toEqual([true, true]);
	});
});
