// the shared candidate-window derivation: the trailing window's boundary
// rules and the pending-insert filter, plus the selection's displayed-space
// view. extracted from the gesture shell so the gestures and the viewport
// context menu agree on what is reachable -- these pin the seam itself

import { describe, expect, test } from "bun:test";
import type { FrameDto } from "../lib/scene-types";
import { candidateWindow, selectionToDisplayed } from "./candidate-window";

function frame(time: number): FrameDto {
	return { time, x: 0, y: 0, buttons: 0 };
}

const frames = [frame(0), frame(100), frame(200), frame(300), frame(400)];

describe("candidateWindow", () => {
	test("the window is the trailing span behind the playhead, exclusive at its far edge", () => {
		// displayLength 200 at t=300: a frame exactly displayLength old has
		// already faded (countTimedAtOrBefore excludes it), the playhead's own
		// millisecond is included
		expect(candidateWindow(frames, null, 300, 200)).toEqual([2, 3]);
	});

	test("a playhead past the stream keeps the tail reachable", () => {
		expect(candidateWindow(frames, null, 450, 200)).toEqual([3, 4]);
	});

	test("a pending boundary insert is not a candidate until its delta lands", () => {
		// displayed index 2 mirrors no authoritative frame yet
		const source = [0, 1, null, 2, 3];
		expect(candidateWindow(frames, source, 400, 500)).toEqual([0, 1, 3, 4]);
	});
});

describe("selectionToDisplayed", () => {
	test("a null source map is the identity", () => {
		const selection = [1, 3];
		expect(selectionToDisplayed(selection, null)).toBe(selection);
	});

	test("maps authoritative indices through the source and drops what the display lost", () => {
		// displayed 0->auth 0, displayed 1 is pending, displayed 2->auth 2;
		// auth 1 is hidden by a pending delete and drops
		const source = [0, null, 2];
		expect(selectionToDisplayed([0, 1, 2], source)).toEqual([0, 2]);
	});
});
