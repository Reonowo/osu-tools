// where a combo palette comes from, now that the engine has stopped deciding.
//
// the engine emits the beatmap's declared colours or null and substitutes
// nothing: picking a palette is a skin decision, and the engine has no concept
// of a skin. this module is the layer that does, and it is the whole of the
// rule.

import type { RenderPlan, SkinManifest } from "@/lib/scene-types";

/** argonskin.cs:51-71 -- argon's own six, and the lazer era's default */
export const ARGON_COMBO_COLOURS: readonly [number, number, number, number][] = [
	[241, 116, 0, 255], // orange
	[0, 241, 53, 255], // green
	[0, 82, 241, 255], // blue
	[241, 0, 0, 255], // red
	[232, 235, 0, 255], // yellow
	[92, 0, 241, 255] // purple
];

/** skinconfiguration.cs:47-53 -- the classic four, and the legacy era's default */
export const CLASSIC_COMBO_COLOURS: readonly [number, number, number, number][] = [
	[255, 192, 0, 255],
	[0, 202, 0, 255],
	[18, 124, 255, 255],
	[242, 24, 57, 255]
];

/**
 * the palette an object's colour index is taken modulo.
 *
 * three sources in order, and the order is the same citation it always was:
 *
 * 1. **the beatmap's own declared colours**, when it declared any. beatmap
 *    skins refuse the legacy default-palette fallback
 *    (legacybeatmapskin.cs:40), so a beatmap either declares a palette or has
 *    nothing to say -- which is exactly what the nullable wire field carries.
 * 2. **the skin's declared colours**, when it declared any.
 * 3. **that skin's ERA default** -- argon's six, or the classic four.
 *
 * step 3 is per era for the same reason every other fallthrough is: a legacy
 * skin falling back to argon's palette would put lazer colours on a legacy
 * playfield, which is the mixed-era look the whole floor rule exists to
 * prevent.
 *
 * a null skin is the bundled default, which is argon -- there is no "no skin"
 * state to model.
 */
export function comboPalette(
	plan: Pick<RenderPlan, "comboColours">,
	skin: SkinManifest | null
): readonly [number, number, number, number][] {
	if (plan.comboColours !== null && plan.comboColours.length > 0) return plan.comboColours;
	const declared = skin?.config.comboColours ?? [];
	if (declared.length > 0) return declared;
	return skin?.era === "legacy" ? CLASSIC_COMBO_COLOURS : ARGON_COMBO_COLOURS;
}

/** the accent every object draws with, resolved once per scene. the index is
 * offset-based and the modulo is applied HERE, which is what lets a palette's
 * length change freely without touching per-object data */
export function objectAccents(
	plan: Pick<RenderPlan, "comboColours" | "objects">,
	skin: SkinManifest | null
): [number, number, number, number][] {
	const palette = comboPalette(plan, skin);
	return plan.objects.map((object) => palette[object.comboColourIndex % palette.length]);
}
