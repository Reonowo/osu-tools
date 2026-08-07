import { describe, expect, test } from "bun:test";
import { errorHistogram, hitErrors, meanHold, medianFrameDelta, peakTapBpm, velocityTrace } from "./analysis";
import type { FrameDto, JudgementEventDto, RenderObject } from "./scene-types";

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
		kind: { type: "circle" }
	};
}

function judgement(time: number, objectIndex: number, grade: "great" | "ok" | "meh" | "miss"): JudgementEventDto {
	return { time, objectIndex, kind: { type: "circle", grade }, comboAfter: 1, accuracyAfter: 1 };
}

function frame(time: number, x: number, y: number, buttons = 0): FrameDto {
	return { time, x, y, buttons };
}

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
						fadeIn: 400
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

describe("peakTapBpm", () => {
	test("reports the densest press run as bpm (four presses per beat)", () => {
		// presses every 62.5ms -> 16 presses/s -> 16/4*60 = 240 bpm
		const presses = Array.from({ length: 20 }, (_, i) => ({
			time: i * 62.5,
			action: "left" as const,
			frameIndex: i
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
