// the one place where getting the ordering wrong silently destroys a
// selection the user just made: cancelling `pointerdown` does not suppress
// the `click` that follows, so a hold-lane press selects a run and this
// handler runs on the same gesture a moment later

import { describe, expect, test } from "bun:test";
import { objectLaneClick, type ObjectLaneClickFacts } from "./object-lane-click";

function facts(overrides: Partial<ObjectLaneClickFacts> = {}): ObjectLaneClickFacts {
	return { insideObjectLane: true, objectIndex: null, tether: null, pressRunStartIndex: null, ...overrides };
}

describe("objectLaneClick", () => {
	test("a click resolving to a press run selects it, and clears nothing", () => {
		expect(objectLaneClick(facts({ objectIndex: 7, tether: { key: "K1" }, pressRunStartIndex: 42 }))).toEqual({
			kind: "select",
			selection: { key: "K1", startIndex: 42 }
		});
	});

	test("a click on a genuine gap inside the lane clears the press selection", () => {
		expect(objectLaneClick(facts({ objectIndex: null })).kind).toBe("clear");
	});

	test("a tetherless object does nothing -- it neither selects nor clears", () => {
		// a miss, a spinner, any object on a NotSimulated scene: the click hit a
		// real object, and only a genuine gap clears
		expect(objectLaneClick(facts({ objectIndex: 3, tether: null })).kind).toBe("nothing");
	});

	test("a tether whose press run no longer resolves does nothing", () => {
		expect(objectLaneClick(facts({ objectIndex: 3, tether: { key: "M2" }, pressRunStartIndex: null })).kind).toBe(
			"nothing"
		);
	});

	test("a click outside the object lane does nothing, whatever else resolved", () => {
		// the handler is bound to a box that also covers the ruler, the four hold
		// lanes and the velocity row -- an unscoped clear would fire on the click
		// that follows the hold lane's own selecting pointerdown and wipe it
		expect(objectLaneClick(facts({ insideObjectLane: false })).kind).toBe("nothing");
		expect(
			objectLaneClick(
				facts({
					insideObjectLane: false,
					objectIndex: 7,
					tether: { key: "K1" },
					pressRunStartIndex: 42
				})
			).kind
		).toBe("nothing");
	});
});
