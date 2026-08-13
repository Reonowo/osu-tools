import { describe, expect, test } from "bun:test";
import { FocusModality } from "./focus-modality";

describe("FocusModality", () => {
	test("starts as keyboard focus so an autofocus keeps its native keys", () => {
		expect(new FocusModality().keyboardFocus).toBe(true);
	});

	test("a click stamps the focus it places as pointer", () => {
		const modality = new FocusModality();
		modality.pointerDown();
		modality.focusChanged();
		expect(modality.keyboardFocus).toBe(false);
	});

	test("tabbing stamps the focus it moves as keyboard", () => {
		const modality = new FocusModality();
		modality.pointerDown();
		modality.focusChanged();
		modality.keyDown("Tab");
		modality.focusChanged();
		expect(modality.keyboardFocus).toBe(true);
	});

	test("space over a click-focused control launders nothing", () => {
		// the chromium trap this module replaces: the browser promotes the
		// focused element to :focus-visible on any keydown, so the very space
		// press the shortcuts reclaim would have flipped the answer. here a
		// non-moving key changes neither the stamp nor the recorded modality
		const modality = new FocusModality();
		modality.pointerDown();
		modality.focusChanged();
		modality.keyDown(" ");
		expect(modality.keyboardFocus).toBe(false);
	});

	test("printable keys do not re-stamp a later programmatic focus either", () => {
		const modality = new FocusModality();
		modality.pointerDown();
		modality.focusChanged();
		modality.keyDown("x");
		// a dialog closed by that click restores its trigger programmatically:
		// the focusin still reads the pointer stamp, so the trigger's keys go
		// back to the viewer instead of reopening the dialog
		modality.focusChanged();
		expect(modality.keyboardFocus).toBe(false);
	});

	test("escape counts as keyboard for the trigger focus a dismissal restores", () => {
		// open a popover by mouse click, dismiss it with escape: base-ui
		// restores focus to the trigger, and that restore was keyboard-driven,
		// so space must activate the visibly focused trigger -- not fall
		// through to the viewer under the opening click's stale stamp
		const modality = new FocusModality();
		modality.pointerDown();
		modality.focusChanged();
		modality.keyDown("Escape");
		expect(modality.keyboardFocus).toBe(false);
		modality.focusChanged();
		expect(modality.keyboardFocus).toBe(true);
	});

	test("arrow roving after a click counts as keyboard for the focus it moves", () => {
		// click a palette tool, then arrow to its neighbour: the roved-to item
		// was chosen by keyboard and space must activate it
		const modality = new FocusModality();
		modality.pointerDown();
		modality.focusChanged();
		modality.keyDown("ArrowRight");
		expect(modality.keyboardFocus).toBe(false);
		modality.focusChanged();
		expect(modality.keyboardFocus).toBe(true);
	});

	test("a nav key that moves no focus changes nothing until focus moves", () => {
		const modality = new FocusModality();
		modality.pointerDown();
		modality.focusChanged();
		// seek on a click-focused plain button: the arrow re-stamps the last
		// input but the recorded modality holds until an actual focusin
		modality.keyDown("ArrowLeft");
		expect(modality.keyboardFocus).toBe(false);
	});
});
