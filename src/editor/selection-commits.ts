// the frame-selection operations as one dispatch surface: erase, smooth and
// snap over the current frame selection, each through the store's commit
// path as exactly one undo step. extracted from use-edit-tools so the
// keybinds and the context menu dispatch the identical operation -- a menu
// item must be indistinguishable from the key it advertises. erase and
// smooth pause playback, as their keybinds always have (a mutating edit must
// not animate out from under its own preview); snap mirrors the frames
// panel's button, which never paused

import { toast } from "sonner";
import type { LoadedScene } from "../lib/scene-types";
import { expandErase, remapEraseTargets, type EraseTarget } from "./erase";
import { frameEditGate } from "./gate";
import { gestureLive } from "./gesture-live";
import { editTargets, snapOps } from "./ops";
import { gesturePreview } from "./preview";
import { smoothMoveOps } from "./smooth";
import { countedLabel, deletedFrameCount, movedFrameCount } from "./tool-commits";
import { frameCursor } from "../playback/frame-cursor";
import { viewerStore, type EditorState, type ViewerState } from "../state/store";

/** the shared precondition of every operation here: a loaded, editable scene
 * with no live gesture. a null declines quietly -- the disabled surface that
 * dispatched already states the reason */
function editableSelectionContext(): { state: ViewerState; scene: LoadedScene; editor: EditorState } | null {
	const state = viewerStore.getState();
	const { scene, editor } = state;
	if (scene === null || editor === null) return null;
	if (!frameEditGate(scene).editable) return null;
	if (gestureLive.active) return null;
	return { state, scene, editor };
}

/** the one erase pipeline, shared by the brush, the erase-selection keybind
 * and the context menu: the live preview is already showing the expansion;
 * freeze it, queue the intent, and let the dispatch-time re-expansion
 * regenerate the entry (or reject with a toast and discard -- the snap-back) */
export function commitEraseTargets(initialTargets: EraseTarget[]): void {
	if (initialTargets.length === 0) {
		gesturePreview.setLive(null);
		return;
	}
	// carried through landed splices by the remap hook, so the dispatch-time
	// expansion names the frames the sweep actually meant
	let targets = initialTargets;
	const id = gesturePreview.freezeLive();
	void viewerStore.getState().commitEdit({
		label: (dispatched) => countedLabel("erase", deletedFrameCount(dispatched)),
		payload: {
			kind: "intent",
			remap: (changes) => {
				targets = remapEraseTargets(targets, changes);
				return targets.length > 0;
			},
			expand: (frames, editor) => {
				const expansion = expandErase(frames, targets, editor.lattice);
				if ("rejected" in expansion) {
					gesturePreview.update(id, null);
					toast.error("erase rejected", { description: expansion.rejected });
					return null;
				}
				if (expansion.ops.length === 0) {
					gesturePreview.update(id, null);
					return null;
				}
				// regenerated from the dispatch payload: what is on screen when
				// this crosses ipc is byte-equal to what is sent
				gesturePreview.update(id, expansion.ops);
				return expansion.ops;
			}
		},
		onSettled: (outcome) => gesturePreview.settle(id, outcome)
	});
}

/** erases the current frame selection with any tool active -- the same
 * operation, the same label, the same intent pipeline as the brush */
export function eraseSelection(): void {
	const context = editableSelectionContext();
	if (context === null) return;
	const { state, scene, editor } = context;
	if (editor.frameSelection.length === 0) return;
	const targets = editor.frameSelection
		.filter((index) => scene.frames[index] !== undefined)
		.map((index) => ({ index, time: scene.frames[index].time }));
	const expansion = expandErase(scene.frames, targets, editor.lattice);
	if ("rejected" in expansion) {
		toast.error("erase rejected", { description: expansion.rejected });
		return;
	}
	if (expansion.ops.length === 0) return;
	state.setPlaying(false);
	gesturePreview.setLive(expansion.ops);
	commitEraseTargets(targets);
}

/** runs the frames panel's own smooth button -- the selection, or the
 * frame-cursor frame when nothing is selected -- through the same intent
 * pipeline, so a queued op reads the selection as of dispatch. move-only, so
 * unlike erase there is nothing structural to preview: the landed delta
 * draws as soon as it applies */
export function smoothSelection(): void {
	const context = editableSelectionContext();
	if (context === null) return;
	const { state, scene } = context;
	if (scene.frames.length === 0) return;
	// frozen at dispatch request, for the reason the button freezes its own:
	// what the user sees as they fire, not whatever a queued intent reads
	const strength = state.smoothStrength;
	const snap = state.editing.snapToLattice;
	state.setPlaying(false);
	void state.commitEdit({
		label: (dispatched) => countedLabel("smooth", movedFrameCount(dispatched)),
		payload: {
			kind: "intent",
			expand: (frames, editor) =>
				smoothMoveOps(
					frames,
					editTargets(editor.frameSelection, frameCursor.currentIndex()),
					strength,
					editor.lattice,
					snap
				)
		}
	});
}

/** the snap-to-lattice dispatch the frames panel's button and the context
 * menu's item share: each off-lattice frame of the selection (or the current
 * frame) onto its nearest lattice point. an identity expansion -- no
 * lattice, nothing off it -- skips rather than committing an empty step */
export function snapSelectionToLattice(): void {
	const context = editableSelectionContext();
	if (context === null) return;
	const { state } = context;
	void state.commitEdit({
		label: "snap to lattice",
		payload: {
			kind: "intent",
			expand: (frames, editor) =>
				snapOps(frames, editTargets(editor.frameSelection, frameCursor.currentIndex()), editor.lattice)
		}
	});
}
