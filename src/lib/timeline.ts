// pure timeline math (decision 4): fraction<->time mapping for the seek bar
// and the combo/accuracy lookup for the hud. no dom, no react, no clock --
// components evaluate these against values they already read elsewhere

export interface TimeBounds {
	minTime: number;
	maxTime: number;
}

/** extends bounds.maxTime to cover the audio when it outlives the last
 * object -- a replay's frames can end before its audio does, and every
 * timeline tier must map against the same effective range or the playhead
 * runs off the end (or the trailing audio is pegged at 100% and unseekable).
 * audioDurationMs is null before the audio element's metadata has loaded, in
 * which case the frame-derived bounds stand alone */
export function audioExtendedBounds(bounds: TimeBounds, audioDurationMs: number | null): TimeBounds {
	return {
		minTime: bounds.minTime,
		maxTime: audioDurationMs === null ? bounds.maxTime : Math.max(bounds.maxTime, audioDurationMs)
	};
}

export function fractionFor(bounds: TimeBounds, t: number): number {
	const span = bounds.maxTime - bounds.minTime;
	if (span <= 0) return 0;
	return Math.min(1, Math.max(0, (t - bounds.minTime) / span));
}

export function timeFor(bounds: TimeBounds, fraction: number): number {
	const clamped = Math.min(1, Math.max(0, fraction));
	return bounds.minTime + clamped * (bounds.maxTime - bounds.minTime);
}

/** latest combo/accuracy at t from the time-sorted judgement events; null
 * before the first judgement (the hud shows resting values then) */
export function statsAt(
	events: import("./scene-types").JudgementEventDto[],
	t: number
): { combo: number; accuracy: number } | null {
	let lo = 0;
	let hi = events.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (events[mid].time <= t) lo = mid + 1;
		else hi = mid;
	}
	if (lo === 0) return null;
	return { combo: events[lo - 1].comboAfter, accuracy: events[lo - 1].accuracyAfter };
}

/** count of entries at-or-before t; the last at-or-before index is one less
 * (floor that at 0 for "nothing at or before t" -- callers that need "no
 * such entry" as a distinct value guard times.length themselves). times must
 * be sorted ascending, as scene.frames and its derived time arrays already
 * are. moved here from renderer/overlays/analysis.ts, which still uses it
 * for aliveWindow, so every consumer shares one definition */
export function countAtOrBefore(times: readonly number[], t: number): number {
	let lo = 0,
		hi = times.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (times[mid] <= t) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/** countAtOrBefore over the objects that carry the times, so a caller with a
 * frame array in hand does not materialize a parallel time array just to
 * binary-search it */
export function countTimedAtOrBefore(entries: readonly { time: number }[], t: number): number {
	let lo = 0,
		hi = entries.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (entries[mid].time <= t) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}
