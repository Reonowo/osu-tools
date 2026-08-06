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
