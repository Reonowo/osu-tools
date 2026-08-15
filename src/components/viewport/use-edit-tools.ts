// the dom half of the cursor-path tools: pointer capture and event
// translation into the pure gesture controller, and application of what it
// emits back onto the store, the preview module, and the edit queue. all
// decisions live in editor/gesture-controller.ts and the pure editor
// modules -- this file only converts events to osu!px, freezes the gesture
// environment at pointer-down, and routes effects

import { useEffect, type RefObject } from "react";
import { toast } from "sonner";
import { expandErase, remapEraseTargets, type EraseTarget } from "@/editor/erase";
import { frameEditGate } from "@/editor/gate";
import { gestureLive } from "@/editor/gesture-live";
import {
	BRUSH_RADIUS_FACTOR,
	CLICK_SLOP_SCREEN_PX,
	GestureController,
	HIT_THRESHOLD_SCREEN_PX,
	type GestureCommit,
	type GestureEffects,
	type GestureEnv
} from "@/editor/gesture-controller";
import { pressDrag } from "@/editor/press-drag";
import { gesturePreview, opsToAuthoritative, selectionToAuthoritative } from "@/editor/preview";
import { countedLabel, deletedFrameCount, movedFrameCount } from "@/editor/tool-commits";
import { countTimedAtOrBefore } from "@/lib/timeline";
import { viewportPointToPlayfield, viewportTransform } from "@/renderer/playfield";
import { captureArm } from "@/playback/capture-arm";
import { focusModality } from "@/playback/focus-modality";
import { playbackClock } from "@/playback/instance";
import { keybindRow, matchesKeybind } from "@/playback/keybinds";
import { spacePan } from "@/playback/space-pan";
import { controlOwnsKeydown, withinInteractiveControl, withinViewportChrome } from "@/playback/shortcut-guards";
import { effectiveOverlays } from "@/state/defaults";
import { viewerStore, type ToolId } from "@/state/store";

interface LiveGesture {
	pointerId: number;
	/** displayed index -> authoritative index (null entries for pending
	 * inserts); a null map means the spaces coincide */
	source: readonly (number | null)[] | null;
	/** viewport box and framing frozen with the gesture, so a mid-drag zoom
	 * cannot re-aim the pointer math the gesture was grabbed under */
	toPlayfield: (e: PointerEvent) => { x: number; y: number };
	/** the editor epoch the gesture was grabbed under: a commit against a
	 * replaced session must be dropped, not expanded against the new scene */
	epoch: number;
	/** frozen with the env, so the ring matches what the sweep actually uses */
	brushRadius: number;
}

/** the two tools that draw a hover ring: the radius is what tells the user
 * what a press would sweep, so no other tool may leave one on screen */
const isBrushTool = (tool: ToolId) => tool === "smooth" || tool === "erase";

export function useEditTools(containerRef: RefObject<HTMLDivElement | null>) {
	useEffect(() => {
		const container = containerRef.current;
		if (container === null) return;

		const controller = new GestureController();
		let live: LiveGesture | null = null;

		// arrow consts rather than function declarations: a hoisted declaration
		// is checked against the flow state at the top of the block, where
		// `container` is still nullable (same rule as Viewport.tsx)
		/** the published gesture flag rides on every assignment rather than on
		 * the handlers: the abandon paths (pointer cancellation, Escape, a
		 * splice invalidating the gesture base) each drop `live` on their own,
		 * and any of them leaving the flag set would keep the tool keys dead
		 * for the rest of the session */
		const setLive = (gesture: LiveGesture | null) => {
			live = gesture;
			gestureLive.set(gesture !== null);
		};

		const endGesture = (e?: PointerEvent) => {
			if (live !== null && e !== undefined && container.hasPointerCapture(e.pointerId)) {
				container.releasePointerCapture(e.pointerId);
			}
			setLive(null);
		};

		/** every abandon path -- Escape, pointer cancellation, a structural
		 * splice invalidating the gesture base -- clears the same three */
		const clearGestureChrome = () => {
			gesturePreview.setLive(null);
			gesturePreview.setShape(null);
			gesturePreview.setBrush(null);
		};

		const brushRadiusOsu = (scale: number) => (BRUSH_RADIUS_FACTOR * HIT_THRESHOLD_SCREEN_PX) / scale;

		const applyEffects = (fx: GestureEffects) => {
			const state = viewerStore.getState();
			if (fx.pause) state.setPlaying(false);
			if (fx.shape !== undefined) gesturePreview.setShape(fx.shape);
			if (fx.brush !== undefined && live !== null) {
				gesturePreview.setBrush(
					fx.brush === null ? null : { x: fx.brush.x, y: fx.brush.y, radius: live.brushRadius }
				);
			}
			if (fx.previewOps !== undefined && live !== null) {
				gesturePreview.setLive(fx.previewOps === null ? null : opsToAuthoritative(fx.previewOps, live.source));
			}
			if (fx.selection !== undefined && live !== null) {
				state.setFrameSelection(selectionToAuthoritative(fx.selection, live.source));
			}
			if (fx.reject !== undefined) toast.error("erase rejected", { description: fx.reject });
			if (fx.commit !== undefined) commitGesture(fx.commit);
		};

		const commitGesture = (commit: GestureCommit) => {
			const gesture = live;
			const state = viewerStore.getState();
			// the gesture computed against a session that is gone: drop it
			if (gesture === null || state.editor?.epoch !== gesture.epoch) {
				gesturePreview.setLive(null);
				return;
			}
			if (commit.op === "erase") {
				// erase: swept identities into authoritative space, committed as
				// an intent so the hybrid-rule expansion runs against the
				// then-current frames at dispatch
				const source = gesture.source;
				const targets =
					source === null
						? commit.targets.slice()
						: commit.targets
								.map((target) => {
									const index = source[target.index];
									return index === null || index === undefined ? null : { index, time: target.time };
								})
								.filter((target): target is EraseTarget => target !== null);
				gesturePreview.setLive(opsToAuthoritative(commit.ops, gesture.source));
				commitErase(targets);
				return;
			}
			const ops = opsToAuthoritative(commit.ops, gesture.source);
			if (ops.length === 0) {
				gesturePreview.setLive(null);
				return;
			}
			gesturePreview.setLive(ops);
			const id = gesturePreview.freezeLive();
			const opName = commit.op;
			void state.commitEdit({
				label: (dispatched) => countedLabel(opName, movedFrameCount(dispatched)),
				payload: { kind: "ops", ops },
				onSettled: (outcome) => gesturePreview.settle(id, outcome)
			});
		};

		/** the one erase pipeline, shared by the brush and the erase-selection
		 * keybind (Delete/Backspace by default, whatever the user bound since):
		 * the live preview is already showing the expansion; freeze it, queue
		 * the intent, and let the dispatch-time re-expansion regenerate the
		 * entry (or reject with a toast and discard -- the snap-back) */
		const commitErase = (initialTargets: EraseTarget[]) => {
			if (initialTargets.length === 0) {
				gesturePreview.setLive(null);
				return;
			}
			// carried through landed splices by the remap hook, so the
			// dispatch-time expansion names the frames the sweep actually meant
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
						// regenerated from the dispatch payload: what is on screen
						// when this crosses ipc is byte-equal to what is sent
						gesturePreview.update(id, expansion.ops);
						return expansion.ops;
					}
				},
				onSettled: (outcome) => gesturePreview.settle(id, outcome)
			});
		};

		const onPointerDown = (e: PointerEvent) => {
			// middle-drag and space-left belong to the pan; plain left is ours
			if (e.button !== 0 || spacePan.armed || live !== null || controller.live) return;
			// a press on the viewport's overlay controls (tool palette, zoom
			// cluster) is that control's click, not a gesture: capturing here
			// would retarget its pointerup -- and the synthesized click -- to
			// this container, leaving every button in the viewport dead. the
			// chrome guard extends that to the panels' padding and readouts,
			// where a press targets a plain div no control walk would catch
			if (withinInteractiveControl(e.target) || withinViewportChrome(e.target)) return;
			const state = viewerStore.getState();
			if (state.mode !== "edit") return;
			const { scene, editor } = state;
			if (scene === null || editor === null) return;
			// non-editable scenes disable the whole palette; no gesture starts
			if (!frameEditGate(scene).editable) return;

			const rect = container.getBoundingClientRect();
			const { viewportZoom, viewportPan } = state;
			const scale = viewportTransform(rect.width, rect.height, viewportZoom, viewportPan).scale;
			if (scale === 0) return;
			// frozen framing: the same inversion for every sample of this gesture
			const toPlayfield = (event: PointerEvent) =>
				viewportPointToPlayfield(rect.width, rect.height, viewportZoom, viewportPan, {
					x: event.clientX - rect.left,
					y: event.clientY - rect.top
				})!;

			// the gesture base: authoritative frames with every pending preview
			// applied -- what is actually on screen. a null source map is the
			// identity fast path: nothing pending, nothing cloned
			const { frames, source } = gesturePreview.displayed(scene.frames);
			// the candidate window is exactly the analysis overlay's trailing
			// window behind the playhead: what is drawn is what is grabbable.
			// frozen here, with playback free to keep running underneath --
			// binary-searched in place, so a huge replay pays no per-frame
			// arrays for a pointer-down
			const displayLength = effectiveOverlays(state.overlays, state.mode).displayLength;
			const t = playbackClock.currentTime();
			const lo = countTimedAtOrBefore(frames, t - displayLength);
			const hi = countTimedAtOrBefore(frames, t);
			const candidates: number[] = [];
			for (let i = lo; i < hi; i++) {
				// a pending boundary insert has no authoritative identity yet and
				// cannot be selected or edited until its delta lands
				if (source === null || source[i] !== null) candidates.push(i);
			}
			let selection: number[];
			if (source === null) {
				selection = editor.frameSelection;
			} else {
				const authToDisplayed = new Map<number, number>();
				source.forEach((auth, displayed) => {
					if (auth !== null) authToDisplayed.set(auth, displayed);
				});
				selection = editor.frameSelection
					.map((auth) => authToDisplayed.get(auth))
					.filter((index): index is number => index !== undefined);
			}

			const hitRadius = HIT_THRESHOLD_SCREEN_PX / scale;
			const env: GestureEnv = {
				tool: state.tool,
				frames,
				candidates,
				selection,
				hitRadius,
				slop: CLICK_SLOP_SCREEN_PX / scale,
				brushRadius: BRUSH_RADIUS_FACTOR * hitRadius,
				featherMs: state.featherMs,
				strength: state.smoothStrength,
				snap: state.editing.snapToLattice,
				lattice: editor.lattice
			};

			// preventDefault suppresses the text selection a drag would start,
			// but it also suppresses the focus shift a click normally makes --
			// leaving a just-edited panel input focused, where the interactive-
			// control guard would swallow Delete and Escape. move the focus off
			// it explicitly, as an unprevented click would have
			e.preventDefault();
			if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) {
				document.activeElement.blur();
			}
			setLive({ pointerId: e.pointerId, source, toPlayfield, epoch: editor.epoch, brushRadius: env.brushRadius });
			container.setPointerCapture(e.pointerId);
			applyEffects(controller.pointerDown(toPlayfield(e), e.shiftKey, env));
		};

		// the brush ring follows the pointer whenever a brush tool is armed,
		// not only mid-drag: the radius is what tells the user what a press
		// would sweep
		const updateHoverBrush = (e: PointerEvent) => {
			const state = viewerStore.getState();
			if (
				state.mode !== "edit" ||
				!isBrushTool(state.tool) ||
				state.scene === null ||
				spacePan.armed ||
				withinInteractiveControl(e.target) ||
				withinViewportChrome(e.target) ||
				!frameEditGate(state.scene).editable
			) {
				if (gesturePreview.brush !== null) gesturePreview.setBrush(null);
				return;
			}
			const rect = container.getBoundingClientRect();
			const point = viewportPointToPlayfield(rect.width, rect.height, state.viewportZoom, state.viewportPan, {
				x: e.clientX - rect.left,
				y: e.clientY - rect.top
			});
			if (point === null) return;
			const scale = viewportTransform(rect.width, rect.height, state.viewportZoom, state.viewportPan).scale;
			gesturePreview.setBrush({ x: point.x, y: point.y, radius: brushRadiusOsu(scale) });
		};

		const onPointerLeave = () => {
			if (live === null && gesturePreview.brush !== null) gesturePreview.setBrush(null);
		};

		const onPointerMove = (e: PointerEvent) => {
			if (live === null || e.pointerId !== live.pointerId) {
				updateHoverBrush(e);
				return;
			}
			applyEffects(controller.pointerMove(live.toPlayfield(e)));
		};

		const onPointerUp = (e: PointerEvent) => {
			if (live === null || e.pointerId !== live.pointerId) return;
			const fx = controller.pointerUp(live.toPlayfield(e));
			applyEffects(fx);
			endGesture(e);
		};

		const onPointerCancel = (e: PointerEvent) => {
			if (live === null || e.pointerId !== live.pointerId) return;
			applyEffects(controller.cancel());
			clearGestureChrome();
			endGesture(e);
		};

		/** the erase-selection keybind erases the current frame selection with
		 * any tool active -- the same operation, the same label, the same intent
		 * pipeline as the brush */
		const eraseSelection = () => {
			const state = viewerStore.getState();
			const { scene, editor } = state;
			if (scene === null || editor === null || editor.frameSelection.length === 0) return;
			if (!frameEditGate(scene).editable) return;
			if (controller.live) return;
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
			commitErase(targets);
		};

		// escape is two-stage: a live gesture dies (nothing commits), otherwise
		// the selection clears. both live on one key
		const onKeyDown = (e: KeyboardEvent) => {
			// a keystroke meant for an armed binding slot is that slot's. this
			// listener is on the window and the hotkey manager does not mediate
			// it, so the settings dialog's own focus containment is not enough
			if (captureArm.armed) return;
			const state = viewerStore.getState();
			if (state.mode !== "edit" || state.scene === null) return;
			// a live gesture owns escape whatever holds focus -- the pointer is
			// mid-drag, so no control's own escape semantics can be meant
			if (e.key === "Escape" && controller.live) {
				applyEffects(controller.cancel());
				clearGestureChrome();
				setLive(null);
				return;
			}
			// the modality-aware keyboard guard, not the structural pointer one:
			// Delete and the clear-selections Escape must fire after a click on
			// the chrome parks focus on a button, while keyboard-acquired focus
			// and text entry keep their own keys (a number field's Backspace,
			// a dialog's Escape)
			if (controlOwnsKeydown(e, focusModality.keyboardFocus)) return;
			// resolved against the effective table rather than compared as
			// literals: these keys were listed in the table without being driven
			// by it, so a user who rebound them was rebinding nothing
			if (matchesKeybind(e, keybindRow(state.effectiveKeybinds, "eraseSelection"))) {
				// claimed, so nothing else acts on it: Backspace still navigates
				// back in some webviews, and this row can now be rebound onto a
				// chord the webview would otherwise answer itself
				e.preventDefault();
				eraseSelection();
				return;
			}
			if (e.key !== "Escape") return;
			// a live press drag owns escape (DetailLanes cancels it); the
			// clear-selections stage must not fire on the same keypress
			if (pressDrag.live) return;
			// the else stage lets go of everything: the frame selection and
			// the press selection clear together
			if ((state.editor?.frameSelection.length ?? 0) > 0) state.setFrameSelection([]);
			if (state.editor?.pressSelection != null) state.setPressSelection(null);
		};

		// a structural splice landing mid-gesture (an erase's delta, a
		// fullFrames replacement) invalidates the frozen displayed-index space;
		// the gesture is cancelled rather than committed against stale indices
		const unsubscribeSplice = gesturePreview.onStructuralSplice(() => {
			if (!controller.live) return;
			controller.cancel();
			clearGestureChrome();
			setLive(null);
		});

		// the ring is refreshed by pointer movement alone, and arming a tool from
		// the keyboard moves nothing: without this, a ring left by smooth or
		// erase keeps drawing a radius the armed tool no longer sweeps until the
		// pointer happens to move again
		const unsubscribeTool = viewerStore.subscribe((state, previous) => {
			if (state.tool === previous.tool || isBrushTool(state.tool)) return;
			// a live gesture owns the ring, same as for pointerleave: its env
			// froze the tool at pointer-down, so it keeps sweeping as the tool it
			// started as and re-emits the ring every move -- and its own pointerup
			// returns brush: null, so nothing it owns can outlive it
			if (live !== null) return;
			if (gesturePreview.brush !== null) gesturePreview.setBrush(null);
		});

		container.addEventListener("pointerdown", onPointerDown);
		container.addEventListener("pointermove", onPointerMove);
		container.addEventListener("pointerup", onPointerUp);
		container.addEventListener("pointercancel", onPointerCancel);
		container.addEventListener("pointerleave", onPointerLeave);
		window.addEventListener("keydown", onKeyDown);
		return () => {
			container.removeEventListener("pointerdown", onPointerDown);
			container.removeEventListener("pointermove", onPointerMove);
			container.removeEventListener("pointerup", onPointerUp);
			container.removeEventListener("pointercancel", onPointerCancel);
			container.removeEventListener("pointerleave", onPointerLeave);
			window.removeEventListener("keydown", onKeyDown);
			unsubscribeSplice();
			unsubscribeTool();
			// the controller dies with the effect, so a gesture live across a
			// remount would otherwise leave the flag latched on forever
			setLive(null);
		};
	}, [containerRef]);
}
