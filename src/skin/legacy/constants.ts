// the legacy era's own constants -- this era's taste, cited to the pinned
// checkout. the sibling of `skin/argon/constants.ts`, and split from
// `engine/game-constants.ts` on the same line: a value here is one the OTHER
// era answers differently, never a ruleset or framework number.
//
// sizes are osu!px at cs-scale 1; multiply by the render plan's `scale` at draw
// time, exactly as argon's are

import { OBJECT_RADIUS } from "@/engine/game-constants";

/**
 * osulegacyskintransformer.cs:28 -- `LEGACY_CIRCLE_RADIUS`.
 *
 * stable's hit circles carry 5px of transparent padding on each side for
 * shadows, so the hittable area is 128px while the drawn circle is 118px. the
 * slider body is the one place that padding is NOT present, which is why the
 * body's ribbon is narrower than argon's and why its shadow portion is derived
 * from this rather than declared
 */
export const LEGACY_CIRCLE_RADIUS = OBJECT_RADIUS - 5;

/** osulegacyskintransformer.cs:38 -- `MAX_FOLLOW_CIRCLE_AREA_SIZE`, three
 * object diameters. some skins draw a follow circle with `sliderb` elements, so
 * the cap is shared by both rather than inlined at the follow circle */
export const MAX_FOLLOW_CIRCLE_AREA_SIZE = OBJECT_RADIUS * 2 * 3;

/** legacysliderbody.cs:35 -- the border's share of the ribbon */
export const LEGACY_SLIDER_BORDER_PORTION = 0.1875;

/** legacysliderbody.cs:34 -- the shadow's share, derived from the padding the
 * circle art carries and the body does not */
export const LEGACY_SLIDER_SHADOW_PORTION = 1 - LEGACY_CIRCLE_RADIUS / OBJECT_RADIUS;

/** legacysliderbody.cs:23 -- legacy skins use a CONSTANT track alpha whatever
 * the source colour was */
export const LEGACY_SLIDER_TRACK_ALPHA = 0.7;

/** legacysliderbody.cs:29 -- the shadow the ribbon's outermost band fades to */
export const LEGACY_SLIDER_SHADOW_ALPHA = 0.25;

/** legacymaincirclepiece.cs:166 -- `legacy_fade_duration`, the hit fade every
 * circle piece shares */
export const LEGACY_FADE_DURATION = 240;

/** legacymaincirclepiece.cs:174 -- the hit expansion */
export const LEGACY_HIT_SCALE = 1.4;

/** legacycursor.cs:16-17 -- the press expansion and its resting value */
export const LEGACY_CURSOR_PRESSED_SCALE = 1.3;
export const LEGACY_CURSOR_RELEASED_SCALE = 1;

/** defaultlegacyskin.cs:45 -- the classic floor's declared slider-ball colour,
 * the one custom colour lazer's DefaultLegacySkin ships */
export const CLASSIC_SLIDER_BALL: [number, number, number, number] = [2, 170, 255, 255];
/** legacycursor.cs:63,68 -- both directions run 100ms Easing.Out */
export const LEGACY_CURSOR_EXPAND_DURATION = 100;
/** legacycursor.cs:14 -- one full turn of the cursor sprite */
export const LEGACY_CURSOR_REVOLUTION_DURATION = 10000;

/**
 * nonplayfieldsprite.cs:23 -- the stable "magic ratio".
 *
 * the cursor and its trail are drawn INSIDE the playfield but were historically
 * not part of it, so lazer multiplies their `ScaleAdjust` by 1.6 to undo the
 * playfield container's own scale (osuplayfieldadjustmentcontainer.cs:57-68).
 * this renderer draws in playfield osu!px, so the same undo is a divide by this
 * at the two sites that sprite covers -- and nowhere else: a hit object's art
 * is playfield art and takes its texture's display size unmodified
 */
export const NON_PLAYFIELD_SCALE_ADJUST = 1.6;

/** legacycursortrail.cs:19 -- a disjoint trail adds one part per 60fps frame,
 * by TIME rather than by distance travelled */
export const DISJOINT_TRAIL_TIME_SEPARATION = 1000 / 60;
/** legacycursortrail.cs:66 -- the two fade lengths, picked by disjointness */
export const DISJOINT_TRAIL_FADE_DURATION = 150;
export const CONNECTED_TRAIL_FADE_DURATION = 500;
/** legacycursortrail.cs:67 -- FadeExponent, flat against argon's 4 */
export const LEGACY_TRAIL_FADE_EXPONENT = 1;

/** legacyspinner.cs:21 -- every spinner sprite is drawn at this */
export const SPINNER_SPRITE_SCALE = 0.625;
/** legacyspinner.cs:28,30 -- stable's gamefield space is shifted 16px down, and
 * these are already negated back into window space */
export const SPINNER_TOP_OFFSET = 45 - 16;
export const SPINNER_Y_CENTRE = SPINNER_TOP_OFFSET + 219;
/** legacyspinner.cs:54-55 -- the window-space box every spinner constant is
 * measured in, and where it sits relative to the playfield's own centre */
export const SPINNER_BOX_WIDTH = 640;
export const SPINNER_BOX_HEIGHT = 480;
export const SPINNER_BOX_Y_OFFSET = -8;
/** legacyoldstylespinner.cs:30 -- the metre's full height, already scaled */
export const SPINNER_FINAL_METRE_HEIGHT = 692 * SPINNER_SPRITE_SCALE;
/** legacyoldstylespinner.cs:115 -- how many bars the metre fills in */
export const SPINNER_METRE_BARS = 10;
/** legacyoldstylespinner.cs:44 -- the background's tint when the skin declares
 * no SpinnerBackground colour */
export const SPINNER_BACKGROUND_DEFAULT: [number, number, number, number] = [100, 100, 100, 255];
/** legacynewstylespinner.cs:30 -- the glow's fixed tint */
export const SPINNER_GLOW_COLOUR: [number, number, number, number] = [3, 151, 255, 255];
/** legacyspinner.cs:198, legacyoldstylespinner.cs:77 -- the approach circle's
 * own scale factor over the shared sprite scale, and where it shrinks to */
export const SPINNER_APPROACH_SCALE = 1.86;
export const SPINNER_APPROACH_END_SCALE = 0.1;

/** legacyfollowcircle.cs:31,41,56 -- the follow circle's own tracking sizes.
 * note the 2 rather than the ruleset's FOLLOW_AREA: legacy behaviour is that
 * the sprite is smaller than the area gameplay actually tracks over */
export const LEGACY_FOLLOW_PRESS_SCALE = 2;
export const LEGACY_FOLLOW_END_SCALE = 1.6;
export const LEGACY_FOLLOW_BREAK_SCALE = 4;
/** legacyfollowcircle.cs:15 -- follow circles are drawn at 2x the hit circle
 * resolution in legacy skins, so the content is halved before anything else */
export const LEGACY_FOLLOW_CONTENT_SCALE = 0.5;

/** legacyreversearrow.cs:94-95 -- the idle pulse's period and its rotation
 * swing, the latter only on version <= 1 skins */
export const LEGACY_REVERSE_PULSE_DURATION = 300;
export const LEGACY_REVERSE_PULSE_ROTATION = 5.625;
/** legacyreversearrow.cs:89-90 -- the hit expansion, capped at 300ms */
export const LEGACY_REVERSE_HIT_SCALE = 1.4;
export const LEGACY_REVERSE_HIT_MAX_DURATION = 300;
/** legacyreversearrow.cs:71 -- the default skin's arrow is dark on a bright
 * accent, expressed as a channel-sum threshold */
export const LEGACY_REVERSE_BRIGHT_THRESHOLD = 600 / 255;

/** legacyjudgementpieceold.cs:44-46 -- every legacy judgement shares one
 * envelope, whichever grade it is */
export const LEGACY_JUDGEMENT_FADE_IN = 120;
export const LEGACY_JUDGEMENT_FADE_OUT_DELAY = 500;
export const LEGACY_JUDGEMENT_FADE_OUT_LENGTH = 600;

/** drawableosujudgement.cs:82-83 -- hit lighting's own scale and fade, which
 * are the ruleset's rather than a skin's but only ever reach a lighting sprite,
 * so they live beside the element they animate */
export const HIT_LIGHTING_START_SCALE = 0.8;
export const HIT_LIGHTING_END_SCALE = 1.2;
export const HIT_LIGHTING_SCALE_DURATION = 600;
export const HIT_LIGHTING_FADE_IN = 200;
export const HIT_LIGHTING_HOLD = 200;
export const HIT_LIGHTING_FADE_OUT = 1000;

/** legacyskinextensions.cs:180 -- the hit circle font's default overlap when
 * the skin declares none */
export const DEFAULT_HIT_CIRCLE_OVERLAP = -2;
/** osulegacyskintransformer.cs:259 -- stable applies a blanket 0.8x to the
 * hit circle font */
export const HIT_CIRCLE_TEXT_SCALE = 0.8;
