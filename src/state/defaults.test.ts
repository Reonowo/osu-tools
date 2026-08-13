import { describe, expect, test } from "bun:test";
import type { EffectSettings, OverlaySettings } from "../lib/scene-types";
import {
	BACKGROUND_DIM_MAX,
	BACKGROUND_DIM_MIN,
	clampBackgroundDim,
	clampPlayfieldGridSpacing,
	DEFAULT_BACKGROUND_DIM,
	DEFAULT_EFFECTS,
	DEFAULT_OVERLAYS,
	effectiveEffects,
	effectiveOverlays,
	PLAYFIELD_GRID_SPACINGS
} from "./defaults";

describe("effectiveOverlays, the edit-mode force-draw fold", () => {
	const allOff: OverlaySettings = {
		cursorPath: false,
		clickMarkers: false,
		frameMarkers: false,
		tintIdleMarkers: false,
		hideCursor: true,
		keyOverlay: false,
		displayLength: 800,
		playfieldGrid: 0
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

describe("clampBackgroundDim", () => {
	test("holds the percent inside its bounds", () => {
		expect(clampBackgroundDim(-20)).toBe(BACKGROUND_DIM_MIN);
		expect(clampBackgroundDim(140)).toBe(BACKGROUND_DIM_MAX);
		expect(clampBackgroundDim(42)).toBe(42);
	});

	test("rounds to whole percent, matching the slider's own step", () => {
		expect(clampBackgroundDim(42.4)).toBe(42);
		expect(clampBackgroundDim(42.5)).toBe(43);
	});

	test("the default is what the viewer drew before the control existed", () => {
		// a fresh install must render the background the way it always did
		expect(DEFAULT_BACKGROUND_DIM).toBe(70);
		expect(DEFAULT_EFFECTS.backgroundDim).toBe(DEFAULT_BACKGROUND_DIM);
	});
});

describe("clampPlayfieldGridSpacing", () => {
	test("the allowed set passes through", () => {
		for (const spacing of PLAYFIELD_GRID_SPACINGS) expect(clampPlayfieldGridSpacing(spacing)).toBe(spacing);
	});

	test("a spacing outside the set falls back to off", () => {
		// an unrecognised value means a hand-edited or newer settings file; off
		// is the inert answer rather than a nearest-neighbour guess
		expect(clampPlayfieldGridSpacing(24)).toBe(0);
		expect(clampPlayfieldGridSpacing(64)).toBe(0);
		expect(clampPlayfieldGridSpacing(-8)).toBe(0);
		expect(clampPlayfieldGridSpacing(8.5)).toBe(0);
		expect(clampPlayfieldGridSpacing(Number.NaN)).toBe(0);
	});

	test("the registry is the off entry plus the four osu! editor spacings", () => {
		expect(PLAYFIELD_GRID_SPACINGS).toEqual([0, 4, 8, 16, 32]);
	});
});

describe("effectiveEffects, the master fold", () => {
	const allOn: EffectSettings = { ...DEFAULT_EFFECTS, backgroundDim: 35 };

	test("an enabled master passes the stored preferences through untouched", () => {
		expect(effectiveEffects(allOn)).toBe(allOn);
	});

	test("a switched-off master hides every effect", () => {
		const folded = effectiveEffects({ ...allOn, enabled: false });
		expect(folded.hitAnimations).toBe(false);
		expect(folded.hitEffects).toBe(false);
		expect(folded.cursorGlow).toBe(false);
		expect(folded.cursorTrail).toBe(false);
		expect(folded.followPoints).toBe(false);
	});

	test("a switched-off master carries the background dim through unchanged", () => {
		// the background dim is not an effect: hiding hit animations must not
		// also lift it off the background. rebuilding this literal with
		// `backgroundDim: 0` is the natural-looking wrong edit, and this catches it
		expect(effectiveEffects({ ...allOn, enabled: false }).backgroundDim).toBe(35);
		expect(effectiveEffects({ ...allOn, enabled: false, backgroundDim: 100 }).backgroundDim).toBe(100);
	});

	test("the stored preferences object is never rewritten", () => {
		const before = { ...allOn, enabled: false };
		const stored = { ...before };
		effectiveEffects(stored);
		expect(stored).toEqual(before);
	});
});
