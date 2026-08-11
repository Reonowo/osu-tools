// the detail tier's window model. the overview strip always maps the whole
// replay; the detail lanes map a span centred on the playhead, and this is
// the maths that keeps that span inside the bounds and rules it

import type { TimeBounds } from "./timeline";

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

// one wheel notch over the detail lanes; asymmetric so that zooming in and
// back out returns close to where it started (0.8 x 1.25 === 1 exactly)
const SPAN_WHEEL_IN = 0.8;
const SPAN_WHEEL_OUT = 1.25;

/** the span a wheel event over the detail lanes asks for, or null when it
 * asks for nothing: a horizontal-only trackpad swipe (deltaY 0) carries no
 * direction, and ctrl+wheel belongs to the viewport's pointer-anchored zoom
 * -- held over the timeline it must neither zoom this tier nor scrub */
export function detailSpanForWheel(spanMs: number, e: { deltaY: number; ctrlKey: boolean }): number | null {
	if (e.deltaY === 0 || e.ctrlKey) return null;
	return spanMs * (e.deltaY > 0 ? SPAN_WHEEL_OUT : SPAN_WHEEL_IN);
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
