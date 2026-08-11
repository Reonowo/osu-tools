// the gesture preview: imperative per-frame state outside the store, the
// codebase's established pattern for state read by animation loops (clock,
// frame cursor, space-pan). the live gesture writes here per pointer-move and
// the renderer's rAF loop reads it back; the store never sees a preview. what
// is held is ops -- the exact arrays a commit sends -- which is what makes
// preview-equals-commit structural rather than asserted: the displayed
// positions and the dispatched payload are the same object.
//
// lifecycle: a live gesture's ops are rewritten per pointer-move; on release
// they freeze into a pending entry tied to the commit crossing the edit
// queue. a pending entry survives until its delta lands *and* the renderer
// has been re-fed the post-delta frames (settleRendered), so there is no
// frame on which the edit is visible in neither form. landing deltas remap
// the other pending entries' indices with the same splice function the store
// applies to queued ops, keeping entry space aligned with the authoritative
// array underneath it

import type { EditOp, FrameChanges, FrameDto } from "../lib/scene-types";
import type { PlayfieldPoint } from "./selection-geometry";
import { isFullFrames, remapQueuedOps } from "./splice";

// re-exported so gesture-facing consumers keep one import site for the
// chrome vocabulary; the type's home is the geometry module
export type { PlayfieldPoint } from "./selection-geometry";

export type ChromeShape =
	| { kind: "marquee"; a: PlayfieldPoint; b: PlayfieldPoint }
	| { kind: "lasso"; points: PlayfieldPoint[] };

export interface BrushRing {
	x: number;
	y: number;
	radius: number;
}

/** the merged view of every pending preview, in authoritative frame space.
 * epoch changes whenever the merge would -- consumers dirty-check it instead
 * of diffing maps */
export interface PreviewSnapshot {
	epoch: number;
	/** authoritative index -> displayed position */
	moved: ReadonlyMap<number, PlayfieldPoint>;
	/** authoritative indices pending deletion */
	hidden: ReadonlySet<number>;
	/** authoritative index -> displayed raw buttons (an erase relocating a
	 * press edge onto a survivor rewrites its pattern) */
	buttons: ReadonlyMap<number, number>;
	/** pending boundary frames, time-ascending; not yet authoritative, so
	 * they carry no index */
	inserted: readonly FrameDto[];
}

export interface DisplayedFrames {
	frames: readonly FrameDto[];
	/** per displayed frame, the authoritative index it mirrors -- null for a
	 * pending boundary insert, which has none yet. a null map means identity:
	 * nothing is pending, displayed space *is* authoritative space, and no
	 * per-frame array was built to say so */
	source: readonly (number | null)[] | null;
}

export type SettleOutcome = "landed" | "skipped" | "cancelled" | "failed";

interface Entry {
	id: number;
	ops: EditOp[];
	landed: boolean;
}

const EMPTY_SNAPSHOT: Omit<PreviewSnapshot, "epoch"> = {
	moved: new Map(),
	hidden: new Set(),
	buttons: new Map(),
	inserted: []
};

export class GesturePreview {
	private entries: Entry[] = [];
	private liveOps: EditOp[] | null = null;
	private nextId = 1;
	private epoch = 0;
	private cachedSnapshot: PreviewSnapshot | null = null;
	/** the last materialized displayed view, keyed by epoch and the identity
	 * of the authoritative array it was built over: a burst of pointer-downs
	 * against the same pending state pays the O(frames) merge once */
	private cachedDisplayed: { epoch: number; frames: readonly FrameDto[]; view: DisplayedFrames } | null = null;
	private currentShape: ChromeShape | null = null;
	private currentBrush: BrushRing | null = null;
	private structuralListeners = new Set<() => void>();

	/** rewrite the live gesture's ops (per pointer-move); null discards */
	setLive(ops: EditOp[] | null): void {
		this.liveOps = ops;
		this.bump();
	}

	/** freeze the live ops into a pending entry tied to the commit about to be
	 * queued; returns the entry id the commit's lifecycle callbacks reference */
	freezeLive(): number {
		const id = this.nextId++;
		this.entries.push({ id, ops: this.liveOps ?? [], landed: false });
		this.liveOps = null;
		this.bump();
		return id;
	}

	/** dispatch-time regeneration for intents: the expansion that is about to
	 * cross IPC rewrites its entry in the same frame, so what is displayed when
	 * the payload is sent is byte-equal to what is sent. null discards (an
	 * expansion that reduced to identity or was rejected) */
	update(id: number, ops: EditOp[] | null): void {
		const at = this.entries.findIndex((e) => e.id === id);
		if (at < 0) return;
		if (ops === null) this.entries.splice(at, 1);
		else this.entries[at] = { ...this.entries[at], ops };
		this.bump();
	}

	/** the commit's terminal state. "landed" only marks: the entry must stay
	 * visible until the renderer is re-fed the post-delta frames, or the frames
	 * between the store install and the react effect would show the pre-edit
	 * state -- exactly the flicker the preview exists to prevent. every other
	 * outcome removes immediately, which is the snap-back a rejection wants */
	settle(id: number, outcome: SettleOutcome): void {
		const at = this.entries.findIndex((e) => e.id === id);
		if (at < 0) return;
		if (outcome === "landed") this.entries[at] = { ...this.entries[at], landed: true };
		else this.entries.splice(at, 1);
		this.bump();
	}

	/** the renderer has been re-fed post-delta frames: landed entries are now
	 * authoritative pixels and drop atomically with that swap */
	settleRendered(): void {
		if (!this.entries.some((e) => e.landed)) return;
		this.entries = this.entries.filter((e) => !e.landed);
		this.bump();
	}

	/** a delta landed: remap the still-pending entries through its splice with
	 * the same transform the store applies to queued ops, so entry space stays
	 * the authoritative array's. a fullFrames splice admits no mapping -- every
	 * pending preview describes a state that no longer exists. structural
	 * splices notify listeners (the gesture shell cancels a live gesture whose
	 * frozen index space the splice just invalidated) */
	applySplice(changes: FrameChanges): void {
		if (isFullFrames(changes)) {
			this.entries = this.entries.filter((e) => e.landed);
			this.liveOps = null;
			this.bump();
			for (const listener of this.structuralListeners) listener();
			return;
		}
		this.entries = this.entries.map((entry) => {
			if (entry.landed) return entry;
			const ops = remapQueuedOps(entry.ops, changes);
			return { ...entry, ops: ops ?? [] };
		});
		this.bump();
		if (changes.removed.length > 0 || changes.inserted.length > 0) {
			for (const listener of this.structuralListeners) listener();
		}
	}

	/** scene install / teardown: nothing pending can outlive its session */
	discardAll(): void {
		this.entries = [];
		this.liveOps = null;
		this.currentShape = null;
		this.currentBrush = null;
		this.bump();
	}

	/** called when a structural splice (delete/insert or fullFrames) lands --
	 * a live gesture's frozen displayed-index mapping is stale past it */
	onStructuralSplice(listener: () => void): () => void {
		this.structuralListeners.add(listener);
		return () => this.structuralListeners.delete(listener);
	}

	setShape(shape: ChromeShape | null): void {
		this.currentShape = shape;
	}

	get shape(): ChromeShape | null {
		return this.currentShape;
	}

	setBrush(brush: BrushRing | null): void {
		this.currentBrush = brush;
	}

	get brush(): BrushRing | null {
		return this.currentBrush;
	}

	get hasPending(): boolean {
		return this.entries.length > 0 || this.liveOps !== null;
	}

	/** every pending entry's ops plus the live gesture's, merged oldest-first
	 * into one authoritative-space view */
	snapshot(): PreviewSnapshot {
		if (this.cachedSnapshot?.epoch === this.epoch) return this.cachedSnapshot;
		const opLists = this.entries.map((e) => e.ops);
		if (this.liveOps !== null) opLists.push(this.liveOps);
		if (opLists.length === 0) {
			this.cachedSnapshot = { epoch: this.epoch, ...EMPTY_SNAPSHOT };
			return this.cachedSnapshot;
		}
		const moved = new Map<number, PlayfieldPoint>();
		const hidden = new Set<number>();
		const buttons = new Map<number, number>();
		const inserted: FrameDto[] = [];
		for (const ops of opLists) {
			for (const op of ops) {
				switch (op.kind) {
					case "moveFrames":
						for (const move of op.moves) moved.set(move.index, { x: move.x, y: move.y });
						break;
					case "deleteFrames":
						for (const index of op.indices) hidden.add(index);
						break;
					case "setButtons":
						for (const set of op.sets) buttons.set(set.index, set.buttons);
						break;
					case "insertFrames":
						inserted.push(...op.frames);
						break;
					default:
						break;
				}
			}
		}
		inserted.sort((a, b) => a.time - b.time);
		this.cachedSnapshot = { epoch: this.epoch, moved, hidden, buttons, inserted };
		return this.cachedSnapshot;
	}

	/** the displayed frame stream: the authoritative frames with every pending
	 * preview applied -- the gesture base a new gesture computes against, and
	 * the stream the candidate window is taken over */
	displayed(frames: readonly FrameDto[]): DisplayedFrames {
		const snapshot = this.snapshot();
		if (snapshotIsEmpty(snapshot)) {
			// the common case pays nothing: a pointer-down with no pending
			// previews must not clone a multi-million-frame stream to learn
			// that nothing changed
			return { frames, source: null };
		}
		const cached = this.cachedDisplayed;
		if (cached !== null && cached.epoch === snapshot.epoch && cached.frames === frames) {
			return cached.view;
		}
		const out: FrameDto[] = [];
		const source: (number | null)[] = [];
		for (let i = 0; i < frames.length; i++) {
			if (snapshot.hidden.has(i)) continue;
			const moved = snapshot.moved.get(i);
			const buttons = snapshot.buttons.get(i);
			if (moved === undefined && buttons === undefined) {
				out.push(frames[i]);
			} else {
				const frame = { ...frames[i] };
				if (moved !== undefined) {
					frame.x = moved.x;
					frame.y = moved.y;
				}
				if (buttons !== undefined) frame.buttons = buttons;
				out.push(frame);
			}
			source.push(i);
		}
		// merge pending boundary frames by time; among equal times they follow
		// the surviving frame, matching the engine's stable insert-after-ties
		for (const frame of snapshot.inserted) {
			let at = out.length;
			while (at > 0 && out[at - 1].time > frame.time) at -= 1;
			out.splice(at, 0, frame);
			source.splice(at, 0, null);
		}
		const view: DisplayedFrames = { frames: out, source };
		this.cachedDisplayed = { epoch: snapshot.epoch, frames, view };
		return view;
	}

	private bump(): void {
		this.epoch += 1;
		this.cachedSnapshot = null;
		// the displayed memo is keyed by epoch, so it can never be served
		// again past this point -- dropping it now releases the O(frames)
		// arrays (and the replay they were built over) instead of pinning
		// them until the next non-empty materialization
		this.cachedDisplayed = null;
	}
}

/** true when the snapshot changes anything at all -- the renderer's fast
 * path back to the plain no-preview drawing */
export function snapshotIsEmpty(snapshot: PreviewSnapshot): boolean {
	return (
		snapshot.moved.size === 0 &&
		snapshot.hidden.size === 0 &&
		snapshot.buttons.size === 0 &&
		snapshot.inserted.length === 0
	);
}

/** the cursor-path polyline for the window frames[lo..hi) with a preview
 * applied: hidden frames drop, moved frames draw at their previewed
 * positions, and pending boundary frames inside (windowStart, windowEnd]
 * merge in time order (after ties, the engine's insert rule). pure so the
 * analysis overlay's preview path is testable off the pixi tree */
export function previewedPathPoints(
	frames: readonly FrameDto[],
	lo: number,
	hi: number,
	snapshot: PreviewSnapshot,
	windowStart: number,
	windowEnd: number
): PlayfieldPoint[] {
	const inWindow = snapshot.inserted.filter((f) => f.time > windowStart && f.time <= windowEnd);
	const points: PlayfieldPoint[] = [];
	let insertAt = 0;
	const flushInsertedThrough = (time: number) => {
		while (insertAt < inWindow.length && inWindow[insertAt].time <= time) {
			points.push({ x: inWindow[insertAt].x, y: inWindow[insertAt].y });
			insertAt += 1;
		}
	};
	for (let i = lo; i < hi; i++) {
		if (snapshot.hidden.has(i)) continue;
		const frame = frames[i];
		// a boundary frame ties after the surviving frame at its ms, so the
		// survivor flushes first: strictly-earlier inserts only
		while (insertAt < inWindow.length && inWindow[insertAt].time < frame.time) {
			points.push({ x: inWindow[insertAt].x, y: inWindow[insertAt].y });
			insertAt += 1;
		}
		const override = snapshot.moved.get(i);
		points.push(override === undefined ? { x: frame.x, y: frame.y } : { x: override.x, y: override.y });
		flushInsertedThrough(frame.time);
	}
	flushInsertedThrough(Number.POSITIVE_INFINITY);
	return points;
}

/** displayed-space selection indices -> authoritative indices through a
 * DisplayedFrames source map; pending inserts (null entries) drop out. a
 * null map is the identity: the spaces coincide */
export function selectionToAuthoritative(
	displayed: readonly number[],
	source: readonly (number | null)[] | null
): number[] {
	if (source === null) return [...displayed];
	const out: number[] = [];
	for (const index of displayed) {
		const auth = source[index];
		if (auth !== null && auth !== undefined) out.push(auth);
	}
	return out;
}

/** displayed-space ops -> authoritative-space ops through the same source
 * map: move/delete/setButtons indices translate, inserts carry no index and
 * pass through, members whose target is a pending insert drop. a null map
 * is the identity */
export function opsToAuthoritative(ops: EditOp[], source: readonly (number | null)[] | null): EditOp[] {
	if (source === null) return ops;
	return ops.flatMap((op): EditOp[] => {
		switch (op.kind) {
			case "moveFrames": {
				const moves = op.moves.flatMap((m) => {
					const index = source[m.index];
					return index === null || index === undefined ? [] : [{ ...m, index }];
				});
				return moves.length > 0 ? [{ kind: "moveFrames", moves }] : [];
			}
			case "deleteFrames": {
				const indices = op.indices.flatMap((i) => {
					const index = source[i];
					return index === null || index === undefined ? [] : [index];
				});
				return indices.length > 0 ? [{ kind: "deleteFrames", indices }] : [];
			}
			case "setButtons": {
				const sets = op.sets.flatMap((s) => {
					const index = source[s.index];
					return index === null || index === undefined ? [] : [{ ...s, index }];
				});
				return sets.length > 0 ? [{ kind: "setButtons", sets }] : [];
			}
			default:
				return [op];
		}
	});
}

/** app-wide, alongside playbackClock, frameCursor, and spacePan */
export const gesturePreview = new GesturePreview();
