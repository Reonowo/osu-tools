// playfield placement and object culling; pure math, no pixi imports

import { PLAYFIELD_SIZE_ADJUST } from "../engine/argon";

/** osuplayfieldadjustmentcontainer.cs: 4:3 fit, x0.8, centred; scale is
 * screen px per osu!px against the 512-wide base */
export function playfieldTransform(hostW: number, hostH: number) {
	const fitW = Math.min(hostW, hostH * (4 / 3)) * PLAYFIELD_SIZE_ADJUST;
	const scale = fitW / 512;
	return {
		scale,
		offsetX: (hostW - 512 * scale) / 2,
		offsetY: (hostH - 384 * scale) / 2
	};
}

// ---- viewport zoom and pan -------------------------------------------------
// the user's framing on top of the fit above. every function here is pure and
// takes the host box explicitly, so the interaction layer (Viewport.tsx) is
// the only thing that has to know a dom element exists

// the 512x384 playfield's centre, which is the point every zoom scales about
const PLAYFIELD_CENTRE_X = 256;
const PLAYFIELD_CENTRE_Y = 192;

/** the pannable area is the playfield plus this many osu!px on every side, so
 * an object sitting on the very edge can still be dragged clear of the
 * viewport border. 48 is the ceiling: the 0.8 fit leaves a fifth of the host
 * free on the constrained axis, which is 96 osu!px vertically, and the margin
 * is spent twice (once per side) -- anything wider would make maxViewportPan
 * non-zero at zoom 1 and let the playfield drift off centre unzoomed */
const PANNABLE_MARGIN = 32;
const PANNABLE_WIDTH = 512 + 2 * PANNABLE_MARGIN;
const PANNABLE_HEIGHT = 384 + 2 * PANNABLE_MARGIN;

export const VIEWPORT_ZOOM_MIN = 0.5;
export const VIEWPORT_ZOOM_MAX = 4;
export const DEFAULT_VIEWPORT_ZOOM = 1;
/** ten percentage points, the +/- buttons' step */
export const VIEWPORT_ZOOM_STEP = 0.1;

// readonly because NO_VIEWPORT_PAN below is one shared object: it is written
// into store state, into GameplayRenderer.pan, and returned by both
// resetViewport() and install(), so a single in-place `pan.x += dx` anywhere
// would silently rewrite the default framing for every scene from then on
export interface ViewportPan {
	readonly x: number;
	readonly y: number;
}

/** the framing every scene starts at, and what resetViewport restores */
export const NO_VIEWPORT_PAN: ViewportPan = { x: 0, y: 0 };

export function clampViewportZoom(zoom: number): number {
	if (!Number.isFinite(zoom)) return DEFAULT_VIEWPORT_ZOOM;
	return Math.min(Math.max(zoom, VIEWPORT_ZOOM_MIN), VIEWPORT_ZOOM_MAX);
}

/** one +/- click. the result is snapped to whole percent so a run of clicks
 * lands on round numbers rather than carrying whatever fraction a pointer
 * zoom left behind (and never accumulates binary-float dust) */
export function steppedViewportZoom(zoom: number, direction: 1 | -1): number {
	const stepped = clampViewportZoom(zoom) + direction * VIEWPORT_ZOOM_STEP;
	return clampViewportZoom(Math.round(stepped * 100) / 100);
}

/** the root container's transform under a user zoom and pan. at zoom 1 with
 * no pan this reduces exactly to playfieldTransform's offsetX/offsetY, which
 * is what makes 100% the framing the app has always drawn:
 *   (hostW / 2) - 256 * scale === (hostW - 512 * scale) / 2 */
export function viewportTransform(hostW: number, hostH: number, zoom: number, pan: ViewportPan) {
	const scale = playfieldTransform(hostW, hostH).scale * zoom;
	return {
		scale,
		x: hostW / 2 + pan.x - PLAYFIELD_CENTRE_X * scale,
		y: hostH / 2 + pan.y - PLAYFIELD_CENTRE_Y * scale
	};
}

/** how far each axis may pan before the pannable area's edge would come
 * inside the viewport's. zero on both axes until the area outgrows the host,
 * which the 0.8 fit means cannot happen at zoom 1 -- so the playfield stays
 * centred until the user actually zooms in */
export function maxViewportPan(hostW: number, hostH: number, zoom: number): ViewportPan {
	const scale = playfieldTransform(hostW, hostH).scale * zoom;
	return {
		x: Math.max(0, (PANNABLE_WIDTH * scale - hostW) / 2),
		y: Math.max(0, (PANNABLE_HEIGHT * scale - hostH) / 2)
	};
}

// the zero bound is special-cased rather than left to Math.min/Math.max: a
// negative pan clamped against -0 comes back as -0, which reads as "-0"
// wherever the pan is displayed or compared with Object.is
function clampPanAxis(pan: number, max: number): number {
	if (max <= 0) return 0;
	return Math.min(Math.max(pan, -max), max);
}

export function clampViewportPan(hostW: number, hostH: number, zoom: number, pan: ViewportPan): ViewportPan {
	const max = maxViewportPan(hostW, hostH, zoom);
	return { x: clampPanAxis(pan.x, max.x), y: clampPanAxis(pan.y, max.y) };
}

/** the pan that keeps the world point under `anchor` (host css pixels from
 * the viewport's top-left) pinned while the zoom changes. inverts the
 * transform at the old scale and re-applies it at the new one --
 *   position' = anchor - (anchor - position) / scale * scale'
 * -- then subtracts the zero-pan position the new scale would place, which is
 * the pan by definition */
export function anchoredZoomPan(
	hostW: number,
	hostH: number,
	zoom: number,
	pan: ViewportPan,
	nextZoom: number,
	anchor: { x: number; y: number }
): ViewportPan {
	const before = viewportTransform(hostW, hostH, zoom, pan);
	const centred = viewportTransform(hostW, hostH, nextZoom, NO_VIEWPORT_PAN);
	// a zero-size host (or a zero zoom, which the clamp rules out) has no world
	// point under the anchor to pin
	if (before.scale === 0) return pan;
	const ratio = centred.scale / before.scale;
	return {
		x: anchor.x - (anchor.x - before.x) * ratio - centred.x,
		y: anchor.y - (anchor.y - before.y) * ratio - centred.y
	};
}

// css pixels per wheel unit for the non-pixel delta modes, so a line-mode
// mouse wheel and a pixel-mode trackpad reach the same zoom for the same
// physical gesture
const WHEEL_LINE_PX = 16;
const WHEEL_PAGE_PX = 400;
/** one 100px notch -- the usual mouse-wheel detent -- is ten percent of zoom.
 * exponential rather than additive so a notch is the same *ratio* wherever
 * the zoom already sits, and so a trackpad's stream of small deltas composes
 * to exactly what one big delta would give */
const WHEEL_ZOOM_PER_NOTCH = 1.1;
/** no single event moves more than a notch and a half: some drivers batch a
 * flick into one enormous delta, which would otherwise cross the whole range */
const WHEEL_MAX_PX = 150;

/** the multiplier a ctrl+wheel event applies to the current zoom */
export function wheelZoomFactor(deltaY: number, deltaMode: number): number {
	if (!Number.isFinite(deltaY)) return 1;
	const px = deltaY * (deltaMode === 1 ? WHEEL_LINE_PX : deltaMode === 2 ? WHEEL_PAGE_PX : 1);
	const capped = Math.min(Math.max(px, -WHEEL_MAX_PX), WHEEL_MAX_PX);
	// wheel-up carries a negative deltaY and zooms in
	return WHEEL_ZOOM_PER_NOTCH ** (-capped / 100);
}

// ---- texture density -------------------------------------------------------
// procedural art is baked once per size and then scaled by the root
// container, so the bake has to know how many device pixels an osu!px will
// actually occupy. quantised into buckets rather than tracked continuously:
// a bake is a canvas rasterisation plus a gpu upload, and a zoom gesture
// walks through hundreds of intermediate scales

/** canvas pixels per osu!px a texture may be baked at */
export const DENSITY_BUCKETS = [2, 3, 4, 6, 8] as const;
export type DensityBucket = (typeof DENSITY_BUCKETS)[number];

/** device pixels per osu!px the playfield actually draws at: the backing
 * store's ratio times the root container's own scale, which is
 * playfieldTransform's fit scale multiplied by the user's zoom */
export function textureDensity(devicePixelRatio: number, playfieldScale: number, zoom: number): number {
	return devicePixelRatio * playfieldScale * zoom;
}

/** the smallest bucket that covers `density`, so art is never magnified past
 * the size it was baked at. densities past the last bucket clamp to it -- the
 * alternative is an unbounded bake for a zoom nobody can read anyway */
export function densityBucket(density: number): DensityBucket {
	// a zero-size host mid-mount makes the scale 0, and NaN would otherwise
	// fail every comparison and fall through to the largest bake
	if (Number.isNaN(density)) return DENSITY_BUCKETS[0];
	return DENSITY_BUCKETS.find((bucket) => bucket >= density) ?? DENSITY_BUCKETS[DENSITY_BUCKETS.length - 1];
}

export interface LifetimeEntry {
	appear: number;
	vanish: number;
}

/** the drawable's alive window. vanish keys off the latest judgement event
 * rather than endTime alone: a late-hit circle's explosion is anchored at
 * the resolved event time (circle-tracks.ts), which can trail startTime by
 * up to the hit window, and culling at endTime would truncate its fade */
export function objectLifetime(
	obj: { startTime: number; preempt: number; endTime: number },
	events: { time: number }[],
	fadeOut: number
): LifetimeEntry {
	const lastEventTime = events.reduce((last, e) => Math.max(last, e.time), obj.endTime);
	return { appear: obj.startTime - obj.preempt, vanish: lastEventTime + fadeOut };
}

/** incremental alive-window tracker: o(new + expired) per forward frame,
 * full rebuild on backward seeks. indices refer to the constructor array */
export class ActiveSetTracker {
	private readonly byAppear: number[];
	private readonly entries: LifetimeEntry[];
	private cursor = 0;
	private active = new Set<number>();
	private lastT = Number.NEGATIVE_INFINITY;

	constructor(entries: LifetimeEntry[]) {
		this.entries = entries;
		this.byAppear = entries.map((_, i) => i).sort((a, b) => entries[a].appear - entries[b].appear);
	}

	update(t: number): { added: number[]; removed: number[] } {
		if (t < this.lastT) {
			const removed = [...this.active];
			this.cursor = 0;
			this.active.clear();
			// lastT must move to t before recursing: otherwise the recursive call
			// re-enters this same backward-seek branch against the stale lastT
			// and never reaches the forward scan below, recursing forever
			this.lastT = t;
			const result = this.update(t);
			// entries alive both before and after the rebuild stay "added" once:
			// callers destroy on removed and create on added, so report the full swap
			return { added: result.added, removed: removed.filter((i) => !result.added.includes(i)) };
		}
		this.lastT = t;

		const added: number[] = [];
		const removed: number[] = [];
		while (this.cursor < this.byAppear.length && this.entries[this.byAppear[this.cursor]].appear <= t) {
			const index = this.byAppear[this.cursor++];
			if (this.entries[index].vanish > t) {
				this.active.add(index);
				added.push(index);
			}
		}
		for (const index of this.active) {
			if (this.entries[index].vanish <= t) {
				this.active.delete(index);
				removed.push(index);
			}
		}
		return { added, removed };
	}
}

/** reconciles a per-object drawable map against an active-set delta
 * (ActiveSetTracker.update's return shape): destroys everything in
 * `removed`, and creates everything in `added` that the map doesn't
 * already hold. the "already holds" check is required, not defensive --
 * a backward-seek rebuild reports an object in `added` without a matching
 * `removed` whenever it was alive both before and after the seek (see
 * ActiveSetTracker.update's rebuild branch), so a caller that unconditionally
 * (re)creates every `added` index would overwrite the map entry without
 * destroying the drawable it replaces, leaking its view/GPU resources on
 * every backward seek */
export function reconcileActiveDrawables<T>(
	map: Map<number, T>,
	delta: { added: number[]; removed: number[] },
	create: (index: number) => T | null,
	destroy: (drawable: T) => void
): void {
	for (const index of delta.removed) {
		const drawable = map.get(index);
		if (drawable !== undefined) destroy(drawable);
		map.delete(index);
	}
	for (const index of delta.added) {
		if (map.has(index)) continue;
		const drawable = create(index);
		if (drawable !== null) map.set(index, drawable);
	}
}
