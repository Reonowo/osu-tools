// the press run model: press editing's object. a press is a physical key's
// maximal held-run over the same per-key predicate the detail lanes render
// (buttons.ts's PHYSICAL_BUTTONS), identified by (key, run-start frame
// index). distinct from the action-attributed press *rows* the keypress
// table shows (interpolation.ts pressEdges): a mid-hold provenance change
// (raw 1 -> 5 -> 1) starts a run with no row, and a row's displayed release
// can outlive its press's falling edge -- a run's realized times are what a
// press operation actually rewrites

import { physicalButton, type PhysicalKey } from "../engine/buttons";
import type { FrameDto } from "../lib/scene-types";

/** the press selection: the single press keypress editing operates on.
 * independent of the frame selection; selecting never seeks */
export interface PressSelection {
	key: PhysicalKey;
	startIndex: number;
}

export interface PressRun {
	key: PhysicalKey;
	/** run-start frame index -- the press's identity */
	startIndex: number;
	/** the fall frame's index (the first frame where the key reads off
	 * again), or frames.length when the press holds through the stream's end */
	fallIndex: number;
	startTime: number;
	/** the fall frame's time -- when the release actually happens -- or the
	 * last frame's time for an open run */
	endTime: number;
	/** held through the stream's end: no falling edge exists */
	open: boolean;
}

/** first index with frames[i].time > t (frames sorted by time) */
function firstAfter(frames: readonly FrameDto[], time: number): number {
	let lo = 0;
	let hi = frames.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (frames[mid].time <= time) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/** first index with frames[i].time >= t */
export function firstAtOrAfter(frames: readonly FrameDto[], time: number): number {
	let lo = 0;
	let hi = frames.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (frames[mid].time < time) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

function buildRun(frames: readonly FrameDto[], key: PhysicalKey, startIndex: number, fallIndex: number): PressRun {
	const open = fallIndex >= frames.length;
	return {
		key,
		startIndex,
		fallIndex,
		startTime: frames[startIndex].time,
		endTime: open ? frames[frames.length - 1].time : frames[fallIndex].time,
		open
	};
}

/** the maximal run containing `index`; null when the key is not held there */
export function pressRunFromIndex(frames: readonly FrameDto[], key: PhysicalKey, index: number): PressRun | null {
	const button = physicalButton(key);
	const frame = frames[index];
	if (frame === undefined || !button.is(frame.buttons)) return null;
	let startIndex = index;
	while (startIndex > 0 && button.is(frames[startIndex - 1].buttons)) startIndex -= 1;
	let fallIndex = index + 1;
	while (fallIndex < frames.length && button.is(frames[fallIndex].buttons)) fallIndex += 1;
	return buildRun(frames, key, startIndex, fallIndex);
}

/** the run of `key` whose held span contains `time`: start <= t < end, with
 * a zero-length run containing exactly its own millisecond and an open run
 * containing through its last frame. among duplicate-time frames the last
 * held one at the millisecond names the run, matching the stream's own
 * "state at t is the last frame at-or-before t" rule */
export function pressRunAt(frames: readonly FrameDto[], key: PhysicalKey, time: number): PressRun | null {
	const button = physicalButton(key);
	let i = firstAfter(frames, time) - 1;
	// a released duplicate at the same millisecond walks over to the held
	// frame behind it (a zero-length press, or a fall beside a re-press)
	while (i >= 0 && !button.is(frames[i].buttons) && frames[i].time === time) i -= 1;
	if (i < 0 || !button.is(frames[i].buttons)) return null;
	const run = pressRunFromIndex(frames, key, i);
	if (run === null) return null;
	// a closed run does not contain its release instant (the key already
	// reads off there), except a zero-length press, which contains exactly
	// its own millisecond; an open run has no release and contains through
	// its last frame
	const contains =
		(time >= run.startTime && time < run.endTime) ||
		time === run.startTime ||
		(run.open && time >= run.startTime && time <= run.endTime);
	return contains ? run : null;
}

/** the run of `key` whose release lies within `withinMs` at or before
 * `time`: the interval search behind near-miss edge grabs, where a run
 * shorter than the window sits entirely between point probes at the
 * window's ends and would never be sampled. a run still held at `time`
 * returns null -- pressRunAt already names it */
export function runEndingWithin(
	frames: readonly FrameDto[],
	key: PhysicalKey,
	time: number,
	withinMs: number
): PressRun | null {
	const button = physicalButton(key);
	// the scan starts at the last frame at-or-before `time`: a fall sitting
	// exactly at the probed millisecond is a zero-distance edge, not a miss
	for (let i = firstAfter(frames, time) - 1; i >= 0 && frames[i].time >= time - withinMs; i--) {
		// a frame in the window that is held, or whose predecessor is held
		// (the window catching only the fall frame of a sparsely-sampled
		// run), names the candidate run
		const heldIndex = button.is(frames[i].buttons) ? i : i > 0 && button.is(frames[i - 1].buttons) ? i - 1 : null;
		if (heldIndex === null) continue;
		const run = pressRunFromIndex(frames, key, heldIndex);
		return run !== null && run.endTime <= time ? run : null;
	}
	return null;
}

/** the run of `key` whose rise lies within `withinMs` at or after `time`;
 * the forward counterpart of runEndingWithin */
export function runStartingWithin(
	frames: readonly FrameDto[],
	key: PhysicalKey,
	time: number,
	withinMs: number
): PressRun | null {
	const button = physicalButton(key);
	for (let i = firstAtOrAfter(frames, time); i < frames.length && frames[i].time <= time + withinMs; i++) {
		if (!button.is(frames[i].buttons)) continue;
		const run = pressRunFromIndex(frames, key, i);
		return run !== null && run.startTime >= time ? run : null;
	}
	return null;
}

/** every run of one key, stream order -- the enumeration the median and the
 * panel counts fold over */
export function pressRunsOfKey(frames: readonly FrameDto[], key: PhysicalKey): PressRun[] {
	const button = physicalButton(key);
	const runs: PressRun[] = [];
	let startIndex = -1;
	for (let i = 0; i <= frames.length; i++) {
		const held = i < frames.length && button.is(frames[i].buttons);
		if (held && startIndex < 0) startIndex = i;
		if (!held && startIndex >= 0) {
			runs.push(buildRun(frames, key, startIndex, i));
			startIndex = -1;
		}
	}
	return runs;
}
