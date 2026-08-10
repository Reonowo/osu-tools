// applying an EditDelta's frame changes to the mirrored frame array and
// remapping indices through the same splice. the wire contract fixes the
// spaces: removed holds pre-op indices, inserted and updated post-op
// indices, all ascending -- so removals apply descending, then insertions,
// then updates, a fully-defined pre-to-post transform

import type { EditOp, FrameChanges, FrameDto } from "../lib/scene-types";

export function isFullFrames(changes: FrameChanges): changes is { fullFrames: FrameDto[] } {
	return "fullFrames" in changes;
}

export function applyFrameChanges(frames: readonly FrameDto[], changes: FrameChanges): FrameDto[] {
	if (isFullFrames(changes)) return changes.fullFrames.slice();
	const next = frames.slice();
	for (let i = changes.removed.length - 1; i >= 0; i--) next.splice(changes.removed[i], 1);
	for (const { index, frame } of changes.inserted) next.splice(index, 0, frame);
	for (const { index, frame } of changes.updated) next[index] = frame;
	return next;
}

/** carries a pre-op index into the post-op array: null when the frame was
 * removed (or the delta was a full replacement, which admits no mapping);
 * otherwise shifted down past removals below it and up past insertions
 * landing at or below its running position */
export function remapIndex(index: number, changes: FrameChanges): number | null {
	if (isFullFrames(changes)) return null;
	let next = index;
	for (const removed of changes.removed) {
		if (removed === index) return null;
		if (removed < index) next -= 1;
		else break;
	}
	for (const { index: inserted } of changes.inserted) {
		if (inserted <= next) next += 1;
		else break;
	}
	return next;
}

export function remapSelection(selection: readonly number[], changes: FrameChanges): number[] {
	const out: number[] = [];
	for (const index of selection) {
		const next = remapIndex(index, changes);
		if (next !== null) out.push(next);
	}
	return out;
}

/** remaps a queued computed payload through a landed delta: move and delete
 * targets shift with the splice, members whose target was deleted drop,
 * inserts and metadata pass through. null when nothing actionable remains */
export function remapQueuedOps(ops: EditOp[], changes: FrameChanges): EditOp[] | null {
	const out: EditOp[] = [];
	for (const op of ops) {
		switch (op.kind) {
			case "moveFrames": {
				const moves = op.moves.flatMap((m) => {
					const index = remapIndex(m.index, changes);
					return index === null ? [] : [{ ...m, index }];
				});
				if (moves.length > 0) out.push({ kind: "moveFrames", moves });
				break;
			}
			case "setButtons": {
				const sets = op.sets.flatMap((s) => {
					const index = remapIndex(s.index, changes);
					return index === null ? [] : [{ ...s, index }];
				});
				if (sets.length > 0) out.push({ kind: "setButtons", sets });
				break;
			}
			case "deleteFrames": {
				const indices = op.indices.flatMap((i) => {
					const index = remapIndex(i, changes);
					return index === null ? [] : [index];
				});
				if (indices.length > 0) out.push({ kind: "deleteFrames", indices });
				break;
			}
			default:
				out.push(op);
		}
	}
	const actionable = out.some((op) => op.kind !== "setPlayerName" && op.kind !== "setTimestamp");
	const metadataOnly = ops.every((op) => op.kind === "setPlayerName" || op.kind === "setTimestamp");
	if (out.length === 0 || (!actionable && !metadataOnly)) return null;
	return out;
}
