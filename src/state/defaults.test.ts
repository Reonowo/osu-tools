import { describe, expect, test } from "bun:test";
import type { OverlaySettings } from "../lib/scene-types";
import { DEFAULT_OVERLAYS, effectiveOverlays } from "./defaults";

describe("effectiveOverlays, the edit-mode force-draw fold", () => {
	const allOff: OverlaySettings = {
		cursorPath: false,
		clickMarkers: false,
		frameMarkers: false,
		hideCursor: true,
		keyOverlay: false,
		displayLength: 800
	};

	test("watch mode passes the stored preferences through untouched", () => {
		expect(effectiveOverlays(allOff, "watch")).toBe(allOff);
		expect(effectiveOverlays(DEFAULT_OVERLAYS, "watch")).toBe(DEFAULT_OVERLAYS);
	});

	test("edit mode force-draws the cursor path and frame markers", () => {
		const folded = effectiveOverlays(allOff, "edit");
		expect(folded.cursorPath).toBe(true);
		expect(folded.frameMarkers).toBe(true);
	});

	test("edit mode leaves click markers, cursor hiding, key overlay, and display length alone", () => {
		const folded = effectiveOverlays(allOff, "edit");
		expect(folded.clickMarkers).toBe(false);
		expect(folded.hideCursor).toBe(true);
		expect(folded.keyOverlay).toBe(false);
		expect(folded.displayLength).toBe(800);
	});

	test("the stored preferences object is never rewritten", () => {
		const before = { ...allOff };
		effectiveOverlays(allOff, "edit");
		expect(allOff).toEqual(before);
	});

	test("edit mode with the overlays already on changes nothing observable", () => {
		const allOn: OverlaySettings = { ...allOff, cursorPath: true, frameMarkers: true };
		expect(effectiveOverlays(allOn, "edit")).toEqual(allOn);
	});
});
