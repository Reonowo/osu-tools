// navigating to the judgements the overview strip marks: the whole decision
// surface behind severity jump, as plain data in and plain data out, so it
// runs headlessly the way open-menu.ts and object-lane-click.ts do. the
// transport's buttons and the number keys are both thin shells over the two
// functions below -- neither computes a landing time, an ordering or a
// never-wrap answer of its own.
//
// the strip draws these same judgements and this module navigates to them, so
// the tick is the shared vocabulary between the two: derive.ts builds the
// ticks once per scene and hands them here in the same walk

import type { Grade, RenderObject } from "./scene-types";

/** the below-great grades: exactly what the overview strip marks and what
 * this module navigates. Exclude rather than a fresh literal union, so a
 * fourth wire grade cannot appear here silently.
 *
 * `ok` and `meh` are the wire's names for the grades the app calls 100 and 50
 * everywhere a user reads them (CONTEXT.md pins the pairing) */
export type SeverityGrade = Exclude<Grade, "great">;

/** the three grades in the order every surface lists them: best first, the
 * order the transport's chips read left to right */
export const SEVERITY_GRADES: readonly SeverityGrade[] = ["ok", "meh", "miss"];

/** one below-great judgement as the overview strip carries it. `time` is the
 * event's own time, which is where the strip draws its mark -- and deliberately
 * not where a jump lands (see landingTime) */
export interface SeverityTick {
	time: number;
	grade: SeverityGrade;
	/** the object judged. carried rather than recovered from `time`, which
	 * cannot identify an object reliably: a miss's event sits at its deadline,
	 * hundreds of milliseconds past anything the object itself is at */
	objectIndex: number;
}

/** one navigable judgement: the object it belongs to and the time a jump lands */
export interface SeverityTarget {
	objectIndex: number;
	/** the object's own startTime: where a jump puts the playhead, and the key
	 * the per-grade lists are sorted by */
	landingTime: number;
	grade: SeverityGrade;
}

/** the three per-grade lists, each sorted by landingTime */
export type SeverityTargets = Record<SeverityGrade, SeverityTarget[]>;

/** what a scene with no judgements at all offers: every button's disabled
 * answer, without a null check at each call site */
export const NO_SEVERITY_TARGETS: SeverityTargets = { ok: [], meh: [], miss: [] };

export interface SeverityJump {
	/** null when nothing lies in that direction -- which IS the disabled answer */
	target: SeverityTarget | null;
	/** how many targets lie in that direction -- the tooltip's count */
	remaining: number;
}

/**
 * the per-grade navigable lists for a scene.
 *
 * a jump lands at the OBJECT -- its own startTime -- and never at the tick's
 * own time. the event time is the wrong target in both of the ways it can be
 * wrong: a miss's event lands at the miss deadline, the close of the late meh
 * window and several hundred milliseconds after the circle faded, and a hit's
 * lands at the press, by which point the circle is already struck. both put
 * the playhead past the thing the user asked to see.
 *
 * landing on the object's start is also what the app's one other object-seek
 * affordance does -- the object double-click in the detail lanes seeks to
 * `object.startTime` -- so the two ways of asking to be taken to an object
 * agree.
 *
 * an earlier revision landed a full `preempt` sooner, to show the approach.
 * real use killed it: 0.45s at AR10 and 1.26s at AR5 puts the playhead where
 * nothing has visibly happened yet, and on a dense map several other objects
 * are on screen, so the jump reads as having gone somewhere arbitrary. it also
 * flipped each control's enabled state that far ahead of the mark that
 * prompted it. a lead-in, if one is ever wanted again, belongs here as a
 * constant and nowhere else.
 *
 * this still sits a little to the left of the mark that prompted it -- the
 * strip draws a miss tick at the deadline, which is the miss window past the
 * object -- and that is accepted: the alternative, landing under the mark, is
 * landing after the object is over.
 *
 * the sort key is that landing time and never the event time, and the two
 * genuinely differ in order: a missed circle followed 200ms later by a hit
 * circle emits its events as *hit, then miss*, because the miss waits for its
 * deadline. ordering by event time would make "next" occasionally move the
 * playhead backwards on screen, which reads as a bug however defensible its
 * derivation. one line to reverse, which is why it is a comment here rather
 * than an ADR
 */
export function severityTargets(ticks: readonly SeverityTick[], objects: readonly RenderObject[]): SeverityTargets {
	const targets: SeverityTargets = { ok: [], meh: [], miss: [] };
	for (const tick of ticks) {
		const object = objects[tick.objectIndex];
		// an index with no object is unreachable from a simulation, whose events
		// index the same object list -- dropped rather than landed on, since
		// there is no time to land at
		if (object === undefined) continue;
		targets[tick.grade].push({
			objectIndex: tick.objectIndex,
			landingTime: object.startTime,
			grade: tick.grade
		});
	}
	for (const grade of SEVERITY_GRADES) targets[grade].sort((a, b) => a.landingTime - b.landingTime);
	return targets;
}

/** the index of the first target strictly after `time` */
function firstAfter(list: readonly SeverityTarget[], time: number): number {
	let lo = 0;
	let hi = list.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (list[mid].landingTime <= time) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/** how many targets lie strictly before `time` -- which is also the index just
 * past the last of them */
function countBefore(list: readonly SeverityTarget[], time: number): number {
	let lo = 0;
	let hi = list.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (list[mid].landingTime < time) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/**
 * where a jump goes, whether its control is live, and how many judgements are
 * left in that direction -- one answer, because the three questions the UI
 * asks have one answer between them.
 *
 * the comparison is strict in both directions, so pressing again from exactly
 * a target's own landing time -- which is where every jump leaves the playhead
 * -- always advances rather than sticking.
 *
 * nothing wraps. running out in a direction answers `null` with a remaining
 * count of zero, and that null IS what disables the control: a navigation
 * button that teleports to the start of the replay when it runs out is worse
 * than one that does nothing.
 *
 * `remaining` counts judgements, which is what the tooltip promises. it equals
 * the number of successive jumps that succeed except where two objects share a
 * landing time (a 2B stack), where one press covers both.
 */
export function severityJump(
	targets: SeverityTargets,
	grade: SeverityGrade,
	direction: 1 | -1,
	fromTime: number
): SeverityJump {
	const list = targets[grade];
	if (direction === 1) {
		const index = firstAfter(list, fromTime);
		return { target: list[index] ?? null, remaining: list.length - index };
	}
	const remaining = countBefore(list, fromTime);
	return { target: list[remaining - 1] ?? null, remaining };
}
