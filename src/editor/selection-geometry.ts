// pure selection geometry for the viewport tools: hit-testing and shape
// containment over frame points in osu!px, plus the sorted-unique set
// operations the selection semantics are written in. every function takes
// the candidate indices explicitly -- the candidate window is the caller's
// policy, geometry never widens it

import type { FrameDto } from "../lib/scene-types";

export interface PlayfieldPoint {
	x: number;
	y: number;
}

/** the nearest candidate frame within `radius` osu!px of the point, or null.
 * the boundary is inclusive; an exact distance tie resolves to the lower
 * index, so a duplicate-position run picks deterministically */
export function hitTestFrame(
	frames: readonly FrameDto[],
	candidates: readonly number[],
	point: PlayfieldPoint,
	radius: number
): number | null {
	let best: number | null = null;
	let bestDistSq = radius * radius;
	for (const index of candidates) {
		const frame = frames[index];
		if (frame === undefined) continue;
		const dx = frame.x - point.x;
		const dy = frame.y - point.y;
		const distSq = dx * dx + dy * dy;
		if (distSq < bestDistSq || (distSq === bestDistSq && best === null)) {
			best = index;
			bestDistSq = distSq;
		}
	}
	return best;
}

/** candidate frames within `radius` of the segment ab -- the brush sweep
 * between two pointer samples, so a drag faster than the event rate still
 * collects everything under the visible stroke. a degenerate segment (a
 * equals b) is the plain circle sweep. edge inclusive, like the hit test */
export function framesNearSegment(
	frames: readonly FrameDto[],
	candidates: readonly number[],
	a: PlayfieldPoint,
	b: PlayfieldPoint,
	radius: number
): number[] {
	const abX = b.x - a.x;
	const abY = b.y - a.y;
	const lengthSq = abX * abX + abY * abY;
	const radiusSq = radius * radius;
	return candidates.filter((index) => {
		const frame = frames[index];
		if (frame === undefined) return false;
		const t = lengthSq === 0 ? 0 : clamp01(((frame.x - a.x) * abX + (frame.y - a.y) * abY) / lengthSq);
		const dx = frame.x - (a.x + t * abX);
		const dy = frame.y - (a.y + t * abY);
		return dx * dx + dy * dy <= radiusSq;
	});
}

function clamp01(value: number): number {
	return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** candidate frames within `radius` of the point -- the brush sweep. edge
 * inclusive, like the hit test */
export function framesWithinRadius(
	frames: readonly FrameDto[],
	candidates: readonly number[],
	point: PlayfieldPoint,
	radius: number
): number[] {
	const radiusSq = radius * radius;
	return candidates.filter((index) => {
		const frame = frames[index];
		if (frame === undefined) return false;
		const dx = frame.x - point.x;
		const dy = frame.y - point.y;
		return dx * dx + dy * dy <= radiusSq;
	});
}

/** candidate frames whose point lies inside the rectangle spanned by two
 * corners (any order), edges inclusive. ascending because candidates are */
export function framesInRect(
	frames: readonly FrameDto[],
	candidates: readonly number[],
	a: PlayfieldPoint,
	b: PlayfieldPoint
): number[] {
	const minX = Math.min(a.x, b.x);
	const maxX = Math.max(a.x, b.x);
	const minY = Math.min(a.y, b.y);
	const maxY = Math.max(a.y, b.y);
	return candidates.filter((index) => {
		const frame = frames[index];
		if (frame === undefined) return false;
		return frame.x >= minX && frame.x <= maxX && frame.y >= minY && frame.y <= maxY;
	});
}

/** even-odd ray cast; the polygon closes itself (last point joins the first) */
function pointInPolygon(point: PlayfieldPoint, polygon: readonly PlayfieldPoint[]): boolean {
	let inside = false;
	for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
		const a = polygon[i];
		const b = polygon[j];
		const crosses = a.y > point.y !== b.y > point.y;
		if (crosses && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
	}
	return inside;
}

/** candidate frames inside a freeform polygon (concave shapes included) */
export function framesInPolygon(
	frames: readonly FrameDto[],
	candidates: readonly number[],
	polygon: readonly PlayfieldPoint[]
): number[] {
	if (polygon.length < 3) return [];
	return candidates.filter((index) => {
		const frame = frames[index];
		return frame !== undefined && pointInPolygon(frame, polygon);
	});
}

/** the shift-click semantic over a sorted-unique selection */
export function toggleIndex(selection: readonly number[], index: number): number[] {
	const at = selection.indexOf(index);
	if (at >= 0) return [...selection.slice(0, at), ...selection.slice(at + 1)];
	const out = [...selection, index];
	out.sort((a, b) => a - b);
	return out;
}

/** the shift-marquee/lasso semantic: sorted-unique union */
export function unionSelection(selection: readonly number[], indices: readonly number[]): number[] {
	const merged = new Set(selection);
	for (const index of indices) merged.add(index);
	return [...merged].sort((a, b) => a - b);
}
