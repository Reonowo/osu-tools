// the one commit shape every press operation shares: an intent expanded at
// dispatch through the shared press-operations module, targeting the press
// selection as of dispatch (installDelta keeps the selection remapped and
// outcome-followed through every landing delta, which is what makes queued
// chevron clicks compound instead of repeating), a rejection surfacing as a
// toast before any ipc, and the selection following the computed outcome
// through the landing splice. the keypress panel and the hold lanes both
// build their commits here instead of restating the closure

import { toast } from "sonner";
import type { PhysicalKey } from "../engine/buttons";
import type { FrameDto } from "../lib/scene-types";
import type { EditCommit, EditorState } from "../state/store";
import {
	expandAddPress,
	medianPressDuration,
	outcomeSelection,
	type PressExpansion,
	type PressOutcome
} from "./press-ops";
import { pressRunAt, pressRunFromIndex, type PressRun } from "./press-runs";

function rejectionToast(rejected: string): void {
	toast.error("press edit rejected", { description: rejected });
}

/** a commit operating on the selected press: `expandRun` receives the
 * selection resolved to its run against the then-current frames and returns
 * the operation's expansion (or null for nothing to do). a cleared or
 * stale selection expands to nothing -- a queued press intent can neither
 * resurrect a bit nor invent a target. `label` is a builder taking the
 * expanded run's key: the selection can move to another key while the
 * intent waits in the queue, and the history must name the key actually
 * operated on, not the one clicked */
export function selectedPressCommit(
	label: (key: PhysicalKey) => string,
	expandRun: (frames: readonly FrameDto[], run: PressRun, editor: EditorState) => PressExpansion | null
): EditCommit {
	let outcome: PressOutcome | null = null;
	let resolvedKey: PhysicalKey | null = null;
	return {
		// a function label resolves at dispatch, after the expansion ran
		// (pumpEdits computes the ops first), so resolvedKey is set on every
		// path that reaches it
		label: () => label(resolvedKey as PhysicalKey),
		payload: {
			kind: "intent",
			expand: (frames, editor) => {
				const selection = editor.pressSelection;
				if (selection === null) return null;
				const run = pressRunFromIndex(frames, selection.key, selection.startIndex);
				if (run === null) return null;
				resolvedKey = selection.key;
				const expansion = expandRun(frames, run, editor);
				if (expansion === null) return null;
				if ("rejected" in expansion) {
					rejectionToast(expansion.rejected);
					return null;
				}
				outcome = expansion.outcome;
				return expansion.ops.length > 0 ? expansion.ops : null;
			}
		},
		pressOutcome: (frames) => outcomeSelection(frames, outcome)
	};
}

/** a commit operating on one specific press, named in time-space (key +
 * run-start ms) rather than through the press selection: a released drag
 * must retime the press it previewed even when the selection moves before
 * the queued intent expands. resolution mirrors installDelta's key + time
 * containment rule, so a landed splice cannot shift the target; a press no
 * longer there expands to nothing */
export function pressRunCommit(
	label: string,
	key: PhysicalKey,
	startTime: number,
	expandRun: (frames: readonly FrameDto[], run: PressRun, editor: EditorState) => PressExpansion | null
): EditCommit {
	let outcome: PressOutcome | null = null;
	return {
		label,
		payload: {
			kind: "intent",
			expand: (frames, editor) => {
				const run = pressRunAt(frames, key, startTime);
				if (run === null) return null;
				const expansion = expandRun(frames, run, editor);
				if (expansion === null) return null;
				if ("rejected" in expansion) {
					rejectionToast(expansion.rejected);
					return null;
				}
				outcome = expansion.outcome;
				return expansion.ops.length > 0 ? expansion.ops : null;
			},
			// the drag's frozen edit holds times snapped to frames the
			// preview saw: over an intervening splice the re-expansion could
			// differ from the preview or even synthesize a boundary frame (a
			// removal orphaning a snapped target), so the queued commit
			// cancels instead -- the same rule the live drag already follows
			// on a landing delta
			remap: () => false
		},
		pressOutcome: (frames) => outcomeSelection(frames, outcome)
	};
}

/** the add-press commit: at the captured playhead, for the armed key,
 * duration from the player's own median at dispatch. the new press is the
 * outcome, so it lands auto-selected */
export function addPressCommit(label: string, key: PhysicalKey, playheadTime: number): EditCommit {
	let outcome: PressOutcome | null = null;
	return {
		label,
		payload: {
			kind: "intent",
			expand: (frames, editor) => {
				const expansion = expandAddPress(
					frames,
					key,
					playheadTime,
					medianPressDuration(frames, key),
					editor.lattice,
					"adding this press"
				);
				if ("rejected" in expansion) {
					rejectionToast(expansion.rejected);
					return null;
				}
				outcome = expansion.outcome;
				return expansion.ops.length > 0 ? expansion.ops : null;
			}
		},
		pressOutcome: (frames) => outcomeSelection(frames, outcome)
	};
}
