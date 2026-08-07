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

/** the neighbouring frame time strictly after (direction 1) or strictly
 * before (direction -1) t, or undefined at the ends; frames must be
 * time-sorted, as scene.frames already is */
export function adjacentFrameTime(
	frames: readonly { time: number }[],
	t: number,
	direction: 1 | -1
): number | undefined {
	let lo = 0;
	let hi = frames.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		const before = direction === 1 ? frames[mid].time <= t : frames[mid].time < t;
		if (before) lo = mid + 1;
		else hi = mid;
	}
	if (direction === 1) return frames[lo]?.time;
	return lo > 0 ? frames[lo - 1].time : undefined;
}
