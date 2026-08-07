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

export function zoomFactor(spanMs: number, bounds: TimeBounds): number {
	const full = Math.max(0, bounds.maxTime - bounds.minTime);
	if (full <= 0 || spanMs <= 0) return 1;
	return full / spanMs;
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
