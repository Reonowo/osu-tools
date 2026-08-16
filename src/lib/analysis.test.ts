import { describe, expect, test } from "bun:test";
import {
	aimTime,
	errorHistogram,
	hitErrors,
	meanHold,
	medianFrameDelta,
	peakTapBpm,
	velocityTrace,
	velocityTraceWindow
} from "./analysis";
import type { FrameDto, JudgementEventDto, RenderObject } from "./scene-types";
import { windowAround } from "./timeline-view";

function circleAt(startTime: number): RenderObject {
	return {
		startTime,
		endTime: startTime,
		position: [0, 0],
		stackHeight: 0,
		comboColourIndex: 0,
		comboIndex: 0,
		indexInCombo: 0,
		preempt: 600,
		fadeIn: 400,
		samples: [],
		kind: { type: "circle" }
	};
}

function judgement(time: number, objectIndex: number, grade: "great" | "ok" | "meh" | "miss"): JudgementEventDto {
	return { time, objectIndex, kind: { type: "circle", grade }, comboAfter: 1, accuracyAfter: 1 };
}

function frame(time: number, x: number, y: number, buttons = 0): FrameDto {
	return { time, x, y, buttons };
}

describe("aimTime", () => {
	test("a circle aims at its start, a slider at its head's nested time, a spinner at nothing", () => {
		expect(aimTime(circleAt(1000))).toBe(1000);
		const slider: RenderObject = {
			...circleAt(1000),
			endTime: 1500,
			kind: {
				type: "slider",
				vertices: [0, 0, 10, 0],
				cumulativeLengths: [0, 10],
				distance: 10,
				segmentEnds: [1],
				repeatCount: 0,
				spanCount: 1,
				spanDuration: 500,
				duration: 500,
				endPosition: [10, 0],
				snakeInDuration: 100,
				nested: [
					{
						kind: "head",
						spanIndex: 0,
						time: 1010,
						position: [0, 0],
						pathProgress: 0,
						preempt: 600,
						fadeIn: 400,
						samples: []
					}
				]
			}
		};
		expect(aimTime(slider)).toBe(1010);
		const spinner: RenderObject = {
			...circleAt(1000),
			endTime: 2000,
			kind: { type: "spinner", duration: 1000, spinsRequired: 3, maxBonusSpins: 1, bonusSamples: [] }
		};
		expect(aimTime(spinner)).toBeNull();
	});
});

describe("hitErrors", () => {
	test("signs errors early-negative against the object start time", () => {
		const objects = [circleAt(1000), circleAt(2000)];
		const events = [judgement(990, 0, "great"), judgement(2015, 1, "ok")];
		expect(hitErrors(events, objects)).toEqual([-10, 15]);
	});

	test("skips misses and non-circle kinds -- neither carries a hit time", () => {
		const objects = [circleAt(1000), circleAt(2000)];
		const events: JudgementEventDto[] = [
			judgement(1000, 0, "miss"),
			{ time: 2000, objectIndex: 1, kind: { type: "sliderTick", hit: true }, comboAfter: 1, accuracyAfter: 1 }
		];
		expect(hitErrors(events, objects)).toEqual([]);
	});

	test("uses the slider head's own time for sliderHead judgements", () => {
		const slider: RenderObject = {
			...circleAt(1000),
			endTime: 1500,
			kind: {
				type: "slider",
				vertices: [0, 0, 10, 0],
				cumulativeLengths: [0, 10],
				distance: 10,
				segmentEnds: [1],
				repeatCount: 0,
				spanCount: 1,
				spanDuration: 500,
				duration: 500,
				endPosition: [10, 0],
				snakeInDuration: 100,
				nested: [
					{
						kind: "head",
						spanIndex: 0,
						time: 1000,
						position: [0, 0],
						pathProgress: 0,
						preempt: 600,
						fadeIn: 400,
						samples: []
					}
				]
			}
		};
		const events: JudgementEventDto[] = [
			{ time: 1008, objectIndex: 0, kind: { type: "sliderHead", hit: true }, comboAfter: 1, accuracyAfter: 1 }
		];
		expect(hitErrors(events, [slider])).toEqual([8]);
	});
});

describe("errorHistogram", () => {
	test("bins symmetrically about zero and counts every in-window error", () => {
		const bins = errorHistogram([-50, 0, 0, 50], 5, 60);
		expect(bins).toHaveLength(5);
		expect(bins.map((b) => b.count)).toEqual([1, 0, 2, 0, 1]);
		// centres span the window: -48, -24, 0, 24, 48
		expect(bins[2].centre).toBeCloseTo(0, 6);
	});

	test("clamps out-of-window errors into the edge bins rather than dropping them", () => {
		const bins = errorHistogram([-500, 500], 5, 60);
		expect(bins[0].count).toBe(1);
		expect(bins[4].count).toBe(1);
	});

	test("an empty error list yields empty bins, not NaN centres", () => {
		const bins = errorHistogram([], 5, 60);
		expect(bins.every((b) => b.count === 0)).toBe(true);
		expect(bins.every((b) => Number.isFinite(b.centre))).toBe(true);
	});
});

describe("velocityTrace", () => {
	test("computes px/s between frames and downsamples to the requested count", () => {
		// 100px in 100ms = 1000 px/s, held for the whole replay
		const frames = Array.from({ length: 11 }, (_, i) => frame(i * 100, i * 100, 0));
		const { samples, peak, mean } = velocityTrace(frames, 5);
		expect(samples).toHaveLength(5);
		expect(peak).toBeCloseTo(1000, 3);
		expect(mean).toBeCloseTo(1000, 3);
	});

	test("weights the mean by elapsed time, not by frame pair", () => {
		// 100 px over the first 100ms, then still until 1000ms -> the true mean
		// speed is 100 px/s; a per-pair average would read (1000 + 0) / 2 = 500
		const frames = [frame(0, 0, 0), frame(100, 100, 0), frame(1000, 100, 0)];
		const { peak, mean } = velocityTrace(frames, 5);
		expect(peak).toBeCloseTo(1000, 6);
		expect(mean).toBeCloseTo(100, 6);
	});

	test("zero-duration frame pairs contribute no velocity instead of Infinity", () => {
		const frames = [frame(0, 0, 0), frame(0, 50, 0), frame(100, 50, 0)];
		const { peak } = velocityTrace(frames, 3);
		expect(Number.isFinite(peak)).toBe(true);
		expect(peak).toBeCloseTo(0, 6);
	});

	test("fewer than two frames yields an empty trace", () => {
		expect(velocityTrace([frame(0, 0, 0)], 5).samples).toEqual([]);
	});

	test("keeps each bucket's maximum sample when downsampling", () => {
		// per-100ms velocities 1000/9000/2000/3000/8000/4000 px/s into three
		// buckets of two -- the trace must keep each bucket's peak and its time
		const speeds = [1000, 9000, 2000, 3000, 8000, 4000];
		let x = 0;
		const frames = [frame(0, 0, 0)];
		speeds.forEach((v, i) => {
			x += v / 10;
			frames.push(frame((i + 1) * 100, x, 0));
		});
		const { samples } = velocityTrace(frames, 3);
		expect(samples.map((s) => s.velocity)).toEqual([9000, 3000, 8000]);
		expect(samples.map((s) => s.time)).toEqual([200, 400, 500]);
	});
});

describe("velocityTraceWindow", () => {
	test("resamples one slice at its own resolution, keeping each time bucket's maximum", () => {
		// per-100ms velocities 1000/9000/2000/3000/8000/4000 px/s, attributed at
		// times 100..600. slice [150, 550] in two buckets of 200ms: bucket one
		// holds the pairs at 200 and 300, bucket two those at 400 and 500; the
		// pairs at 100 and 600 straddle the edges and ride along raw
		const speeds = [1000, 9000, 2000, 3000, 8000, 4000];
		let x = 0;
		const frames = [frame(0, 0, 0)];
		speeds.forEach((v, i) => {
			x += v / 10;
			frames.push(frame((i + 1) * 100, x, 0));
		});
		const samples = velocityTraceWindow(frames, 150, 550, 2);
		expect(samples.map((s) => s.velocity)).toEqual([1000, 9000, 8000, 4000]);
		expect(samples.map((s) => s.time)).toEqual([100, 200, 500, 600]);
	});

	test("the slice's trace covers the window's leading edge at every playhead position between re-slices", () => {
		// the reported symptom: the whole-replay downsample left a long replay's
		// slice with no sample near its leading edge, so the lane's line ended
		// short of the visible window until the next re-slice. mirror the lane's
		// cycle -- slice a 3x-span neighbourhood, slide the window until the
		// re-slice guard fires -- and require the trace to reach past the
		// window's right edge the whole way
		const durationMs = 360_000;
		const stepMs = 15;
		const frames: FrameDto[] = [];
		for (let t = 0; t <= durationMs; t += stepMs) {
			frames.push(frame(t, 256 + 100 * Math.cos(t / 300), 192 + 100 * Math.sin(t / 300)));
		}
		const bounds = { minTime: 0, maxTime: durationMs };
		const spanMs = 20_000;
		const tSlice = 180_000;
		const neighbourhood = windowAround(bounds, tSlice, spanMs * 3);
		const samples = velocityTraceWindow(frames, neighbourhood.start, neighbourhood.end, 600);
		expect(samples.length).toBeGreaterThan(0);
		const firstCovered = samples[0].time;
		const lastCovered = samples[samples.length - 1].time;
		expect(firstCovered).toBeLessThanOrEqual(neighbourhood.start);
		for (let t = tSlice; ; t += 100) {
			const view = windowAround(bounds, t, spanMs);
			if (view.start < neighbourhood.start || view.end > neighbourhood.end) break;
			expect(lastCovered).toBeGreaterThanOrEqual(view.end);
		}
	});

	test("no phantom samples past the stream's own ends", () => {
		// a slice wider than the stream gets exactly the stream's pairs (buckets
		// narrow enough that neither downsamples away)
		const frames = [frame(0, 0, 0), frame(100, 50, 0), frame(200, 100, 0)];
		const samples = velocityTraceWindow(frames, -1000, 1000, 40);
		expect(samples.map((s) => s.time)).toEqual([100, 200]);
	});

	test("a slice with no stream overlap yields nothing to draw", () => {
		// the audio tail can outlive the frame stream; a slice out there must
		// not resurrect the stream's outermost pair as a lone off-slice sample
		// -- the lane's fill polygon would render it as a fabricated wedge over
		// a slice that holds no data at all. both directions guard the same way
		const frames = [frame(0, 0, 0), frame(100, 50, 0), frame(200, 100, 0)];
		expect(velocityTraceWindow(frames, 1000, 2000, 4)).toEqual([]);
		expect(velocityTraceWindow(frames, -2000, -1000, 4)).toEqual([]);
	});

	test("a slice between two frames still draws the crossing pair", () => {
		// no pair lands inside [2000, 3000]; the straddling pairs on each side
		// must come back so the line crosses the window instead of vanishing
		const frames = [frame(0, 0, 0), frame(100, 50, 0), frame(5000, 100, 0)];
		const samples = velocityTraceWindow(frames, 2000, 3000, 3);
		expect(samples.map((s) => s.time)).toEqual([100, 5000]);
	});

	test("duplicate-time pairs carry zero velocity, never NaN", () => {
		const frames = [frame(0, 0, 0), frame(0, 50, 0), frame(100, 50, 0)];
		const samples = velocityTraceWindow(frames, 0, 100, 2);
		expect(samples.every((s) => Number.isFinite(s.velocity))).toBe(true);
		expect(samples.map((s) => s.velocity)).toEqual([0, 0]);
	});

	test("degenerate inputs yield an empty trace", () => {
		expect(velocityTraceWindow([], 0, 100, 4)).toEqual([]);
		expect(velocityTraceWindow([frame(0, 0, 0)], 0, 100, 4)).toEqual([]);
		expect(velocityTraceWindow([frame(0, 0, 0), frame(10, 5, 0)], 100, 100, 4)).toEqual([]);
		expect(velocityTraceWindow([frame(0, 0, 0), frame(10, 5, 0)], 0, 100, 0)).toEqual([]);
	});
});

describe("peakTapBpm", () => {
	test("reports the densest press run as bpm (four presses per beat)", () => {
		// presses every 62.5ms -> 16 presses/s -> 16/4*60 = 240 bpm
		const presses = Array.from({ length: 20 }, (_, i) => ({
			time: i * 62.5,
			action: "left" as const,
			frameIndex: i,
			key: "M1" as const
		}));
		expect(peakTapBpm(presses, 1000)).toBeCloseTo(240, 0);
	});

	test("an empty press list is zero, not NaN", () => {
		expect(peakTapBpm([], 1000)).toBe(0);
	});
});

describe("meanHold", () => {
	test("averages held-button durations across k1 and k2", () => {
		// k1 (4) held 0-50, k2 (8) held 100-150
		const frames = [frame(0, 0, 0, 4), frame(50, 0, 0, 0), frame(100, 0, 0, 8), frame(150, 0, 0, 0)];
		expect(meanHold(frames)).toBeCloseTo(50, 6);
	});

	test("a button still held at the last frame closes at that frame", () => {
		const frames = [frame(0, 0, 0, 4), frame(30, 0, 0, 4)];
		expect(meanHold(frames)).toBeCloseTo(30, 6);
	});

	test("no presses is zero", () => {
		expect(meanHold([frame(0, 0, 0), frame(10, 0, 0)])).toBe(0);
	});

	test("pins that a keyboard tap's k1+m1 alias counts as one hold, not two", () => {
		// a keyboard-tapped left press (k1|m1 = 5) held 0-50, plus a
		// mouse-only right press (m2 = 2) held 100-130 -- true mean is
		// (50 + 30) / 2 = 40; double-counting the aliased left press as two
		// holds would instead read (50 + 50 + 30) / 3 = 43.3
		const frames = [frame(0, 0, 0, 5), frame(50, 0, 0, 0), frame(100, 0, 0, 2), frame(130, 0, 0, 0)];
		expect(meanHold(frames)).toBeCloseTo(40, 6);
	});
});

describe("medianFrameDelta", () => {
	test("takes the middle inter-frame delta", () => {
		const frames = [frame(0, 0, 0), frame(10, 0, 0), frame(30, 0, 0), frame(90, 0, 0)];
		// deltas 10, 20, 60 -> median 20
		expect(medianFrameDelta(frames)).toBe(20);
	});

	test("averages the two middle deltas for an even count", () => {
		const frames = [frame(0, 0, 0), frame(10, 0, 0), frame(30, 0, 0)];
		// deltas 10, 20 -> 15
		expect(medianFrameDelta(frames)).toBe(15);
	});

	test("fewer than two frames is zero", () => {
		expect(medianFrameDelta([frame(0, 0, 0)])).toBe(0);
	});

	test("selects the exact median from unsorted deltas", () => {
		// deltas 5, 1, 4, 2, 3 -> sorted 1 2 3 4 5 -> median 3
		const frames = [0, 5, 6, 10, 12, 15].map((t) => frame(t, 0, 0));
		expect(medianFrameDelta(frames)).toBe(3);
	});

	test("averages the middles of an even unsorted count", () => {
		// deltas 5, 1, 4, 2, 3, 6 -> sorted 1 2 3 4 5 6 -> (3 + 4) / 2
		const frames = [0, 5, 6, 10, 12, 15, 21].map((t) => frame(t, 0, 0));
		expect(medianFrameDelta(frames)).toBe(3.5);
	});
});
