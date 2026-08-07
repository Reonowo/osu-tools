import { describe, expect, test } from "bun:test";
import { SpacePan } from "./space-pan";

describe("space tap vs space drag", () => {
	test("a tap still toggles playback, exactly as it did on keydown", () => {
		const pan = new SpacePan();
		pan.press();
		expect(pan.release()).toBe(true);
	});

	test("a hold that dragged toggles nothing on release", () => {
		const pan = new SpacePan();
		pan.press();
		pan.noteDrag();
		expect(pan.release()).toBe(false);
	});

	test("the drag is forgotten by the next press, so a drag then a tap still toggles", () => {
		const pan = new SpacePan();
		pan.press();
		pan.noteDrag();
		pan.release();
		pan.press();
		expect(pan.release()).toBe(true);
	});

	test("a release with nothing armed toggles nothing", () => {
		// the keydown guard declines inside a focused button or a text field, so
		// press() never ran -- but the keyup still reaches the handler
		const pan = new SpacePan();
		expect(pan.release()).toBe(false);
	});

	test("a stray drag between holds cannot suppress the next tap", () => {
		// a middle-mouse pan drags with space untouched
		const pan = new SpacePan();
		pan.noteDrag();
		pan.press();
		expect(pan.release()).toBe(true);
	});
});

describe("losing focus mid-hold", () => {
	test("a blur disarms, so a plain left-drag stops panning", () => {
		// the keyup that would have released this hold goes to whichever window
		// took focus, so nothing else can ever clear the latch
		const pan = new SpacePan();
		pan.press();
		pan.cancel();
		// Viewport gates its left-button pan on exactly this
		expect(pan.armed).toBe(false);
	});

	test("a blur puts the cursor back, once", () => {
		const pan = new SpacePan();
		const seen: boolean[] = [];
		pan.subscribe((armed) => seen.push(armed));
		pan.press();
		pan.cancel();
		// a blur with nothing armed (the common case) must not churn the cursor
		pan.cancel();
		expect(seen).toEqual([true, false]);
	});

	test("a blur never toggles playback, and the next space tap still toggles exactly once", () => {
		const pan = new SpacePan();
		pan.press();
		pan.noteDrag();
		pan.cancel();
		// cancel() returns nothing, so a blur has no toggle to report -- and a
		// late keyup (alt-tab back, then let go) finds nothing armed to release
		expect(pan.release()).toBe(false);
		// nor may the discarded hold's drag suppress the next tap
		pan.press();
		expect(pan.release()).toBe(true);
	});
});

describe("arming", () => {
	test("space down arms a pan drag and space up disarms it", () => {
		const pan = new SpacePan();
		expect(pan.armed).toBe(false);
		pan.press();
		expect(pan.armed).toBe(true);
		pan.release();
		expect(pan.armed).toBe(false);
	});

	test("subscribers see each transition once, for the grab cursor", () => {
		const pan = new SpacePan();
		const seen: boolean[] = [];
		const unsubscribe = pan.subscribe((armed) => seen.push(armed));
		pan.press();
		// a keydown that slipped past the repeat filter must not re-notify
		pan.press();
		pan.release();
		// nor may a release with nothing armed
		pan.release();
		expect(seen).toEqual([true, false]);
		unsubscribe();
		pan.press();
		expect(seen).toEqual([true, false]);
	});
});
