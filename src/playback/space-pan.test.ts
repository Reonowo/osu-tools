import { describe, expect, test } from "bun:test";
import { SpacePan } from "./space-pan";

describe("space tap vs space drag", () => {
	test("a tap while paused asks to play", () => {
		const pan = new SpacePan();
		pan.press("Space", false);
		expect(pan.release()).toBe(true);
	});

	test("a tap while playing asks to stay paused -- the press already did it", () => {
		// this is the whole split: the press pauses, so a release that toggled
		// again would put a replay the user just stopped straight back on
		const pan = new SpacePan();
		pan.press("Space", true);
		expect(pan.release()).toBe(false);
	});

	test("a hold that dragged puts back what the press interrupted", () => {
		const pan = new SpacePan();
		pan.press("Space", true);
		pan.noteDrag();
		// panning through a playing replay pauses for the drag and resumes after
		expect(pan.release()).toBe(true);
	});

	test("a hold that dragged through a paused replay leaves it paused", () => {
		const pan = new SpacePan();
		pan.press("Space", false);
		pan.noteDrag();
		expect(pan.release()).toBe(false);
	});

	test("the drag is forgotten by the next press, so a drag then a tap still toggles", () => {
		const pan = new SpacePan();
		pan.press("Space", false);
		pan.noteDrag();
		pan.release();
		pan.press("Space", false);
		expect(pan.release()).toBe(true);
	});

	test("a release with nothing armed answers nothing at all", () => {
		// the keydown guard declines inside a focused button or a text field, so
		// press() never ran -- but the keyup still reaches the handler. null, not
		// false: "not mine to answer" is not "should be paused"
		const pan = new SpacePan();
		expect(pan.release()).toBeNull();
	});

	test("a stray drag between holds cannot suppress the next tap", () => {
		// a middle-mouse pan drags with space untouched
		const pan = new SpacePan();
		pan.noteDrag();
		pan.press("Space", false);
		expect(pan.release()).toBe(true);
	});

	test("a second play/pause binding pressed mid-drag cannot erase the drag", () => {
		// play/pause can carry an alternate binding, so a keydown arriving mid
		// hold is a real key and not only auto-repeat. the hold stays attributed
		// to the key that armed it -- and it must keep its DRAG too, or the
		// original key's release reads as a tap and moves playback the opposite
		// way from what the pan should restore
		const pan = new SpacePan();
		pan.press("Space", true);
		pan.noteDrag();
		pan.press("KeyK", true);
		expect(pan.heldBy("Space")).toBe(true);
		expect(pan.release()).toBe(true); // a pan through a playing replay resumes it

		const paused = new SpacePan();
		paused.press("Space", false);
		paused.noteDrag();
		paused.press("KeyK", false);
		expect(paused.release()).toBe(false); // and a pan through a paused one leaves it paused
	});

	test("a repeat cannot re-read the playing flag the press itself cleared", () => {
		// the press pauses, so by the time auto-repeat arrives the store says
		// paused; re-arming on it would make the release resume the replay the
		// user just stopped. the guard filters repeats, and this is the state
		// that would go wrong if it ever stopped
		const pan = new SpacePan();
		pan.press("Space", true);
		pan.press("Space", false);
		expect(pan.release()).toBe(false);
	});
});

describe("losing focus mid-hold", () => {
	test("a blur disarms, so a plain left-drag stops panning", () => {
		// the keyup that would have released this hold goes to whichever window
		// took focus, so nothing else can ever clear the latch
		const pan = new SpacePan();
		pan.press("Space", false);
		pan.cancel();
		// Viewport gates its left-button pan on exactly this
		expect(pan.armed).toBe(false);
	});

	test("a blur puts the cursor back, once", () => {
		const pan = new SpacePan();
		const seen: boolean[] = [];
		pan.subscribe((armed) => seen.push(armed));
		pan.press("Space", false);
		pan.cancel();
		// a blur with nothing armed (the common case) must not churn the cursor
		pan.cancel();
		expect(seen).toEqual([true, false]);
	});

	test("a blur never moves playback, and the next space tap still toggles exactly once", () => {
		const pan = new SpacePan();
		pan.press("Space", true);
		pan.noteDrag();
		pan.cancel();
		// cancel() returns nothing, so a blur has nothing to report -- and a
		// late keyup (alt-tab back, then let go) finds nothing armed to release.
		// the replay the press paused stays paused, which is the safe end of
		// alt-tabbing away mid-hold
		expect(pan.release()).toBeNull();
		// nor may the discarded hold's drag suppress the next tap
		pan.press("Space", false);
		expect(pan.release()).toBe(true);
	});
});

describe("which key ends the hold", () => {
	test("only the key that armed the hold can end it", () => {
		// play/pause can carry an alternate binding, so a keyup arrives for keys
		// this hold never began on. treating one of those as the release would
		// drop a pan mid-drag and toggle playback behind it
		const pan = new SpacePan();
		pan.press("Space", false);
		expect(pan.heldBy("K")).toBe(false);
		expect(pan.heldBy("Space")).toBe(true);
	});

	test("nothing is held by anything once the hold is over", () => {
		const pan = new SpacePan();
		pan.press("Space", false);
		pan.release();
		expect(pan.heldBy("Space")).toBe(false);
		// a blur leaves nothing armed either, so the late keyup finds no hold
		pan.press("Space", false);
		pan.cancel();
		expect(pan.heldBy("Space")).toBe(false);
	});

	test("a repeat cannot re-attribute a hold to another key", () => {
		// the guard filters repeats, but a chord's own keydown can arrive again
		// before the release; the hold stays the one that started it
		const pan = new SpacePan();
		pan.press("Space", false);
		pan.press("K", false);
		expect(pan.heldBy("Space")).toBe(true);
		expect(pan.heldBy("K")).toBe(false);
	});
});

describe("arming", () => {
	test("space down arms a pan drag and space up disarms it", () => {
		const pan = new SpacePan();
		expect(pan.armed).toBe(false);
		pan.press("Space", false);
		expect(pan.armed).toBe(true);
		pan.release();
		expect(pan.armed).toBe(false);
	});

	test("subscribers see each transition once, for the grab cursor", () => {
		const pan = new SpacePan();
		const seen: boolean[] = [];
		const unsubscribe = pan.subscribe((armed) => seen.push(armed));
		pan.press("Space", false);
		// a keydown that slipped past the repeat filter must not re-notify
		pan.press("Space", false);
		pan.release();
		// nor may a release with nothing armed
		pan.release();
		expect(seen).toEqual([true, false]);
		unsubscribe();
		pan.press("Space", false);
		expect(seen).toEqual([true, false]);
	});
});
