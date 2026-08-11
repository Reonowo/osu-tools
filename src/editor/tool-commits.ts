// history-label helpers for the editing tools: cursor-path labels carry
// counts, computed at dispatch from the ops that actually cross ipc -- a
// queued payload can shrink through a landing delta's remap, and the label
// must name what the edit finally did. press operations get named labels
// through the same helper module

import type { PhysicalKey } from "../engine/buttons";
import type { EditOp } from "../lib/scene-types";

export function countedLabel(op: "move" | "smooth" | "erase", count: number): string {
	return `${op} ${count} frame${count === 1 ? "" : "s"}`;
}

/** a press operation's history label: the operation, the key, and for edge
 * operations which edge it touched */
export function pressLabel(
	op: "delete" | "add" | "drag" | "nudge" | "retime",
	key: PhysicalKey,
	edge?: "start" | "end"
): string {
	return `${op} ${key} press${edge === undefined ? "" : ` ${edge}`}`;
}

export function movedFrameCount(ops: readonly EditOp[]): number {
	let count = 0;
	for (const op of ops) {
		if (op.kind === "moveFrames") count += op.moves.length;
	}
	return count;
}

export function deletedFrameCount(ops: readonly EditOp[]): number {
	let count = 0;
	for (const op of ops) {
		if (op.kind === "deleteFrames") count += op.indices.length;
	}
	return count;
}
