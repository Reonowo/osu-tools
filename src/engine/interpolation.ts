// cursor state sampling: the frontend twin of
// engine/src/replay/interpolation.rs (see its module docs for the full
// derivation from framedreplayinputhandler.cs). both ports must reproduce
// fixtures/replays/cursor_interpolation.json -- lazer is the oracle,
// agreement between the two ports alone is not evidence

import type { FrameDto } from "../lib/scene-types";
import { isLeft, isRight } from "./buttons";
import { f32 } from "./vec";

export interface CursorSample {
	x: number;
	y: number;
	buttons: number;
}

export interface Press {
	time: number;
	action: "left" | "right";
	frameIndex: number;
}

/** index of the first frame with time > t (frames sorted by time) */
function partitionPoint(frames: FrameDto[], time: number): number {
	let lo = 0;
	let hi = frames.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (frames[mid].time <= time) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

export function cursorStateAt(frames: FrameDto[], time: number): CursorSample | null {
	if (frames.length === 0) return null;
	const idx = partitionPoint(frames, time);
	if (idx === 0) {
		// before the first frame: position holds, nothing pressed
		// (framedreplayinputhandler.cs:48-72 with currentframeindex -1)
		return { x: frames[0].x, y: frames[0].y, buttons: 0 };
	}
	// duplicate-time runs settle on the last of the run
	// (framedreplayinputhandler.cs:141-146); the <= predicate lands there
	const start = frames[idx - 1];
	const end = idx < frames.length ? frames[idx] : start;
	const clamped = Math.min(Math.max(time, start.time), end.time);
	const [x, y] = vector2ValueAt(clamped, start.x, start.y, end.x, end.y, start.time, end.time);
	return { x, y, buttons: start.buttons };
}

/** interpolation.cs:351-361 -- float-space lerp with the framework's exact
 * zero-duration and zero-elapsed early-outs */
function vector2ValueAt(
	time: number,
	x1: number,
	y1: number,
	x2: number,
	y2: number,
	startTime: number,
	endTime: number
): [number, number] {
	const current = f32(time - startTime);
	const duration = f32(endTime - startTime);
	if (duration === 0 || current === 0) return [x1, y1];
	const t = f32(current / duration);
	return [f32(x1 + f32(t * f32(x2 - x1))), f32(y1 + f32(t * f32(y2 - y1)))];
}

/** rising edges of the two gameplay actions, left before right within one
 * frame (osureplayframe.cs builds pressedactions left-first) */
export function pressEdges(frames: FrameDto[]): Press[] {
	const presses: Press[] = [];
	let prev = 0;
	frames.forEach((frame, frameIndex) => {
		if (isLeft(frame.buttons) && !isLeft(prev)) {
			presses.push({ time: frame.time, action: "left", frameIndex });
		}
		if (isRight(frame.buttons) && !isRight(prev)) {
			presses.push({ time: frame.time, action: "right", frameIndex });
		}
		prev = frame.buttons;
	});
	return presses;
}

export interface HoldSpan {
	start: number;
	end: number;
}

/** the streaming core of the span walk: emits every press-to-release span of
 * a caller-chosen "is this held" predicate over the raw buttons bitfield,
 * materializing nothing itself. shared by spansWhere/holdSpansFlat here and
 * analysis.ts's meanHold -- all walk identical rising/falling edges and
 * differ only in what counts as "held" and what they do with a span, and a
 * capped replay carries millions of frames, so the scalar consumers must be
 * able to fold spans without allocating one object each */
export function eachSpanWhere(
	frames: readonly FrameDto[],
	isHeld: (buttons: number) => boolean,
	emit: (start: number, end: number) => void
): void {
	let down: number | null = null;
	let previous = 0;
	for (const frame of frames) {
		const held = isHeld(frame.buttons);
		if (held && !isHeld(previous)) down = frame.time;
		else if (!held && isHeld(previous) && down !== null) {
			emit(down, frame.time);
			down = null;
		}
		previous = frame.buttons;
	}
	// a press still down at the end closes at the last frame rather than being
	// discarded -- discarding it would silently drop a hold that is still
	// visibly in progress when the replay stream ends
	if (down !== null) emit(down, frames[frames.length - 1].time);
}

/** every span of the predicate as objects -- for small or test-sized inputs;
 * large retained span sets should use holdSpansFlat instead */
export function spansWhere(frames: readonly FrameDto[], isHeld: (buttons: number) => boolean): HoldSpan[] {
	const spans: HoldSpan[] = [];
	eachSpanWhere(frames, isHeld, (start, end) => spans.push({ start, end }));
	return spans;
}

/** rising-to-falling spans of one raw button bit -- what the detail lanes'
 * K1/K2/M1/M2 rows draw. distinct from meanHold's logical-action spans: a
 * keyboard tap sets both its K and M bit for one physical press (buttons.ts),
 * so per-bit spans legitimately double up where meanHold's per-action spans
 * must not */
export function holdSpans(frames: readonly FrameDto[], bit: number): HoldSpan[] {
	return spansWhere(frames, (buttons) => (buttons & bit) !== 0);
}

/** holdSpans pair-packed as [start0, end0, start1, end1, ...] -- the form
 * DetailLanes retains per scene. at the frame cap the object form would pin
 * millions of tiny heap objects for the scene's whole lifetime; a packed
 * Float64Array is one allocation. counted in a first pass so the fill pass
 * allocates exactly once */
export function holdSpansFlat(frames: readonly FrameDto[], bit: number): Float64Array {
	const isHeld = (buttons: number) => (buttons & bit) !== 0;
	let count = 0;
	eachSpanWhere(frames, isHeld, () => {
		count += 1;
	});
	const flat = new Float64Array(count * 2);
	let at = 0;
	eachSpanWhere(frames, isHeld, (start, end) => {
		flat[at] = start;
		flat[at + 1] = end;
		at += 2;
	});
	return flat;
}

/** the packed spans of holdSpansFlat intersecting [start, end], as objects
 * for rendering. chronological spans whose gap is at most mergeGap coalesce:
 * a gap below one lane pixel cannot render distinctly anyway, and duplicate
 * frame times are legal, so a crafted replay can pack millions of spans into
 * one window -- materializing (then mounting) a node per span would stall the
 * webview, while coalescing bounds the slice by the window's pixel budget */
export function sliceSpansFlat(flat: Float64Array, start: number, end: number, mergeGap: number): HoldSpan[] {
	const spans: HoldSpan[] = [];
	for (let i = 0; i < flat.length; i += 2) {
		const spanStart = flat[i];
		const spanEnd = flat[i + 1];
		if (spanStart > end || spanEnd < start) continue;
		const last = spans[spans.length - 1];
		if (last !== undefined && spanStart - last.end <= mergeGap) {
			if (spanEnd > last.end) last.end = spanEnd;
		} else {
			spans.push({ start: spanStart, end: spanEnd });
		}
	}
	return spans;
}

export interface ButtonEdges {
	k1: number[];
	k2: number[];
	m1: number[];
	m2: number[];
}

/** rising-edge times per raw button bit -- the keypress overlay's counts
 * display what the replay recorded, bit by bit */
export function buttonEdges(frames: FrameDto[]): ButtonEdges {
	const edges: ButtonEdges = { k1: [], k2: [], m1: [], m2: [] };
	const bits: [number, keyof ButtonEdges][] = [
		[1, "m1"],
		[2, "m2"],
		[4, "k1"],
		[8, "k2"]
	];
	let prev = 0;
	for (const frame of frames) {
		for (const [bit, key] of bits) {
			if ((frame.buttons & bit) !== 0 && (prev & bit) === 0) edges[key].push(frame.time);
		}
		prev = frame.buttons;
	}
	return edges;
}
