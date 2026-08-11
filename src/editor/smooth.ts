// the smoothing kernel, pinned by the parent design spec so the math is
// testable: gaussian σ 16 ms over a ±48 ms (±3σ) window, truncated at the
// window and renormalized over the samples actually present -- stream
// boundaries clip and renormalize rather than dragging toward an imaginary
// zero. weights read the frames array handed in (the original pre-gesture
// positions: the brush recomputes over its gesture base every pointer-move,
// so brushing the same spot twice does not double-smooth), every frame inside the window
// contributes whether targeted or not, and duplicate-time frames each
// contribute and are each smoothed. computed in f64 (js numbers), blended
// original->smoothed by strength, snapped under the preference, then
// truncated to the wire's f32

import type { Lattice } from "../lib/lattice";
import type { EditOp, FrameDto } from "../lib/scene-types";
import { snapToLatticePoint } from "./ops";

export const SMOOTH_SIGMA_MS = 16;
export const SMOOTH_WINDOW_MS = 48;

/** index of the first frame with time >= t */
function lowerBound(frames: readonly FrameDto[], time: number): number {
	let lo = 0;
	let hi = frames.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (frames[mid].time < time) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/** the smooth batch over `targets`: null when nothing would move (strength
 * zero, empty targets, or an already-symmetric neighbourhood) */
export function smoothMoveOps(
	frames: readonly FrameDto[],
	targets: readonly number[],
	strength: number,
	lattice: Lattice | null,
	snap: boolean
): EditOp[] | null {
	if (targets.length === 0 || strength <= 0) return null;
	const blend = Math.min(strength, 100) / 100;
	const twoSigmaSq = 2 * SMOOTH_SIGMA_MS * SMOOTH_SIGMA_MS;
	const moves: { index: number; x: number; y: number }[] = [];
	for (const index of targets) {
		const frame = frames[index];
		if (frame === undefined) continue;
		const centre = frame.time;
		let weightSum = 0;
		let sumX = 0;
		let sumY = 0;
		for (let j = lowerBound(frames, centre - SMOOTH_WINDOW_MS); j < frames.length; j++) {
			const sample = frames[j];
			const dt = sample.time - centre;
			if (dt > SMOOTH_WINDOW_MS) break;
			const weight = Math.exp(-(dt * dt) / twoSigmaSq);
			weightSum += weight;
			sumX += weight * sample.x;
			sumY += weight * sample.y;
		}
		let x = frame.x + (sumX / weightSum - frame.x) * blend;
		let y = frame.y + (sumY / weightSum - frame.y) * blend;
		if (snap && lattice !== null) {
			x = snapToLatticePoint(x, lattice.step);
			y = snapToLatticePoint(y, lattice.step);
		}
		x = Math.fround(x);
		y = Math.fround(y);
		if (x === frame.x && y === frame.y) continue;
		moves.push({ index, x, y });
	}
	return moves.length > 0 ? [{ kind: "moveFrames", moves }] : null;
}
