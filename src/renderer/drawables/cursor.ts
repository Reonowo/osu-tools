// argon cursor + trail. citations: argoncursor.cs:16-80 (visual; the dot's
// glow is additive per compositedrawable.drawnode.cs:142, EdgeEffectType.Glow),
// skinnablecursor.cs:9-30 (press-expand), osucursor.cs:25 (size),
// osuconfigmanager.cs:115-117 (cursor scale fixed at 1.0 by default),
// cursortrail.cs + argoncursortrail.cs (distance-interval parts, additive
// 0.8, pow-4 fade). cursortrail.cs's actual vertex/fragment shader
// (sh_CursorTrail.vs/.fs) lives in an osu-framework nupkg, not the pinned
// source checkout -- the fade formula below is inlined from the task brief,
// cross-checked against cursortrail.cs's C#-side FadeClock/FadeExponent wiring

import { Container, Sprite } from "pixi.js";
import { CURSOR_SIZE } from "../../engine/argon";
import { darken, fromHex, toNumber } from "../../engine/color";
import { outElasticHalf, outQuad } from "../../engine/easing";
import { cursorStateAt } from "../../engine/interpolation";
import { isLeft, isRight } from "../../engine/buttons";
import { jump, trackValueAt, tween, type Track } from "../../engine/transforms";
import type { FrameDto } from "../../lib/scene-types";
import type { ObjectDrawable, RenderContext } from "../GameplayRenderer";

export function holdIntervals(frames: FrameDto[]): { start: number; end: number }[] {
  const intervals: { start: number; end: number }[] = [];
  let openStart: number | null = null;
  for (const frame of frames) {
    const held = isLeft(frame.buttons) || isRight(frame.buttons);
    if (held && openStart === null) openStart = frame.time;
    if (!held && openStart !== null) {
      intervals.push({ start: openStart, end: frame.time });
      openStart = null;
    }
  }
  if (openStart !== null) intervals.push({ start: openStart, end: Number.POSITIVE_INFINITY });
  return intervals;
}

/** skinnablecursor.cs:14-23 -- Expand() unconditionally jumps ExpandTarget to
 * 1 first (a duration-less ScaleTo is an instant set), *then* queues the
 * elastic tween to 1.2 over 400ms OutElasticHalf; Contract() tweens back to
 * 1 over 400ms OutQuad, starting from whatever the *current* value actually
 * is at that moment. every interval is independent (start/end come straight
 * from the hold span, never a fixed timestamp shared across intervals), so
 * there is no cross-interval track-resurrection risk: trackValueAt's
 * "greatest start <= t" selection always lands on the current interval's
 * own tracks.
 *
 * a same-instant press+release (`start === end`, the duplicate-time-run
 * shape interpolation.ts already treats as real input -- two frames sharing
 * one timestamp, one pressed and one not) is the one degenerate case within
 * a single interval: naively pushing all three tracks lets the release tween
 * tie the press tween's start and win (later-in-array wins ties), snapping
 * the value to 1.2 and easing it back down as if a real press-and-hold had
 * just ended, even though nothing was ever visibly expanded. tracing
 * Expand()/Contract() by hand: Expand()'s instant jump lands the value at 1
 * with zero elapsed time, then Contract() immediately starts its own tween
 * *from that already-1 value* (ScaleTo always samples the drawable's current
 * value as its start) -- so it eases 1 -> 1, i.e. nothing moves. the fix
 * below reproduces that by emitting only the jump for a zero-duration
 * interval, skipping both tweens entirely */
export function expandTracks(intervals: { start: number; end: number }[]): Track[] {
  const tracks: Track[] = [];
  for (const { start, end } of intervals) {
    tracks.push(jump(start, 1));
    if (start === end) continue;
    const press = tween(start, 400, 1, 1.2, outElasticHalf);
    tracks.push(press);
    if (Number.isFinite(end)) {
      // contract()'s scaleto samples the current value: a release mid-
      // expansion eases down from wherever the elastic actually got to,
      // never from an assumed-complete 1.2
      tracks.push(tween(end, 400, trackValueAt([press], end, 1), 1, outQuad));
    }
  }
  return tracks;
}

// argoncursor.cs:33,49 -- fixed pixel border thicknesses (unlike the default
// skin's cursor, argon's aren't relative to CURSOR_SIZE)
const RING_BORDER_OUTER = 6;
const RING_BORDER_INNER = 2;
/** argoncursor.cs:68 -- the centre dot's Scale, relative to the 28px cursor */
const DOT_RELATIVE_SCALE = 0.2;
/** argoncursor.cs:73 -- EdgeEffectParameters.Radius on the dot's glow */
const DOT_GLOW_RADIUS = 20;
/** bake the ring texture at 2x so its edges stay crisp */
const TEXTURE_SCALE = 2;

/** osuconfigmanager.cs:115,117 -- GameplayCursorSize defaults to 1.0 and
 * AutoCursorSize defaults to false, so OsuCursor.CalculateCursorScale() is
 * always 1 for an unmodded replay viewer */
const CURSOR_SCALE = 1;
/** cursortrail.cs:129 -- FadeDuration */
const TRAIL_FADE_DURATION = 300;
/** argoncursortrail.cs:16 -- FadeExponent override (base CursorTrail is 1.7) */
const TRAIL_FADE_EXPONENT = 4;
/** argoncursortrail.cs:26 -- Alpha */
const TRAIL_BASE_ALPHA = 0.8;
/** argoncursortrail.cs:22 -- Scale = 0.8/Texture.ScaleAdjust, folded with an
 * assumed 64 osu!px DisplayWidth stand-in for the real Cursor/cursortrail
 * texture (not present in the pinned checkout; see the task brief) */
const TRAIL_PART_SIZE = 64 * 0.8;
/** cursortrail.cs:201 -- interval = Texture.DisplayWidth * CursorScale.X / 2.5 * IntervalMultiplier;
 * argoncursortrail.cs:14 -- IntervalMultiplier override is 0.4 (base is 1.0) */
const TRAIL_INTERVAL = (64 * CURSOR_SCALE) / 2.5 * 0.4;
/** ample for a ~300ms fade window at ~10.24 osu!px spacing; spawnPart falls
 * back to recycling the oldest live part if this is ever exceeded */
const TRAIL_POOL = 256;
const SEEK_RESET_MS = 200;

/** true when playback should discard the trail instead of extending it: a
 * backward seek, or a forward jump bigger than the reset threshold. a seek
 * is not cursor movement -- cursortrail.cs's AddTrail assumes a continuous
 * stream of mouse-move events, which scrubbing does not produce */
export function isTrailReset(lastT: number | null, t: number, threshold: number): boolean {
  return lastT === null || t < lastT || t - lastT > threshold;
}

/** cursortrail.cs:179-226 -- points spaced `interval` apart along the
 * straight segment from `from` to `to`, matching `for (d = interval; d <
 * stopAt; d += interval)` with `stopAt == distance` (AvoidDrawingNearCursor
 * is false for both the default and argon trails). `next` is the last spawn
 * point (or `from` if nothing spawned this call), so leftover sub-interval
 * distance carries into the following call exactly like the source's
 * `lastPosition` field, which the loop only reassigns on an actual spawn */
export function advanceTrail(
  from: [number, number], to: [number, number], interval: number,
): { spawns: [number, number][]; next: [number, number] } {
  const [x1, y1] = from;
  const [x2, y2] = to;
  const dx = x2 - x1, dy = y2 - y1;
  const distance = Math.hypot(dx, dy);
  const spawns: [number, number][] = [];
  // guard the division, not just as a shortcut: at distance === interval
  // exactly, `d = interval` already fails the loop's own `d < distance`, so
  // running the loop unconditionally still yields zero spawns -- the guard
  // only exists to avoid dividing by a zero distance
  if (distance >= interval) {
    const dirX = dx / distance, dirY = dy / distance;
    for (let d = interval; d < distance; d += interval) spawns.push([x1 + dirX * d, y1 + dirY * d]);
  }
  return { spawns, next: spawns.length > 0 ? spawns[spawns.length - 1] : from };
}

/** the trail shader's pow(clamp(m_Time - g_FadeClock, 0, 1), g_FadeExponent)
 * times the base alpha (argoncursortrail.cs:26); `age` is already
 * normalized to fade duration, i.e. (t - bornAt) / TRAIL_FADE_DURATION */
export function trailAlpha(age: number): number {
  return TRAIL_BASE_ALPHA * Math.max(0, Math.min(1, 1 - age)) ** TRAIL_FADE_EXPONENT;
}

interface TrailPart {
  sprite: Sprite;
  bornAt: number;
}

export class CursorDrawable implements ObjectDrawable {
  readonly view = new Container();
  /** the ring/dot piece, repositioned to the live cursor position every
   * frame (see update()) */
  private readonly cursorSprite = new Container();
  private readonly expandTarget = new Container();
  /** trail parts are positioned in the same absolute playfield space they
   * were spawned in, so this container is never itself moved -- unlike
   * cursorSprite, it stays a direct child of the unmoved `view` */
  private readonly trailLayer = new Container();
  private readonly expand: Track[];
  private readonly frames: FrameDto[];
  private readonly parts: TrailPart[] = [];
  private readonly pool: Sprite[] = [];
  private lastT: number | null = null;
  private lastPos: [number, number] | null = null;

  constructor(private readonly ctx: RenderContext) {
    this.frames = ctx.scene.frames;
    this.expand = expandTracks(holdIntervals(this.frames));

    // `view` itself is never repositioned and stays a real parent of both
    // pieces, so a single destroy() call releases everything -- attaching
    // trailLayer as a sibling straight to ctx.layers.cursor instead would
    // leave it outside this drawable's tracked view, relying on the
    // layer's own removeChildren() (a detach, not a destroy) for cleanup.
    // trailLayer is added first so the trail draws under the ring/dot
    this.view.addChild(this.trailLayer, this.cursorSprite);
    ctx.layers.cursor.addChild(this.view);

    // the cursor's own size and position are already in playfield osu!px;
    // unlike hit objects it does not apply renderPlan.scale -- CURSOR_SIZE
    // is a fixed UI constant (osucursor.cs:25), not CS-derived

    // ring stack: canvas-drawn CURSOR_SIZE box, supersampled by TEXTURE_SCALE
    const ring = new Sprite(ctx.textures.canvasTexture(
      CURSOR_SIZE * TEXTURE_SCALE, "argon-cursor", (c, size) => {
        const s = size / CURSOR_SIZE;
        const radius = CURSOR_SIZE / 2;
        // fill disc: fc618f darkened x0.625 at 0.4 alpha, spans the full ring (argoncursor.cs:37-42)
        const fill = darken(fromHex("FC618F"), 0.6);
        c.fillStyle = `rgba(${Math.round(fill.r * 255)}, ${Math.round(fill.g * 255)}, ${Math.round(fill.b * 255)}, 0.4)`;
        c.beginPath();
        c.arc(size / 2, size / 2, radius * s - 1, 0, Math.PI * 2);
        c.fill();
        // outer ring: 6px border, vertical gradient fc618f -> bb1a41 (argoncursor.cs:33-34)
        const gradient = c.createLinearGradient(0, 0, 0, size);
        gradient.addColorStop(0, "#FC618F");
        gradient.addColorStop(1, "#BB1A41");
        c.strokeStyle = gradient;
        c.lineWidth = RING_BORDER_OUTER * s;
        c.beginPath();
        c.arc(size / 2, size / 2, (radius - RING_BORDER_OUTER / 2) * s, 0, Math.PI * 2);
        c.stroke();
        // inner white ring: 2px at 0.8 alpha, immediately inside the outer border (argoncursor.cs:49-50)
        c.strokeStyle = "rgba(255, 255, 255, 0.8)";
        c.lineWidth = RING_BORDER_INNER * s;
        c.beginPath();
        c.arc(size / 2, size / 2, (radius - RING_BORDER_OUTER - RING_BORDER_INNER / 2) * s, 0, Math.PI * 2);
        c.stroke();
      },
    ));
    ring.anchor.set(0.5);
    ring.width = ring.height = CURSOR_SIZE;
    this.expandTarget.addChild(ring);

    // centre dot: a fixed-size white core (argoncursor.cs:63-69) with an
    // additive cyan glow behind it (argoncursor.cs:70-75); the dot itself
    // is not a child of expandTarget, so it never scales on press
    const dotSize = CURSOR_SIZE * DOT_RELATIVE_SCALE;
    const glow = new Sprite(ctx.textures.glowTexture(128, (dotSize / 2) / (dotSize / 2 + DOT_GLOW_RADIUS)));
    glow.anchor.set(0.5);
    glow.width = glow.height = dotSize + 2 * DOT_GLOW_RADIUS;
    glow.tint = toNumber(fromHex("ABFFFF"));
    glow.alpha = 100 / 255; // argoncursor.cs:74 -- Color4(171, 255, 255, 100), a byte alpha
    glow.blendMode = "add"; // compositedrawable.drawnode.cs:142 -- EdgeEffectType.Glow blends additively
    const dot = new Sprite(ctx.textures.circleTexture(32));
    dot.anchor.set(0.5);
    dot.width = dot.height = dotSize;

    this.cursorSprite.addChild(this.expandTarget, glow, dot);
  }

  private spawnPart(x: number, y: number, bornAt: number, scale: number): void {
    let sprite = this.pool.pop();
    if (sprite === undefined) {
      if (this.parts.length >= TRAIL_POOL) {
        sprite = this.parts.shift()!.sprite;
      } else {
        sprite = new Sprite(this.ctx.textures.glowTexture(64, 0.1));
        sprite.anchor.set(0.5);
        sprite.blendMode = "add"; // argoncursortrail.cs:24 -- BlendingParameters.Additive
        this.trailLayer.addChild(sprite);
      }
    }
    sprite.visible = true;
    sprite.position.set(x, y);
    sprite.width = sprite.height = TRAIL_PART_SIZE * scale;
    this.parts.push({ sprite, bornAt });
  }

  private releasePart(index: number): void {
    const [part] = this.parts.splice(index, 1);
    part.sprite.visible = false;
    this.pool.push(part.sprite);
  }

  private releaseAllParts(): void {
    for (const part of this.parts) {
      part.sprite.visible = false;
      this.pool.push(part.sprite);
    }
    this.parts.length = 0;
  }

  update(t: number): void {
    const state = cursorStateAt(this.frames, t);
    if (state === null) return;
    this.cursorSprite.position.set(state.x, state.y);
    const expandScale = trackValueAt(this.expand, t, 1);
    this.expandTarget.scale.set(expandScale);

    if (isTrailReset(this.lastT, t, SEEK_RESET_MS)) {
      this.releaseAllParts();
      this.lastPos = [state.x, state.y];
    } else {
      const { spawns, next } = advanceTrail(this.lastPos!, [state.x, state.y], TRAIL_INTERVAL);
      for (const [x, y] of spawns) this.spawnPart(x, y, t, expandScale);
      this.lastPos = next;
    }
    this.lastT = t;

    for (let i = this.parts.length - 1; i >= 0; i--) {
      const age = (t - this.parts[i].bornAt) / TRAIL_FADE_DURATION;
      if (age >= 1) this.releasePart(i);
      else this.parts[i].sprite.alpha = trailAlpha(age);
    }
  }

  destroy(): void {
    // trailLayer is a child of view, so this one call releases every pooled
    // sprite (live and recycled alike -- recycled ones stay attached, just
    // hidden) plus the ring/glow/dot. nothing here is a raw Graphics with
    // its own GraphicsContext, so {children: true} alone is sufficient --
    // every piece is a Sprite over a cached texture.ts texture, which this
    // does not (and must not) destroy
    this.view.destroy({ children: true });
  }
}
