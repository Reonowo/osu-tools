// the candidate window and the selection's displayed-space view, shared by
// every consumer that freezes a pointer's context over the gesture base --
// the cursor-path gestures (use-edit-tools) and the viewport context menu.
// extracted from the gesture shell rather than duplicated: right-click and
// left-click must agree on what is reachable, and one derivation is how.
// pure over plain data; the callers own the impure reads (the clock, the
// preview module, the store)

import { countTimedAtOrBefore } from "../lib/timeline";
import type { FrameDto } from "../lib/scene-types";

/** the displayed indices inside the trailing candidate window behind the
 * playhead, ascending: exactly the analysis overlay's trailing window, so
 * what is drawn is what is grabbable. `source` is the gesture base's
 * displayed->authoritative map (editor/preview.ts DisplayedFrames); a pending
 * boundary insert has no authoritative identity yet and cannot be selected
 * or edited until its delta lands, so it is filtered out */
export function candidateWindow(
	frames: readonly FrameDto[],
	source: readonly (number | null)[] | null,
	playheadTime: number,
	displayLength: number
): number[] {
	const lo = countTimedAtOrBefore(frames, playheadTime - displayLength);
	const hi = countTimedAtOrBefore(frames, playheadTime);
	const candidates: number[] = [];
	for (let i = lo; i < hi; i++) {
		if (source === null || source[i] !== null) candidates.push(i);
	}
	return candidates;
}

/** the authoritative frame selection in displayed space: each index mapped
 * through the source map, members the display no longer shows dropped. a
 * null map means the spaces coincide (preview.ts's identity fast path) */
export function selectionToDisplayed(
	selection: readonly number[],
	source: readonly (number | null)[] | null
): readonly number[] {
	if (source === null) return selection;
	const authToDisplayed = new Map<number, number>();
	source.forEach((auth, displayed) => {
		if (auth !== null) authToDisplayed.set(auth, displayed);
	});
	return selection.map((auth) => authToDisplayed.get(auth)).filter((index): index is number => index !== undefined);
}
