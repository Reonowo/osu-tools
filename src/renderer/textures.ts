// procedural stand-ins for osu-resources bitmaps (plan decision 8) plus
// shared shape textures. all canvas-rendered once and cached, keyed by the
// density bucket they were baked at
//
// sizes here are *logical* osu!px: the caller asks for the size the sprite
// will occupy in playfield space and the current bucket decides how many
// canvas pixels back it. the texture carries that factor as its own
// `resolution`, so `texture.width` always reads back as the osu!px size that
// was asked for, whatever bucket baked it

import { Texture } from "pixi.js";
import { toCss, type Rgba } from "../engine/color";
import { DENSITY_BUCKETS, type DensityBucket } from "./playfield";

/** the widest canvas any procedural texture may bake to. 8x the 128 osu!px
 * hit circle lands exactly here; anything larger (the circle's flash glow,
 * which spans ~218 osu!px) drops to a lower factor rather than the bucket it
 * asked for -- a soft gradient loses nothing, and vram is not free */
const MAX_TEXTURE_DIM = 1024;

/** the approach circle's own, tighter cap. the sprite is drawn at up to 4x
 * the circle diameter when it spawns, so covering its full spawn size would
 * cost 2048+ px for the one frame it is most transparent; capping here
 * accepts slight softness at spawn and stays sharp where it converges */
const APPROACH_MAX_DIM = 512;

/** the approach ring's natural size: `defaultapproachcircle.cs` draws the
 * sprite at the circle diameter expanded by 128/118, and the visible ring
 * sits at 118/128 of the sprite */
export const APPROACH_CIRCLE_SIZE = 128;

const cache = new Map<string, Texture>();

let bucket: DensityBucket = DENSITY_BUCKETS[0];

/** the bucket every texture handed out right now is baked at */
export function currentDensityBucket(): DensityBucket {
	return bucket;
}

/** installs a new bake density, evicting everything baked at a bucket that is
 * now neither current nor previous -- the previous one is kept so that a
 * drawable built moments before the change still gets cache hits rather than
 * a second copy of everything. returns whether the bucket actually moved,
 * which is the caller's cue to rebuild the drawables that live for the whole
 * scene */
export function setDensityBucket(next: DensityBucket): boolean {
	if (next === bucket) return false;
	const previous = bucket;
	bucket = next;
	evictStaleBuckets(cache, [bucket, previous]);
	return true;
}

/** drops every accent-derived bake, whatever bucket it sits at.
 *
 * the combo accent is baked INTO the key (`grad:outer:<rgba>:...`), and the
 * accent is now a skin decision -- a colourless beatmap takes its palette from
 * whichever skin is active. bucket eviction cannot reach these: it keeps
 * everything at the current bucket regardless of which palette produced it, so
 * comparing a few skins over one replay would strand a full set of large
 * gradient canvases per palette for the process lifetime.
 *
 * released rather than destroyed, exactly as `evictStaleBuckets` releases: a
 * drawable baked moments ago may still be on screen for a frame, and pixi's
 * destroy() would null the source out from under it
 */
export function clearAccentTextures(): void {
	dropAccentBakes(cache);
}

/** the policy behind `clearAccentTextures`, over whatever map it is given --
 * the same split `evictStaleBuckets` makes, so it is testable without a gpu */
export function dropAccentBakes<T>(entries: Map<string, T>): void {
	for (const key of entries.keys()) {
		if (key.startsWith("grad:")) entries.delete(key);
	}
}

/** cache keys are density-scoped: the same shape at two buckets is two
 * textures, and eviction reads the bucket back off the key */
export function bucketedKey(key: string, atBucket: number): string {
	return `${key}:b${atBucket}`;
}

/** the bucket a cache key was baked at, or null if the key carries no
 * `:bN` suffix (which no key this module writes ever lacks) */
export function bucketOfKey(key: string): number | null {
	const suffix = /:b(\d+)$/.exec(key);
	return suffix === null ? null : Number(suffix[1]);
}

/** drops every entry whose key is not one of `keep`'s buckets, so nothing
 * baked at a dead density is ever handed out again. pure over the map it is
 * given, which is what makes the policy testable without a gpu
 *
 * dropped textures are *released*, not destroyed: a per-object drawable
 * created two buckets ago can still be on screen (a long slider outlives
 * several zoom steps), and pixi's destroy() nulls the source's resource --
 * the next frame that drew such a sprite would throw inside the uploader.
 * their vram comes back through pixi's gc instead (see canvasTexture's
 * autoGarbageCollect), and the canvas behind one goes when the last sprite
 * holding it does */
export function evictStaleBuckets<T>(entries: Map<string, T>, keep: readonly number[]): void {
	for (const key of entries.keys()) {
		const at = bucketOfKey(key);
		if (at === null || !keep.includes(at)) entries.delete(key);
	}
}

/** the canvas a logical size bakes to, and the factor that canvas is sampled
 * at. the side is always an exact multiple of the factor: pixi divides the
 * canvas back down by the source resolution to recover the logical size and
 * multiplies it out again, and a canvas whose width does not survive that
 * round trip bit-for-bit gets *reassigned* -- which blanks everything drawn
 * on it (CanvasSource.resizeCanvas) */
export function bakedTextureSize(
	logicalSizePx: number,
	atBucket: number,
	maxDimensionPx = MAX_TEXTURE_DIM
): { canvasPx: number; scale: number } {
	const logical = Number.isFinite(logicalSizePx) ? Math.max(1, Math.ceil(logicalSizePx)) : 1;
	const scale = Math.max(1, Math.min(atBucket, Math.floor(maxDimensionPx / logical)));
	return { canvasPx: logical * scale, scale };
}

export function canvasTexture(
	logicalSizePx: number,
	key: string,
	draw: (ctx: CanvasRenderingContext2D, size: number) => void,
	maxDimensionPx = MAX_TEXTURE_DIM
): Texture {
	const cacheKey = bucketedKey(key, bucket);
	const hit = cache.get(cacheKey);
	if (hit !== undefined) return hit;
	const { canvasPx, scale } = bakedTextureSize(logicalSizePx, bucket, maxDimensionPx);
	const canvas = document.createElement("canvas");
	canvas.width = canvasPx;
	canvas.height = canvasPx;
	const ctx = canvas.getContext("2d")!;
	draw(ctx, canvasPx);
	// mipmaps are worth it here and only here: these are static, cached for
	// the scene's lifetime, and routinely minified (a 4x-bucket circle drawn
	// at cs-scale 0.8 samples well under 1:1). pixi skips generation by itself
	// on a context without non-power-of-two mipmap support
	//
	// autoGarbageCollect (off by default on a canvas source) is what returns an
	// evicted texture's vram: pixi's own gc unloads any opted-in source left
	// unused for a minute and re-uploads it from the canvas if it is ever
	// wanted again -- so eviction never has to destroy() a texture a drawable
	// might still be holding
	//
	// skipCache: pixi's global asset Cache would key this by the canvas and
	// hold both forever, and this module is already the cache. bypassing it is
	// what lets an evicted texture actually become collectable
	const texture = Texture.from(
		{
			resource: canvas,
			resolution: scale,
			scaleMode: "linear",
			autoGenerateMipmaps: true,
			autoGarbageCollect: true
		},
		true
	);
	cache.set(cacheKey, texture);
	return texture;
}

/** white disc with a hard core and (1-k)^2 falloff beyond it -- mirrors the
 * framework glow's linear ramp raised to alphaexponent 2 */
export function glowTexture(diameterPx: number, hardFraction: number): Texture {
	return canvasTexture(diameterPx, `glow:${diameterPx}:${hardFraction}`, (ctx, size) => {
		const half = size / 2;
		const gradient = ctx.createRadialGradient(half, half, 0, half, half, half);
		gradient.addColorStop(0, "rgba(255,255,255,1)");
		gradient.addColorStop(hardFraction, "rgba(255,255,255,1)");
		for (let i = 1; i <= 8; i++) {
			const k = i / 8;
			const alpha = (1 - k) ** 2;
			gradient.addColorStop(hardFraction + (1 - hardFraction) * k, `rgba(255,255,255,${alpha})`);
		}
		ctx.fillStyle = gradient;
		ctx.fillRect(0, 0, size, size);
	});
}

export function circleTexture(diameterPx: number): Texture {
	return canvasTexture(diameterPx, `circle:${diameterPx}`, (ctx, size) => {
		ctx.fillStyle = "#fff";
		ctx.beginPath();
		// the inset stays one canvas pixel at every bucket: it exists to keep
		// the antialiased rim inside the bitmap, not to model anything
		ctx.arc(size / 2, size / 2, size / 2 - 1, 0, Math.PI * 2);
		ctx.fill();
	});
}

/** ring stroked inward from the outer edge, matching maskedborder semantics */
export function ringTexture(diameterPx: number, thicknessPx: number): Texture {
	return canvasTexture(diameterPx, `ring:${diameterPx}:${thicknessPx}`, (ctx, size) => {
		const scale = size / diameterPx;
		ctx.strokeStyle = "#fff";
		ctx.lineWidth = thicknessPx * scale;
		ctx.beginPath();
		ctx.arc(size / 2, size / 2, size / 2 - (thicknessPx * scale) / 2 - 0.5, 0, Math.PI * 2);
		ctx.stroke();
	});
}

export function gradientCircleTexture(diameterPx: number, key: string, top: Rgba, bottom: Rgba): Texture {
	return canvasTexture(diameterPx, `grad:${key}:${diameterPx}`, (ctx, size) => {
		const gradient = ctx.createLinearGradient(0, 0, 0, size);
		gradient.addColorStop(0, toCss(top));
		gradient.addColorStop(1, toCss(bottom));
		ctx.fillStyle = gradient;
		ctx.beginPath();
		ctx.arc(size / 2, size / 2, size / 2 - 0.5, 0, Math.PI * 2);
		ctx.fill();
	});
}

/** stand-in for osu-resources' gameplay/osu/approachcircle: the visible ring
 * sits at 118/128 of the sprite (defaultapproachcircle.cs:28-32). the stroke
 * geometry is written in osu!px of that 128 sprite and scaled to whatever
 * canvas the bucket (under APPROACH_MAX_DIM) baked */
export function approachCircleTexture(): Texture {
	return canvasTexture(
		APPROACH_CIRCLE_SIZE,
		"approach",
		(ctx, size) => {
			const scale = size / APPROACH_CIRCLE_SIZE;
			const half = size / 2;
			ctx.strokeStyle = "#fff";
			ctx.lineWidth = 4.5 * scale;
			ctx.filter = `blur(${0.5 * scale}px)`;
			ctx.beginPath();
			ctx.arc(half, half, half * (118 / 128) - 2.25 * scale, 0, Math.PI * 2);
			ctx.stroke();
		},
		APPROACH_MAX_DIM
	);
}
