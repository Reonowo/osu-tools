// the press-drag controller: a pure state machine for drag-to-retime on
// hold spans, consuming pointer samples already converted to lane time and
// emitting what should happen -- selection, pause, previews, the commit.
// the lane component stays a thin dom shell doing pointer capture and the
// pixel-to-time inversion (timeline-view.ts's laneTransform), which is what
// lets synthetic pointer streams drive this headless, the gesture-
// controller pattern. zone grammar: pointer-down near a span edge retimes
// that edge alone, the span body moves the whole press -- each edge landing
// on the frame nearest its original time plus the pointer's time delta, so
// duration is approximately preserved. every landing is frame-snapped: a
// by-feel gesture never synthesizes frames. a landing the expansion refuses
// (a collapse, an M press dragged under its paired K) keeps the last valid
// preview instead -- the drag simply cannot reach it, and what is on screen
// at release is exactly what commits

import type { PhysicalKey } from "../engine/buttons";
import type { Lattice } from "../lib/lattice";
import type { FrameDto } from "../lib/scene-types";
import { expandRetimePress, nearestFrameTime, type PressEdit } from "./press-ops";
import { pressRunAt, runEndingWithin, runStartingWithin, type PressRun, type PressSelection } from "./press-runs";

/** everything a drag computes against, frozen at pointer-down: a mid-drag
 * zoom or delta must not re-aim the gesture */
export interface PressDragEnv {
	key: PhysicalKey;
	frames: readonly FrameDto[];
	/** ms per css pixel at pointer-down */
	msPerPx: number;
	/** px of pointer travel separating a click (plain select) from a drag */
	slopPx: number;
	/** px around a span edge grabbing that edge alone */
	edgeZonePx: number;
	lattice: Lattice | null;
}

export type PressDragZone = "start" | "end" | "body";

export interface PressDragPreview {
	key: PhysicalKey;
	/** authoritative spans inside these ranges hide while the preview shows:
	 * the dragged run's own span and the realized outcome's, kept separate
	 * when the drag has flown past intervening presses -- those survive the
	 * commit and must stay visible */
	hide: { from: number; to: number }[];
	/** the realized frame-snapped outcome, merges folded in */
	span: { start: number; end: number };
}

/** what a pointer sample decided. absent fields mean "no change"; a null
 * preview means "stop showing it" */
export interface PressDragEffects {
	select?: PressSelection;
	clearSelection?: true;
	pause?: true;
	preview?: PressDragPreview | null;
	/** the released drag's edit, re-expanded at dispatch by the shell's
	 * intent -- identical inputs, so the previewed expansion is the
	 * committed expansion. runStartTime names the dragged run in time-space
	 * so a queued commit stays bound to the press it previewed even when
	 * the selection moves before the intent expands */
	commit?: { key: PhysicalKey; runStartTime: number; edit: PressEdit };
}

interface LiveState {
	env: PressDragEnv;
	/** null: the press landed on empty lane space -- the gesture stays live
	 * only so its release can decide between deselect (click) and nothing */
	run: PressRun | null;
	zone: PressDragZone;
	originTime: number;
	/** a press is a click until its travel crosses the slop, then a drag for
	 * the rest of its life */
	phase: "click" | "drag";
	lastValid: { edit: PressEdit; preview: PressDragPreview } | null;
}

export class PressDragController {
	private state: LiveState | null = null;

	get live(): boolean {
		return this.state !== null;
	}

	pointerDown(time: number, env: PressDragEnv): PressDragEffects {
		if (this.state !== null) return {};
		const edgeMs = env.edgeZonePx * env.msPerPx;
		let run = pressRunAt(env.frames, env.key, time);
		let zone: PressDragZone = "body";
		if (run === null) {
			// a near-miss within the edge zone still grabs the nearer edge --
			// a short span is only a few pixels wide. the zone is searched as
			// an interval: a run shorter than the zone lies entirely between
			// point probes at its ends and a probe would never sample it
			const before = runEndingWithin(env.frames, env.key, time, edgeMs);
			const after = runStartingWithin(env.frames, env.key, time, edgeMs);
			const beforeDist = before === null ? Number.POSITIVE_INFINITY : time - before.endTime;
			const afterDist = after === null ? Number.POSITIVE_INFINITY : after.startTime - time;
			if (beforeDist <= edgeMs && beforeDist <= afterDist) {
				run = before;
				zone = "end";
			} else if (afterDist <= edgeMs) {
				run = after;
				zone = "start";
			}
		} else {
			const startPx = (time - run.startTime) / env.msPerPx;
			const endPx = (run.endTime - time) / env.msPerPx;
			if (startPx <= env.edgeZonePx && startPx <= endPx) zone = "start";
			else if (endPx <= env.edgeZonePx) zone = "end";
		}
		this.state = { env, run, zone, originTime: time, phase: "click", lastValid: null };
		if (run === null) return {};
		// select-and-drag in one gesture; a mutating drag pauses playback at
		// pointer-down so spans stop scrolling under the pointer
		return { select: { key: run.key, startIndex: run.startIndex }, pause: true };
	}

	pointerMove(time: number): PressDragEffects {
		const state = this.state;
		if (state === null) return {};
		if (state.phase === "click") {
			if (Math.abs(time - state.originTime) / state.env.msPerPx <= state.env.slopPx) return {};
			state.phase = "drag";
		}
		const { env, run, zone } = state;
		if (run === null) return {};
		const delta = time - state.originTime;
		const snapped = (t: number) => nearestFrameTime(env.frames, t);
		const edit: PressEdit = {};
		if (zone !== "end") {
			const start = snapped(run.startTime + delta);
			if (start === null) return this.stickyPreview();
			edit.start = start;
		}
		if (zone !== "start") {
			const end = snapped(run.endTime + delta);
			if (end === null) return this.stickyPreview();
			edit.end = end;
		}
		const expansion = expandRetimePress(env.frames, run, edit, env.lattice, "this drag");
		if ("rejected" in expansion || expansion.realized === null) return this.stickyPreview();
		const oldSpan = { from: run.startTime, to: run.endTime };
		const newSpan = { from: expansion.realized.startTime, to: expansion.realized.endTime };
		const preview: PressDragPreview = {
			key: env.key,
			hide:
				newSpan.from <= oldSpan.to && oldSpan.from <= newSpan.to
					? [{ from: Math.min(oldSpan.from, newSpan.from), to: Math.max(oldSpan.to, newSpan.to) }]
					: [oldSpan, newSpan],
			span: { start: expansion.realized.startTime, end: expansion.realized.endTime }
		};
		state.lastValid = { edit, preview };
		return { preview };
	}

	pointerUp(time: number): PressDragEffects {
		const state = this.state;
		if (state === null) return {};
		// the release position is one last sample
		this.pointerMove(time);
		this.state = null;
		if (state.run === null) {
			// a click on empty hold-lane space clears the selection; a drag
			// from empty space grabbed nothing and does nothing
			return state.phase === "click" ? { clearSelection: true } : {};
		}
		if (state.phase === "click") return {};
		if (state.lastValid === null) return { preview: null };
		// preview-equals-commit: the committed edit is the previewed one,
		// re-expanded by the shell's intent from the same frames
		return {
			commit: { key: state.run.key, runStartTime: state.run.startTime, edit: state.lastValid.edit },
			preview: state.lastValid.preview
		};
	}

	/** Escape (or a pointer cancellation, or a structural splice) mid-drag:
	 * the gesture dies with nothing committed and the selection untouched */
	cancel(): PressDragEffects {
		if (this.state === null) return {};
		this.state = null;
		return { preview: null };
	}

	private stickyPreview(): PressDragEffects {
		const state = this.state;
		if (state === null || state.lastValid === null) return {};
		return { preview: state.lastValid.preview };
	}
}

/** app-wide, alongside playbackClock, frameCursor, and gesturePreview: the
 * viewport's escape handling must see a live lane drag without the two
 * components knowing each other */
export const pressDrag = new PressDragController();
