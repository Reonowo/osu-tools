// dispatch-time expansion for the frames-panel operations. every builder
// reads the authoritative frames it is handed and returns final wire values
// -- the engine validates but never invents positions; policy lives here.
// null means identity: nothing to send

import { cursorStateAt } from "../engine/interpolation";
import { isOnLattice, type Lattice } from "../lib/lattice";
import type { EditOp, FrameDto } from "../lib/scene-types";

export function snapToLatticePoint(value: number, step: number): number {
	return Math.round(value / step) * step;
}

/** the frames an operation applies to: the selection, or the frame-cursor
 * frame when nothing is selected. the one rule behind every panel op and the
 * smooth-selection keybind -- called inside the expand closure, so a queued
 * op reads the selection as of dispatch */
export function editTargets(selection: readonly number[], cursorIndex: number): readonly number[] {
	return selection.length > 0 ? selection : [cursorIndex];
}

/** moves the given frames by (dx, dy), snapped onto the lattice when the
 * preference is on and one was inferred */
export function nudgeOps(
	frames: readonly FrameDto[],
	indices: readonly number[],
	dx: number,
	dy: number,
	lattice: Lattice | null,
	snap: boolean
): EditOp[] | null {
	if (dx === 0 && dy === 0) return null;
	const moves: { index: number; x: number; y: number }[] = [];
	for (const index of indices) {
		const frame = frames[index];
		if (frame === undefined) continue;
		let x = frame.x + dx;
		let y = frame.y + dy;
		if (snap && lattice !== null) {
			x = snapToLatticePoint(x, lattice.step);
			y = snapToLatticePoint(y, lattice.step);
		}
		if (x === frame.x && y === frame.y) continue;
		moves.push({ index, x, y });
	}
	return moves.length > 0 ? [{ kind: "moveFrames", moves }] : null;
}

/** moves each off-lattice frame to its nearest lattice point; frames the
 * tolerance already counts as on-lattice are identity-skipped so a snap
 * never generates micro-moves out of f32 round-trip noise */
export function snapOps(
	frames: readonly FrameDto[],
	indices: readonly number[],
	lattice: Lattice | null
): EditOp[] | null {
	if (lattice === null) return null;
	const moves: { index: number; x: number; y: number }[] = [];
	for (const index of indices) {
		const frame = frames[index];
		if (frame === undefined) continue;
		if (isOnLattice(frame.x, lattice.step) && isOnLattice(frame.y, lattice.step)) continue;
		moves.push({
			index,
			x: snapToLatticePoint(frame.x, lattice.step),
			y: snapToLatticePoint(frame.y, lattice.step)
		});
	}
	return moves.length > 0 ? [{ kind: "moveFrames", moves }] : null;
}

/** a new frame at the given time: integral ms, position interpolated between
 * neighbours (the cursor-interpolation port), buttons inherited from the
 * previous frame so the insert is keypress-neutral. the position snaps
 * whenever a lattice was inferred, independent of the snap preference --
 * the spec's synthetic-frame emittability rule */
export function insertOps(frames: readonly FrameDto[], timeMs: number, lattice: Lattice | null): EditOp[] | null {
	if (frames.length === 0) return null;
	const time = Math.round(timeMs);
	let previous = -1;
	for (let i = 0; i < frames.length; i++) {
		if (frames[i].time <= time) previous = i;
		else break;
	}
	// cursorStateAt only reads its frames argument; the panel-op callers here
	// hand it an immutable snapshot, so the mutable parameter type is safe to cast
	const sample = cursorStateAt(frames as FrameDto[], time);
	const at = sample ?? frames[previous >= 0 ? previous : 0];
	let x = at.x;
	let y = at.y;
	if (lattice !== null) {
		x = snapToLatticePoint(x, lattice.step);
		y = snapToLatticePoint(y, lattice.step);
	}
	const buttons = previous >= 0 ? frames[previous].buttons : 0;
	return [{ kind: "insertFrames", frames: [{ time, x, y, buttons }] }];
}
