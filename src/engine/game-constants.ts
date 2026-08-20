// ruleset and framework constants, cited to the pinned checkout. these are true
// whatever skin is loaded -- no skin.ini key reaches them and no era forks them
// -- which is why they do not live under a skin's name. sizes are osu!px at
// cs-scale 1; multiply by the render plan's `scale` at draw time.
//
// the other half of the old `argon.ts` is at `skin/argon/constants.ts`: values
// that are argon's own taste and that a legacy skin answers differently

/** osuhitobject.cs:22 */
export const OBJECT_RADIUS = 64;

/** drawablesliderball.cs:19 */
export const FOLLOW_AREA = 2.4;

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

/** smoothpath.cs:58 -- the framework's own edge antialias portion, shared by
 * every path body whatever era bakes it */
export const LUT_AA_PORTION = 0.02;

/** osucursor.cs:25 -- `OsuCursor.SIZE`, on the ruleset's own cursor container
 * (`osu.Game.Rulesets.Osu.UI.Cursor`), applied before any skin is consulted.
 * argon fills it relatively and declares no size of its own
 * (argoncursor.cs:20), so it is not argon's number to own */
export const CURSOR_SIZE = 28;
