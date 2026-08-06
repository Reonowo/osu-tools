// playfield placement and object culling; pure math, no pixi imports

import { PLAYFIELD_SIZE_ADJUST } from "../engine/argon";

/** osuplayfieldadjustmentcontainer.cs: 4:3 fit, x0.8, centred; scale is
 * screen px per osu!px against the 512-wide base */
export function playfieldTransform(hostW: number, hostH: number) {
	const fitW = Math.min(hostW, hostH * (4 / 3)) * PLAYFIELD_SIZE_ADJUST;
	const scale = fitW / 512;
	return {
		scale,
		offsetX: (hostW - 512 * scale) / 2,
		offsetY: (hostH - 384 * scale) / 2
	};
}

export interface LifetimeEntry {
	appear: number;
	vanish: number;
}

/** the drawable's alive window. vanish keys off the latest judgement event
 * rather than endTime alone: a late-hit circle's explosion is anchored at
 * the resolved event time (circle-tracks.ts), which can trail startTime by
 * up to the hit window, and culling at endTime would truncate its fade */
export function objectLifetime(
	obj: { startTime: number; preempt: number; endTime: number },
	events: { time: number }[],
	fadeOut: number
): LifetimeEntry {
	const lastEventTime = events.reduce((last, e) => Math.max(last, e.time), obj.endTime);
	return { appear: obj.startTime - obj.preempt, vanish: lastEventTime + fadeOut };
}

/** incremental alive-window tracker: o(new + expired) per forward frame,
 * full rebuild on backward seeks. indices refer to the constructor array */
export class ActiveSetTracker {
	private readonly byAppear: number[];
	private readonly entries: LifetimeEntry[];
	private cursor = 0;
	private active = new Set<number>();
	private lastT = Number.NEGATIVE_INFINITY;

	constructor(entries: LifetimeEntry[]) {
		this.entries = entries;
		this.byAppear = entries.map((_, i) => i).sort((a, b) => entries[a].appear - entries[b].appear);
	}

	update(t: number): { added: number[]; removed: number[] } {
		if (t < this.lastT) {
			const removed = [...this.active];
			this.cursor = 0;
			this.active.clear();
			// lastT must move to t before recursing: otherwise the recursive call
			// re-enters this same backward-seek branch against the stale lastT
			// and never reaches the forward scan below, recursing forever
			this.lastT = t;
			const result = this.update(t);
			// entries alive both before and after the rebuild stay "added" once:
			// callers destroy on removed and create on added, so report the full swap
			return { added: result.added, removed: removed.filter((i) => !result.added.includes(i)) };
		}
		this.lastT = t;

		const added: number[] = [];
		const removed: number[] = [];
		while (this.cursor < this.byAppear.length && this.entries[this.byAppear[this.cursor]].appear <= t) {
			const index = this.byAppear[this.cursor++];
			if (this.entries[index].vanish > t) {
				this.active.add(index);
				added.push(index);
			}
		}
		for (const index of this.active) {
			if (this.entries[index].vanish <= t) {
				this.active.delete(index);
				removed.push(index);
			}
		}
		return { added, removed };
	}
}

/** reconciles a per-object drawable map against an active-set delta
 * (ActiveSetTracker.update's return shape): destroys everything in
 * `removed`, and creates everything in `added` that the map doesn't
 * already hold. the "already holds" check is required, not defensive --
 * a backward-seek rebuild reports an object in `added` without a matching
 * `removed` whenever it was alive both before and after the seek (see
 * ActiveSetTracker.update's rebuild branch), so a caller that unconditionally
 * (re)creates every `added` index would overwrite the map entry without
 * destroying the drawable it replaces, leaking its view/GPU resources on
 * every backward seek */
export function reconcileActiveDrawables<T>(
	map: Map<number, T>,
	delta: { added: number[]; removed: number[] },
	create: (index: number) => T | null,
	destroy: (drawable: T) => void
): void {
	for (const index of delta.removed) {
		const drawable = map.get(index);
		if (drawable !== undefined) destroy(drawable);
		map.delete(index);
	}
	for (const index of delta.added) {
		if (map.has(index)) continue;
		const drawable = create(index);
		if (drawable !== null) map.set(index, drawable);
	}
}
