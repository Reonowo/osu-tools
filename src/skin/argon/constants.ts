// argon's own constants -- this skin's taste, cited to the pinned checkout.
// a legacy skin answers every one of these differently, which is why they sit
// under the skin rather than beside the ruleset values in
// `engine/game-constants.ts`. sizes are osu!px at cs-scale 1; multiply by the
// render plan's `scale` at draw time

import { OBJECT_RADIUS } from "@/engine/game-constants";

// argonmaincirclepiece.cs:27-34
export const BORDER_THICKNESS = OBJECT_RADIUS * 2 * (2 / 58);
export const GRADIENT_THICKNESS = BORDER_THICKNESS * 2.5;
export const OUTER_GRADIENT_SIZE = OBJECT_RADIUS * 2 - BORDER_THICKNESS * 4;
export const INNER_GRADIENT_SIZE = OUTER_GRADIENT_SIZE - GRADIENT_THICKNESS * 2;
export const INNER_FILL_SIZE = INNER_GRADIENT_SIZE - GRADIENT_THICKNESS * 2;

/** argonsliderbody.cs:18 -- the body ribbon's half-width */
export const SLIDER_PATH_RADIUS = OUTER_GRADIENT_SIZE / 2;
/** argonsliderbody.cs:26-28, drawablesliderpath.cs:68 -- bordersize
 * (intended_thickness / border_portion) times calculatedborderportion's own
 * border_portion factor collapses to just intended_thickness, which is
 * gradient_thickness / path_radius = (640/58) / (3200/58) = 0.2 exactly.
 * written as the literal so the f64 expression's rounding cannot drift off
 * the c# float value. typed `number` (rather than the precise literal type)
 * because slider-lut.ts compares it against 0 -- see the guard there */
export const SLIDER_BORDER_PORTION: number = 0.2;
/** osuargonskintransformer.cs:57 -- the `isPro` branch. argonpro is this
 * app's default skin throughout, so the pro alpha is the one that applies;
 * the non-pro branch on the same line is 0.98 */
export const SLIDER_BODY_ALPHA = 0.92;
