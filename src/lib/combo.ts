// the combo counter's pop, pure: the list of moments the combo changed, and
// what the counter looks like at any time on that list.
//
// the whole animation is a function of TIMELINE time — the clock's time minus
// the last combo change on the judgement timeline — and of nothing else
// (`docs/adr/0009`). no per-frame state, no "did the value change since the
// last frame" check: a seek lands on the frame playback would have shown, a
// pause holds the counter mid-pop, and an edit that changes the value under
// the playhead rebuilds the list and reads it with no transition of its own.
// a "changed since last frame" check in the HUD loop is the signature of a
// violation of that rule

import { outQuint } from "@/engine/easing";
import type { JudgementEventDto } from "./scene-types";
import { countTimedAtOrBefore } from "./timeline";

/** one moment the combo changed, and what it changed from */
export interface ComboChange {
	time: number;
	combo: number;
	/** the combo standing before this event — what says whether a drop to 0
	 * was a break worth flashing or a lone hit lost */
	previous: number;
}

/** the increment pop's duration and how far it scales the digits */
export const POP_DURATION_MS = 500;
export const POP_SCALE = 0.1;

/** the break's duration, how far it shrinks the digits, and the combo a break
 * has to fall FROM to be worth flashing: losing a run of one is not a run
 * lost, and flashing on it would fire through a section of nothing but misses */
export const BREAK_DURATION_MS = 1000;
export const BREAK_SCALE = 0.2;
export const BREAK_MIN_COMBO = 2;

/** what the counter draws at a moment: the digits' scale about their
 * bottom-left anchor, and how far they are mixed toward the miss red */
export interface ComboPop {
	scale: number;
	/** 0 at rest, 1 at the instant of a break */
	flash: number;
}

/** the counter's own resting look. exported because the HUD writes it too --
 * while the pop is off it must write rest values rather than call the function
 * at all, and a second literal there is a second place for the two to drift */
export const COMBO_AT_REST: ComboPop = { scale: 1, flash: 0 };

/** the moments the combo changed, in time order.
 *
 * built off `comboAfter` alone rather than off the event kinds, which is what
 * makes it right without a per-kind table: a dropped tail and a non-miss
 * slider aggregate HOLD the combo, and a spinner's spin and bonus events do
 * not touch it, so none of them lands here. ticks, repeats and tails that hit
 * do increment it, and they pop exactly as a circle does. the run starts from
 * 0, so the play's first hit is an increment from nothing */
export function comboChanges(events: readonly JudgementEventDto[]): ComboChange[] {
	const changes: ComboChange[] = [];
	let previous = 0;
	for (const event of events) {
		if (event.comboAfter === previous) continue;
		changes.push({ time: event.time, combo: event.comboAfter, previous });
		previous = event.comboAfter;
	}
	return changes;
}

/** the eased tail of a pop: 1 at the instant of the change, 0 once the
 * duration has passed, and clamped either side so a phase outside the window
 * cannot push the quintic past its endpoints */
function remaining(phase: number, duration: number): number {
	if (!(phase > 0)) return 1;
	if (phase >= duration) return 0;
	return 1 - outQuint(phase / duration);
}

/** what the combo counter draws at `time`.
 *
 * an increment scales up and eases back; a break from a run worth the name
 * shrinks and flashes red, over twice as long. everything else — a drop from
 * a combo of one, a hold, a time before the first change — is at rest, and so
 * is any moment past the animation's own duration.
 *
 * the answer depends only on `time` and the list, so calling it for the same
 * millisecond twice, in any order, gives the same frame */
export function comboPopAt(changes: readonly ComboChange[], time: number): ComboPop {
	// the LAST change at or before `time`, which is what makes two sharing a
	// millisecond read as the later one; -1 before the first
	const index = countTimedAtOrBefore(changes, time) - 1;
	if (index < 0) return COMBO_AT_REST;
	const change = changes[index];
	const phase = time - change.time;
	if (change.combo > change.previous) {
		return { scale: 1 + POP_SCALE * remaining(phase, POP_DURATION_MS), flash: 0 };
	}
	if (change.combo === 0 && change.previous >= BREAK_MIN_COMBO) {
		const tail = remaining(phase, BREAK_DURATION_MS);
		return { scale: 1 - BREAK_SCALE * tail, flash: tail };
	}
	return COMBO_AT_REST;
}
