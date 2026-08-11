// the shared press-operations module: every operation that touches a press
// edge -- erase's edge preservation and the press operations (delete,
// nudge, retime, add) -- realizes edges and rewrites patterns through this
// one seam. it owns the hybrid rule's 1 ms directional tolerance, boundary-
// frame construction (neighbour-interpolated position, lattice-snapped
// whenever a lattice was inferred, independent of the snap preference,
// f32-truncated), the degenerate-press guard, the same-millisecond re-press
// ordering rejection, and the paired K/M pattern rules. the four paired-
// provenance transitions -- 0->5->0 delete clears the mouse bit, 1->5->1
// delete leaves the mouse hold intact, a K press over its paired mouse hold
// writes the K bit with the mouse lane showing the provenance gap, and an M
// press under its paired K is rejected -- are this module's contract

import { isM1, isM2, K1, K2, M1, M2, physicalButton, type PhysicalKey } from "../engine/buttons";
import { cursorStateAt } from "../engine/interpolation";
import type { Lattice } from "../lib/lattice";
import type { EditOp, FrameDto } from "../lib/scene-types";
import { snapToLatticePoint } from "./ops";
import { firstAtOrAfter, pressRunAt, pressRunsOfKey, type PressRun, type PressSelection } from "./press-runs";

/** the hybrid rule's directional tolerance: a press edge lands on an
 * existing frame when one sits within this many ms in the press's
 * direction; otherwise a boundary frame is inserted at the exact ms */
export const EDGE_TOLERANCE_MS = 1;

/** an added press when the key has no observed presses to take a median from */
export const FALLBACK_PRESS_DURATION_MS = 60;

/** end at or before start: no representable press */
export function pressCollapsed(realizedStart: number, realizedEnd: number): boolean {
	return realizedEnd <= realizedStart;
}

export function collapseRejection(action: string, key: PhysicalKey, atMs: number): string {
	return `${action} would collapse a ${key} press at ${atMs} ms to zero length`;
}

export function repressRejection(action: string, key: PhysicalKey, atMs: number): string {
	return `${action} would land a ${key} release behind its re-press at ${atMs} ms`;
}

function pairedRejection(action: string, key: PhysicalKey, atMs: number): string {
	const paired = key === "M1" ? "K1" : "K2";
	return `${action} would put an ${key} press under its paired ${paired} at ${atMs} ms, which the raw encoding cannot represent`;
}

/** clears one physical key's press contribution from a raw pattern. a K key
 * rides with its paired mouse bit, so releasing K1 clears M1 too -- unless
 * the deleted release frame shows the mouse hold genuinely continuing, in
 * which case its bit is inherited. an M key clears only its own bit */
export function releasePattern(buttons: number, key: PhysicalKey, releasedButtons: number): number {
	switch (key) {
		case "K1":
			return (buttons & ~(K1 | M1)) | (isM1(releasedButtons) ? M1 : 0);
		case "K2":
			return (buttons & ~(K2 | M2)) | (isM2(releasedButtons) ? M2 : 0);
		case "M1":
			return buttons & ~M1;
		case "M2":
			return buttons & ~M2;
	}
}

/** sets one physical key's press bits on a raw pattern. a K key writes its
 * paired mouse bit alongside -- stable's own encoding (k1 always rides with
 * m1) -- which over an independent mouse hold reads as the provenance gap:
 * the mouse bit stays underneath, reversibly. an M key sets only its own bit */
export function pressPattern(buttons: number, key: PhysicalKey): number {
	switch (key) {
		case "K1":
			return buttons | K1 | M1;
		case "K2":
			return buttons | K2 | M2;
		case "M1":
			return buttons | M1;
		case "M2":
			return buttons | M2;
	}
}

/** an M press under its paired keyboard bit is unrepresentable: raw K|M
 * already means "keyboard", so the mouse press would silently vanish */
export function pairedKeyHeld(buttons: number, key: PhysicalKey): boolean {
	if (key === "M1") return (buttons & K1) !== 0;
	if (key === "M2") return (buttons & K2) !== 0;
	return false;
}

/** the paired mouse bit reads as an independent hold on this pattern */
function pairedMouseIndependent(buttons: number, key: PhysicalKey): boolean {
	if (key === "K1") return isM1(buttons);
	if (key === "K2") return isM2(buttons);
	return false;
}

/** clears one key's contribution across a whole released span. the paired
 * mouse bit clears with a K key except where the span connects to an
 * adjacent independent mouse hold (the 1->5->1 shape), where clearing it
 * would release an ongoing action the operation never touched */
function clearPattern(buttons: number, key: PhysicalKey, keepPaired: boolean): number {
	switch (key) {
		case "K1":
			return (buttons & ~(K1 | M1)) | (keepPaired ? buttons & M1 : 0);
		case "K2":
			return (buttons & ~(K2 | M2)) | (keepPaired ? buttons & M2 : 0);
		case "M1":
			return buttons & ~M1;
		case "M2":
			return buttons & ~M2;
	}
}

/** a boundary frame at the exact millisecond: position interpolated over
 * the surviving stream (falling back to `fallback` when the stream cannot
 * answer), lattice-snapped whenever a lattice was inferred -- independent
 * of the snap preference, since tool output must carry no detectable
 * signature the source itself lacked -- and f32-truncated */
export function boundaryFrame(
	survivors: readonly FrameDto[],
	time: number,
	buttons: number,
	lattice: Lattice | null,
	fallback?: { x: number; y: number }
): FrameDto {
	// cursorStateAt only reads its frames argument; the immutable snapshot
	// handed here makes the mutable parameter type safe to cast (ops.ts's
	// insertOps makes the same cast)
	const sample = cursorStateAt(survivors as FrameDto[], time);
	let x = sample?.x ?? fallback?.x ?? 0;
	let y = sample?.y ?? fallback?.y ?? 0;
	if (lattice !== null) {
		x = snapToLatticePoint(x, lattice.step);
		y = snapToLatticePoint(y, lattice.step);
	}
	return { time, x: Math.fround(x), y: Math.fround(y), buttons };
}

/** raw buttons of the stream at `time`: the last frame at-or-before it, or
 * nothing pressed before the first frame */
function underlyingButtons(frames: readonly FrameDto[], time: number): number {
	const sample = cursorStateAt(frames as FrameDto[], time);
	return sample?.buttons ?? 0;
}

export interface PressEdit {
	/** desired new edge times in ms; an absent edge keeps its frames */
	start?: number;
	end?: number;
}

/** an operation's computed outcome: the produced press named by key and
 * start time -- the time-space identity a landing splice cannot shift */
export interface PressOutcome {
	key: PhysicalKey;
	startTime: number;
}

export type PressExpansion =
	| {
			ops: EditOp[];
			/** the computed outcome the press selection follows, merges folded
			 * in; null when the operation removes the press */
			outcome: PressOutcome | null;
			/** the post-edit merged run, for previews and realized readouts;
			 * null for delete */
			realized: { startTime: number; endTime: number } | null;
			/** the time range whose authoritative spans a preview replaces */
			affected: { from: number; to: number };
	  }
	| { rejected: string };

/** resolves a computed outcome against the post-splice frames: the run of
 * that key containing the outcome's start time names the new selection */
export function outcomeSelection(frames: readonly FrameDto[], outcome: PressOutcome | null): PressSelection | null {
	if (outcome === null) return null;
	const run = pressRunAt(frames, outcome.key, outcome.startTime);
	return run === null ? null : { key: outcome.key, startIndex: run.startIndex };
}

/** the chevron step's target: the nearest existing frame time strictly
 * earlier or later than `fromTime`, skipping duplicate-time runs so a step
 * always changes the realized edge; null at the stream's ends */
export function adjacentFrameTime(frames: readonly FrameDto[], fromTime: number, direction: -1 | 1): number | null {
	if (direction === 1) {
		let i = firstAtOrAfter(frames, fromTime);
		while (i < frames.length && frames[i].time <= fromTime) i += 1;
		return i < frames.length ? frames[i].time : null;
	}
	const i = firstAtOrAfter(frames, fromTime) - 1;
	return i >= 0 ? frames[i].time : null;
}

/** the existing frame time nearest to `time`; earlier wins a tie so a
 * snapped landing is deterministic. null on an empty stream */
export function nearestFrameTime(frames: readonly FrameDto[], time: number): number | null {
	if (frames.length === 0) return null;
	const after = firstAtOrAfter(frames, time);
	const before = after - 1;
	if (before < 0) return frames[after].time;
	if (after >= frames.length) return frames[before].time;
	return time - frames[before].time <= frames[after].time - time ? frames[before].time : frames[after].time;
}

/** the median observed duration of a key's closed presses -- an added press
 * should look like the player's own. FALLBACK_PRESS_DURATION_MS when the
 * key has none */
export function medianPressDuration(frames: readonly FrameDto[], key: PhysicalKey): number {
	const durations = pressRunsOfKey(frames, key)
		.filter((run) => !run.open)
		.map((run) => run.endTime - run.startTime)
		.sort((a, b) => a - b);
	if (durations.length === 0) return FALLBACK_PRESS_DURATION_MS;
	const mid = Math.floor(durations.length / 2);
	return durations.length % 2 === 1 ? durations[mid] : Math.round((durations[mid - 1] + durations[mid]) / 2);
}

/** deletes a press: the key's bits clear across the run's span under the
 * paired-provenance rules -- the paired mouse bit clears with a keyboard
 * tap (0->5->0) and survives where the span connects to an adjacent
 * independent mouse hold (1->5->1) */
export function expandDeletePress(frames: readonly FrameDto[], run: PressRun): PressExpansion {
	const leftConnects = run.startIndex > 0 && pairedMouseIndependent(frames[run.startIndex - 1].buttons, run.key);
	const rightConnects =
		run.fallIndex < frames.length && pairedMouseIndependent(frames[run.fallIndex].buttons, run.key);
	const keepPaired = leftConnects || rightConnects;
	const sets: { index: number; buttons: number }[] = [];
	for (let i = run.startIndex; i < run.fallIndex; i++) {
		const next = clearPattern(frames[i].buttons, run.key, keepPaired);
		if (next !== frames[i].buttons) sets.push({ index: i, buttons: next });
	}
	return {
		ops: sets.length > 0 ? [{ kind: "setButtons", sets }] : [],
		outcome: null,
		realized: null,
		affected: { from: run.startTime, to: run.endTime }
	};
}

/** retimes a press's edges to the given millisecond targets under the
 * hybrid rule. serves every edge operation: a nudge or drag passes existing
 * frame times (landing exactly, never synthesizing), direct entry passes
 * arbitrary ms (the only path that can insert a boundary frame). an edge
 * left out of `edit` keeps its frames */
export function expandRetimePress(
	frames: readonly FrameDto[],
	run: PressRun,
	edit: PressEdit,
	lattice: Lattice | null,
	action: string
): PressExpansion {
	const targetStart = edit.start === undefined ? null : Math.round(edit.start);
	const targetEnd = edit.end === undefined ? null : Math.round(edit.end);
	return rewriteSpan(
		frames,
		run.key,
		run,
		targetStart === run.startTime ? null : targetStart,
		targetEnd === run.endTime ? null : targetEnd,
		lattice,
		action
	);
}

/** a new press at `atMs` for `key`: duration from the player's own median,
 * edges under the hybrid rule, synthesized frames inheriting the other
 * keys' hold state; overlap with an adjacent same-key press merges */
export function expandAddPress(
	frames: readonly FrameDto[],
	key: PhysicalKey,
	atMs: number,
	durationMs: number,
	lattice: Lattice | null,
	action: string
): PressExpansion {
	const start = Math.round(atMs);
	const end = start + Math.max(1, Math.round(durationMs));
	return rewriteSpan(frames, key, null, start, end, lattice, action);
}

/** an edge's realized landing: an existing frame within the tolerance in
 * the press's direction (into the press: a start searches forward, an end
 * backward, so the realized press never outgrows the request), else the
 * exact millisecond by boundary insert */
function realizeEdge(
	frames: readonly FrameDto[],
	target: number,
	edge: "start" | "end"
): { time: number; insert: boolean } {
	const lo = edge === "start" ? target : target - EDGE_TOLERANCE_MS;
	const hi = edge === "start" ? target + EDGE_TOLERANCE_MS : target;
	let best: number | null = null;
	for (let i = firstAtOrAfter(frames, lo); i < frames.length && frames[i].time <= hi; i++) {
		const t = frames[i].time;
		if (best === null || Math.abs(t - target) < Math.abs(best - target)) best = t;
	}
	return best === null ? { time: target, insert: true } : { time: best, insert: false };
}

/** the core rewrite: one key's held signal becomes [start, end) in time.
 * frames inside the span gain the key, old-run frames left outside release
 * it, and edges the hybrid rule could not land insert boundary frames.
 * same-key runs the span meets or overlaps merge -- backward by pressing
 * through the previous run's fall, forward by leaving the meeting frame's
 * rise unreleased. a same-millisecond ordering conflict is structurally
 * unreachable here: a boundary only inserts where no frame sits at its
 * millisecond, so it can never land behind a surviving re-press */
function rewriteSpan(
	frames: readonly FrameDto[],
	key: PhysicalKey,
	oldRun: PressRun | null,
	targetStart: number | null,
	targetEnd: number | null,
	lattice: Lattice | null,
	action: string
): PressExpansion {
	const button = physicalButton(key);
	const start =
		targetStart === null
			? { time: (oldRun as PressRun).startTime, insert: false }
			: realizeEdge(frames, targetStart, "start");
	const end =
		targetEnd === null
			? { time: (oldRun as PressRun).endTime, insert: false }
			: realizeEdge(frames, targetEnd, "end");

	if (pressCollapsed(start.time, end.time)) {
		return { rejected: collapseRejection(action, key, start.time) };
	}

	// an open run with its end untouched has no release to preserve: the
	// span runs through the stream's end
	const openEnd = targetEnd === null && oldRun !== null && oldRun.open;

	// the span's frame-index bounds. an untouched edge keeps the run's own
	// indices rather than a time window: duplicate-time frames beside the
	// boundary (an unheld duplicate at the start's millisecond, a held one
	// at the fall's) sit outside the run, and a time window would rewrite
	// them -- moving the edge the edit never named
	const spanFrom = targetStart === null ? (oldRun as PressRun).startIndex : firstAtOrAfter(frames, start.time);
	const spanUntil =
		targetEnd === null
			? openEnd
				? frames.length
				: (oldRun as PressRun).fallIndex
			: firstAtOrAfter(frames, end.time);

	const sets = new Map<number, number>();
	const released = new Set<number>();

	// release: old-run frames left outside the new span. a released prefix
	// keeps the paired mouse bit when it connects to an independent hold on
	// the left, a suffix on the right; a segment that turns out to be the
	// whole run connects like a delete -- either side
	if (oldRun !== null) {
		const leftConnects =
			oldRun.startIndex > 0 && pairedMouseIndependent(frames[oldRun.startIndex - 1].buttons, key);
		const rightConnects =
			oldRun.fallIndex < frames.length && pairedMouseIndependent(frames[oldRun.fallIndex].buttons, key);
		const outside: number[] = [];
		for (let i = oldRun.startIndex; i < oldRun.fallIndex; i++) {
			if (i >= spanFrom && i < spanUntil) continue;
			outside.push(i);
		}
		const wholeRun = outside.length === oldRun.fallIndex - oldRun.startIndex;
		for (const i of outside) {
			const prefix = frames[i].time < start.time;
			const keep = wholeRun ? leftConnects || rightConnects : prefix ? leftConnects : rightConnects;
			released.add(i);
			const next = clearPattern(frames[i].buttons, key, keep);
			if (next !== frames[i].buttons) sets.set(i, next);
		}
	}

	// press: frames inside the new span lacking the key
	for (let i = spanFrom; i < spanUntil; i++) {
		const buttons = frames[i].buttons;
		if (button.is(buttons)) continue;
		if (pairedKeyHeld(buttons, key)) {
			return { rejected: pairedRejection(action, key, frames[i].time) };
		}
		sets.set(i, pressPattern(buttons, key));
	}

	// merge detection at the edited edges: the key already held coming into
	// the span start means the press flows out of the previous run and no
	// rise exists to insert; a distinct pre-edit run containing the span's
	// end means the spans meet or overlap and no release exists to write.
	// released frames belong to the old run alone, so any other run survives
	// the rewrite intact. an untouched edge merges with nothing -- its
	// frames are the run's own, so a same-millisecond neighbour (a re-press
	// beside the fall) stays a distinct press
	const beforeIdx = spanFrom - 1;
	const mergeBack =
		targetStart !== null && beforeIdx >= 0 && button.is(frames[beforeIdx].buttons) && !released.has(beforeIdx);
	let mergeForwardRun: PressRun | null = null;
	if (targetEnd !== null) {
		const covering = pressRunAt(frames, key, end.time);
		if (covering !== null && (oldRun === null || covering.startIndex !== oldRun.startIndex)) {
			mergeForwardRun = covering;
		}
	}

	// boundary inserts for edges the hybrid rule could not land
	const inserts: FrameDto[] = [];
	if (start.insert && !mergeBack) {
		const underlying = underlyingButtons(frames, start.time);
		if (pairedKeyHeld(underlying, key)) {
			return { rejected: pairedRejection(action, key, start.time) };
		}
		inserts.push(boundaryFrame(frames, start.time, pressPattern(underlying, key), lattice));
	}
	if (end.insert && mergeForwardRun === null) {
		const underlyingIdx = firstAtOrAfter(frames, end.time) - 1;
		const underlying = underlyingIdx >= 0 ? frames[underlyingIdx].buttons : 0;
		// the release boundary keeps the paired mouse bit exactly as the
		// released frames beside it do: an independent hold at that ms
		// continues through it, and a shrink inside the old run follows the
		// suffix's right-connection rule
		const inOldRun = oldRun !== null && underlyingIdx >= oldRun.startIndex && underlyingIdx < oldRun.fallIndex;
		const rightConnects =
			oldRun !== null &&
			oldRun.fallIndex < frames.length &&
			pairedMouseIndependent(frames[oldRun.fallIndex].buttons, key);
		const keep = pairedMouseIndependent(underlying, key) || (inOldRun && rightConnects);
		inserts.push(boundaryFrame(frames, end.time, clearPattern(underlying, key, keep), lattice));
	}

	// the produced run, merges folded in
	let outcomeStart = start.time;
	if (mergeBack) {
		let i = beforeIdx;
		while (i > 0 && button.is(frames[i - 1].buttons)) i -= 1;
		outcomeStart = frames[i].time;
	}
	let outcomeEnd = openEnd ? (oldRun as PressRun).endTime : end.time;
	if (mergeForwardRun !== null) outcomeEnd = mergeForwardRun.endTime;

	const setsList = [...sets.entries()].sort((a, b) => a[0] - b[0]).map(([index, buttons]) => ({ index, buttons }));
	const ops: EditOp[] = [];
	if (setsList.length > 0) ops.push({ kind: "setButtons", sets: setsList });
	if (inserts.length > 0) ops.push({ kind: "insertFrames", frames: inserts });
	return {
		ops,
		outcome: { key, startTime: outcomeStart },
		realized: { startTime: outcomeStart, endTime: outcomeEnd },
		affected: {
			from: Math.min(oldRun?.startTime ?? start.time, outcomeStart),
			to: Math.max(oldRun?.endTime ?? end.time, outcomeEnd)
		}
	};
}
