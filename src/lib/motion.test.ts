import { describe, expect, test } from "bun:test";
import { effectiveMotion, motionAttribute, motionChoice, motionPreference, type MotionChoice } from "./motion";

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
