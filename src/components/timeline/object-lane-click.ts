// what a click on the timeline's shared lane box means for the press
// selection. timeline chrome behaviour, not an editor operation, so it lives
// beside the components rather than in editor/ -- but pure, over facts the
// dom half has already resolved (which row the click landed in, which object
// mark if any, that object's tether, and the press run the tether resolves
// to), so the decision is testable without a dom.
//
// the ordering here is the whole point. cancelling `pointerdown` does not
// suppress the `click` that follows it, so the hold lanes' own press
// selection is made by a pointerdown and then immediately followed by a click
// on this same box: a clear that did not first check it landed inside the
// object lane would destroy the selection its own gesture just made

import type { PressSelection } from "@/editor/press-runs";
import type { PhysicalKey } from "@/engine/buttons";

export type ObjectLaneClick =
	| { kind: "select"; selection: PressSelection }
	/** let go of the press selection: a genuine gap in the object lane */
	| { kind: "clear" }
	| { kind: "nothing" };

export interface ObjectLaneClickFacts {
	/** the click's ancestor walk found the object lane's own container */
	insideObjectLane: boolean;
	/** the object mark the click landed on, if any */
	objectIndex: number | null;
	/** that object's judging press, if it has one */
	tether: { key: PhysicalKey } | null;
	/** the run start index the tether resolves to against the current frames,
	 * or null when it no longer resolves to one */
	pressRunStartIndex: number | null;
}

export function objectLaneClick(facts: ObjectLaneClickFacts): ObjectLaneClick {
	// the ruler, the hold lanes and the velocity row: this handler has never
	// done anything there and still does not
	if (!facts.insideObjectLane) return { kind: "nothing" };
	// a genuine gap -- the one thing that clears, matching the hold lane
	// directly below it. shift is deliberately not consulted: the press
	// selection has no shift-refine semantics anywhere
	if (facts.objectIndex === null) return { kind: "clear" };
	// the click hit a real object. a tetherless one (a miss, a spinner, any
	// object on a NotSimulated scene) does nothing rather than selecting
	// something arbitrary -- and nothing rather than clearing, because only a
	// gap clears
	if (facts.tether === null) return { kind: "nothing" };
	if (facts.pressRunStartIndex === null) return { kind: "nothing" };
	return { kind: "select", selection: { key: facts.tether.key, startIndex: facts.pressRunStartIndex } };
}
