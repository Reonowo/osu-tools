// the score curve's whole reading surface, pure and canvas-free: what the
// play's scorev1 total was at a moment. the watch HUD's score line and the
// replay panel's simulated total are thin shells over this, so neither can
// disagree with the other about the same play
//
// the curve is the ENGINE's (scene-types' ScoreCurve): the same fold the
// exported header's total score is written from, stepped at every moment the
// number on screen changed

import type { ScoreCurve } from "./scene-types";
import { countPairedAtOrBefore } from "./timeline";

/** the score before the curve's first step, and what an absent curve reads
 * everywhere: a play starts at nothing */
const NOTHING = 0;

/** the score the play held at `time`: the last step at or before it, 0 before
 * the first.
 *
 * a step, never a ramp — the number jumps at a judgement and holds until the
 * next one, which is what the player saw. no interpolation between two steps,
 * unlike `hpAt`, whose curve is piecewise linear by construction */
export function scoreAt(curve: ScoreCurve, time: number): number {
	// the LAST step at or before `time`, which is what makes a
	// same-millisecond pair read as the post-judgement total
	const index = countPairedAtOrBefore(curve, time) - 1;
	return index < 0 ? NOTHING : curve[index][1];
}

/** the play's final score: the curve's last step, 0 for an empty curve.
 *
 * this IS the engine's `total_score` for the current document — the engine
 * pins the equality on every fixture and corpus play — which is why the
 * replay panel leads with it rather than with a second fold of its own */
export function finalScore(curve: ScoreCurve): number {
	return curve.length === 0 ? NOTHING : curve[curve.length - 1][1];
}
