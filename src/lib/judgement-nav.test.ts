import { describe, expect, test } from "bun:test";
import type { RenderKind, RenderObject } from "./scene-types";
import { severityJump, severityTargets, type SeverityGrade, type SeverityTick } from "./judgement-nav";

/** a hit object with its own approach rate. every fixture names its own
 * preempt, and no landing time may move with it: the jump goes to the object,
 * not to where it becomes visible */
function object(startTime: number, preempt: number, kind: RenderKind = { type: "circle" }): RenderObject {
	return {
		startTime,
		endTime: startTime,
		position: [0, 0],
		stackHeight: 0,
		comboColourIndex: 0,
		comboIndex: 0,
		indexInCombo: 0,
		preempt,
		fadeIn: 400,
		samples: [],
		kind
	};
}

const sliderKind = (duration: number): RenderKind => ({
	type: "slider",
	vertices: [0, 0, 10, 0],
	cumulativeLengths: [0, 10],
	distance: 10,
	segmentEnds: [1],
	repeatCount: 0,
	spanCount: 1,
	spanDuration: duration,
	duration,
	endPosition: [10, 0],
	snakeInDuration: 100,
	nested: []
});

const spinnerKind = (duration: number): RenderKind => ({
	type: "spinner",
	duration,
	spinsRequired: 3,
	maxBonusSpins: 1,
	bonusSamples: []
});

/** one mark as the overview strip carries it: the event's own time, which is
 * deliberately NOT where a jump lands */
const tick = (objectIndex: number, time: number, grade: SeverityGrade): SeverityTick => ({
	objectIndex,
	time,
	grade
});

const landings = (targets: readonly { landingTime: number }[]) => targets.map((target) => target.landingTime);

describe("severityTargets", () => {
	test("a target lands on its object, at that object's own start time", () => {
		// neither the tick's time (1300, the miss deadline) nor anything derived
		// from the approach rate: two objects sharing a start time under wildly
		// different preempts land at the same place, which is the object
		const targets = severityTargets(
			[tick(0, 1300, "miss"), tick(1, 1010, "meh")],
			[object(1000, 600), object(1000, 1800)]
		);
		expect(landings(targets.miss)).toEqual([1000]);
		expect(landings(targets.meh)).toEqual([1000]);
	});

	test("a low approach rate does not drag the landing earlier", () => {
		// the regression this replaced: landing a full preempt before the object
		// put the playhead 1.26s early on an AR5 map, where nothing has visibly
		// happened yet
		const targets = severityTargets([tick(0, 5300, "miss")], [object(5000, 1200)]);
		expect(landings(targets.miss)).toEqual([5000]);
	});

	test("each grade's list holds only its own judgements", () => {
		const targets = severityTargets(
			[tick(0, 1000, "ok"), tick(1, 2000, "meh"), tick(2, 3400, "miss"), tick(3, 4000, "ok")],
			[object(1000, 400), object(2000, 400), object(3000, 400), object(4000, 400)]
		);
		expect(landings(targets.ok)).toEqual([1000, 4000]);
		expect(landings(targets.meh)).toEqual([2000]);
		expect(landings(targets.miss)).toEqual([3000]);
	});

	test("sliders and spinners are navigable, not only circles", () => {
		// derive.ts marks a slider by its aggregate and a spinner by its final,
		// so both reach this module as ordinary ticks -- what is pinned here is
		// that the landing reads the start time off any object kind rather than
		// special-casing circles
		const targets = severityTargets(
			[tick(0, 2500, "ok"), tick(1, 4000, "miss")],
			[object(2000, 450, sliderKind(500)), object(3000, 450, spinnerKind(1000))]
		);
		expect(landings(targets.ok)).toEqual([2000]);
		expect(landings(targets.miss)).toEqual([3000]);
	});

	test("lists sort by landing time even where event order disagrees", () => {
		// the case that motivates the whole ordering rule: a missed circle's
		// event waits for its miss deadline, so it is emitted AFTER the hit
		// judgement of a circle that comes later on the map. ordering by event
		// time would put the later object first and make "next" walk backwards
		const targets = severityTargets(
			[tick(0, 1400, "miss"), tick(1, 1210, "miss")],
			[object(1000, 600), object(1200, 600)]
		);
		expect(landings(targets.miss)).toEqual([1000, 1200]);
		expect(targets.miss.map((target) => target.objectIndex)).toEqual([0, 1]);
	});

	test("a grade with no judgements answers an empty list rather than being absent", () => {
		const targets = severityTargets([tick(0, 1000, "miss")], [object(1000, 600)]);
		expect(targets.ok).toEqual([]);
		expect(targets.meh).toEqual([]);
	});
});

/** the three-object fixture the jump tests share: landings at 1000, 2000, 3000 */
const threeMisses = severityTargets(
	[tick(0, 1300, "miss"), tick(1, 2050, "miss"), tick(2, 3010, "miss")],
	[object(1000, 600), object(2000, 600), object(3000, 600)]
);

describe("severityJump", () => {
	test("forward from before everything reaches the first target", () => {
		const jump = severityJump(threeMisses, "miss", 1, -5000);
		expect(jump.target?.landingTime).toBe(1000);
		expect(jump.remaining).toBe(3);
	});

	test("backward from after everything reaches the last target", () => {
		const jump = severityJump(threeMisses, "miss", -1, 99_000);
		expect(jump.target?.landingTime).toBe(3000);
		expect(jump.remaining).toBe(3);
	});

	test("the comparison is strict, so a press from a target's own landing time advances", () => {
		// which is the position every jump leaves the playhead at: a non-strict
		// comparison would make the second press land where the first one did
		expect(severityJump(threeMisses, "miss", 1, 2000).target?.landingTime).toBe(3000);
		expect(severityJump(threeMisses, "miss", -1, 2000).target?.landingTime).toBe(1000);
	});

	test("past the last target forward there is no answer, and no wrap", () => {
		const jump = severityJump(threeMisses, "miss", 1, 3000);
		expect(jump.target).toBeNull();
		expect(jump.remaining).toBe(0);
	});

	test("before the first target backward there is no answer, and no wrap", () => {
		const jump = severityJump(threeMisses, "miss", -1, 1000);
		expect(jump.target).toBeNull();
		expect(jump.remaining).toBe(0);
	});

	test("a grade the replay never produced answers nothing from anywhere", () => {
		for (const from of [-99_000, 0, 2000, 99_000]) {
			for (const direction of [1, -1] as const) {
				const jump = severityJump(threeMisses, "ok", direction, from);
				expect(jump.target).toBeNull();
				expect(jump.remaining).toBe(0);
			}
		}
	});

	test("remaining counts only the queried direction", () => {
		// standing between the first and second of three
		expect(severityJump(threeMisses, "miss", 1, 1500).remaining).toBe(2);
		expect(severityJump(threeMisses, "miss", -1, 1500).remaining).toBe(1);
	});

	test("remaining equals the number of successive jumps that actually succeed", () => {
		const walk = (direction: 1 | -1, from: number) => {
			let time = from;
			let landed = 0;
			for (;;) {
				const jump = severityJump(threeMisses, "miss", direction, time);
				if (jump.target === null) return landed;
				time = jump.target.landingTime;
				landed += 1;
			}
		};
		expect(walk(1, -5000)).toBe(severityJump(threeMisses, "miss", 1, -5000).remaining);
		expect(walk(1, 1500)).toBe(severityJump(threeMisses, "miss", 1, 1500).remaining);
		expect(walk(-1, 99_000)).toBe(severityJump(threeMisses, "miss", -1, 99_000).remaining);
		expect(walk(-1, 1500)).toBe(severityJump(threeMisses, "miss", -1, 1500).remaining);
	});

	test("two judgements sharing a landing time are one press, and remaining still counts both", () => {
		// the 2B case: two objects starting at the same instant, so one press
		// covers both. this is the one place `remaining` and the number of
		// presses that succeed come apart, and the disagreement is the intended
		// reading rather than an off-by-one -- the tooltip promises how many
		// judgements are left, and there really are three
		const stacked = severityTargets(
			[tick(0, 1300, "miss"), tick(1, 2300, "miss"), tick(2, 2300, "miss"), tick(3, 3300, "miss")],
			[object(1000, 600), object(2000, 600), object(2000, 600), object(3000, 600)]
		);
		// both survive into the list -- neither is deduplicated away
		expect(landings(stacked.miss)).toEqual([1000, 2000, 2000, 3000]);
		const forward = severityJump(stacked, "miss", 1, 1000);
		expect(forward.target?.landingTime).toBe(2000);
		expect(forward.remaining).toBe(3);
		// pressing again from where that landed clears BOTH of the pair at once
		expect(severityJump(stacked, "miss", 1, 2000).target?.landingTime).toBe(3000);
		// and the same holds coming back the other way, count included
		const backward = severityJump(stacked, "miss", -1, 3000);
		expect(backward.target?.landingTime).toBe(2000);
		expect(backward.remaining).toBe(3);
		expect(severityJump(stacked, "miss", -1, 2000).target?.landingTime).toBe(1000);
	});

	test("repeated forward jumps walk the map in order and never move backwards", () => {
		// the same walk read as the user experiences it: press, press, press
		const visited: number[] = [];
		let time = -5000;
		for (;;) {
			const jump = severityJump(threeMisses, "miss", 1, time);
			if (jump.target === null) break;
			time = jump.target.landingTime;
			visited.push(time);
		}
		expect(visited).toEqual([1000, 2000, 3000]);
	});
});
