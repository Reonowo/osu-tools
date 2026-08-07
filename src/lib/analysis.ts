// per-scene hit-timing and cursor statistics for the analysis panel. pure
// maths over what LoadedScene already carries -- errors come from the
// simulated judgement timeline, everything else from the frame stream

import { eachSpanWhere, type Press } from "../engine/interpolation";
import { isLeft, isRight } from "../engine/buttons";
import type { FrameDto, JudgementEventDto, LoadedScene, RenderObject } from "./scene-types";

export interface HistogramBin {
	/** bin centre in ms, negative = early */
	centre: number;
	count: number;
}

export interface VelocitySample {
	time: number;
	/** osu!px per second */
	velocity: number;
}

export interface ReplayAnalysis {
	errors: number[];
	unstableRate: number;
	meanError: number;
	stdDev: number;
	earlyFraction: number;
	lateFraction: number;
	histogram: HistogramBin[];
	velocity: VelocitySample[];
	peakVelocity: number;
	meanVelocity: number;
	peakTapBpm: number;
	meanHoldMs: number;
	medianDeltaMs: number;
	frameCount: number;
}

/** the histogram's half-width; matches the design's -60..+60ms axis */
export const ERROR_WINDOW_MS = 60;
export const HISTOGRAM_BINS = 25;
/** points in the downsampled velocity trace -- the svg is ~600 css px wide */
export const VELOCITY_SAMPLES = 220;
/** the sliding window peak tap rate is measured over */
export const TAP_WINDOW_MS = 1000;

/** the time an object's judgement is measured against: a slider head has its
 * own nested time, everything else is judged at the object's start */
function judgedTime(object: RenderObject, kind: JudgementEventDto["kind"]): number | null {
	if (kind.type === "circle") return kind.grade === "miss" ? null : object.startTime;
	if (kind.type === "sliderHead") {
		if (!kind.hit) return null;
		if (object.kind.type !== "slider") return object.startTime;
		return object.kind.nested.find((n) => n.kind === "head")?.time ?? object.startTime;
	}
	// ticks, repeats, tails and spinner events carry no meaningful tap error:
	// they are judged by proximity or spin count, not by a press time
	return null;
}

export function hitErrors(events: readonly JudgementEventDto[], objects: readonly RenderObject[]): number[] {
	const errors: number[] = [];
	for (const event of events) {
		const object = objects[event.objectIndex];
		if (object === undefined) continue;
		const reference = judgedTime(object, event.kind);
		if (reference === null) continue;
		errors.push(event.time - reference);
	}
	return errors;
}

export function errorHistogram(errors: readonly number[], binCount: number, windowMs: number): HistogramBin[] {
	const width = (2 * windowMs) / binCount;
	const bins: HistogramBin[] = Array.from({ length: binCount }, (_, i) => ({
		centre: -windowMs + width * (i + 0.5),
		count: 0
	}));
	for (const error of errors) {
		// out-of-window errors land in the edge bins: dropping them would make
		// a heavy-tailed replay look tighter than it is
		const raw = Math.floor((error + windowMs) / width);
		bins[Math.min(binCount - 1, Math.max(0, raw))].count += 1;
	}
	return bins;
}

export function velocityTrace(
	frames: readonly FrameDto[],
	sampleCount: number
): { samples: VelocitySample[]; peak: number; mean: number } {
	if (frames.length < 2) return { samples: [], peak: 0, mean: 0 };
	const rawCount = frames.length - 1;
	// downsample by taking each bucket's maximum: an average would erase the
	// snap peaks the trace exists to show. the bucket best is folded in while
	// walking the frames -- the backend admits multi-million-frame replays
	// (limits.rs MAX_REPLAY_FRAMES) and this runs on the synchronous
	// scene-install path, so buffering a per-frame sample array first would
	// allocate millions of transient objects before keeping ~220 of them
	const buckets = Math.min(sampleCount, rawCount);
	const bucketSpan = buckets >= 1 ? rawCount / buckets : Number.POSITIVE_INFINITY;
	const samples: VelocitySample[] = [];
	let peak = 0;
	let distance = 0;
	let elapsed = 0;
	let bucketIndex = 0;
	let bucketEnd = Math.floor(bucketSpan);
	let bestTime = 0;
	let bestVelocity = -1;
	for (let i = 1; i < frames.length; i++) {
		const previous = frames[i - 1];
		const frame = frames[i];
		const dt = frame.time - previous.time;
		// duplicate-time frames are legal in the stream; they carry no velocity
		// and no elapsed time
		let velocity = 0;
		if (dt > 0) {
			const dist = Math.hypot(frame.x - previous.x, frame.y - previous.y);
			velocity = (dist / dt) * 1000;
			distance += dist;
			elapsed += dt;
		}
		if (velocity > peak) peak = velocity;
		if (i - 1 >= bucketEnd) {
			samples.push({ time: bestTime, velocity: bestVelocity });
			bucketIndex += 1;
			bucketEnd = Math.floor((bucketIndex + 1) * bucketSpan);
			bestVelocity = -1;
		}
		// strict comparison keeps the bucket's first maximum, matching the
		// previous buffered implementation sample for sample
		if (velocity > bestVelocity) {
			bestVelocity = velocity;
			bestTime = frame.time;
		}
	}
	if (buckets >= 1) samples.push({ time: bestTime, velocity: bestVelocity });
	// the mean weights by elapsed time -- total distance over total duration
	// -- not by frame pair: replay frames sample densest exactly where the
	// cursor is busiest, and a per-pair average would let those sections
	// dominate the whole-replay figure
	return { samples, peak, mean: elapsed <= 0 ? 0 : (distance / elapsed) * 1000 };
}

/** peak press density expressed as bpm, counting four presses to the beat --
 * the convention osu! players read stream speed in. density is measured as
 * intervals between presses inside the window, not raw press count: an
 * n-press run spans n-1 intervals, and counting presses instead would read
 * high by one interval's worth of rate */
export function peakTapBpm(presses: readonly Press[], windowMs: number): number {
	if (presses.length === 0) return 0;
	let best = 0;
	let start = 0;
	for (let end = 0; end < presses.length; end++) {
		while (presses[end].time - presses[start].time > windowMs) start += 1;
		best = Math.max(best, end - start + 1);
	}
	return ((best - 1) / (windowMs / 1000) / 4) * 60;
}

// held by logical action (left = k1|m1, right = k2|m2), not by raw bit --
// stable sets both bits for a single keyboard tap (buttons.ts), and
// aggregating per-bit would count that one physical press twice. eachSpanWhere
// is the same edge-walk holdSpans uses for the detail lanes' raw-bit rows;
// only the predicate differs, and folding through it keeps this scalar from
// materializing a span object per press on a capped multi-million-frame replay
const HELD_ACTIONS = [isLeft, isRight];

export function meanHold(frames: readonly FrameDto[]): number {
	let total = 0;
	let count = 0;
	for (const isHeld of HELD_ACTIONS) {
		eachSpanWhere(frames, isHeld, (start, end) => {
			total += end - start;
			count += 1;
		});
	}
	return count === 0 ? 0 : total / count;
}

// hoare-partition quickselect, in place on a typed array: after it returns,
// values[k] is the k-th order statistic and everything left of k is <= it.
// expected linear, so the median below stays cheap on the scene-install path
// even at the multi-million-frame cap where a comparator sort stalls the ui
function quickselect(values: Float64Array, k: number): number {
	let left = 0;
	let right = values.length - 1;
	while (left < right) {
		const pivot = values[(left + right) >> 1];
		let i = left;
		let j = right;
		while (i <= j) {
			while (values[i] < pivot) i += 1;
			while (values[j] > pivot) j -= 1;
			if (i <= j) {
				const swap = values[i];
				values[i] = values[j];
				values[j] = swap;
				i += 1;
				j -= 1;
			}
		}
		if (k <= j) right = j;
		else if (k >= i) left = i;
		else break;
	}
	return values[k];
}

export function medianFrameDelta(frames: readonly FrameDto[]): number {
	if (frames.length < 2) return 0;
	const deltas = new Float64Array(frames.length - 1);
	for (let i = 1; i < frames.length; i++) deltas[i - 1] = frames[i].time - frames[i - 1].time;
	const mid = deltas.length >> 1;
	const upper = quickselect(deltas, mid);
	if (deltas.length % 2 === 1) return upper;
	// selection left everything before mid <= deltas[mid], so the lower middle
	// is that prefix's maximum
	let lower = deltas[0];
	for (let i = 1; i < mid; i++) {
		if (deltas[i] > lower) lower = deltas[i];
	}
	return (lower + upper) / 2;
}

export function analyseScene(scene: LoadedScene, presses: readonly Press[]): ReplayAnalysis {
	const events = scene.simulation.status === "authoritative" ? scene.simulation.events : [];
	const errors = hitErrors(events, scene.renderPlan.objects);
	const meanError = errors.length === 0 ? 0 : errors.reduce((a, b) => a + b, 0) / errors.length;
	const variance = errors.length === 0 ? 0 : errors.reduce((a, b) => a + (b - meanError) ** 2, 0) / errors.length;
	const stdDev = Math.sqrt(variance);
	const early = errors.filter((e) => e < 0).length;
	const late = errors.filter((e) => e > 0).length;
	const signed = early + late;
	const { samples, peak, mean } = velocityTrace(scene.frames, VELOCITY_SAMPLES);

	return {
		errors,
		// lazer's UnstableRate is 10x the standard deviation of hit offsets
		unstableRate: stdDev * 10,
		meanError,
		stdDev,
		earlyFraction: signed === 0 ? 0 : early / signed,
		lateFraction: signed === 0 ? 0 : late / signed,
		histogram: errorHistogram(errors, HISTOGRAM_BINS, ERROR_WINDOW_MS),
		velocity: samples,
		peakVelocity: peak,
		meanVelocity: mean,
		peakTapBpm: peakTapBpm(presses, TAP_WINDOW_MS),
		meanHoldMs: meanHold(scene.frames),
		medianDeltaMs: medianFrameDelta(scene.frames),
		frameCount: scene.frames.length
	};
}
