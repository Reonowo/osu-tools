// the feather: the time window past a moved selection's edges over which a
// move blends into the surrounding path. one uniform rule -- an unselected
// frame's weight is a smoothstep over its time distance to the *nearest*
// selected frame, inside the window -- which reproduces the edge falloff for
// contiguous selections and blends the gaps of disjoint ones. feather
// belongs to the move tool alone; the panel's Δ offset stays exact

import type { Lattice } from "../lib/lattice";
import type { EditOp, FrameDto } from "../lib/scene-types";
import { snapToLatticePoint } from "./ops";

/** the hermite smoothstep 3x² - 2x³, clamped to [0, 1] */
export function smoothstep01(x: number): number {
	const t = Math.min(Math.max(x, 0), 1);
	return t * t * (3 - 2 * t);
}

/** per-frame move weights: 1 for every target, smoothstep(1 - d/feather) for
 * an unselected frame at time distance d < feather from the nearest target.
 * frames beyond the window are absent (weight zero) */
export function featherWeights(
	frames: readonly FrameDto[],
	targets: readonly number[],
	featherMs: number
): Map<number, number> {
	const weights = new Map<number, number>();
	const targetSet = new Set(targets);
	for (const index of targets) {
		if (frames[index] !== undefined) weights.set(index, 1);
	}
	if (featherMs <= 0 || targets.length === 0) return weights;

	const targetTimes = targets
		.map((index) => frames[index]?.time)
		.filter((time): time is number => time !== undefined)
		.sort((a, b) => a - b);
	if (targetTimes.length === 0) return weights;

	// frames are time-sorted, so only the span the windows can reach needs
	// walking: the walk starts at the binary-searched window edge (a late
	// drag in a long replay must not pay for the whole prefix) and each
	// frame binary-searches its nearest target time
	const minTime = targetTimes[0] - featherMs;
	const maxTime = targetTimes[targetTimes.length - 1] + featherMs;
	for (let index = firstIndexAtOrAfter(frames, minTime); index < frames.length; index++) {
		const frame = frames[index];
		if (frame.time > maxTime) break;
		if (targetSet.has(index)) continue;
		const distance = nearestDistance(targetTimes, frame.time);
		if (distance >= featherMs) continue;
		weights.set(index, smoothstep01(1 - distance / featherMs));
	}
	return weights;
}

function firstIndexAtOrAfter(frames: readonly FrameDto[], time: number): number {
	let lo = 0;
	let hi = frames.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (frames[mid].time < time) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

function nearestDistance(sortedTimes: readonly number[], time: number): number {
	let lo = 0;
	let hi = sortedTimes.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (sortedTimes[mid] < time) lo = mid + 1;
		else hi = mid;
	}
	const after = lo < sortedTimes.length ? sortedTimes[lo] - time : Number.POSITIVE_INFINITY;
	const before = lo > 0 ? time - sortedTimes[lo - 1] : Number.POSITIVE_INFINITY;
	return Math.min(after, before);
}

/** the move tool's batch: targets move by the full translation, frames in
 * the feather window by their weighted fraction. snap applies to both alike
 * when the preference is on; every position is f32-truncated to the wire, so
 * the preview drawn from these ops is the authoritative post-landing value.
 * null when nothing would actually move -- an identity commits nothing */
export function featherMoveOps(
	frames: readonly FrameDto[],
	targets: readonly number[],
	dx: number,
	dy: number,
	featherMs: number,
	lattice: Lattice | null,
	snap: boolean
): EditOp[] | null {
	if (targets.length === 0) return null;
	// a zero translation moves nothing: without this, snap alone would
	// fabricate a move for any off-lattice frame under a stationary click
	if (dx === 0 && dy === 0) return null;
	const weights = featherWeights(frames, targets, featherMs);
	const moves: { index: number; x: number; y: number }[] = [];
	const indices = [...weights.keys()].sort((a, b) => a - b);
	for (const index of indices) {
		const frame = frames[index];
		const weight = weights.get(index)!;
		let x = frame.x + dx * weight;
		let y = frame.y + dy * weight;
		if (snap && lattice !== null) {
			x = snapToLatticePoint(x, lattice.step);
			y = snapToLatticePoint(y, lattice.step);
		}
		x = Math.fround(x);
		y = Math.fround(y);
		// identity moves are skipped so a sub-step drag under snap never sends
		// (and never labels) frames that did not move. isOnLattice-style
		// tolerance is unnecessary: equality after fround is the wire's own test
		if (x === frame.x && y === frame.y) continue;
		moves.push({ index, x, y });
	}
	return moves.length > 0 ? [{ kind: "moveFrames", moves }] : null;
}
