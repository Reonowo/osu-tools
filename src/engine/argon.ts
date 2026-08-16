// argon skin constants, cited to the pinned checkout. sizes are osu!px at
// cs-scale 1; multiply by the render plan's `scale` at draw time

/** osuhitobject.cs:22 */
export const OBJECT_RADIUS = 64;

// argonmaincirclepiece.cs:27-34
export const BORDER_THICKNESS = OBJECT_RADIUS * 2 * (2 / 58);
export const GRADIENT_THICKNESS = BORDER_THICKNESS * 2.5;
export const OUTER_GRADIENT_SIZE = OBJECT_RADIUS * 2 - BORDER_THICKNESS * 4;
export const INNER_GRADIENT_SIZE = OUTER_GRADIENT_SIZE - GRADIENT_THICKNESS * 2;
export const INNER_FILL_SIZE = INNER_GRADIENT_SIZE - GRADIENT_THICKNESS * 2;

/** argonsliderbody.cs:18 -- the body ribbon's half-width */
export const SLIDER_PATH_RADIUS = OUTER_GRADIENT_SIZE / 2;
/** drawablesliderpath.cs:11 */
export const BORDER_PORTION = 0.128;
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
/** smoothpath.cs:58 */
export const LUT_AA_PORTION = 0.02;

/** drawablesliderball.cs:19 */
export const FOLLOW_AREA = 2.4;

/** osucursor.cs:25 */
export const CURSOR_SIZE = 28;

/** osuplayfieldadjustmentcontainer.cs:16 */
export const PLAYFIELD_SIZE_ADJUST = 0.8;

/** followpointconnection.cs:20-21 */
export const FOLLOW_POINT_SPACING = 32;
export const FOLLOW_POINT_PREEMPT = 800;

/** osuhitobject.cs:37 -- preempt floor used by fade-in scaling */
export const PREEMPT_MIN = 450;

/** drawablehitcircle.cs:214 -- this.Delay(800).FadeOut() lifetime cutoff after the hit state */
export const HIT_FADE_OUT_TIME = 800;
/** drawableslider.cs:355 -- const float fade_out_time = 240 */
export const SLIDER_FADE_OUT_TIME = 240;
/** drawablespinner.cs:71 -- const double fade_out_duration = 240 */
export const SPINNER_FADE_OUT_TIME = 240;

/** drawableosuhitobject.cs:117 -- the pre-hit dim tint, Color4(195, 195, 195, 255) */
export const DIM_TINT = 195 / 255;
/** osuhitwindows.cs:19 -- fixed miss window; the dim releases at start - miss_window */
export const MISS_WINDOW = 400;
