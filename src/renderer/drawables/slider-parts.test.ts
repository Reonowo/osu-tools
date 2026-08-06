import { describe, expect, test } from "bun:test";
import { Sprite, Texture } from "pixi.js";
import type { RenderContext } from "../GameplayRenderer";
import { ArgonSliderBall } from "./slider-parts";

// slider-parts.ts's ball/follow-circle/reverse-arrow classes call
// ctx.textures.*Texture(...) in their constructors, which (for the real
// textures.ts) touch `document.createElement("canvas")` -- unavailable
// under bun test (see slider/body.test.ts's identical note for
// SliderBodyRenderer). stubbing ctx.textures lets the *real* class and its
// *real* methods run headlessly; only the actual canvas rasterisation is
// swapped out
function stubContext(): RenderContext {
  return {
    textures: {
      gradientCircleTexture: () => Texture.EMPTY,
      ringTexture: () => Texture.EMPTY,
      canvasTexture: () => Texture.EMPTY,
    },
  } as unknown as RenderContext;
}

describe("ArgonSliderBall icon scale (regression: Sprite.width/height are scale.set() sugar)", () => {
  test("setIconScale keeps the (0.6, 0.8) design aspect the constructor no longer bakes in", () => {
    const ball = new ArgonSliderBall(stubContext(), { r: 1, g: 1, b: 1, a: 1 });
    const icon = ball.view.children[2] as Sprite;
    expect(icon).toBeInstanceOf(Sprite);

    ball.setIconScale(1);
    // 48/64 * 0.6 = 0.45, 48/64 * 0.8 = 0.6 -- not the square (1,1) a naive
    // uniform scale.set(v) would have produced (the bug this pins)
    expect(icon.scale.x).toBeCloseTo(0.45, 9);
    expect(icon.scale.y).toBeCloseTo(0.6, 9);

    ball.setIconScale(0.5);
    expect(icon.scale.x).toBeCloseTo(0.225, 9);
    expect(icon.scale.y).toBeCloseTo(0.3, 9);
  });

  test("the pre-fix pattern really would have clobbered the aspect (proves the bug, not just the fix)", () => {
    // this is exactly what slider.ts used to do: this.ball.icon.scale.set(v)
    // -- a single scalar applied to both axes of a sprite whose width/height
    // had been set independently in the constructor
    const icon = new Sprite(Texture.EMPTY);
    icon.width = 28.8; // 48 * 0.6
    icon.height = 38.4; // 48 * 0.8
    expect(icon.scale.x).toBeCloseTo(28.8, 9);
    expect(icon.scale.y).toBeCloseTo(38.4, 9);

    icon.scale.set(1); // the old bug
    expect(icon.scale.x).toBe(1);
    expect(icon.scale.y).toBe(1); // aspect is gone -- both axes now equal
  });
});
