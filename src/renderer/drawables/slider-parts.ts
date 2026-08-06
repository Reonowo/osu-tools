// argon slider companions: ball, follow circle, tick, reverse arrow.
// sizes cited: argonsliderball.cs (outer_gradient_size body, gradient
// thickness border, 48px chevron at (0.6,0.8)), argonfollowcircle.cs
// (border 4, fill alpha 0.3, additive), argonsliderscorepoint.cs (12px,
// border 3), argonreversearrow.cs (40x20 capsule, 16px double chevron)

import { Container, Graphics, Sprite } from "pixi.js";
import { GRADIENT_THICKNESS, OUTER_GRADIENT_SIZE } from "../../engine/argon";
import { darken, toNumber, type Rgba } from "../../engine/color";
import type { RenderContext } from "../GameplayRenderer";

/** the chevron glyphs are baked onto a square canvas this many px across */
const CHEVRON_TEXTURE_SIZE = 64;

/** canvas-drawn chevron glyphs (decision 8): ">" and ">>" strokes */
function chevronTexture(ctx: RenderContext, key: string, double: boolean) {
  return ctx.textures.canvasTexture(CHEVRON_TEXTURE_SIZE, `chevron:${key}`, (c, size) => {
    c.strokeStyle = "#fff";
    c.lineWidth = size / 6;
    c.lineCap = "round";
    c.lineJoin = "round";
    const draw = (x: number) => {
      c.beginPath();
      c.moveTo(x - size / 8, size / 4);
      c.lineTo(x + size / 8, size / 2);
      c.lineTo(x - size / 8, (3 * size) / 4);
      c.stroke();
    };
    if (double) { draw(size * 0.4); draw(size * 0.65); }
    else draw(size / 2);
  });
}

/** argonsliderball.cs:24 -- the icon's 48px box, scaled to (0.6, 0.8) */
const ICON_SIZE = 48;
const ICON_ASPECT = { x: 0.6, y: 0.8 };

export class ArgonSliderBall {
  readonly view = new Container();
  private readonly fill: Sprite;
  private readonly icon: Sprite;

  constructor(ctx: RenderContext, accent: Rgba) {
    const key = toNumber(accent).toString(16);
    this.fill = new Sprite(ctx.textures.gradientCircleTexture(
      Math.round(OUTER_GRADIENT_SIZE * 2), `ball:${key}`, accent, darken(accent, 0.5)));
    this.fill.anchor.set(0.5);
    this.fill.width = this.fill.height = OUTER_GRADIENT_SIZE;

    const ring = new Sprite(ctx.textures.ringTexture(
      Math.round(OUTER_GRADIENT_SIZE * 2), GRADIENT_THICKNESS * 2));
    ring.anchor.set(0.5);
    ring.width = ring.height = OUTER_GRADIENT_SIZE;

    this.icon = new Sprite(chevronTexture(ctx, "single", false));
    this.icon.anchor.set(0.5);

    this.view.addChild(this.fill, ring, this.icon);
  }

  /** fill/ring stay upright; only the icon takes the travel rotation
   * (argonsliderball.cs:107-114) */
  setRotation(radians: number): void {
    this.icon.rotation = radians;
  }

  /** folds both the design aspect ratio and the chevron's baked-texture
   * size into the animated 0->1 scale factor -- Sprite.width/height are
   * pure scale.set() sugar (pixi's Sprite.js), so any later scale.set()
   * call must include this ratio itself or it clobbers the (0.6, 0.8)
   * aspect and the texture-to-design-size ratio entirely */
  setIconScale(v: number): void {
    const base = ICON_SIZE / CHEVRON_TEXTURE_SIZE;
    this.icon.scale.set(base * ICON_ASPECT.x * v, base * ICON_ASPECT.y * v);
  }
}

export class ArgonFollowCircle {
  readonly view = new Container();

  constructor(ctx: RenderContext, accent: Rgba) {
    const key = toNumber(accent).toString(16);
    const fill = new Sprite(ctx.textures.gradientCircleTexture(
      Math.round(OUTER_GRADIENT_SIZE * 2), `follow:${key}`, accent, darken(accent, 0.5)));
    fill.anchor.set(0.5);
    fill.width = fill.height = OUTER_GRADIENT_SIZE;
    fill.alpha = 0.3;
    const ring = new Sprite(ctx.textures.ringTexture(Math.round(OUTER_GRADIENT_SIZE * 2), 4 * 2));
    ring.anchor.set(0.5);
    ring.width = ring.height = OUTER_GRADIENT_SIZE;
    ring.tint = toNumber(accent);
    this.view.addChild(fill, ring);
    this.view.blendMode = "add";
  }
}

export class ArgonTick {
  readonly view: Graphics;

  constructor(accent: Rgba) {
    this.view = new Graphics().circle(0, 0, 6).stroke({ width: 3, color: toNumber(accent), alignment: 1 });
  }
}

export class ArgonReverseArrow {
  readonly view = new Container();
  readonly main = new Container();
  readonly icon: Sprite;

  constructor(ctx: RenderContext, accent: Rgba) {
    const capsule = new Graphics().roundRect(-20, -10, 40, 20, 10).fill(0xffffff);
    this.icon = new Sprite(chevronTexture(ctx, "double", true));
    this.icon.anchor.set(0.5);
    this.icon.width = this.icon.height = 16;
    this.icon.tint = toNumber(darken(accent, 4));
    this.main.addChild(capsule, this.icon);
    this.view.addChild(this.main);
  }
}
