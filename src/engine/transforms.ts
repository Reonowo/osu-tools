// declarative transform tracks: the evaluate-at-t replacement for the
// framework's stateful transform sequences (spec, stateless time-driven
// rendering). the track with the greatest start <= t owns the value
// (later-in-array wins ties), clamped at its ends -- callers may pass
// tracks in any order, not just start-ascending

import { none, type EasingFn } from "./easing";

export interface Track {
	start: number;
	duration: number;
	from: number;
	to: number;
	easing: EasingFn;
}

export function tween(start: number, duration: number, from: number, to: number, easing: EasingFn = none): Track {
	return { start, duration, from, to, easing };
}

export function jump(start: number, to: number): Track {
	return { start, duration: 0, from: to, to, easing: none };
}

/** the tracks that can own the value anywhere in [from, to]: every one
 * starting inside the window, plus the single track active at `from` (the
 * greatest start before it, later-in-array winning ties, exactly as
 * trackValueAt selects). trackValueAt over the result answers identically to
 * trackValueAt over the whole array for any t in the window, which is what a
 * caller sampling one track set at many times within a narrow window needs:
 * trackValueAt is a full scan, and a replay's press tracks number in the
 * thousands while a window holds a handful */
export function tracksWithin(tracks: Track[], from: number, to: number): Track[] {
	let before: Track | null = null;
	const within: Track[] = [];
	for (const track of tracks) {
		if (track.start > to) continue;
		if (track.start >= from) within.push(track);
		else if (before === null || track.start >= before.start) before = track;
	}
	// `before` starts strictly earlier than anything in `within`, so prepending
	// it cannot create a tie the array order would have to break
	return before === null ? within : [before, ...within];
}

export function trackValueAt(tracks: Track[], t: number, initial: number): number {
	// single allocation-free pass: keep the candidate with the greatest
	// start <= t, letting a later-in-array tie replace the current one. this
	// is called every frame per animated property per drawable, so it must
	// stay O(n) with no sort and no array allocation
	let active: Track | null = null;
	for (const track of tracks) {
		if (track.start <= t && (active === null || track.start >= active.start)) active = track;
	}
	if (active === null) return initial;
	if (active.duration <= 0 || t >= active.start + active.duration) return active.to;
	const progress = (t - active.start) / active.duration;
	return active.from + (active.to - active.from) * active.easing(progress);
}
