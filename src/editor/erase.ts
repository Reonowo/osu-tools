// erase expansion: frame deletion that never destroys a keypress. the
// hybrid rule (CONTEXT.md) preserves every physical key's press edges: a
// deleted edge frame lands its edge on a surviving frame when one sits
// within 1 ms in the press's direction, and otherwise a boundary frame is
// inserted at the edge's exact millisecond -- interpolated position over the
// surviving stream, lattice-snapped whenever a lattice was inferred
// (independent of the snap preference: tool output must carry no detectable
// signature the source itself lacked), other keys' hold state inherited from
// the deleted frame's own pattern, which is the ground truth at that ms.
// a batch whose rewrites would collapse a press to zero or negative length
// is rejected whole, before any ipc. the edge machinery itself -- the
// tolerance, boundary construction, pairing rules, and rejections -- is the
// shared press-operations module (press-ops.ts), which the press operations
// consume through the same seam

import { PHYSICAL_BUTTONS, type PhysicalButton } from "../engine/buttons";
import {
	boundaryFrame,
	collapseRejection,
	EDGE_TOLERANCE_MS,
	pressCollapsed,
	releasePattern,
	repressRejection
} from "./press-ops";
import { remapIndex } from "./splice";
import type { Lattice } from "../lib/lattice";
import type { EditOp, FrameChanges, FrameDto } from "../lib/scene-types";

/** a swept frame's identity: the index it had when swept plus its time, so
 * a dispatch-time re-expansion can verify the frame is still the one meant
 * and drop the ones an interleaved edit moved out from under the intent */
export interface EraseTarget {
	index: number;
	time: number;
}

export type EraseExpansion = { ops: EditOp[]; deleteCount: number } | { rejected: string };

/** carries a queued intent's swept identities through a landed splice, the
 * same transform the store applies to queued computed payloads: indices
 * shift, targets whose frame the splice removed drop */
export function remapEraseTargets(targets: readonly EraseTarget[], changes: FrameChanges): EraseTarget[] {
	return targets.flatMap((target) => {
		const index = remapIndex(target.index, changes);
		return index === null ? [] : [{ index, time: target.time }];
	});
}

export function expandErase(
	frames: readonly FrameDto[],
	targets: readonly EraseTarget[],
	lattice: Lattice | null
): EraseExpansion {
	const deleteSet = new Set<number>();
	for (const target of targets) {
		if (frames[target.index]?.time === target.time) deleteSet.add(target.index);
	}
	if (deleteSet.size === 0) return { ops: [], deleteCount: 0 };
	if (deleteSet.size >= frames.length) {
		return { rejected: "an erase may not delete every frame in the replay" };
	}
	const indices = [...deleteSet].sort((a, b) => a - b);
	const spanLo = indices[0];
	const spanHi = indices[indices.length - 1];

	// boundary positions interpolate over what will actually remain. only the
	// span around the deletions can matter: spanLo - 1 and spanHi + 1 survive
	// by construction and bracket every insert time, except that duplicate
	// times past spanHi must ride along so the slice keeps cursorStateAt's
	// last-of-a-tied-run pick, plus one frame beyond as the right bracket
	let sliceEnd = Math.min(frames.length - 1, spanHi + 1);
	while (sliceEnd < frames.length - 1 && frames[sliceEnd].time <= frames[spanHi].time) sliceEnd += 1;
	const survivors: FrameDto[] = [];
	for (let i = Math.max(0, spanLo - 1); i <= sliceEnd; i++) {
		if (!deleteSet.has(i)) survivors.push(frames[i]);
	}

	/** survivor index -> rewritten raw buttons, accumulated across keys */
	const rewrites = new Map<number, number>();
	/** deleted source frame index -> boundary insert. keyed (and later
	 * emitted) by source index so duplicate-time frames keep their stream
	 * order, and one frame carrying several keys' edges donates one insert */
	const boundarySources = new Set<number>();
	let rejection: string | null = null;

	const handleRun = (button: PhysicalButton, rise: number, fall: number): void => {
		if (rejection !== null) return;
		const key = button.label;
		const riseTime = frames[rise].time;
		let realizedStart = riseTime;
		if (deleteSet.has(rise)) {
			// the press's direction from a rising edge is forward: an in-run
			// survivor within 1 ms already carries the bit and needs no rewrite
			let anchor = -1;
			for (let j = rise + 1; j < fall; j++) {
				if (!deleteSet.has(j)) {
					anchor = j;
					break;
				}
			}
			if (anchor >= 0 && frames[anchor].time - riseTime <= EDGE_TOLERANCE_MS) {
				realizedStart = frames[anchor].time;
			} else {
				boundarySources.add(rise);
			}
		}
		// an open press (held through the stream's end) has no falling edge
		if (fall >= frames.length) return;
		const fallTime = frames[fall].time;
		let realizedEnd = fallTime;
		if (deleteSet.has(fall)) {
			// naturally preserved: the first surviving frame from the release
			// onward is already off within 1 ms -- and not a re-press, which
			// would merge two presses into one
			let next = -1;
			for (let j = fall; j < frames.length; j++) {
				if (!deleteSet.has(j)) {
					next = j;
					break;
				}
			}
			const nextHeld = next >= 0 && button.is(frames[next].buttons);
			if (next >= 0 && !nextHeld && frames[next].time - fallTime <= EDGE_TOLERANCE_MS) {
				realizedEnd = frames[next].time;
			} else {
				// the press's direction from a falling edge is backward: the
				// release rewrites onto the last in-run survivor within 1 ms
				let last = -1;
				for (let j = fall - 1; j >= rise; j--) {
					if (!deleteSet.has(j)) {
						last = j;
						break;
					}
				}
				if (last >= 0 && fallTime - frames[last].time <= EDGE_TOLERANCE_MS) {
					const current = rewrites.get(last) ?? frames[last].buttons;
					rewrites.set(last, releasePattern(current, key, frames[fall].buttons));
					realizedEnd = frames[last].time;
				} else if (nextHeld && frames[next].time === fallTime) {
					// the engine inserts after all equal-time frames, so a
					// boundary release here would land behind the surviving
					// same-millisecond re-press and turn it off -- an order the
					// wire format cannot express, so the batch refuses
					rejection = repressRejection("erasing these frames", key, fallTime);
					return;
				} else {
					boundarySources.add(fall);
				}
			}
		}
		// the guard applies on every path that moved an edge; a press whose
		// edges both survive keeps whatever length it had
		if ((deleteSet.has(rise) || deleteSet.has(fall)) && pressCollapsed(realizedStart, realizedEnd)) {
			rejection = collapseRejection("erasing these frames", key, riseTime);
		}
	};

	for (const button of PHYSICAL_BUTTONS) {
		// only runs touching the deleted span can contribute: a run with
		// neither edge nor interior deleted emits nothing and cannot reject,
		// so the scan starts at the run containing spanLo and stops once past
		// spanHi with no run open. a deleted fall is an *off* frame ending
		// the run before it, so the walk first backs up onto that run
		let scanStart = spanLo;
		if (scanStart > 0 && !button.is(frames[scanStart].buttons) && button.is(frames[scanStart - 1].buttons)) {
			scanStart -= 1;
		}
		while (scanStart > 0 && button.is(frames[scanStart].buttons) && button.is(frames[scanStart - 1].buttons)) {
			scanStart -= 1;
		}
		let runStart = -1;
		for (let i = scanStart; i <= frames.length; i++) {
			// checked before a run can open: a run starting past the span has
			// no deleted frame and must not be walked to its (possibly
			// replay-length) fall just to emit nothing
			if (runStart < 0 && i > spanHi) break;
			const held = i < frames.length && button.is(frames[i].buttons);
			if (held && runStart < 0) runStart = i;
			if (!held && runStart >= 0) {
				handleRun(button, runStart, i);
				runStart = -1;
			}
		}
	}
	if (rejection !== null) return { rejected: rejection };

	const ops: EditOp[] = [];
	const sets = [...rewrites.entries()]
		.filter(([index, buttons]) => buttons !== frames[index].buttons)
		.sort((a, b) => a[0] - b[0])
		.map(([index, buttons]) => ({ index, buttons }));
	if (sets.length > 0) ops.push({ kind: "setButtons", sets });

	ops.push({ kind: "deleteFrames", indices });

	const inserted = [...boundarySources]
		.sort((a, b) => a - b)
		.map((sourceIndex) => {
			const source = frames[sourceIndex];
			return boundaryFrame(survivors, source.time, source.buttons, lattice, { x: source.x, y: source.y });
		});
	if (inserted.length > 0) ops.push({ kind: "insertFrames", frames: inserted });

	return { ops, deleteCount: indices.length };
}
