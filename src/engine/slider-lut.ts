// argon's slider gradient: argonsliderbody.cs's colourat baked through
// smoothpath.cs's 1-d texture generation. u=0 is the ribbon's outer edge,
// u=1 the spine

import { LUT_AA_PORTION, SLIDER_BORDER_PORTION } from "./argon";
import { darken, type Rgba } from "./color";

/** argonsliderbody.cs:40-46 -- solid border outside, flat darken(4) fill
 * inside; accent's alpha already carries bodyalpha (0.98) */
export function colourAt(position: number, accent: Rgba, border: Rgba): Rgba {
  // the != 0 check mirrors argonsliderbody.cs:42, where calculatedborderportion
  // is skin-configurable and can be zero; here slider_border_portion is a
  // fixed 0.2 literal so this branch is always taken, but the guard stays to
  // keep the port structurally aligned with the c# source
  if (SLIDER_BORDER_PORTION !== 0 && position <= SLIDER_BORDER_PORTION) return border;
  return darken(accent, 4);
}

/** smoothpath.cs:48-66 -- width (int)max(radius,1)*2, alpha ramped over the
 * outer aa_portion of u */
export function bakeSliderLut(
  accent: Rgba,
  border: Rgba,
  pathRadius: number,
): { width: number; rgba: Uint8Array } {
  const width = Math.trunc(Math.max(pathRadius, 1)) * 2;
  const data = new Uint8Array(width * 4);
  for (let i = 0; i < width; i++) {
    const progress = i / (width - 1);
    const c = colourAt(progress, accent, border);
    const alpha = c.a * Math.min(progress / LUT_AA_PORTION, 1);
    data[i * 4] = Math.round(c.r * 255);
    data[i * 4 + 1] = Math.round(c.g * 255);
    data[i * 4 + 2] = Math.round(c.b * 255);
    data[i * 4 + 3] = Math.round(alpha * 255);
  }
  return { width, rgba: data };
}
