// history-label helpers for the cursor-path tools: labels carry counts,
// computed at dispatch from the ops that actually cross ipc -- a queued
// payload can shrink through a landing delta's remap, and the label must
// name what the edit finally did

import type { EditOp } from "../lib/scene-types";

export function countedLabel(op: "move" | "smooth" | "erase", count: number): string {
	return `${op} ${count} frame${count === 1 ? "" : "s"}`;
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
