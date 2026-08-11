import { describe, expect, test } from "bun:test";
import {
	bracketPixels,
	clampSpan,
	detailSpanForWheel,
	laneTimeAtPixel,
	laneTransform,
	rulerTicks,
	snapDevicePixels,
	timeToPixels,
	windowAround,
	windowFraction,
	zoomFactor
} from "./timeline-view";
import { fractionFor } from "./timeline";

const bounds = { minTime: -1000, maxTime: 99_000 };

describe("detailSpanForWheel", () => {
	const wheel = (deltaY: number, deltaMode = 0) => ({ deltaY, ctrlKey: true, deltaMode });

	test("ctrl+wheel-down widens the span and ctrl+wheel-up narrows it", () => {
		expect(detailSpanForWheel(20_000, wheel(100))).toBe(25_000);
		expect(detailSpanForWheel(20_000, wheel(-100))).toBe(16_000);
	});

	test("zooming in and back out lands exactly where it started", () => {
		const inOnce = detailSpanForWheel(20_000, wheel(-100));
		expect(detailSpanForWheel(inOnce!, wheel(100))).toBe(20_000);
	});

	test("four quarter-notches compose to one whole one, so a touchpad pinch matches a wheel", () => {
		// the defect this pins down: a fixed per-event step made every tiny
		// precision-touchpad delta apply a full notch, slamming the span
		let span = 20_000;
		for (let i = 0; i < 4; i++) span = detailSpanForWheel(span, wheel(25))!;
		expect(span).toBeCloseTo(25_000, 9);
	});

	test("a single tiny delta barely moves the span", () => {
		const next = detailSpanForWheel(20_000, wheel(-1))!;
		expect(next).toBeLessThan(20_000);
		expect(next).toBeGreaterThan(20_000 * 0.99);
	});

	test("line and page delta modes are normalised to pixels", () => {
		expect(detailSpanForWheel(20_000, wheel(-3, 1))).toBe(detailSpanForWheel(20_000, wheel(-48)));
		expect(detailSpanForWheel(20_000, wheel(-0.25, 2))).toBe(detailSpanForWheel(20_000, wheel(-100)));
	});

	test("a batched flick is capped rather than crossing the whole span range", () => {
		expect(detailSpanForWheel(20_000, wheel(100_000))).toBe(detailSpanForWheel(20_000, wheel(150)));
		expect(detailSpanForWheel(20_000, wheel(-100_000))).toBe(detailSpanForWheel(20_000, wheel(-150)));
	});

	test("a non-finite delta asks for nothing rather than a NaN span", () => {
		expect(detailSpanForWheel(20_000, wheel(Number.NaN))).toBeNull();
		expect(detailSpanForWheel(20_000, wheel(Number.POSITIVE_INFINITY))).toBeNull();
	});

	test("a horizontal-only trackpad swipe leaves the span alone even with ctrl held", () => {
		// deltaY 0 carries no direction and must not fall into the zoom-in branch
		expect(detailSpanForWheel(20_000, wheel(0))).toBeNull();
	});

	test("plain wheel leaves the span alone -- it frame-steps over the timeline like everywhere else", () => {
		expect(detailSpanForWheel(20_000, { deltaY: 100, ctrlKey: false, deltaMode: 0 })).toBeNull();
		expect(detailSpanForWheel(20_000, { deltaY: -100, ctrlKey: false, deltaMode: 0 })).toBeNull();
	});
});

describe("windowAround", () => {
	test("centres the window on the playhead", () => {
		expect(windowAround(bounds, 50_000, 10_000)).toEqual({ start: 45_000, end: 55_000 });
	});

	test("slides rather than shrinks at the head of the replay", () => {
		expect(windowAround(bounds, -900, 10_000)).toEqual({ start: -1000, end: 9000 });
	});

	test("slides rather than shrinks at the tail", () => {
		expect(windowAround(bounds, 98_900, 10_000)).toEqual({ start: 89_000, end: 99_000 });
	});

	test("a span wider than the replay collapses onto the full bounds", () => {
		expect(windowAround(bounds, 50_000, 1_000_000)).toEqual({ start: -1000, end: 99_000 });
	});
});

describe("clampSpan", () => {
	test("never exceeds the replay length", () => {
		expect(clampSpan(bounds, 1_000_000)).toBe(100_000);
	});

	test("never drops below the floor", () => {
		expect(clampSpan(bounds, 1)).toBe(250);
	});
});

describe("zoomFactor", () => {
	test("is the ratio of the whole replay to the visible span", () => {
		expect(zoomFactor(10_000, bounds)).toBeCloseTo(10, 6);
	});

	test("degenerate bounds do not produce Infinity", () => {
		expect(Number.isFinite(zoomFactor(10_000, { minTime: 0, maxTime: 0 }))).toBe(true);
	});
});

describe("rulerTicks", () => {
	test("picks a round interval and covers the window", () => {
		const ticks = rulerTicks({ start: 44_000, end: 64_000 }, 5);
		expect(ticks[0]).toBe(45_000);
		// 20s over ~5 ticks -> a 5s interval
		expect(ticks[1] - ticks[0]).toBe(5000);
		expect(ticks[ticks.length - 1]).toBeLessThanOrEqual(64_000);
	});

	test("starts on a multiple of the interval, not on the window edge", () => {
		const ticks = rulerTicks({ start: 44_300, end: 64_300 }, 5);
		expect(ticks[0] % 5000).toBe(0);
	});

	test("a degenerate window yields no ticks instead of looping", () => {
		expect(rulerTicks({ start: 10, end: 10 }, 5)).toEqual([]);
	});

	test("terminates at float magnitudes where the interval is below one ulp", () => {
		// frame deltas are unchecked backend-side, so a crafted replay can put
		// the window at magnitudes where tick addition stops advancing; the
		// ruler must stop rather than loop forever. 3e18 sits where the ulp is
		// 512, so the 250ms interval this window selects genuinely cannot move
		// t -- asserted as a precondition so the case never silently weakens
		const start = 3e18;
		expect(start + 250).toBe(start);
		const ticks = rulerTicks({ start, end: start + 600 }, 5);
		expect(ticks.length).toBeGreaterThan(0);
		expect(ticks.length).toBeLessThan(10);
	});
});

describe("windowFraction", () => {
	test("is unclamped, so a mark outside the window keeps its true offset", () => {
		expect(windowFraction({ start: 0, end: 100 }, -50)).toBe(-0.5);
		expect(windowFraction({ start: 0, end: 100 }, 150)).toBe(1.5);
	});

	test("a degenerate window yields no offset instead of NaN", () => {
		expect(windowFraction({ start: 5, end: 5 }, 5)).toBe(0);
	});
});

describe("timeToPixels", () => {
	const view = { start: 40_000, end: 60_000 };

	test("maps the window's edges onto the track's edges", () => {
		expect(timeToPixels(view, 40_000, 900)).toBe(0);
		expect(timeToPixels(view, 60_000, 900)).toBe(900);
	});

	test("does not clamp outside the window -- the track's overflow box does", () => {
		expect(timeToPixels(view, 30_000, 900)).toBe(-450);
		expect(timeToPixels(view, 70_000, 900)).toBe(1350);
	});
});

// the ratios windows reports at the display scales this app is used at:
// 100%, 125%, 150% and 200%
const DEVICE_PIXEL_RATIOS = [1, 1.25, 1.5, 2];

describe("snapDevicePixels", () => {
	test("lands on a whole device pixel at every ratio", () => {
		for (const dpr of DEVICE_PIXEL_RATIOS) {
			for (let px = -20; px < 20; px += 0.13) {
				const devicePixels = snapDevicePixels(px, dpr) * dpr;
				expect(devicePixels).toBeCloseTo(Math.round(devicePixels), 9);
			}
		}
	});

	test("moves an offset by less than half a device pixel", () => {
		let furthest = 0;
		for (const dpr of DEVICE_PIXEL_RATIOS) {
			for (let px = -20; px < 20; px += 0.17) {
				furthest = Math.max(furthest, Math.abs(snapDevicePixels(px, dpr) - px) * dpr);
			}
		}
		expect(furthest).toBeLessThanOrEqual(0.5);
	});

	test("the grid is the device's, not the css pixel's", () => {
		expect(snapDevicePixels(3.4, 1)).toBe(3);
		expect(snapDevicePixels(3.6, 1)).toBe(4);
		// 1css px is 1.25 device px at 125%, so the nearest device pixel is the
		// first one, back at 0.8css px
		expect(snapDevicePixels(1, 1.25)).toBe(0.8);
		expect(snapDevicePixels(1, 1.5)).toBeCloseTo(4 / 3, 12);
		expect(snapDevicePixels(3.4, 2)).toBe(3.5);
	});

	test("a bogus ratio degrades to whole css pixels rather than NaN", () => {
		expect(snapDevicePixels(3.6, 0)).toBe(4);
		expect(snapDevicePixels(3.6, Number.NaN)).toBe(4);
	});
});

// the geometry the timeline actually runs: the default 20s detail span across
// a typical track is ~0.045px per ms, so consecutive frames of a 60Hz replay
// sit well under one device pixel apart -- the regime where independently
// positioned elements used to decohere
describe("snapped timeline geometry", () => {
	const view = { start: 40_000, end: 60_000 };
	const trackPx = 903.5;
	const frameMs = 1000 / 60;

	test("adjacent distinct frame times never step backwards once snapped", () => {
		let smallestStep = Number.POSITIVE_INFINITY;
		let stalls = 0;
		for (const dpr of DEVICE_PIXEL_RATIOS) {
			let previous = snapDevicePixels(timeToPixels(view, view.start, trackPx), dpr);
			for (let t = view.start + frameMs; t <= view.end; t += frameMs) {
				const x = snapDevicePixels(timeToPixels(view, t, trackPx), dpr);
				smallestStep = Math.min(smallestStep, x - previous);
				if (x === previous) stalls += 1;
				previous = x;
			}
		}
		// zero rather than merely non-negative: a frame that lands on the same
		// device pixel as its predecessor is allowed, going backwards is not
		expect(smallestStep).toBe(0);
		// and the sweep has to be exercising that sub-pixel regime rather than
		// stepping a clean pixel at a time, or it would prove nothing
		expect(stalls).toBeGreaterThan(0);
	});

	test("a span's two snapped endpoints never invert its width", () => {
		let narrowest = Number.POSITIVE_INFINITY;
		for (const dpr of DEVICE_PIXEL_RATIOS) {
			for (let start = view.start; start < view.start + 400; start += 0.7) {
				for (const durationMs of [0, 0.4, 1, frameMs, 250]) {
					const left = snapDevicePixels(timeToPixels(view, start, trackPx), dpr);
					const right = snapDevicePixels(timeToPixels(view, start + durationMs, trackPx), dpr);
					narrowest = Math.min(narrowest, right - left);
				}
			}
		}
		// a zero-length span collapses to exactly nothing; nothing narrower
		expect(narrowest).toBe(0);
	});
});

describe("bracketPixels", () => {
	// the strip's regime: a 100s replay across a ~900px track, so the bracket
	// moves well under a device pixel per frame -- exactly where two
	// independently rounded edges used to step in opposite directions
	const trackPx = 903.5;
	const spanMs = 20_000;

	test("the width is rigid: one snapped value for every centre, at every ratio", () => {
		for (const dpr of DEVICE_PIXEL_RATIOS) {
			const widths = new Set<number>();
			for (let t = bounds.minTime; t <= bounds.maxTime; t += 313) {
				widths.add(bracketPixels(bounds, t, spanMs, trackPx, dpr).width);
			}
			expect(widths.size).toBe(1);
		}
	});

	test("both numbers land on the device-pixel grid", () => {
		for (const dpr of DEVICE_PIXEL_RATIOS) {
			for (let t = 10_000; t <= 90_000; t += 313) {
				const { left, width } = bracketPixels(bounds, t, spanMs, trackPx, dpr);
				expect(left * dpr).toBeCloseTo(Math.round(left * dpr), 9);
				expect(width * dpr).toBeCloseTo(Math.round(width * dpr), 9);
			}
		}
	});

	test("the playhead-to-bracket offset stays constant through unpinned motion", () => {
		// the strip's playhead pixel, exactly as its rAF loop computes it; the
		// bracket must hold a fixed distance from it -- mapping the window's
		// start for itself rounded on a different subpixel phase and made the
		// gap flick by a device pixel while both slid
		for (const dpr of DEVICE_PIXEL_RATIOS) {
			const offsetsDev = new Set<number>();
			for (let t = bounds.minTime + spanMs / 2 + 500; t <= bounds.maxTime - spanMs / 2 - 500; t += 313) {
				const playheadPx = snapDevicePixels(fractionFor(bounds, t) * trackPx, dpr);
				const { left } = bracketPixels(bounds, t, spanMs, trackPx, dpr);
				offsetsDev.add(Math.round((playheadPx - left) * dpr));
			}
			expect(offsetsDev.size).toBe(1);
		}
	});

	test("the left edge never steps backwards as the playhead advances", () => {
		for (const dpr of DEVICE_PIXEL_RATIOS) {
			let previous = Number.NEGATIVE_INFINITY;
			for (let t = bounds.minTime; t <= bounds.maxTime; t += 47) {
				const { left } = bracketPixels(bounds, t, spanMs, trackPx, dpr);
				expect(left).toBeGreaterThanOrEqual(previous);
				previous = left;
			}
		}
	});

	test("freezes at the head: pinned at 0 while the playhead travels the leading half-span", () => {
		expect(bracketPixels(bounds, bounds.minTime, spanMs, trackPx, 1).left).toBe(0);
		expect(bracketPixels(bounds, bounds.minTime + spanMs / 2 - 1, spanMs, trackPx, 1).left).toBe(0);
	});

	test("freezes at the tail: pinned against the track end while the playhead travels inside", () => {
		for (const dpr of DEVICE_PIXEL_RATIOS) {
			const atEnd = bracketPixels(bounds, bounds.maxTime, spanMs, trackPx, dpr);
			// the two snapped numbers each move at most half a device pixel, so
			// their sum sits within one device pixel of the track's true end
			expect(Math.abs(atEnd.left + atEnd.width - trackPx)).toBeLessThanOrEqual(1 / dpr);
			const inside = bracketPixels(bounds, bounds.maxTime - spanMs / 2 + 1, spanMs, trackPx, dpr);
			expect(inside.left).toBe(atEnd.left);
		}
	});

	test("a span wider than the replay covers the whole track", () => {
		const { left, width } = bracketPixels(bounds, 50_000, 1_000_000, trackPx, 1);
		expect(left).toBe(0);
		expect(width).toBe(snapDevicePixels(trackPx, 1));
	});

	test("degenerate bounds collapse to nothing", () => {
		expect(bracketPixels({ minTime: 0, maxTime: 0 }, 0, spanMs, trackPx, 1)).toEqual({ left: 0, width: 0 });
	});
});

describe("lane hit inversion", () => {
	// the draw loop's placement of a mark at time t: neighbourhood-relative
	// fraction of the layer width, shifted by the snapped layer transform
	function drawnPixel(
		neighbourhood: { start: number; end: number },
		transform: { layerPx: number; viewStartInLayer: number },
		t: number
	): number {
		return windowFraction(neighbourhood, t) * transform.layerPx - transform.viewStartInLayer;
	}

	test("laneTimeAtPixel round-trips the draw loop's own geometry", () => {
		const neighbourhood = { start: 10_000, end: 70_000 };
		const view = { start: 30_000, end: 50_000 };
		for (const dpr of [1, 1.25, 2]) {
			const transform = laneTransform(neighbourhood, view, 800, dpr);
			expect(transform).not.toBeNull();
			for (const t of [30_000, 31_337, 40_000, 49_999]) {
				const x = drawnPixel(neighbourhood, transform!, t);
				expect(laneTimeAtPixel(neighbourhood, transform!, x)).toBeCloseTo(t, 6);
			}
		}
	});

	test("the inversion carries the snapped transform, not the ideal one", () => {
		// with a fractional dpr the snap shifts the layer by a sub-pixel; an
		// inversion using the unsnapped offset would disagree with the drawn
		// pixels by that same sub-pixel
		const neighbourhood = { start: 0, end: 60_000 };
		const view = { start: 20_123, end: 40_123 };
		const transform = laneTransform(neighbourhood, view, 777, 1.25)!;
		const ideal = timeToPixels(neighbourhood, view.start, transform.layerPx);
		expect(transform.viewStartInLayer).toBe(snapDevicePixels(ideal, 1.25));
		// the window's left edge inverts to view.start through the snapped
		// offset exactly when x = 0 means "at the drawn left edge"
		const atLeftEdge = laneTimeAtPixel(neighbourhood, transform, 0);
		const drawnLeft = windowFraction(neighbourhood, atLeftEdge) * transform.layerPx - transform.viewStartInLayer;
		expect(drawnLeft).toBeCloseTo(0, 6);
	});

	test("a degenerate view yields no transform", () => {
		expect(laneTransform({ start: 0, end: 100 }, { start: 50, end: 50 }, 800, 1)).toBeNull();
	});
});
