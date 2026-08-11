// the detail tier's window model. the overview strip always maps the whole
// replay; the detail lanes map a span centred on the playhead, and this is
// the maths that keeps that span inside the bounds and rules it

import { fractionFor, type TimeBounds } from "./timeline";

export interface TimeWindow {
	start: number;
	end: number;
}

/** the tightest detail span, in ms -- roughly fifteen frames across */
export const MIN_SPAN_MS = 250;

export function clampSpan(bounds: TimeBounds, spanMs: number): number {
	const full = Math.max(0, bounds.maxTime - bounds.minTime);
	if (full <= 0) return MIN_SPAN_MS;
	return Math.min(full, Math.max(MIN_SPAN_MS, spanMs));
}

/** the window is centred on `centre` and slid -- never shrunk -- back inside
 * the bounds, so the visible span stays constant as the playhead reaches
 * either end and the lanes do not appear to zoom on their own */
export function windowAround(bounds: TimeBounds, centre: number, spanMs: number): TimeWindow {
	const span = clampSpan(bounds, spanMs);
	let start = centre - span / 2;
	if (start < bounds.minTime) start = bounds.minTime;
	if (start + span > bounds.maxTime) start = bounds.maxTime - span;
	return { start, end: start + span };
}

// one 100px ctrl+wheel notch over the timeline dock widens the span a
// quarter. exponential in the pixel delta so a precision touchpad's stream
// of small ctrl+wheel deltas composes to exactly what one notch would give
// instead of each event slamming a full step, and so zooming in and back out
// returns exactly where it started. the delta normalisation mirrors
// renderer/playfield's wheelZoomFactor -- same line/page pixel factors, same
// batched-flick cap -- duplicated because lib must not import from renderer
const SPAN_WHEEL_PER_NOTCH = 1.25;
const SPAN_WHEEL_LINE_PX = 16;
const SPAN_WHEEL_PAGE_PX = 400;
const SPAN_WHEEL_MAX_PX = 150;

/** the span a wheel event over the timeline dock asks for, or null when it
 * asks for nothing: zooming rides ctrl+wheel -- one rule with the viewport's
 * pointer-anchored zoom, so the same gesture means zoom everywhere -- while
 * plain wheel frame-steps over the timeline exactly as it does everywhere
 * else (wheelFrameStep bails on ctrl for the mirror-image reason), and a
 * horizontal-only trackpad swipe (deltaY 0) carries no direction */
export function detailSpanForWheel(
	spanMs: number,
	e: { deltaY: number; ctrlKey: boolean; deltaMode: number }
): number | null {
	if (e.deltaY === 0 || !e.ctrlKey || !Number.isFinite(e.deltaY)) return null;
	const px = e.deltaY * (e.deltaMode === 1 ? SPAN_WHEEL_LINE_PX : e.deltaMode === 2 ? SPAN_WHEEL_PAGE_PX : 1);
	const capped = Math.min(Math.max(px, -SPAN_WHEEL_MAX_PX), SPAN_WHEEL_MAX_PX);
	// wheel-down carries a positive deltaY and widens the span
	return spanMs * SPAN_WHEEL_PER_NOTCH ** (capped / 100);
}

export function zoomFactor(spanMs: number, bounds: TimeBounds): number {
	const full = Math.max(0, bounds.maxTime - bounds.minTime);
	if (full <= 0 || spanMs <= 0) return 1;
	return full / spanMs;
}

/** unlike lib/timeline's fractionFor, this must not clamp into [0,1]: a mark
 * that starts or ends outside the visible window is clipped by the track's
 * overflow box, not stuck against the 0/1 edge -- clamping here would hide
 * the fact that a hold started before the window and make it look like it
 * began exactly at the left edge every time */
export function windowFraction(view: TimeWindow, t: number): number {
	const span = view.end - view.start;
	return span <= 0 ? 0 : (t - view.start) / span;
}

/** a time's offset along a track `trackPx` css pixels wide. the timeline does
 * its geometry in pixels rather than percentages so every moving offset can
 * go through snapDevicePixels before it reaches the dom */
export function timeToPixels(view: TimeWindow, t: number, trackPx: number): number {
	return windowFraction(view, t) * trackPx;
}

/** rounds a css-pixel offset onto the device-pixel grid. an element that
 * moves by a fraction of a device pixel per frame rasterises differently from
 * frame to frame -- a 1.5px stem covers 1 or 2 device pixels depending on its
 * subpixel phase, and a span whose two endpoints round independently can have
 * its edges step in opposite directions on one sub-pixel move. snapping keeps
 * that phase constant. non-decreasing in `px`, which is what guarantees a
 * span built from two snapped endpoints can never come out inside-out */
export function snapDevicePixels(px: number, dpr: number): number {
	// devicePixelRatio is read at the point of use and is > 0 in any real
	// browser; guard anyway rather than divide the whole geometry to NaN
	const ratio = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
	return Math.round(px * ratio) / ratio;
}

/** the zoom bracket's overview-strip geometry: the detail window mapped onto
 * the track as one rigid piece, anchored to the playhead rather than mapped
 * for itself. the left edge is the playhead's own snapped pixel minus a
 * constant snapped half-span -- snapping the window's start independently
 * rounds on a different subpixel phase than the playhead's centre, which made
 * the gap between them flick by a device pixel while both slid. the width is
 * snapped once from the span so the edges can never round in opposite
 * directions. the arithmetic stays in whole device pixels until the return so
 * the pinned and unpinned regimes meet without float drift. the freeze at the
 * timeline's ends is the clamp, with the tail pin evaluated on the unpinned
 * trajectory at the freeze boundary itself -- deriving it from the track end
 * instead can sit a device pixel off the trajectory and let the bracket creep
 * after the playhead enters the trailing half-span */
export function bracketPixels(
	bounds: TimeBounds,
	centre: number,
	spanMs: number,
	trackPx: number,
	dpr: number
): { left: number; width: number } {
	const full = bounds.maxTime - bounds.minTime;
	if (full <= 0) return { left: 0, width: 0 };
	// same guard as snapDevicePixels: a degenerate ratio must not NaN the strip
	const ratio = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
	const span = clampSpan(bounds, spanMs);
	const halfSpanPx = (span / 2 / full) * trackPx;
	const widthDev = Math.round((span / full) * trackPx * ratio);
	const halfSpanDev = Math.round(halfSpanPx * ratio);
	const playheadDev = Math.round(fractionFor(bounds, centre) * trackPx * ratio);
	const pinDev = Math.round((trackPx - halfSpanPx) * ratio) - halfSpanDev;
	const leftDev = Math.min(Math.max(playheadDev - halfSpanDev, 0), pinDev);
	return { left: leftDev / ratio, width: widthDev / ratio };
}

/** the detail tier's lane-layer geometry, exactly as its draw loop computes
 * it: the layer's css width and the snapped offset its transform applies.
 * hit-testing inverts pointer positions through these same numbers -- the
 * live offset is written imperatively per tick and never stored as state,
 * so a click must recompute it from the same inputs the draw did */
export interface LaneTransform {
	layerPx: number;
	viewStartInLayer: number;
}

export function laneTransform(
	neighbourhood: TimeWindow,
	view: TimeWindow,
	trackPx: number,
	dpr: number
): LaneTransform | null {
	const viewSpan = view.end - view.start;
	if (viewSpan <= 0) return null;
	const layerPx = ((neighbourhood.end - neighbourhood.start) / viewSpan) * trackPx;
	return { layerPx, viewStartInLayer: snapDevicePixels(timeToPixels(neighbourhood, view.start, layerPx), dpr) };
}

/** a pointer's track-relative css x -> lane time, through the transform the
 * pixels on screen were actually drawn with */
export function laneTimeAtPixel(neighbourhood: TimeWindow, transform: LaneTransform, xPx: number): number {
	if (transform.layerPx <= 0) return neighbourhood.start;
	const fraction = (xPx + transform.viewStartInLayer) / transform.layerPx;
	return neighbourhood.start + fraction * (neighbourhood.end - neighbourhood.start);
}

/** 1-2-5 decade steps, the intervals a time ruler reads naturally in */
const NICE_STEPS = [100, 250, 500, 1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000];

export function rulerTicks(window: TimeWindow, targetCount: number): number[] {
	const span = window.end - window.start;
	if (span <= 0 || targetCount <= 0) return [];
	const ideal = span / targetCount;
	const interval = NICE_STEPS.find((step) => step >= ideal) ?? NICE_STEPS[NICE_STEPS.length - 1];
	const ticks: number[] = [];
	let t = Math.ceil(window.start / interval) * interval;
	while (t <= window.end) {
		ticks.push(t);
		const next = t + interval;
		// frame deltas are not range-checked backend-side, so a crafted replay
		// can seek the window to magnitudes where the interval sits below one
		// float ulp and addition stops advancing -- stop instead of spinning
		if (next === t) break;
		t = next;
	}
	return ticks;
}
