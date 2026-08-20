// the legacy slider body's colour ramp.
//
// it lives HERE rather than beside argon's in `engine/slider-lut.ts` for the
// reason that module's own comment gives: the engine's ported ruleset maths
// must not import a skin's constants, which is the direction the constant split
// exists to forbid. what the engine keeps is the bake (`bakeSliderLut`) and the
// framework's own antialias ramp; what an era supplies is a sampler.
//
// the body is the one element in the inventory that is NOT a texture. it stays
// procedural in both eras and goes on drawing through the existing
// path-lookup-table and shader route; only the ramp and the ribbon's width
// change.

import { darken, lighten, type Rgba } from "@/engine/color";
import type { SliderColourSampler } from "@/engine/slider-lut";
import { LEGACY_SLIDER_BORDER_PORTION, LEGACY_SLIDER_SHADOW_ALPHA, LEGACY_SLIDER_SHADOW_PORTION } from "./constants";

/**
 * legacysliderbody.cs:27-44 -- the classic ramp, and a different shape from
 * argon's rather than the same one with other numbers.
 *
 * three bands outward-in: a shadow fading up from nothing over the padding the
 * hit circle art carries and the body does not, then a flat border, then the
 * track ramped from a darkened accent to a lightened one. the accent's alpha is
 * already the era's flat track alpha (:22-23 -- legacy skins use a CONSTANT
 * value whatever the source colour was)
 */
export function legacyColourAt(position: number, accent: Rgba, border: Rgba): Rgba {
	if (position <= LEGACY_SLIDER_SHADOW_PORTION) {
		// :38 -- from fully transparent black up to the shadow, over the padding
		const k = LEGACY_SLIDER_SHADOW_PORTION === 0 ? 1 : position / LEGACY_SLIDER_SHADOW_PORTION;
		return { r: 0, g: 0, b: 0, a: LEGACY_SLIDER_SHADOW_ALPHA * k };
	}
	if (position <= LEGACY_SLIDER_BORDER_PORTION) return border;
	const outer = darken(accent, 0.1);
	const inner = lighten(accent, 0.5);
	const k = (position - LEGACY_SLIDER_BORDER_PORTION) / (1 - LEGACY_SLIDER_BORDER_PORTION);
	return {
		r: outer.r + k * (inner.r - outer.r),
		g: outer.g + k * (inner.g - outer.g),
		b: outer.b + k * (inner.b - outer.b),
		a: outer.a + k * (inner.a - outer.a)
	};
}

/** the sampler `bakeSliderLut` takes, closed over one slider's colours */
export function legacySliderSampler(accent: Rgba, border: Rgba): SliderColourSampler {
	return (position) => legacyColourAt(position, accent, border);
}
