import { describe, expect, test } from "bun:test";
import { DEFAULT_INTERFACE } from "@/state/defaults";
import {
	effectiveMotion,
	effectiveRow,
	motionAttribute,
	rootMotionAttributes,
	motionChoice,
	motionPreference,
	type MotionChoice
} from "./motion";

describe("effectiveMotion", () => {
	test("an explicit choice wins over the OS, either way", () => {
		expect(effectiveMotion(true, true)).toBe(true);
		expect(effectiveMotion(true, false)).toBe(true);
		expect(effectiveMotion(false, false)).toBe(false);
		expect(effectiveMotion(false, true)).toBe(false);
	});

	test("unset follows the OS", () => {
		expect(effectiveMotion(null, false)).toBe(true);
		expect(effectiveMotion(null, true)).toBe(false);
	});

	test("a flipped OS query re-resolves an unset preference and not a stored one", () => {
		// what the app root's matchMedia listener does: the same preference,
		// resolved again against the new answer
		const beforeAndAfter = (pref: boolean | null) => [effectiveMotion(pref, false), effectiveMotion(pref, true)];
		expect(beforeAndAfter(null)).toEqual([true, false]);
		expect(beforeAndAfter(true)).toEqual([true, true]);
		expect(beforeAndAfter(false)).toEqual([false, false]);
	});
});

describe("the segmented control's three states", () => {
	test("each preference shows its own segment", () => {
		expect(motionChoice(null)).toBe("system");
		expect(motionChoice(true)).toBe("on");
		expect(motionChoice(false)).toBe("off");
	});

	test("picking the segment a preference already shows leaves it unchanged", () => {
		for (const pref of [null, true, false] as const) {
			expect(motionPreference(motionChoice(pref))).toBe(pref);
		}
	});

	test("every segment maps to a preference", () => {
		const choices: MotionChoice[] = ["system", "on", "off"];
		expect(choices.map(motionPreference)).toEqual([null, true, false]);
	});
});

describe("motionAttribute", () => {
	test("is the two values the stylesheet's rule keys on", () => {
		expect(motionAttribute(true)).toBe("on");
		expect(motionAttribute(false)).toBe("off");
	});
});

describe("the rows under the master", () => {
	test("a row off under a master on is off", () => {
		expect(effectiveRow(false, true)).toBe(false);
	});

	test("a row on under a master off is off", () => {
		expect(effectiveRow(true, false)).toBe(false);
	});

	test("only both on runs", () => {
		expect(effectiveRow(true, true)).toBe(true);
		expect(effectiveRow(false, false)).toBe(false);
	});
});

describe("rootMotionAttributes", () => {
	const prefs = (over: Partial<typeof DEFAULT_INTERFACE> = {}) => ({ ...DEFAULT_INTERFACE, ...over });

	test("a fresh install with a quiet OS runs everything", () => {
		expect(rootMotionAttributes(prefs(), false)).toEqual({ motion: "on", shell: "on", popup: "on" });
	});

	test("the master off takes both rows with it while data-motion stays the master's", () => {
		expect(rootMotionAttributes(prefs({ motion: false }), false)).toEqual({
			motion: "off",
			shell: "off",
			popup: "off"
		});
	});

	test("one row off leaves the master and the other row alone", () => {
		expect(rootMotionAttributes(prefs({ motion: true, shellTransitions: false }), false)).toEqual({
			motion: "on",
			shell: "off",
			popup: "on"
		});
		expect(rootMotionAttributes(prefs({ motion: true, popupTransitions: false }), false)).toEqual({
			motion: "on",
			shell: "on",
			popup: "off"
		});
	});

	test("`system` follows the OS, rows included, with no preference change", () => {
		// what the app root's matchMedia listener produces: the same stored
		// preferences resolved again against the new answer
		expect(rootMotionAttributes(prefs(), true)).toEqual({ motion: "off", shell: "off", popup: "off" });
		expect(rootMotionAttributes(prefs(), false)).toEqual({ motion: "on", shell: "on", popup: "on" });
	});

	test("a row's stored value survives the master, so switching it back on restores what the user had", () => {
		const stored = prefs({ motion: false, shellTransitions: false, popupTransitions: true });
		expect(rootMotionAttributes(stored, false)).toEqual({ motion: "off", shell: "off", popup: "off" });
		expect(rootMotionAttributes({ ...stored, motion: true }, false)).toEqual({
			motion: "on",
			shell: "off",
			popup: "on"
		});
	});
});
