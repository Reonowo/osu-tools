import { describe, expect, test } from "bun:test";
import { SLIDER_BORDER_PORTION, SLIDER_PATH_RADIUS } from "./argon";
import { darken, rgba, withAlpha } from "./color";
import { bakeSliderLut, colourAt } from "./slider-lut";

describe("argon slider gradient (argonsliderbody.cs:40-47)", () => {
  const accent = withAlpha(rgba(1, 0.5, 0.25), 0.98); // body alpha baked into accent
  const border = rgba(1, 0.5, 0.25, 1);

  test("the border portion is exactly the outer 20%", () => {
    expect(SLIDER_BORDER_PORTION).toBe(0.2);
    expect(colourAt(0, accent, border)).toEqual(border);
    expect(colourAt(0.2, accent, border)).toEqual(border);
    const fill = colourAt(0.2000001, accent, border);
    expect(fill.r).toBeCloseTo(0.2, 6);       // darken(4) = ×0.2
    expect(fill.g).toBeCloseTo(0.1, 6);
    expect(fill.b).toBeCloseTo(0.05, 6);
    expect(fill.a).toBeCloseTo(0.98, 6);      // alpha preserved by darken
    expect(colourAt(1, accent, border)).toEqual(fill); // flat fill, no gradient
  });

  test("the baked lut matches smoothpath.cs:48-66", () => {
    const { width, rgba: data } = bakeSliderLut(accent, border, SLIDER_PATH_RADIUS);
    // (int)max(55.172, 1) * 2 = 110
    expect(width).toBe(110);
    expect(data.length).toBe(110 * 4);

    // texel 0: progress 0 -> alpha 0 (aa ramp), colour = border
    expect(data[0]).toBe(255);
    expect(data[3]).toBe(0);
    // texel 1: progress 1/109 ≈ 0.00917 -> alpha factor 0.4587
    expect(data[1 * 4 + 3]).toBe(Math.round(255 * 1 * Math.min(1 / 109 / 0.02, 1)));
    // texel 3: progress 3/109 ≈ 0.0275 -> ramp saturated, full border alpha
    expect(data[3 * 4 + 3]).toBe(255);
    // texel 21: progress 21/109 ≈ 0.1927 <= 0.2 -> still border
    expect(data[21 * 4 + 0]).toBe(255);
    // texel 22: progress 22/109 ≈ 0.2018 > 0.2 -> fill (accent × 0.2, alpha 0.98)
    expect(data[22 * 4 + 0]).toBe(Math.round(0.2 * 255));
    expect(data[22 * 4 + 1]).toBe(Math.round(0.1 * 255));
    expect(data[22 * 4 + 3]).toBe(Math.round(0.98 * 255));
    // last texel: spine, same flat fill
    expect(data[109 * 4 + 0]).toBe(Math.round(0.2 * 255));
  });

  test("darken clamps and preserves alpha (color4extensions.cs:113-129)", () => {
    const c = darken(rgba(0.5, 1, 0.1, 0.7), 0.5);
    expect(c.r).toBeCloseTo(0.5 / 1.5, 9);
    expect(c.g).toBeCloseTo(1 / 1.5, 9);
    expect(c.a).toBe(0.7);
  });
});
