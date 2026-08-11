// the gesture controller: a pure tool state machine consuming pointer
// samples already converted to osu!px and emitting what should happen --
// selection updates, preview ops, pause requests, commits. the viewport
// component stays a thin dom shell doing pointer capture and event
// translation (as it already does for pan and zoom); everything decided here
// is decided on plain data, which is what lets synthetic pointer streams
// drive it headless.
//
// spaces: every index in and out of the controller is a *displayed* frame
// index over env.frames (the gesture base -- authoritative frames with all
// pending previews applied). the shell owns the translation to and from
// authoritative indices. every input point, radius, and slop is osu!px; the
// shell divides the screen-px constants by the viewport scale, which is what
// makes picking feel the same at every zoom

import type { Lattice } from "../lib/lattice";
import type { EditOp, FrameDto } from "../lib/scene-types";
import type { ToolId } from "../state/store";
import { expandErase, type EraseTarget } from "./erase";
import { featherMoveOps } from "./feather";
import type { ChromeShape, PlayfieldPoint } from "./preview";
import {
	framesInPolygon,
	framesInRect,
	framesNearSegment,
	hitTestFrame,
	toggleIndex,
	unionSelection
} from "./selection-geometry";
import { smoothMoveOps } from "./smooth";

/** the select tool's hit threshold, screen px (parent design spec) */
export const HIT_THRESHOLD_SCREEN_PX = 12;
/** pointer travel separating a click from a marquee drag, screen px */
export const CLICK_SLOP_SCREEN_PX = 4;
/** the smooth/erase brush radius is twice the hit threshold */
export const BRUSH_RADIUS_FACTOR = 2;

/** everything a gesture computes against, frozen at pointer-down: the
 * candidate window, the gesture base, the selection, and the tool
 * parameters. freezing is the spec'd rule -- the playhead advancing or a
 * preference changing mid-drag must not change what the gesture means */
export interface GestureEnv {
	tool: ToolId;
	/** displayed frames: the gesture base */
	frames: readonly FrameDto[];
	/** displayed indices inside the trailing candidate window, ascending */
	candidates: readonly number[];
	/** displayed indices currently selected, ascending */
	selection: readonly number[];
	/** osu!px */
	hitRadius: number;
	/** osu!px */
	slop: number;
	/** osu!px */
	brushRadius: number;
	featherMs: number;
	/** 0-100 */
	strength: number;
	snap: boolean;
	lattice: Lattice | null;
}

/** a released gesture's edit. the counted history label is derived from the
 * ops at dispatch (tool-commits.ts), not carried here */
export type GestureCommit =
	| { op: "move" | "smooth"; ops: EditOp[] }
	| { op: "erase"; targets: EraseTarget[]; ops: EditOp[] };

/** what a pointer sample decided. absent fields mean "no change"; an
 * explicit null means "clear" (a shape that should stop rendering, a preview
 * that should discard) */
export interface GestureEffects {
	/** displayed indices, sorted ascending */
	selection?: number[];
	pause?: true;
	previewOps?: EditOp[] | null;
	shape?: ChromeShape | null;
	brush?: PlayfieldPoint | null;
	commit?: GestureCommit;
	reject?: string;
}

interface SelectState {
	tool: "select";
	/** a press is a click until its travel crosses the slop, then a marquee
	 * for the rest of its life -- returning near the origin does not demote it */
	phase: "click" | "marquee";
	origin: PlayfieldPoint;
	shift: boolean;
	env: GestureEnv;
}

interface LassoState {
	tool: "lasso";
	points: PlayfieldPoint[];
	shift: boolean;
	env: GestureEnv;
}

interface MoveState {
	tool: "move";
	origin: PlayfieldPoint;
	/** what the drag moves: the whole selection when it grabbed a selected
	 * frame, the one frame it grabbed otherwise. empty means the press landed
	 * on empty space -- the gesture stays live only to swallow its release */
	targets: readonly number[];
	env: GestureEnv;
}

interface SmoothState {
	tool: "smooth";
	/** every candidate the brush has swept, accumulated across the drag. the
	 * smoothing always recomputes over env.frames -- the pre-gesture
	 * positions -- so sweeping a frame again cannot compound */
	swept: Set<number>;
	/** the previous sample: each sweep covers the segment from here, so a
	 * drag faster than the event rate cannot skip frames under the stroke */
	lastPoint: PlayfieldPoint;
	env: GestureEnv;
}

interface EraseState {
	tool: "erase";
	swept: Set<number>;
	lastPoint: PlayfieldPoint;
	env: GestureEnv;
}

type GestureState = SelectState | LassoState | MoveState | SmoothState | EraseState;

export class GestureController {
	private state: GestureState | null = null;

	get live(): boolean {
		return this.state !== null;
	}

	pointerDown(point: PlayfieldPoint, shift: boolean, env: GestureEnv): GestureEffects {
		if (this.state !== null) return {};
		switch (env.tool) {
			case "select":
				this.state = { tool: "select", phase: "click", origin: point, shift, env };
				return {};
			case "lasso":
				this.state = { tool: "lasso", points: [point], shift, env };
				return {};
			case "move": {
				const hit = hitTestFrame(env.frames, env.candidates, point, env.hitRadius);
				if (hit === null) {
					// empty space does nothing -- but the press is still consumed,
					// or its release would fall through to whatever else listens
					this.state = { tool: "move", origin: point, targets: [], env };
					return {};
				}
				const grabbedSelected = env.selection.includes(hit);
				this.state = {
					tool: "move",
					origin: point,
					targets: grabbedSelected ? env.selection : [hit],
					env
				};
				// a mutating gesture pauses playback: the path must not animate
				// out from under the drag
				return grabbedSelected ? { pause: true } : { pause: true, selection: [hit] };
			}
			case "smooth": {
				const state: SmoothState = { tool: "smooth", swept: new Set(), lastPoint: point, env };
				this.state = state;
				this.sweep(state, point);
				return { pause: true, brush: point, previewOps: this.smoothOps(state) };
			}
			case "erase": {
				const state: EraseState = { tool: "erase", swept: new Set(), lastPoint: point, env };
				this.state = state;
				this.sweep(state, point);
				return { pause: true, brush: point, previewOps: this.erasePreviewOps(state) };
			}
		}
	}

	pointerMove(point: PlayfieldPoint): GestureEffects {
		const state = this.state;
		if (state === null) return {};
		switch (state.tool) {
			case "select": {
				if (state.phase === "click" && distance(state.origin, point) <= state.env.slop) return {};
				state.phase = "marquee";
				return { shape: { kind: "marquee", a: state.origin, b: point } };
			}
			case "lasso": {
				// thin to quarter-slop spacing (about a screen pixel): containment
				// cannot tell denser vertices apart and a slow trace would
				// otherwise collect thousands
				const last = state.points[state.points.length - 1];
				if (distance(last, point) >= state.env.slop / 4) state.points.push(point);
				return { shape: { kind: "lasso", points: state.points } };
			}
			case "move":
				if (state.targets.length === 0) return {};
				return { previewOps: this.moveOps(state, point) };
			case "smooth":
			case "erase": {
				// recomputing over the whole stream on a move that swept nothing
				// new would burn the drag's budget for no visible change -- the
				// preview only depends on the accumulated set
				const grew = this.sweep(state, point);
				if (!grew) return { brush: point };
				return {
					brush: point,
					previewOps: state.tool === "smooth" ? this.smoothOps(state) : this.erasePreviewOps(state)
				};
			}
		}
	}

	pointerUp(point: PlayfieldPoint): GestureEffects {
		const state = this.state;
		if (state === null) return {};
		this.state = null;
		switch (state.tool) {
			case "select":
				if (state.phase === "marquee") return this.marqueeRelease(state, point);
				return this.selectClick(state, point);
			case "lasso":
				return this.lassoRelease(state, point);
			case "move": {
				if (state.targets.length === 0) return {};
				const ops = this.moveOps(state, point);
				// preview-equals-commit is structural: the ops released with are
				// the ops the last preview drew, recomputed from identical inputs
				if (ops === null) return { previewOps: null };
				return { commit: { op: "move", ops } };
			}
			case "smooth": {
				this.sweep(state, point);
				const ops = this.smoothOps(state);
				if (ops === null) return { previewOps: null, brush: null };
				return { brush: null, commit: { op: "smooth", ops } };
			}
			case "erase": {
				this.sweep(state, point);
				const targets = this.eraseTargets(state);
				const expansion = expandErase(state.env.frames, targets, state.env.lattice);
				if ("rejected" in expansion) {
					// the whole batch refuses before any ipc: the preview snaps
					// back and the reason surfaces as a toast
					return { reject: expansion.rejected, previewOps: null, brush: null };
				}
				if (expansion.ops.length === 0) return { previewOps: null, brush: null };
				return { brush: null, commit: { op: "erase", targets, ops: expansion.ops } };
			}
		}
	}

	/** Escape (or a pointer cancellation) mid-gesture: the gesture dies with
	 * nothing committed and the selection untouched */
	cancel(): GestureEffects {
		const state = this.state;
		if (state === null) return {};
		this.state = null;
		switch (state.tool) {
			case "select":
				return state.phase === "click" ? {} : { shape: null };
			case "lasso":
				return { shape: null };
			case "move":
				return { previewOps: null };
			case "smooth":
			case "erase":
				return { previewOps: null, brush: null };
		}
	}

	private selectClick(state: SelectState, point: PlayfieldPoint): GestureEffects {
		const { env } = state;
		const hit = hitTestFrame(env.frames, env.candidates, point, env.hitRadius);
		if (state.shift) {
			// refining a selection: a miss must not throw the work away
			if (hit === null) return {};
			return { selection: toggleIndex(env.selection, hit) };
		}
		return { selection: hit === null ? [] : [hit] };
	}

	private marqueeRelease(state: SelectState, point: PlayfieldPoint): GestureEffects {
		const { env } = state;
		const contained = framesInRect(env.frames, env.candidates, state.origin, point);
		return {
			shape: null,
			selection: state.shift ? unionSelection(env.selection, contained) : contained
		};
	}

	/** accumulates the candidates under the brush's travel since the previous
	 * sample; true when the set grew */
	private sweep(state: SmoothState | EraseState, point: PlayfieldPoint): boolean {
		const { env } = state;
		const before = state.swept.size;
		for (const index of framesNearSegment(env.frames, env.candidates, state.lastPoint, point, env.brushRadius)) {
			state.swept.add(index);
		}
		state.lastPoint = point;
		return state.swept.size > before;
	}

	private smoothOps(state: SmoothState) {
		if (state.swept.size === 0) return null;
		const targets = [...state.swept].sort((a, b) => a - b);
		const { env } = state;
		return smoothMoveOps(env.frames, targets, env.strength, env.lattice, env.snap);
	}

	private eraseTargets(state: EraseState): EraseTarget[] {
		return [...state.swept].sort((a, b) => a - b).map((index) => ({ index, time: state.env.frames[index].time }));
	}

	/** the drag's live view of the sweep. a mid-drag expansion that the
	 * degenerate guard would reject still previews the raw deletions -- the
	 * user needs to see what the brush is holding -- and the refusal fires on
	 * release, where the commit would have been */
	private erasePreviewOps(state: EraseState): EditOp[] | null {
		if (state.swept.size === 0) return null;
		const expansion = expandErase(state.env.frames, this.eraseTargets(state), state.env.lattice);
		if ("rejected" in expansion) {
			return [{ kind: "deleteFrames", indices: [...state.swept].sort((a, b) => a - b) }];
		}
		return expansion.ops.length > 0 ? expansion.ops : null;
	}

	private moveOps(state: MoveState, point: PlayfieldPoint) {
		const { env } = state;
		return featherMoveOps(
			env.frames,
			state.targets,
			point.x - state.origin.x,
			point.y - state.origin.y,
			env.featherMs,
			env.lattice,
			env.snap
		);
	}

	/** release closes the polygon (containment joins last to first itself); a
	 * degenerate trace contains nothing, so a plain lasso tap clears -- the
	 * same empty-shape semantics as the marquee */
	private lassoRelease(state: LassoState, point: PlayfieldPoint): GestureEffects {
		const { env } = state;
		const last = state.points[state.points.length - 1];
		if (distance(last, point) > 0) state.points.push(point);
		const contained = framesInPolygon(env.frames, env.candidates, state.points);
		return {
			shape: null,
			selection: state.shift ? unionSelection(env.selection, contained) : contained
		};
	}
}

function distance(a: PlayfieldPoint, b: PlayfieldPoint): number {
	return Math.hypot(b.x - a.x, b.y - a.y);
}
