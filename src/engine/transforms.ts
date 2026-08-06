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
