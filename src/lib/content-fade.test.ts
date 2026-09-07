// the body-fade rule's whole surface (spec decision 11), driven the way the
// two sites drive it: the surface reports its key on every render, and `null`
// while it is closed. prior art: presence.test.ts next door -- the same pure
// fold exercised through its own inputs, with no dom

import { describe, expect, test } from "bun:test";
import { contentFadeStep, initialContentFade, type ContentFade } from "./content-fade";

/** a sequence of reported keys, folded in order, so a test reads as the
 * user's gestures rather than as a list of single steps */
const run = (start: ContentFade<string>, ...keys: (string | null)[]): ContentFade<string> =>
	keys.reduce(contentFadeStep, start);

const openOn = (key: string) => initialContentFade(key, key);
const closed = initialContentFade<string>(null, "first");

describe("a surface that opens", () => {
	test("shows the key it opened on and does not fade -- an entry is not a content change", () => {
		expect(contentFadeStep(closed, "general")).toEqual({ shown: "general", fading: false, open: true });
	});

	test("mounting already open is an entry too, so nothing fades on first paint", () => {
		expect(openOn("replay")).toEqual({ shown: "replay", fading: false, open: true });
	});
});

describe("a key change inside an open surface", () => {
	test("is the one thing that fades", () => {
		expect(contentFadeStep(openOn("replay"), "frames")).toEqual({
			shown: "frames",
			fading: true,
			open: true
		});
	});

	test("the same key reported again changes nothing, and returns the same object", () => {
		const state = openOn("replay");
		expect(contentFadeStep(state, "replay")).toBe(state);
	});

	test("every further change keeps fading, including back to the key it opened on", () => {
		expect(run(openOn("replay"), "frames", "replay")).toEqual({
			shown: "replay",
			fading: true,
			open: true
		});
	});
});

describe("a surface that closes", () => {
	test("holds the body it was closed on, because it stays mounted for its whole exit", () => {
		expect(run(openOn("replay"), "frames", null)).toEqual({
			shown: "frames",
			fading: false,
			open: false
		});
	});

	test("clears the fade, so a reopen onto a DIFFERENT key is an entry and not a change", () => {
		// the panel's case: closing on `replay`, then a rail tab reopening it on
		// `frames`. the presence helper re-enters without unmounting, so without
		// this the body would fade over the slide that is bringing it back
		expect(run(openOn("replay"), null, "frames")).toEqual({
			shown: "frames",
			fading: false,
			open: true
		});
	});

	test("a closed surface reporting closed again returns the same object", () => {
		const state = contentFadeStep(openOn("replay"), null);
		expect(contentFadeStep(state, null)).toBe(state);
	});

	test("reopening on the key it was closed on is an entry as well", () => {
		expect(run(openOn("general"), "audio", null, "audio")).toEqual({
			shown: "audio",
			fading: false,
			open: true
		});
	});
});

describe("a surface that was never opened", () => {
	test("falls back rather than having no key at all, since a closed surface still renders while it leaves", () => {
		expect(closed).toEqual({ shown: "first", fading: false, open: false });
	});
});
