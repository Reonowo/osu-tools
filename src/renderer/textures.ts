// procedural stand-ins for osu-resources bitmaps (plan decision 8) plus
// shared shape textures. all canvas-rendered once and cached

import { Texture } from "pixi.js";
import { toCss, type Rgba } from "../engine/color";

const cache = new Map<string, Texture>();

export function canvasTexture(
	sizePx: number,
	key: string,
	draw: (ctx: CanvasRenderingContext2D, size: number) => void
): Texture {
	const hit = cache.get(key);
	if (hit !== undefined) return hit;
	const canvas = document.createElement("canvas");
	canvas.width = sizePx;
	canvas.height = sizePx;
	const ctx = canvas.getContext("2d")!;
	draw(ctx, sizePx);
	const texture = Texture.from(canvas);
	cache.set(key, texture);
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
 * sits at 118/128 of the sprite (defaultapproachcircle.cs:28-32) */
export function approachCircleTexture(): Texture {
	return canvasTexture(256, "approach", (ctx, size) => {
		const half = size / 2;
		ctx.strokeStyle = "#fff";
		ctx.lineWidth = 9;
		ctx.filter = "blur(1px)";
		ctx.beginPath();
		ctx.arc(half, half, half * (118 / 128) - 4.5, 0, Math.PI * 2);
		ctx.stroke();
	});
}
